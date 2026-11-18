/**
 * What an app of the catalogue is made of.
 *
 * A template is code that ships with the panel, reviewed like any other file in
 * it: nothing here comes from a user, a repository or the network. That is what
 * lets an install skip the host checks a repository's own compose file would
 * deserve — and it is also why a template never builds YAML out of answers.
 * The compose file is a constant; what the person types reaches the containers
 * only as project variables (`${NAME:-}` in the file), which Compose substitutes
 * into values after it has parsed the YAML, so an answer can never become a key,
 * a mount or an image.
 *
 * Zero imports: the unit suite loads these files directly.
 */

export type CatalogCategory =
  | "automation"
  | "websites"
  | "monitoring"
  | "analytics"
  | "storage"
  | "security"
  | "development";

/** What the person is asked. A generated secret is not a question: see `CatalogSecret`. */
export type QuestionType = "text" | "email" | "password" | "number" | "boolean";

export interface CatalogQuestion {
  /** The project variable the answer becomes, referenced in the compose file as `${KEY:-…}`. */
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /**
   * As the variable will hold it: `"true"` for a boolean that starts on. For a
   * port question, where the search for a free port starts.
   */
  default?: string;
  /** A default only the context knows: the visitor's time zone. */
  defaultFrom?: "timezone";
  help?: string;
  placeholder?: string;
  /** Extra rule for text. */
  format?: "timezone" | "username";
  minLength?: number;
  maxLength?: number;
  /** Bounds for numbers. */
  min?: number;
  max?: number;
  /**
   * A number that is a port published on the host. Left empty, the server
   * picks a free one; given, it is checked against every other port the panel
   * knows and against what is already listening.
   */
  port?: boolean;
  /** What a boolean writes into the variable. `"true"`/`"false"` when absent. */
  values?: { on: string; off: string };
  /** Shown under "Avanzate" only. */
  advanced?: boolean;
}

/** A password or key the server generates at install, never typed. */
export interface CatalogSecret {
  key: string;
  label: string;
  /** In characters. */
  length: number;
  /**
   * `alnum` is what may sit inside a URL (a `DATABASE_URL`) without encoding;
   * `hex` is for keys an app expects as hex.
   */
  alphabet: "hex" | "alnum";
  /** Needed by the person — to log in, to recover data — so it is shown first. */
  important?: boolean;
  help?: string;
}

/** A named volume and what it keeps, for the page and for the backups. */
export interface CatalogVolume {
  name: string;
  service: string;
  path: string;
  label: string;
}

/** A database that runs inside the stack, not a panel service. */
export interface CatalogDatabase {
  service: string;
  /** As people say it: "MariaDB 11.8". */
  engine: string;
}

/** Where the app answers: the chosen address over HTTPS, or the server's own name and port. */
export interface AppLocation {
  /** `https://app.esempio.it` or `http://192.168.1.10:8080`, no trailing slash. */
  url: string;
  /** The host part alone, no scheme and no port. */
  host: string;
  https: boolean;
}

export interface DeriveContext extends AppLocation {
  port: number;
  /** The validated answers, as the variables hold them. */
  answers: Readonly<Record<string, string>>;
}

export type AddressNeed = "optional" | "recommended" | "required";

export interface CatalogTemplate {
  /** Also the URL segment and the name the project is offered under. */
  id: string;
  /** Bumped when the compose file changes; written into its header. */
  revision: number;
  name: string;
  /** One sentence, for the gallery. */
  description: string;
  /** A few more, for the install page. */
  about: string;
  category: CatalogCategory;
  /** A Solar icon, as a literal so the icon bundler finds it. */
  icon: string;
  /** The upstream documentation, for whoever wants to go further. */
  website: string;
  /** Extra words the search matches: what people call this kind of app. */
  keywords: readonly string[];
  /** The service the address and the health check reach, and its port inside the container. */
  web: { service: string; internalPort: number; defaultPort: number };
  /** What the deploy waits for. A first start can mean minutes of migrations. */
  healthcheck: { path: string; expectStatus: readonly number[]; startPeriodSec: number; timeoutSec: number };
  volumes: readonly CatalogVolume[];
  databases: readonly CatalogDatabase[];
  questions: readonly CatalogQuestion[];
  secrets: readonly CatalogSecret[];
  /** The variables `derive` computes, with a label for the page that lists them. */
  derived: readonly { key: string; label: string }[];
  /** The values that follow from where the app answers. Always the same keys as `derived`. */
  derive: (ctx: DeriveContext) => Record<string, string>;
  address: AddressNeed;
  /** Why the address matters, when it is recommended or required. */
  addressNote?: string;
  /**
   * What to do once it is online, in order. `{KEY}` is replaced with that
   * variable's value when it is not a secret; `{APP_URL}` is always there.
   */
  notes: readonly string[];
  /** The compose file, without its header. Static: never built from answers. */
  compose: string;
}

/** What `POST /api/catalog/install` answers with when the project exists. */
export interface CatalogInstallResponse {
  project: { id: string; slug: string; name: string };
  templateId: string;
  port: number;
  url: string;
  hostname: string | null;
  /** The proxy's state when an address was given, so the page can say why it does not open yet. */
  proxy: { state: string; detail: string } | null;
  deployment:
    | { status: "started"; deploymentId: string }
    | { status: "queued"; message: string }
    | { status: "not-started"; message: string };
  /** The only time these leave the server in clear. Afterwards: the project's variables. */
  secrets: { key: string; label: string; value: string; important: boolean; help: string | null }[];
  /** Every variable that is not a secret, as written. */
  values: Record<string, string>;
  /** The template's notes, with the final values in them. */
  notes: string[];
}

/** What it answers with when it refuses: the sentence, and where the form should put it. */
export interface CatalogInstallRefusal {
  error: string;
  /** `name`, `port`, `address` or `answers.<KEY>`. */
  field?: string | null;
  code?: string;
  suggestedName?: string;
  suggestedPort?: number;
}

/** One project variable an install writes, and where its value came from. */
export interface EnvEntry {
  key: string;
  value: string;
  source: "question" | "secret" | "derived";
  /** Never shown back once the install is over, never logged. */
  sensitive: boolean;
}
