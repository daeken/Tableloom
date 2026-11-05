import { resolve, sep } from "node:path";
import { z } from "zod";

const manifestSchema = z.record(
  z.string(),
  z
    .object({
      file: z.string().min(1),
      isEntry: z.boolean().optional(),
      imports: z.array(z.string()).optional(),
    })
    .passthrough(),
);
/** Count the complete static import closure, excluding code loaded only by dynamic imports. */
export function initialJavaScript(input: unknown): string[] {
  const manifest = manifestSchema.parse(input),
    pending = Object.keys(manifest).filter((key) => manifest[key]!.isEntry),
    visited = new Set<string>(),
    files = new Set<string>();
  if (!pending.length)
    throw new Error("The build manifest has no entry point.");
  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    if (!Object.hasOwn(manifest, key))
      throw new Error(`Missing build import: ${key}`);
    visited.add(key);
    const chunk = manifest[key]!;
    if (chunk.file.endsWith(".js")) files.add(chunk.file);
    pending.push(...(chunk.imports ?? []));
  }
  return [...files].sort();
}
/** Generated manifest paths must resolve to files inside the build directory. */
export function bundleAssetPath(directory: string, file: string): string {
  const root = resolve(directory),
    target = resolve(root, file);
  if (!target.startsWith(root + sep))
    throw new Error("A build asset path leaves the build directory.");
  return target;
}
