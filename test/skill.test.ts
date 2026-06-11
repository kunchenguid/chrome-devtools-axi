import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createSkillMarkdown,
  extractCommandsBlock,
  SKILL_AUTHOR,
  SKILL_DESCRIPTION,
  SKILL_HERMES_CATEGORY,
  SKILL_HERMES_TAGS,
} from "../src/skill.js";

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error("Missing frontmatter");
  }
  return parseYaml(match[1]) as Record<string, unknown>;
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
      author: SKILL_AUTHOR,
      metadata: {
        hermes: {
          tags: [...SKILL_HERMES_TAGS],
          category: SKILL_HERMES_CATEGORY,
        },
      },
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
