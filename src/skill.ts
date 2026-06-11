import { HOME_DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "needs a real browser" intents.
export const SKILL_DESCRIPTION =
  "Control a Chrome browser session through the chrome-devtools-axi CLI - navigate, snapshot, " +
  "click, fill forms, run JavaScript, inspect console and network, take screenshots, audit " +
  "performance. Use whenever a task needs a real browser: opening or testing a web page, " +
  "clicking through a flow, extracting page content, or debugging a website.";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Extract the `commands[N]:` block from the top-level help so the skill's
 * command list can never drift from what `chrome-devtools-axi --help` prints.
 */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in TOP_HELP");
  }
  return match[1].trimEnd();
}

/**
 * Render the installable SKILL.md for the chrome-devtools-axi skill. The body is
 * built from the same shared guidance the CLI prints (home description and
 * top-level help), rewriting invocations to non-interactive
 * `npx -y chrome-devtools-axi ...` so the CLI comes along on demand.
 *
 * @returns full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown(): string {
  return `---
name: chrome-devtools-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
---

# chrome-devtools-axi

${HOME_DESCRIPTION}

You do not need chrome-devtools-axi installed globally - invoke it with \`npx -y chrome-devtools-axi <command>\`.
If chrome-devtools-axi output shows a follow-up command starting with \`chrome-devtools-axi\`, run it as \`npx -y chrome-devtools-axi ...\` instead.

## When to use

Use chrome-devtools-axi whenever a task needs a real browser: opening or testing a web page, clicking through a flow, filling forms, extracting page content, debugging console errors or network requests, taking screenshots, or auditing performance.

## Workflow

1. Run \`npx -y chrome-devtools-axi open <url>\` to navigate. Output includes the page's accessibility snapshot; interactive elements carry \`uid=\` refs.
2. Interact by ref: \`click @<uid>\`, \`fill @<uid> <text>\`, \`fillform @<uid>=<val>...\`, \`hover @<uid>\`, \`drag @<from> @<to>\`, \`upload @<uid> <path>\`.
3. Pass refs back exactly as printed, including the \`g<N>:\` generation prefix. If the page re-rendered since the snapshot, the action fails loudly with \`STALE_REF\` - run \`snapshot\` again and retry with fresh refs.
4. Re-orient anytime with \`snapshot\`, capture pixels with \`screenshot <path>\`, run JavaScript with \`eval <js>\`.
5. Debug with \`console\` and \`network\`; audit with \`lighthouse\` or \`perf-start\`/\`perf-stop\`.
6. Every response ends with contextual next-step hints - follow them. The first command auto-starts a persistent bridge, so the browser session survives across invocations; run \`stop\` when you are done.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Run \`npx -y chrome-devtools-axi --help\` for flags and environment variables, or \`npx -y chrome-devtools-axi <command> --help\` for per-command usage.

## Tips

- Pipe output through grep/head to extract specific data from large pages.
- Add \`--full\` to snapshot-producing commands to disable truncation.
`;
}
