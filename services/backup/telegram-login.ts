import crypto from "node:crypto";
import os from "node:os";
import type { Api } from "telegram";
import {
  TELEGRAM_MAX_FILE_PARTS,
  TelegramFailure,
  classifyTelegramError,
  partBytesFor,
  telegramProblemText,
  withTimeout,
  type TelegramAccount,
} from "./destinations/telegram";
import { GramTransport, closeClient, connectClient, createClient, describeUser, type GramClient } from "./destinations/telegram-client";

/**
 * Linking a Telegram account to the panel, one step per request.
 *
 * Telegram's login is a conversation — a QR code that renews itself every 30
 * seconds, or a code sent to the phone, then the account's two-step password
 * if it has one — and the browser holds up one end of it across several
 * requests. The other end, the connection and the half-made authorization,
 * lives here, in memory, for a few minutes; the browser only ever gets an
 * opaque id, the QR to draw and what step comes next.
 *
 * When it succeeds, the authorization stays here until the destination is
 * saved, which reads it straight from this map into the encrypted config: the
 * session string never travels to the browser and back. A login nobody saves
 * expires, and is logged out at Telegram on the way, so an abandoned form does
 * not leave a working session among the account's devices.
 *
 * In memory on purpose: the panel is one process, a login is minutes long,
 * and a restart in the middle simply means scanning the code again.
 */

export type LoginStep = "qr" | "code" | "password" | "done" | "failed";
export type LoginMethod = "qr" | "phone";

/** What the browser is told: never the api_hash, the code hash or the session. */
export interface LoginView {
  id: string;
  step: LoginStep;
  method: LoginMethod;
  /** `tg://login?token=…`, to draw as a QR code. */
  qr?: { url: string; expiresAt: string };
  /** Where the code went. */
  codeVia?: "app" | "sms" | "email" | "other";
  passwordHint?: string | null;
  /** A wrong code or password: the step stays, with this sentence. A failed login: why. */
  error?: string | null;
  account?: { name: string; username: string | null; premium: boolean; maxPartBytes: number };
  suggestedChannelTitle?: string;
  expiresAt: string;
}

/** What a saved destination takes from a finished login. */
export interface LinkedAccount {
  apiId: number;
  apiHash: string;
  session: string;
  account: TelegramAccount;
  maxPartBytes: number;
}

interface PendingLogin {
  id: string;
  userId: string;
  apiId: number;
  apiHash: string;
  method: LoginMethod;
  link: GramClient;
  step: LoginStep;
  phone?: string;
  phoneCodeHash?: string;
  codeVia?: LoginView["codeVia"];
  qr?: { token: Buffer; expires: number };
  passwordHint?: string | null;
  error?: string | null;
  /** Wrong codes and passwords: five, then the login fails. */
  wrong: number;
  account?: TelegramAccount;
  maxPartBytes?: number;
  expiresAt: number;
  /** One operation at a time: a poll renewing the QR must not interleave with a code being checked. */
  queue: Promise<unknown>;
  closed: boolean;
}

/** To scan the code or type it, with time to fetch the phone. */
const LOGIN_TTL_MS = 10 * 60_000;
/** After it worked: time to finish the form and save. */
const LINKED_TTL_MS = 20 * 60_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_WRONG = 5;
const MAX_PENDING = 10;

const store = globalThis as typeof globalThis & {
  __runpanelTelegramLogins?: Map<string, PendingLogin>;
  __runpanelTelegramSweep?: ReturnType<typeof setInterval>;
};

function logins(): Map<string, PendingLogin> {
  store.__runpanelTelegramLogins ??= new Map();
  if (!store.__runpanelTelegramSweep) {
    store.__runpanelTelegramSweep = setInterval(() => void sweep(), 30_000);
    store.__runpanelTelegramSweep.unref?.();
  }
  return store.__runpanelTelegramLogins;
}

async function sweep(): Promise<void> {
  const now = Date.now();
  for (const login of [...logins().values()]) {
    if (login.expiresAt <= now) await discard(login);
  }
}

/** Forget a login, logging the half-made session out at Telegram when there is one. */
async function discard(login: PendingLogin): Promise<void> {
  if (login.closed) return;
  login.closed = true;
  logins().delete(login.id);
  if (login.step === "done") {
    const { Api: A } = login.link.gram;
    await withTimeout(login.link.client.invoke(new A.auth.LogOut()), 10_000, "uscita").catch(() => {});
  }
  await closeClient(login.link.client);
}

