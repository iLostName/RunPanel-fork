import { join, resolve } from "node:path";

/** The checkout: two levels above this folder. */
export const REPO_ROOT = resolve(__dirname, "..", "..");

/** The owner's cookie, written by the setup project and read by every other test. */
export const AUTH_FILE = join(__dirname, ".auth", "owner.json");

/** The account the setup project creates. */
export const OWNER = { email: "titolare@officina-rossi.it", password: "e2e-Password-2026" };
