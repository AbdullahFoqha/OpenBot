/**
 * Absolute git-root resolution for studio products.
 */
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

/** Legacy default product id (still used as fallback / ensureProduct seed). */
export const STUDIO_PRODUCT_ID = "studio-local";

async function tryCommand(cmd: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
  });
}

export async function resolveProjectPath(
  inputPath: string,
): Promise<
  { ok: true; absolutePath: string; gitRoot: string } | { ok: false; reason: string }
> {
  if (!inputPath.startsWith("/")) {
    return { ok: false, reason: "The path must be absolute." };
  }
  let real: string;
  try {
    real = await realpath(inputPath);
  } catch {
    return { ok: false, reason: `No such directory: ${inputPath}` };
  }
  const gitRoot = await tryCommand(["git", "rev-parse", "--show-toplevel"], real);
  if (!gitRoot) {
    return {
      ok: false,
      reason: `${real} is not inside a git repository, so the studio cannot give a worker its own branch there.`,
    };
  }
  return { ok: true, absolutePath: real, gitRoot };
}
