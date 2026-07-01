import { isAbsolute, resolve } from "node:path";

/** Resolve a caller-relative output path to an absolute path for the bridge. */
export function resolveOutputPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}