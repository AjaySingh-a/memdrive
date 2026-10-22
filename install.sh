#!/usr/bin/env bash
# memdrive installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/AjaySingh-a/memdrive/main/install.sh | bash
set -euo pipefail

REPO="${MEMDRIVE_REPO:-AjaySingh-a/memdrive}"
REF="${MEMDRIVE_REF:-main}"
APP_DIR="$HOME/.memdrive/app"
BIN_DIR="$HOME/.local/bin"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# claude-mem installs Bun, so it is normally already here.
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -z "$BUN" ]; then
  say "Bun not found, installing it (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi

if [ ! -d "${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}" ]; then
  say "Note: claude-mem's data folder was not found. Install claude-mem first, or memdrive will have nothing to back up."
fi

say "Downloading memdrive..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$tmp"
rm -rf "$APP_DIR"
mkdir -p "$(dirname "$APP_DIR")" "$BIN_DIR"
mv "$tmp"/memdrive-* "$APP_DIR"

cat > "$BIN_DIR/memdrive" <<EOF
#!/bin/sh
exec "$BUN" "$APP_DIR/src/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/memdrive"

# Teach Claude Code about memdrive, so "is my memory backed up?" just works.
SKILL_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/memdrive"
mkdir -p "$SKILL_DIR"
cp "$APP_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH to use the memdrive command from anywhere." ;;
esac

say "Connecting Google Drive..."
"$BIN_DIR/memdrive" setup
