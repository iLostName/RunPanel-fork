import {
  TelegramFailure,
  accountLabel,
  asTelegramFailure,
  chatLabel,
  readTelegramChat,
  readTelegramConfig,
  type TelegramChat,
  type TelegramConfig,
} from "./destinations/telegram";
import { connectTelegram } from "./destinations/telegram-client";
import type { LinkedAccount } from "./telegram-login";

/**
 * From a finished login to the config a Telegram destination stores, and from
 * a stored config to the one a re-link leaves behind.
 *
 * The channel is created here, when the destination is saved and not when
 * the account is linked: a form abandoned halfway leaves no empty channel in
 * somebody's chat list.
 */

/** Telegram allows 128 characters; the panel proposes one when none is given. */
const CHANNEL_TITLE_MAX = 128;

export async function telegramConfigFromLogin(
  linked: LinkedAccount,
  choice: { chat: "channel" | "saved"; channelTitle?: string; fallbackTitle: string }
): Promise<TelegramConfig> {
  const base = {
    apiId: linked.apiId,
    apiHash: linked.apiHash,
    session: linked.session,
    account: { id: linked.account.id, name: linked.account.name, username: linked.account.username },
  };
  if (choice.chat === "saved") return { ...base, chat: { kind: "saved" } };

  const title = (choice.channelTitle?.trim() || choice.fallbackTitle).slice(0, CHANNEL_TITLE_MAX);
  const transport = await connectTelegram({ ...base, chat: { kind: "saved" } }).catch((err: unknown) => {
    throw asTelegramFailure(err);
  });
  try {
    return { ...base, chat: await transport.createChannel(title) };
  } catch (err) {
    const failure = asTelegramFailure(err);
    if (failure.code === "CHANNELS_TOO_MUCH") {
      throw new TelegramFailure(
        "Questo account è già in troppi canali e gruppi per crearne un altro: lasciane qualcuno, oppure salva nei Messaggi salvati.",
        failure.code
      );
    }
    throw failure;
  } finally {
    await transport.close();
  }
}

/**
 * A new login for an existing destination: the account, its keys and its
 * session change, the chat the archives are in does not.
 *
 * The same account is the common case — a session closed from the app — and
 * changes nothing else. Another account is accepted only where the archives
 * already stored stay reachable: a channel it can see (an admin added after
 * the first account was lost), or Saved Messages that hold nothing yet. The
 * alternative would be a destination that saves fine from tonight on and
 * cannot restore anything it held until today.
 */
export async function relinkTelegramConfig(
  stored: Record<string, unknown>,
  linked: LinkedAccount,
  archives: number
): Promise<{ config: TelegramConfig; accountChanged: boolean }> {
  const chat = readTelegramChat(stored.chat);
  if (!chat) throw new TelegramFailure("Questa destinazione non sa più in quale chat salva: creane una nuova.");
  const previous = stored.account && typeof stored.account === "object" ? (stored.account as Record<string, unknown>) : null;
  const previousId = typeof previous?.id === "string" ? previous.id : null;
  const accountChanged = previousId !== null && previousId !== linked.account.id;
  const base = {
    apiId: linked.apiId,
    apiHash: linked.apiHash,
    session: linked.session,
    account: { id: linked.account.id, name: linked.account.name, username: linked.account.username },
  };
  if (!accountChanged) return { config: { ...base, chat }, accountChanged };

  const before = typeof previous?.name === "string" ? accountLabel({ name: previous.name, username: typeof previous.username === "string" ? previous.username : null }) : "l'account di prima";
  if (chat.kind === "saved") {
    if (archives > 0) {
      throw new TelegramFailure(
        `Gli archivi di questa destinazione sono nei Messaggi salvati di ${before}: collega quell'account, oppure crea una nuova destinazione per questo.`
      );
    }
    return { config: { ...base, chat }, accountChanged };
  }

  const transport = await connectTelegram({ ...base, chat }).catch((err: unknown) => {
    throw asTelegramFailure(err);
  });
  let found: Extract<TelegramChat, { kind: "channel" }> | null;
  try {
    found = await transport.findChannel(chat.id);
  } catch (err) {
    throw asTelegramFailure(err);
  } finally {
    await transport.close();
  }
  if (!found) {
    throw new TelegramFailure(
      `${accountLabel(linked.account)} non vede ${chatLabel(chat)}, dove sono gli archivi. Collega ${before}, oppure aggiungi questo account al canale come amministratore e riprova.`
    );
  }
  return { config: { ...base, chat: { ...found, title: found.title || chat.title } }, accountChanged };
}

/**
 * End a session the panel no longer uses — a destination deleted, or an
 * account re-linked — so it does not linger among the account's devices with
 * full access and nobody behind it. Best effort: a session already closed
 * from the app is the usual reason for a re-link, and that is fine too.
 */
export async function logOutTelegram(raw: Record<string, unknown>): Promise<void> {
  const config = readTelegramConfig(raw);
  if (!config) return;
  const transport = await connectTelegram(config).catch(() => null);
  if (!transport) return;
  try {
    await transport.logOut();
  } catch {
    /* already closed, or unreachable: nothing more to do from here */
  } finally {
    await transport.close();
  }
}
