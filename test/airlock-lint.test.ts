import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("airlock lint dependency installation", () => {
  it("uses pnpm for missing dependencies and local tools", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../.airlock/lint.sh"),
      "utf8",
    );

    expect(script).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(script).toContain("pnpm exec prettier --write");
    expect(script).toContain("pnpm exec prettier --check");
    expect(script).toContain("pnpm exec tsc --noEmit");
    expect(script).not.toContain("npm install --ignore-scripts");
    expect(script).not.toContain("npx ");
  });
});
