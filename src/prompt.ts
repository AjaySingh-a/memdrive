import { isatty } from "node:tty";

// Terminal input that works with hidden passwords. Returns null when there is no
// interactive terminal (scheduled runs, Claude's Bash tool, pipes), so callers can
// fall back to a safe default instead of hanging.
export function canPrompt(): boolean {
  return isatty(0);
}

export async function readInput(question: string, opts: { hidden?: boolean } = {}): Promise<string | null> {
  if (!canPrompt()) return null;
  return process.platform === "win32" ? readInputRaw(question, opts) : readInputShell(question, opts);
}

// macOS and Linux: let the shell read the line. Bun cannot watch a terminal opened as
// /dev/tty on macOS (kqueue EINVAL), which is exactly what `curl ... | bash` gives us.
// The trap restores echo even if the user presses Ctrl-C at the password prompt.
function readInputShell(question: string, opts: { hidden?: boolean }): string | null {
  process.stdout.write(question);
  const script = opts.hidden
    ? 'trap "stty echo 2>/dev/null" EXIT INT TERM; stty -echo 2>/dev/null; IFS= read -r line; s=$?; printf "%s" "$line"; exit $s'
    : 'IFS= read -r line; s=$?; printf "%s" "$line"; exit $s';
  const p = Bun.spawnSync(["/bin/sh", "-c", script], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  if (opts.hidden) process.stdout.write("\n");
  if (p.signalCode) throw new Error("cancelled");
  const value = p.stdout.toString();
  if (p.exitCode !== 0 && value === "") return null; // end of input
  return value;
}

// Keystrokes that arrived after an Enter (fast typing or a paste) belong to the next question.
let pending = "";

// Windows: raw-mode console input.
function readInputRaw(question: string, opts: { hidden?: boolean }): Promise<string | null> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === "\r" || ch === "\n") {
          let rest = chars.slice(i + 1).join("");
          if (ch === "\r" && rest.startsWith("\n")) rest = rest.slice(1);
          pending = rest;
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0 && !opts.hidden) process.stdout.write("\b \b");
          value = value.slice(0, -1);
        } else if (ch >= " ") {
          value += ch;
          if (!opts.hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
    if (pending) {
      const queued = pending;
      pending = "";
      onData(queued);
    }
  });
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean | null> {
  const answer = await readInput(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  if (answer === null) return null;
  const a = answer.trim().toLowerCase();
  return a === "" ? defaultYes : a === "y" || a === "yes";
}
