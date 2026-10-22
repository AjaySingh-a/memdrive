// tar ships with macOS, Linux and Windows 10 (1803+), so no extra dependency is needed.
async function tar(args: string[]): Promise<void> {
  const proc = Bun.spawn(["tar", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed: ${(await new Response(proc.stderr).text()).trim()}`);
}

export const createArchive = (archive: string, parentDir: string, dirName: string) =>
  tar(["-czf", archive, "-C", parentDir, dirName]);

export const extractArchive = (archive: string, intoDir: string) => tar(["-xzf", archive, "-C", intoDir]);
