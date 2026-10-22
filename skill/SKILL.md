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
older than 6 hours.

Run it with the Bash tool. If `memdrive` is not on PATH, use `~/.local/bin/memdrive`
(macOS/Linux) or `~/.memdrive/bin/memdrive.cmd` (Windows).

## Commands

| Command | What it does |
|---|---|
| `memdrive status` | Google Drive connection, schedule, last backup, last error |
| `memdrive backup` | back up now |
| `memdrive list` | backups on Drive, for every computer on this Google account |
| `memdrive restore [computer] [file] --yes` | replace local memory with a backup |
| `memdrive setup` | sign in to Google, back up now, turn on automatic backups |
| `memdrive connect` | sign in to Google only |
| `memdrive disconnect` | turn off automatic backups and revoke Google access (backups on Drive are kept) |
| `memdrive schedule on\|off` | turn automatic backups on or off |
| `memdrive config <key> <value>` | `intervalHours`, `keepDays`, `keepMin`, `machine` |
| `memdrive help` | all commands |

## How to handle common requests

- **"Is my memory backed up?" / "Is memdrive working?"**: run `memdrive status` and explain
  it in plain words. If it shows "Last error", say what went wrong. If it says "not
  connected", the fix is `memdrive setup`.
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
