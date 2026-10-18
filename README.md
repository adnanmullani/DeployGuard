# 🛡️ DeployGuard

AI powered GitHub Action that reviews Terraform, Kubernetes, Docker and pipeline changes in every PR and flags deployment risk before merge.

**Rules catch it, AI explains it, the merge gate stops it.**

- Reads the real `terraform show -json` plan: what is created, updated, destroyed or **replaced**
- Rule engine (no AI needed): public S3, `0.0.0.0/0`, IAM `*`, destroyed or replaced databases, privileged pods, `:latest` images, `pull_request_target`
- AI layer: summary, blast radius and rollback plan (Gemini default, Claude and OpenAI supported)
- **One-click fixes**: simple, safe problems get a GitHub *Suggested change* on the exact line. Click *Commit suggestion* to apply. Nothing is changed for you, and risky decisions (like a database replace) are only flagged, never auto-fixed
- Secrets are masked before anything is sent to the AI
- One sticky PR comment, updated on every push
- `fail-on: high` turns it into a required check that blocks risky merges
- No server, no database: runs entirely on the GitHub runner

## Usage

```yaml
name: DeployGuard
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: adnanmullani/DeployGuard@v1
        with:
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

Without `api-key` it still runs, rules only.

### With a Terraform plan (recommended)

```yaml
      - uses: hashicorp/setup-terraform@v3
      - run: |
          terraform init
          terraform plan -out=tfplan
          terraform show -json tfplan > plan.json
      - uses: adnanmullani/DeployGuard@v1
        with:
          plan-file: plan.json
          api-key: ${{ secrets.GEMINI_API_KEY }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | none | AI provider key. Omit for rules only |
| `ai-provider` | `gemini` | `gemini`, `anthropic` or `openai` |
| `model` | provider default | Override the model |
| `plan-file` | none | Path to `terraform show -json` output |
| `fail-on` | `high` | `high`, `medium` or `none` |
| `suggest-fixes` | `true` | Post inline one-click fixes for simple issues |
| `max-diff-chars` | `30000` | Cap on diff text sent to the AI |
| `github-token` | `github.token` | Used to read the PR and post the comment |

Outputs: `risk-level` (`low`/`medium`/`high`) and `findings-count`.

## One-click fixes

| Found | Suggested change |
|---|---|
| `publicly_accessible = true` | `false` |
| `privileged: true`, `hostNetwork: true` | `false` |
| `FROM node:latest` | `FROM node:20` (known official images only) |
| `USER root` / `runAsUser: 0` | non-root UID |
| `cidr_blocks = ["0.0.0.0/0"]` | `10.0.0.0/16` (adjust to your range; skipped for ports 80/443) |
| `permissions: write-all` | `read-all` |
| `acl = "public-read"`, `encrypted = false`, `force_destroy = true` | the safe value |

If a safe fix cannot be known (unknown image, IAM `*`, `pull_request_target`), DeployGuard explains the problem and leaves the change to you. Fork PRs have a read-only token, so there the summary comment is posted without inline fixes.

## Block risky merges

Add the `DeployGuard` job as a required status check in branch protection and set `fail-on: high`.

## Try it without AWS

`examples/` has intentionally risky Terraform, a matching `sample-plan.json` and a Kubernetes manifest. Open a PR that adds them to see a HIGH RISK comment.

## Privacy

Only masked diffs of infra files and the plan summary are sent to the AI provider you choose. Nothing goes anywhere else.

## Development

```bash
npm ci
npm run all   # typecheck, tests, build into dist/
```

`dist/` is committed on purpose: GitHub runs it directly. CI fails if it is stale.

## Releasing

Work on `feature/*` branches, merge to `main` by PR, then tag `v1.x.y` and move the `v1` tag to it.

## License

MIT
