import { appendFileSync, renameSync, statSync } from "node:fs";
import { LOG_FILE, ensureHomeDir } from "./paths";

const MAX_LOG_BYTES = 1024 * 1024;

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  try {
    ensureHomeDir();
    if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // logging must never break a backup
  }
}
