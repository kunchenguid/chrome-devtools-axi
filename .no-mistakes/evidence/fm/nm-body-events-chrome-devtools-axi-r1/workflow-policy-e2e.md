# PR body compliance event policy - focused E2E evidence

Validated target commit `fe58abd197a2f20798041a3817d7165aef11abf1` against base
`de1b5c5040ac657674dcb5475c0f2d90d714256d`.

The harness parsed the committed `.github/workflows/no-mistakes-required.yml`,
resolved its event policy for representative GitHub event identities, and
executed the workflow's actual Bash signature-check step with signed, unsigned,
and empty pull request bodies.

## Resolved concurrency groups

| Action | Run ID | Resolved group |
| --- | ---: | --- |
| `opened` | 9001 | `no-mistakes-required-417-9001` |
| `opened` | 9002 | `no-mistakes-required-417-9002` |
| `edited` | 9003 | `no-mistakes-required-417-9003` |
| `edited` | 9004 | `no-mistakes-required-417-9004` |
| `synchronize` | 9005 | `no-mistakes-required-417-head-change` |
| `reopened` | 9006 | `no-mistakes-required-417-head-change` |

Every tested body-bearing event has its own immutable run-ID group. The two
head-change actions retain the shared `head-change` group.

## Terminal signature outcomes

| Event | PR body | Exit | User-visible first line |
| --- | --- | ---: | --- |
| `opened` | Required marker present | 0 | `Found no-mistakes signature in PR #417 body.` |
| `edited` | Marker absent | 1 | `::error::This PR was not raised through no-mistakes.` |
| `edited` | Empty | 1 | `::error::This PR was not raised through no-mistakes.` |

## Preserved workflow contract

- Trigger: `pull_request` actions `opened`, `edited`, `synchronize`, and
  `reopened`, targeting `main`
- Permissions: `contents: read`
- Stable check name: `PR must be raised via no-mistakes`
- `cancel-in-progress: true`
- Exact deterministic marker remains unchanged
- Exemptions remain for `github-actions[bot]`, `dependabot[bot]`, and
  `release-please[bot]`
- No checkout, fork-code execution, or secret reference
- Diff remains limited to `.github/workflows/no-mistakes-required.yml`, with
  the run-name and concurrency-policy hunks

Result: **PASS**
