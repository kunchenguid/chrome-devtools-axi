import { appendFileSync } from "node:fs";

/**
 * ESM `load` hook that records every module the process actually resolves, so
 * tests can assert on the real loaded graph instead of on source text.
 */
export async function load(url, context, next) {
  const out = process.env.CHROME_DEVTOOLS_AXI_MODULE_TRACE;
  if (out) appendFileSync(out, `${url}\n`);
  return next(url, context);
}
