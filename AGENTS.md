# Genji Ball Ranked

The ranked server: one Cloudflare Worker (TypeScript) that serves the API and the website, with a D1 database. Free tier only.

## Commands

| Command | Use |
|---|---|
| `npm ci` | Install |
| `npm run dev` | Run locally with a local D1 |
| `npm run check` | Typecheck, lint and test. What CI runs. **It must pass before a change is done.** |
| `npm run db:migrate:local` | Apply migrations to the local D1 |

Tests run inside the Workers runtime (`@cloudflare/vitest-pool-workers`) with every migration applied, so a test can use `env.DB` directly. The `compatibility_date` in `wrangler.toml` can't be newer than the runtime in the installed wrangler supports, or the tests fail to start.

## Config: no magic numbers

Every tunable lives in `src/config.ts`, with its default and a comment saying what it does: rating parameters, tier thresholds, limits, timeouts, accepted log versions, feature flags. Code reads `config.someValue`, never a literal.

- A wrangler.toml var can override a default (`LOG_LEVEL` overrides `logLevel`). Secrets (webhook URLs, keys) are `wrangler secret`s, never in `wrangler.toml` or the repo.
- Unfinished features ship behind a flag in the config, off by default.
- `LOG_LEVEL=debug` should be enough to see why a log was parsed, rejected or rated the way it was. Log through `src/log.ts`, not `console.log`.

## Database

- The schema changes only through a new file in `migrations/` (`npx wrangler d1 migrations create DB <name>`). Never edit a migration that's been merged: it may already be applied in production.
- Keep the raw log of every upload. Ratings and stats must be rebuildable from the stored logs alone, so a parser or rating fix can be re-run over everything.
- Stay inside the D1 free tier: index what pages query, and avoid per-row writes in loops (use `db.batch`).

## The log format is a contract

The format the game writes is defined in GenjiBall-CE's [`docs/ranked-log.md`](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md) on the `v1.3.3R` branch. The parser follows that page and never guesses past it. If the parser needs a format change, change the spec there first, in its own PR. Test the parser with the spec's example log.

## PR habits

- One topic per PR, branched from `main`. Fill in `.github/PULL_REQUEST_TEMPLATE.md`, and link the issue (`Fixes #12`).
- Match the surrounding code: `camelCase`, small pure modules where possible (the parser and rating engine don't touch D1), a test for each behaviour.
- Commits are made as `GenjiBallTeam`.

## Other repos

Ranked spans three repos in the Genji-Ball-Team org, cloned side by side in the same parent folder:

| Repo | What it is |
|---|---|
| `GenjiBall-CE` | The game. Ranked logging and the log format spec are on its `v1.3.3R` branch |
| `genjiball-ranked` (this one) | Cloudflare Worker: upload API, log parser, ratings, website |
| `genjiball-host-tool` | Tauri app: watches the host's Workshop log folder and uploads matches |

- An issue here may need work in another repo. Check that repo's issues before starting, keep one PR per repo, and link them to each other (`Genji-Ball-Team/GenjiBall-CE#132`).
- A sibling repo that isn't cloned yet: use `gh -R Genji-Ball-Team/<repo>` rather than guessing its contents. Each repo has its own `AGENTS.md`; follow it when working there.
