#!/usr/bin/env bun
import { connect, disconnect, isConnected } from "./auth";
import { DEFAULTS, backup } from "./backup";
import { list, restore } from "./restore";
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
  memdrive config <key> <value>      set intervalHours, keepDays, keepMin or machine

Options:
  --yes                              restore without asking for confirmation
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";

  switch (command) {
    case "setup": {
      applyClientOptions(args);
      if (!isConnected()) await connect();
      console.log("Google Drive connected. Making the first backup...");
      await backup();
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
