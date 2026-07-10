# AGENTS.md policy rollout evidence

Validated target commit `203d7e3c36603b082ac0883e09053402cf8f3150` against base commit `27e291a28164410a6b9b80796b3c4c490bca0fa3`.

## Scope and source of truth

- The commit changes only `AGENTS.md`.
- `package.json` remains the authoritative source for `scripts.prepublishOnly: "npm run build"`.
- `package.json` remains the authoritative source for including `skills/chrome-devtools-axi` in the npm `files` list.
- The corresponding duplicate AGENTS.md narration is absent.

## Agent-facing end state

```md
## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
```

The validation asserted this block is verbatim, appears exactly once, and is the final section of `AGENTS.md`.
