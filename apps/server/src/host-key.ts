import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Never log this value. The machine owner uses the private file for setup/recovery. */
export function loadHostKey(dataDir: string, configured?: string): string {
  if (configured !== undefined)
    return z.string().min(32).max(512).parse(configured);
  const path = join(dataDir, "host-key");
  try {
    writeFileSync(path, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  return readHostKeyFile(path);
}

/** Read-only counterpart for backup; never creates or rotates the key. */
export function readHostKeyFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 2048 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error(
        "The host-key file must be private to the server user (permissions 600).",
      );
    }
    return z.string().min(32).max(512).parse(readFileSync(fd, "utf8").trim());
  } finally {
    closeSync(fd);
  }
}