function serialize<T>(login: PendingLogin, op: () => Promise<T>): Promise<T> {
  const next = login.queue.then(op, op);
  login.queue = next.catch(() => {});
  return next;
}

function call<T>(promise: Promise<T>, what: string): Promise<T> {
  return withTimeout(promise, CALL_TIMEOUT_MS, what);
}

function code(err: unknown): string | null {
  return classifyTelegramError(err).code;
}

/** The login's own failures, in words; anything else is a Telegram failure like any other. */
export function loginProblemText(err: unknown): string {
  switch (code(err)) {
    case "PHONE_NUMBER_INVALID":
      return "Il numero non è valido: scrivilo con il prefisso internazionale, per esempio +39 333 123 4567.";
    case "PHONE_NUMBER_BANNED":
      return "Telegram ha bloccato questo numero.";
    case "PHONE_NUMBER_UNOCCUPIED":
      return "Questo numero non ha un account Telegram: crealo prima dall'app.";
    case "PHONE_NUMBER_FLOOD":
    case "PHONE_PASSWORD_FLOOD":
      return "Troppi tentativi con questo numero: Telegram chiede di riprovare più tardi.";
    case "PHONE_CODE_INVALID":
    case "EMAIL_CODE_INVALID":
      return "Codice sbagliato: ricontrollalo e riprova.";
    case "PHONE_CODE_EXPIRED":
      return "Il codice è scaduto: ricomincia, e Telegram ne manderà un altro.";
    case "PASSWORD_HASH_INVALID":
      return "Password sbagliata: è quella della verifica in due passaggi di Telegram.";
    case "AUTH_TOKEN_EXPIRED":
    case "AUTH_TOKEN_INVALID":
      return "Il codice QR è scaduto: ricomincia.";
    default:
      return telegramProblemText(err);
  }
}

/** What the channel is called unless the form says otherwise: whose archives these are, at a glance. */
export function suggestedChannelTitle(): string {
  return `RunPanel · backup di ${os.hostname()}`.slice(0, 128);
}

function view(login: PendingLogin): LoginView {
  return {
    id: login.id,
    step: login.step,
    method: login.method,
    ...(login.step === "qr" && login.qr
      ? {
          qr: {
            url: `tg://login?token=${login.qr.token.toString("base64url")}`,
            expiresAt: new Date(login.qr.expires * 1000).toISOString(),
          },
        }
      : {}),
    ...(login.step === "code" ? { codeVia: login.codeVia ?? "other" } : {}),
    ...(login.step === "password" ? { passwordHint: login.passwordHint ?? null } : {}),
    error: login.error ?? null,
    ...(login.step === "done" && login.account
      ? {
          account: {
            name: login.account.name,
            username: login.account.username,
            premium: login.account.premium,
            maxPartBytes: login.maxPartBytes ?? 0,
          },
          suggestedChannelTitle: suggestedChannelTitle(),
        }
      : {}),
    expiresAt: new Date(login.expiresAt).toISOString(),
  };
}

function fail(login: PendingLogin, message: string): void {
  login.step = "failed";
  login.error = message;
  // Kept a little, so the page that polls reads why; nothing in it works any more.
  login.expiresAt = Math.min(login.expiresAt, Date.now() + 60_000);
  void closeClient(login.link.client);
}

async function authorized(login: PendingLogin, authorization: Api.auth.TypeAuthorization): Promise<void> {
  const { Api: A } = login.link.gram;
  if (authorization instanceof A.auth.AuthorizationSignUpRequired) {
    fail(login, "Questo numero non ha ancora un account Telegram: crealo dall'app, poi riprova.");
    return;
  }
  const user = authorization.user;
  if (!(user instanceof A.User)) {
    fail(login, "Telegram non ha restituito l'account collegato: riprova.");
    return;
  }
  if (user.bot) {
    fail(login, "Serve un account Telegram, non un bot: i bot caricano al massimo 50 MB.");
    return;
  }
  const account = describeUser(user);
  const transport = new GramTransport(login.link.gram, login.link.client);
  const documented = account.premium ? TELEGRAM_MAX_FILE_PARTS.premium : TELEGRAM_MAX_FILE_PARTS.regular;
  login.account = account;
  login.maxPartBytes = partBytesFor(await transport.maxFileParts(account.premium).catch(() => documented));
  login.step = "done";
  login.error = null;
  login.qr = undefined;
  login.phoneCodeHash = undefined;
  login.expiresAt = Date.now() + LINKED_TTL_MS;
}

