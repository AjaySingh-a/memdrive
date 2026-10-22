#!/usr/bin/env bun
import { connect, disconnect, isConnected } from "./auth";
import { DEFAULTS, backup } from "./backup";
import { MIN_PASSWORD_LENGTH, createKey, hasKey, saveKey } from "./crypto";
import { canPrompt, confirm, readInput } from "./prompt";
import { deleteUnencrypted, findUnencrypted, list, restore } from "./restore";
import { scheduleOff, scheduleOn, scheduleStatus } from "./schedule";
import { HOME_DIR, claudeMemDataDir, loadConfig, loadState, machineName, saveConfig } from "./paths";
import pkg from "../package.json";

const HELP = `memdrive ${pkg.version} — free Google Drive backup for claude-mem

Usage:
  memdrive setup                     connect Google Drive, back up now, turn on automatic backups
  memdrive backup                    back up now
  memdrive list                      show backups on Google Drive (all your computers)
  memdrive restore [computer] [file] restore the latest backup (of this or another computer)
  memdrive status                    show connection, schedule and last backup
  memdrive schedule on|off           turn automatic backups on or off
  memdrive connect                   connect Google Drive
  memdrive disconnect                turn off backups and revoke Google Drive access
  memdrive password                  change the backup password (for new backups)
  memdrive clean-unencrypted         delete old backups made before encryption
  memdrive config <key> <value>      set intervalHours, keepDays, keepMin or machine

Options:
  --yes                              restore / clean-unencrypted without asking
  --client-id, --client-secret       use your own Google OAuth client (with connect/setup)
`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
}

function applyClientOptions(args: string[]): void {
  const clientId = option(args, "--client-id");
  const clientSecret = option(args, "--client-secret");
  if (clientId || clientSecret) saveConfig({ ...loadConfig(), clientId, clientSecret });
}

async function choosePassword(): Promise<void> {
  console.log(
    "\nChoose a backup password. Every backup is encrypted with it before it leaves this computer,\n" +
      "so nobody can read your memory from Google Drive, not even Google.\n" +
      "Write it down somewhere safe: without it, your backups can never be restored on another computer.\n" +
      "Tip: use the same password on all your computers.\n",
  );
  let password = process.env.MEMDRIVE_PASSWORD ?? null;
  if (password === null) {
    if (!canPrompt()) {
      throw new Error("memdrive needs you to choose a backup password. Run `memdrive setup` in your own terminal window.");
    }
    for (;;) {
      const first = await readInput("Backup password: ", { hidden: true });
      if (first === null) throw new Error("no password entered");
      if (first.length < MIN_PASSWORD_LENGTH) {
        console.log(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
        continue;
      }
      const second = await readInput("Type it again: ", { hidden: true });
      if (first !== second) {
        console.log("The passwords don't match, try again.");
        continue;
      }
      password = first;
      break;
    }
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`the backup password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  saveKey(createKey(password));
  console.log("Backup password set.");
}

async function cleanUnencrypted(yes: boolean): Promise<void> {
  const old = await findUnencrypted();
  if (old.length === 0) {
    console.log("No unencrypted backups on Google Drive.");
    return;
  }
  console.log(`\nFound ${old.length} old backup(s) on Google Drive that are NOT encrypted:`);
  for (const { folder, file } of old) console.log(`  ${folder}/${file.name}`);
  const ok = yes || (await confirm("Delete them now? Your encrypted backups replace them.", true));
  if (ok) await deleteUnencrypted(old);
  else console.log("Kept them. Delete them later with: memdrive clean-unencrypted");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";

  switch (command) {
    case "setup": {
      applyClientOptions(args);
      if (!hasKey()) await choosePassword();
      if (!isConnected()) await connect();
      console.log("Google Drive connected. Making an encrypted backup...");
      await backup();
      await cleanUnencrypted(false);
      console.log(`Automatic backups on: ${scheduleOn()}`);
      console.log(`\nDone. Your claude-mem memory is backed up to Google Drive / memdrive / ${machineName()}.`);
      console.log("On a new computer: install claude-mem and memdrive, then run `memdrive restore`.");
      break;
    }
    case "connect":
      applyClientOptions(args);
      await connect();
      console.log("Google Drive connected.");
      break;
    case "disconnect":
      scheduleOff();
      await disconnect();
      console.log("Automatic backups turned off and Google Drive access revoked. Backups already on Drive were kept.");
      break;
    case "password":
      await choosePassword();
      console.log("New backups use the new password. Older backups still need the password they were made with.");
      break;
    case "clean-unencrypted":
      await cleanUnencrypted(flag(args, "--yes"));
      break;
    case "backup":
      await backup({ ifDue: flag(args, "--if-due") });
      break;
    case "list":
      await list();
      break;
    case "restore": {
      const yes = flag(args, "--yes");
      await restore({ machine: args[0], file: args[1], yes });
      break;
    }
    case "schedule":
      if (args[0] === "on") console.log(`Automatic backups on: ${scheduleOn()}`);
      else if (args[0] === "off") (scheduleOff(), console.log("Automatic backups off."));
      else console.log(`Automatic backups: ${scheduleStatus()}`);
      break;
    case "status": {
      const state = loadState();
      const config = { ...DEFAULTS, ...loadConfig() };
      console.log(`memdrive ${pkg.version}`);
      console.log(`Google Drive:      ${isConnected() ? "connected" : "not connected (run: memdrive connect)"}`);
      console.log(`Encryption:        ${hasKey() ? "on (backup password set)" : "no backup password yet (run: memdrive setup)"}`);
      console.log(`Automatic backups: ${scheduleStatus()} — every ${config.intervalHours}h when memory changed`);
      console.log(`Last backup:       ${state.lastSuccessAt ? `${new Date(state.lastSuccessAt).toLocaleString()} (${state.lastFile})` : "never"}`);
      if (state.lastError) console.log(`Last error:        ${state.lastError} (${state.lastErrorAt})`);
      console.log(`This computer:     ${machineName()}`);
      console.log(`claude-mem data:   ${claudeMemDataDir()}`);
      console.log(`memdrive files:    ${HOME_DIR}`);
      break;
    }
    case "config": {
      const [key, value] = args;
      const config = loadConfig() as Record<string, unknown>;
      if (!key) {
        console.log(JSON.stringify({ ...DEFAULTS, ...config, clientSecret: config.clientSecret ? "(set)" : undefined }, null, 2));
      } else if (["intervalHours", "keepDays", "keepMin"].includes(key) && Number(value) > 0) {
        saveConfig({ ...config, [key]: Number(value) });
      } else if (key === "machine" && value) {
        saveConfig({ ...config, machine: value });
      } else {
        throw new Error(`unknown setting or bad value: ${key} ${value ?? ""}`);
      }
      break;
    }
    case "version":
    case "--version":
      console.log(pkg.version);
      break;
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`memdrive: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
