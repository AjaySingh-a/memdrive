---
name: memdrive
description: memdrive backs up claude-mem's memory to the user's own Google Drive and restores it. Use when the user mentions memdrive, or asks whether their claude-mem memory is backed up, when the last backup was, to back up now, to restore or move their memory to another computer, to connect, switch or disconnect the Google account used for backups, or to turn automatic backups on or off.
---

# memdrive

memdrive is a command-line program installed on this computer, separate from claude-mem.
It is not an MCP server or plugin, so it will not appear in Claude's config or plugin list.
It takes a safe snapshot of claude-mem's data (`~/.claude-mem`, or `CLAUDE_MEM_DATA_DIR`)
and uploads it to the user's Google Drive, in `memdrive/<computer name>/`. A background
scheduler checks every hour and backs up when memory changed and the last backup is
older than 6 hours. Every backup is encrypted with the user's backup password before upload.

Run it with the Bash tool. If `memdrive` is not on PATH, use `~/.local/bin/memdrive`
(macOS/Linux) or `~/.memdrive/bin/memdrive.cmd` (Windows).

## Commands

| Command | What it does |
|---|---|
| `memdrive status` | Google Drive connection, schedule, last backup, last error |
| `memdrive backup` | back up now |
| `memdrive list` | backups on Drive, for every computer on this Google account |
| `memdrive restore [computer] [file] --yes` | replace local memory with a backup |
| `memdrive setup` | choose a backup password, sign in to Google, back up, turn on automatic backups |
| `memdrive password` | change the backup password (new backups only) |
| `memdrive clean-unencrypted --yes` | delete old unencrypted backups (made before memdrive 0.2) |
| `memdrive connect` | sign in to Google only |
| `memdrive disconnect` | turn off automatic backups and revoke Google access (backups on Drive are kept) |
| `memdrive schedule on\|off` | turn automatic backups on or off |
| `memdrive config <key> <value>` | `intervalHours`, `keepDays`, `keepMin`, `machine` |
| `memdrive help` | all commands |

## Backup passwords

The Bash tool has no keyboard, so it cannot type a password. Never ask the user to tell you
their backup password, and never put it on a command line. When `setup`, `password`, or a
restore of another computer's backup needs it, ask the user to run that command in their own
terminal window (Terminal, iTerm, PowerShell), not through you.

A restore of a backup made on this same computer does not need the password.

## How to handle common requests

- **"Is my memory backed up?" / "Is memdrive working?"**: run `memdrive status` and explain
  it in plain words. If it shows "Last error", say what went wrong. If it says "not
  connected" or "no backup password yet", the fix is `memdrive setup` in their own terminal.
  If `memdrive list` shows backups marked "NOT encrypted", suggest
  `memdrive clean-unencrypted --yes`: they may contain passwords from past sessions.
- **"Back up now"**: run `memdrive backup`.
- **Sign-in (`setup`, `connect`)**: this opens the user's browser and waits up to 5 minutes
  for them to click Allow. Tell them before you run it. If they want a different Google
  account than the browser picks, they can open the printed link in a private/incognito
  window.
- **Switch Google account**: `memdrive disconnect`, then `memdrive setup`.
- **Restore**: this replaces the claude-mem memory on this computer. First run
  `memdrive list` and confirm with the user which computer and backup to use. Only after
  they explicitly agree, run `memdrive restore <computer> --yes` (without `--yes` it waits for
  a keyboard answer that the Bash tool cannot give). Restore stops claude-mem's background
  worker and saves the current memory to `~/.claude-mem.pre-restore-<time>` first. Afterwards,
  tell the user to quit and reopen Claude Code so claude-mem loads the restored memory.
- **Uninstall**: `memdrive disconnect`, then delete `~/.memdrive`, `~/.local/bin/memdrive`
  and this skill's folder. Do this only when the user asks.

Logs are in `~/.memdrive/memdrive.log`. Project page: https://github.com/AjaySingh-a/memdrive
