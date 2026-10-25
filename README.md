# Genji Ball Ranked

The ranked server for [Genji Ball: Community Edition](https://github.com/Genji-Ball-Team/GenjiBall-CE): the upload API, the log parser, the rating engine and the website at genjiball.us.

How ranked works end to end:

1. A host runs the **v1.3.3R** version of the game mode. It writes what happens in each match to the Workshop log file ([format](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md)).
2. The [host tool](https://github.com/Genji-Ball-Team/genjiball-host-tool) watches the log folder and uploads finished matches here.
3. This server parses the log, rates each round and shows the results on the website.

It's one Cloudflare Worker that serves both the API and the website, with a D1 database, so there is one thing to deploy. It fits in the Cloudflare free tier.

- **Discord:** [discord.gg/sv9VVjh5pT](https://discord.gg/sv9VVjh5pT), the Genji Ball Ranked server

## Run it locally

You need Node.js 22 or newer.

```sh
npm ci
npm run db:migrate:local   # create the local D1 database
npm run dev                # http://localhost:8787
```

`npm run dev` runs the Worker with a local D1 (stored in `.wrangler/`), so nothing touches the real database.

Rating recomputation processes 100 matches per run by default, intended for the Workers Standard plan. `wrangler.toml` sets `RATING_MATCHES_PER_RUN = "5"` for the free plan, under `[vars]` and `[env.test.vars]`; each deployment has its own variables. See [docs/rating.md](docs/rating.md) for the resource budget. To see what recomputing a region would change without writing anything, run `npm run ratings:dry-run -- --region eu --remote` on your computer ([docs/api.md](docs/api.md), "Debug tools").

| Command | Use |
|---|---|
| `npm run dev` | Run the Worker and website locally |
| `npm run check` | Typecheck, lint and test. What CI runs |
| `npm test` | Tests only: Vitest in the Workers runtime with a local D1, then the Node tests for the browser scripts |
| `npm run db:migrate:local` | Apply migrations to the local D1 |
| `npm run admin:token -- <name>` | Make an admin token, and the SQL file that adds the admin |
| `npm run deploy` | Migrate and deploy production, from `main` after a merge ([deployment.md](docs/deployment.md)) |
| `npm run deploy:test` | Migrate and deploy the test server |
| `npm run upload -- <server> <file>...` | Upload log files by hand, with `GENJIBALL_HOST_TOKEN` set |
| `npm run import:legacy -- <server> <host id> <folder or file>...` | Import old v1.3.2 logs, with `GENJIBALL_ADMIN_TOKEN` set ([legacy.md](docs/legacy.md)) |
| `npm run tune:rating -- <log folder> [--grid]` | Score the rating config on real logs and fit the display scale ([rating.md](docs/rating.md#tuning)) |
| `npm run ratings:dry-run -- --region <id> [--remote]` | Show what recomputing a region's ratings would change, writing nothing ([api.md](docs/api.md), "Debug tools") |
| `npm run rebuild:head-to-head -- <first match id> <last match id>` | Write the SQL that re-derives head-to-head pairs, and print the command to run it ([database.md](docs/database.md)) |

The pages: the leaderboard at `/`, `/player?id=`, `/compare?ids=`, `/match?id=`, `/live` (open lobbies), `/records`, `/tourneys` and `/tourney?id=`. Other paths get the 404 page (`site/html/404.html`). The admin page is at `/admin` ([api.md](docs/api.md), "Admin").

Links to a player, match or compare page get a title and description of their own in Discord, X and the like: for a link preview crawler (`linkPreviewAgents` in `src/config.ts`) the Worker fills them into the page's meta tags (`src/site/preview.ts`, `run_worker_first` in `wrangler.toml`). The Share button on those pages draws a card of the page in the browser (`site/share.ts`), so it costs the server nothing.

## Tourney screenshot storage

Tourney screenshots use the `PROOFS` R2 binding. Before deploying, enable R2 in the Cloudflare dashboard and create the production and test buckets:

```sh
npx wrangler r2 bucket create genjiball-proofs
npx wrangler r2 bucket create genjiball-proofs-test
```

`wrangler.toml` binds each deployment to its own bucket. Local development uses local R2 storage. Screenshot limits and expiry defaults live in `src/config.ts` ([api.md](docs/api.md)).

## Test server

A second deployment for playtests and for trying changes before they reach the real leaderboard: [test.genjiball.us](https://test.genjiball.us). It's the `test` environment in `wrangler.toml`: the same Worker with its own D1 database (`genjiball-ranked-test`), so nothing done there touches the real ratings. Every page shows a "Test server" banner, and it logs at `debug`.

- **Its data never goes to production.** The test database holds playtests, fake results and admin experiments. Never copy, export or restore it into the production database. Production starts empty and gets real matches only from hosts' uploads and from importing the release logs (the v1.3.2 logs, [legacy.md](docs/legacy.md)) into it directly.
- **Deploy:** `npm run deploy:test` applies the migrations to the test database and deploys.
- **Admin token:** `npm run admin:token -- <name>`, then run the printed command with `--env test` added.
- **Host token:** sign in at `/admin` on the test server and add a host. Production tokens don't work there, and the other way round.
- **Upload logs by hand** (until the host tool can point at the test server): `GENJIBALL_HOST_TOKEN=<token> npm run upload -- https://test.genjiball.us Log-*.txt`. Run it in the host's time zone: the start time comes from the file name.

## Layout

| Path | What |
|---|---|
| `src/` | The Worker: API routes, parser, rating engine |
| `src/config.ts` | Every tunable and its default |
| `site/` | The website in TypeScript on `@genji-ball-team/ui`: a module per page in `site/pages/`, built into `public/build/` by `scripts/build-site.mjs` |
| `public/` | The website's HTML pages and static files |
| `migrations/` | D1 schema migrations. Tables and free-tier budget: [docs/database.md](docs/database.md) |
| `docs/` | [deployment.md](docs/deployment.md) (Cloudflare setup, updating, admins, backups, rollback), [api.md](docs/api.md) (the upload, host token check, admin, site and rank tags APIs, CORS and caching of the public API), [rating.md](docs/rating.md), [database.md](docs/database.md), [legacy.md](docs/legacy.md) (old v1.3.2 logs) |
| `scripts/` | Node scripts behind the `npm run` commands above (`upload`, `admin:token`, `import:legacy`, `tune:rating`, `ratings:dry-run`, `rebuild:head-to-head`) |
| `test/` | Vitest tests (`*.test.ts`) and Node tests for the browser scripts (`*.node.mjs`) |

## Contributing

Read [AGENTS.md](AGENTS.md) first (it's written for AI agents, but it's the short version of the rules for everyone). Open an issue or a PR; the templates say what to include.

## License

See [LICENSE.md](LICENSE.md). There is no open-source license yet.
