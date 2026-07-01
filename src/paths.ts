import { isAbsolute, resolve } from "node:path";

/**
 * Resolve local output paths against the invoking CLI's current directory
 * before they are sent to the bridge. Absolute paths pass through unchanged.
 */
export function resolveOutputPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}
