import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const started = performance.now();

process.on("beforeExit", () => {
  const out = process.env.CHROME_DEVTOOLS_AXI_PROCESS_TIMING;
  if (out) appendFileSync(out, `${performance.now() - started}\n`);
});
