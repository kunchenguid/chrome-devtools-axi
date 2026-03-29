#!/usr/bin/env tsx

import { getErrorMessage, runBridge } from "../src/bridge.js";

runBridge().catch((error) => {
  process.stderr.write(`[chrome-devtools-axi] Fatal: ${getErrorMessage(error)}\n`);
  process.exit(1);
});
