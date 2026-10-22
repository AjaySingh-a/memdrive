# memdrive

**Free Google Drive backup and restore for [claude-mem](https://github.com/thedotmack/claude-mem).**

claude-mem gives Claude Code a long-term memory, stored on your computer. memdrive
keeps a copy of that memory in **your own Google Drive**, automatically, so it survives a
broken laptop and moves with you to a new computer. Free, open source, and your data
never touches anyone else's server.

Website: <https://ajaysingh-a.github.io/memdrive/> · [Privacy policy](https://ajaysingh-a.github.io/memdrive/privacy.html)

> memdrive is an independent project. It is not made by or affiliated with the
> claude-mem authors.

## Install

You need [claude-mem](https://github.com/thedotmack/claude-mem) installed first.

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/AjaySingh-a/memdrive/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/AjaySingh-a/memdrive/main/install.ps1 | iex
```

The installer opens your browser and asks you to allow access to Google Drive, makes
the first backup, and turns on automatic backups. That's it.

## What it does

- Every hour it checks whether your claude-mem memory changed. If it did and the last
  backup is more than 6 hours old, it backs up.
- Backups go to **Google Drive → memdrive → _your computer's name_**.
- The newest 5 backups are always kept, and older ones are deleted after 30 days.
- Snapshots are taken safely while claude-mem is running and checked for corruption
  before upload.

## Commands

```
memdrive status                     connection, schedule, last backup
memdrive backup                     back up now
memdrive list                       backups on Drive, for all your computers
memdrive restore                    restore this computer's latest backup
memdrive restore <computer>         restore another computer's latest backup (e.g. on a new laptop)
memdrive restore <computer> <file>  restore a specific backup
memdrive schedule on|off            automatic backups on or off
memdrive config keepDays 60         settings: intervalHours, keepDays, keepMin, machine
memdrive disconnect                 stop backups and revoke Google access
```

### Moving to a new computer

1. Install Claude Code and claude-mem.
2. Install memdrive (command above) and allow Google Drive access.
3. `memdrive list` to find your old computer's name, then
   `memdrive restore <old-computer-name>`.

Restore stops claude-mem's background worker, saves your current memory to
`~/.claude-mem.pre-restore-<time>`, and puts the backup in place. Nothing is deleted.

## Privacy

- memdrive uses Google's `drive.file` permission: it can only see files **it created**.
  It cannot read anything else in your Drive.
- Your login is stored in `~/.memdrive/credentials.json`, readable only by you.
- Backups include claude-mem's `settings.json`. If you put API keys in there, they are
  in your backups too (in your own Drive).

## What is backed up

From `~/.claude-mem` (or `CLAUDE_MEM_DATA_DIR`): all SQLite databases, the `chroma`
vector index, `corpora`, `settings.json` and sync state. Logs, process files and
claude-mem's own upgrade backups are skipped.

## Limitations

- Restore replaces the memory on a computer; it does not merge memories from two
  computers that were used at the same time.
- On a headless Linux server, the Google sign-in page must be opened from a machine
  that can reach `127.0.0.1` on the server (for example with `ssh -L`).

## Development

```sh
bun test
bun src/cli.ts status
```

Maintainers: see [docs/google-oauth-setup.md](docs/google-oauth-setup.md) to set up the
Google OAuth client.

## License

MIT
