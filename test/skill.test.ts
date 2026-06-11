import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  createSkillMarkdown,
  extractCommandsBlock,
  SKILL_DESCRIPTION,
} from "../src/skill.js";

function parseFrontmatter(markdown: string): Record<string, string | boolean> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error("Missing frontmatter");
  }

  const parsed: Record<string, string | boolean> = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z-]+): (.*)$/);
    if (!field) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }

    const [, key, rawValue] = field;
    if (rawValue.startsWith('"')) {
      parsed[key] = JSON.parse(rawValue);
    } else if (rawValue === "true" || rawValue === "false") {
      parsed[key] = rawValue === "true";
    } else {
      if (/:\s/.test(rawValue)) {
        throw new Error(`Invalid plain scalar for ${key}`);
      }
      parsed[key] = rawValue;
    }
  }

  return parsed;
}

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
    const frontmatter = parseFrontmatter(markdown);
    expect(frontmatter).toEqual({
      name: "chrome-devtools-axi",
      description: SKILL_DESCRIPTION,
      "user-invocable": false,
    });
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
