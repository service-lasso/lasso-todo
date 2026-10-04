import { constants, realpathSync } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isEntrypoint(url) {
  try { return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(url))).href; }
  catch { return false; }
}
export async function readHeld(path, maximum = 1048576) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) throw new Error("bounded regular retained file required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw new Error("retained file replaced");
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) { const row = await handle.read(bytes, offset, bytes.length - offset, offset); if (!row.bytesRead) throw new Error("retained file truncated"); offset += row.bytesRead; }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("retained file grew");
    const after = await handle.stat(), named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino || named.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("retained file changed");
    return bytes;
  } finally { await handle.close(); }
}