async function askPassword(login: PendingLogin): Promise<void> {
  const { Api: A } = login.link.gram;
  const password = await call(login.link.client.invoke(new A.account.GetPassword()), "password");
  login.step = "password";
  login.passwordHint = password.hint ?? null;
  login.error = null;
  login.qr = undefined;
}

/** What `auth.exportLoginToken` answered: a fresh code to show, or the scan already accepted. */
async function onLoginToken(login: PendingLogin, result: Api.auth.TypeLoginToken): Promise<void> {
  const { Api: A } = login.link.gram;
  if (result instanceof A.auth.LoginToken) {
    login.qr = { token: Buffer.from(result.token), expires: result.expires };
    return;
  }
  if (result instanceof A.auth.LoginTokenMigrateTo) {
    // The account lives on another data center: the token is accepted there.
    await call(login.link.client._switchDC(result.dcId), "cambio di data center");
    const imported = await call(login.link.client.invoke(new A.auth.ImportLoginToken({ token: result.token })), "accesso");
    await onLoginToken(login, imported);
    return;
  }
  if (result instanceof A.auth.LoginTokenSuccess) await authorized(login, result.authorization);
}

/** Ask Telegram for the QR state: a renewed code, or the authorization if the phone already scanned it. */
async function exportToken(login: PendingLogin): Promise<void> {
  const { Api: A } = login.link.gram;
  try {
    const result = await call(
      login.link.client.invoke(new A.auth.ExportLoginToken({ apiId: login.apiId, apiHash: login.apiHash, exceptIds: [] })),
      "codice QR"
    );
    await onLoginToken(login, result);
  } catch (err) {
    if (code(err) === "SESSION_PASSWORD_NEEDED") {
      await askPassword(login);
      return;
    }
    throw err;
  }
}

function settle(login: PendingLogin, err: unknown): void {
  if (login.closed) return;
  const kind = classifyTelegramError(err).kind;
  // A dropped connection or a slow answer: the next poll tries again.
  if (kind === "network" || kind === "timeout" || kind === "transient") {
    login.error = "Telegram non risponde, riprovo…";
    return;
  }
  fail(login, loginProblemText(err));
}

export async function startTelegramLogin(input: {
  userId: string;
  apiId: number;
  apiHash: string;
  method: LoginMethod;
  phone?: string;
}): Promise<LoginView> {
  const map = logins();
  // One login per account at a time: a second press replaces the first.
  for (const login of [...map.values()]) {
    if (login.userId === input.userId) await discard(login);
  }
  if (map.size >= MAX_PENDING) {
    throw new TelegramFailure("Troppi collegamenti a Telegram in corso su questo pannello: riprova tra qualche minuto.");
  }

  let link: GramClient;
  try {
    link = await createClient(input.apiId, input.apiHash, "");
    await connectClient(link.client);
  } catch (err) {
    throw err instanceof TelegramFailure ? err : new TelegramFailure(loginProblemText(err), code(err));
  }
  const login: PendingLogin = {
    id: crypto.randomBytes(18).toString("base64url"),
    userId: input.userId,
    apiId: input.apiId,
    apiHash: input.apiHash,
    method: input.method,
    link,
    step: input.method === "qr" ? "qr" : "code",
    wrong: 0,
    expiresAt: Date.now() + LOGIN_TTL_MS,
    queue: Promise.resolve(),
    closed: false,
  };

  const { Api: A } = link.gram;
  try {
    if (input.method === "qr") {
      // The phone accepted the code: Telegram says so with this update, and the
      // authorization is then one more export away.
      link.client.addEventHandler((update: unknown) => {
        if (update instanceof A.UpdateLoginToken && login.step === "qr" && !login.closed) {
          void serialize(login, () => exportToken(login)).catch((err) => settle(login, err));
        }
      });
      await exportToken(login);
    } else {
      const phone = (input.phone ?? "").replace(/[\s()-]/g, "");
      const sent = await call(
        link.client.invoke(
          new A.auth.SendCode({ phoneNumber: phone, apiId: input.apiId, apiHash: input.apiHash, settings: new A.CodeSettings({}) })
        ),
        "invio del codice"
      );
      if (sent instanceof A.auth.SentCodeSuccess) {
        await authorized(login, sent.authorization);
      } else {
        if (sent.type instanceof A.auth.SentCodeTypeSetUpEmailRequired) {
          throw new TelegramFailure(
            "Telegram chiede di impostare un'email di accesso prima di collegare un nuovo dispositivo con il numero: collega l'account con il QR, dall'app."
          );
        }
        login.phone = phone;
        login.phoneCodeHash = sent.phoneCodeHash;
        login.codeVia =
          sent.type instanceof A.auth.SentCodeTypeApp
            ? "app"
            : sent.type instanceof A.auth.SentCodeTypeSms
              ? "sms"
              : sent.type instanceof A.auth.SentCodeTypeEmailCode
                ? "email"
                : "other";
      }
    }
  } catch (err) {
    await closeClient(link.client);
    throw err instanceof TelegramFailure ? err : new TelegramFailure(loginProblemText(err), code(err));
  }

  map.set(login.id, login);
  return view(login);
}

