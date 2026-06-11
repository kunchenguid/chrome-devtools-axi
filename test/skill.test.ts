import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  createSkillMarkdown,
  extractCommandsBlock,
  SKILL_DESCRIPTION,
} from "../src/skill.js";

describe("createSkillMarkdown", () => {
  it("matches the committed skills/chrome-devtools-axi/SKILL.md", () => {
    const committed = readFileSync(
      new URL("../skills/chrome-devtools-axi/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown());
  });

  it("starts with valid frontmatter and is not user-invocable", () => {
    const markdown = createSkillMarkdown();
    expect(markdown.startsWith("---\nname: chrome-devtools-axi\n")).toBe(true);
    expect(markdown).toContain(`description: ${SKILL_DESCRIPTION}`);
    expect(markdown).toContain("user-invocable: false");
    expect(markdown).not.toContain("$ARGUMENTS");
    expect(markdown).not.toContain("argument-hint:");
  });

  it("teaches npx invocation instead of assuming a global install", () => {
    const markdown = createSkillMarkdown();
    expect(markdown).toContain("npx -y chrome-devtools-axi");
  });
});

describe("extractCommandsBlock", () => {
  it("pulls the commands list from the top-level help", () => {
    const block = extractCommandsBlock();
    expect(block).toMatch(/^commands\[\d+\]:\n/);
    expect(block).toContain("open <url>");
    expect(block).toContain("setup hooks");
  });
});