function find(id: string, userId: string): PendingLogin | null {
  const login = logins().get(id);
  // Someone else's login is no login at all: same answer as an expired one.
  if (!login || login.userId !== userId || login.closed) return null;
  if (login.expiresAt <= Date.now()) {
    void discard(login);
    return null;
  }
  return login;
}

/** Where the login stands. On the QR step, also renews a code about to expire. */
export async function telegramLoginStatus(id: string, userId: string): Promise<LoginView | null> {
  const login = find(id, userId);
  if (!login) return null;
  if (login.step === "qr" && login.qr && login.qr.expires * 1000 - Date.now() < 5_000) {
    await serialize(login, async () => {
      if (login.step === "qr" && login.qr && login.qr.expires * 1000 - Date.now() < 5_000) await exportToken(login);
    }).catch((err) => settle(login, err));
  }
  return view(login);
}

/** The code from the phone, or the two-step password. */
export async function submitTelegramLogin(
  id: string,
  userId: string,
  input: { code?: string; password?: string }
): Promise<LoginView | null> {
  const login = find(id, userId);
  if (!login) return null;
  const { Api: A } = login.link.gram;

  await serialize(login, async () => {
    try {
      if (login.step === "code" && input.code) {
        const result = await call(
          login.link.client.invoke(
            new A.auth.SignIn({
              phoneNumber: login.phone ?? "",
              phoneCodeHash: login.phoneCodeHash ?? "",
              ...(login.codeVia === "email"
                ? { emailVerification: new A.EmailVerificationCode({ code: input.code }) }
                : { phoneCode: input.code }),
            })
          ),
          "verifica del codice"
        );
        await authorized(login, result);
      } else if (login.step === "password" && input.password) {
        const password = await call(login.link.client.invoke(new A.account.GetPassword()), "password");
        const check = await login.link.gram.password.computeCheck(password, input.password);
        const result = await call(login.link.client.invoke(new A.auth.CheckPassword({ password: check })), "verifica della password");
        await authorized(login, result);
      } else {
        login.error = login.step === "code" ? "Scrivi il codice." : login.step === "password" ? "Scrivi la password." : null;
      }
    } catch (err) {
      const problem = code(err);
      if (problem === "SESSION_PASSWORD_NEEDED") {
        await askPassword(login);
      } else if (problem === "PHONE_CODE_INVALID" || problem === "EMAIL_CODE_INVALID" || problem === "PASSWORD_HASH_INVALID") {
        login.wrong++;
        if (login.wrong >= MAX_WRONG) fail(login, "Troppi tentativi sbagliati: ricomincia il collegamento.");
        else login.error = loginProblemText(err);
      } else {
        settle(login, err);
      }
    }
  });
  return view(login);
}

export async function cancelTelegramLogin(id: string, userId: string): Promise<boolean> {
  const login = find(id, userId);
  if (!login) return false;
  await discard(login);
  return true;
}

/** A finished login, read for saving; it stays until `releaseTelegramLogin`, so a failed save can be retried. */
export function linkedTelegramLogin(id: string, userId: string): LinkedAccount | null {
  const login = find(id, userId);
  if (!login || login.step !== "done" || !login.account) return null;
  return {
    apiId: login.apiId,
    apiHash: login.apiHash,
    session: login.link.session.save(),
    account: login.account,
    maxPartBytes: login.maxPartBytes ?? 0,
  };
}

/**
 * The session now belongs to a destination: close this connection, and do not
 * log it out — that would revoke what was just saved.
 */
export async function releaseTelegramLogin(id: string, userId: string): Promise<void> {
  const login = find(id, userId);
  if (!login) return;
  login.closed = true;
  logins().delete(login.id);
  await closeClient(login.link.client);
}
