# Genji Ball Ranked

The ranked server for [Genji Ball: Community Edition](https://github.com/Genji-Ball-Team/GenjiBall-CE): the upload API, the log parser, the rating engine and the website at genjiball.us.

How ranked works end to end:

1. A host runs the **v1.3.3R** version of the game mode. It writes what happens in each match to the Workshop log file ([format](https://github.com/Genji-Ball-Team/GenjiBall-CE/blob/v1.3.3R/docs/ranked-log.md)).
2. The [host tool](https://github.com/Genji-Ball-Team/genjiball-host-tool) watches the log folder and uploads finished matches here.
3. This server parses the log, rates each round and shows the results on the website.

It's one Cloudflare Worker that serves both the API and the website, with a D1 database, so there is one thing to deploy. It fits in the Cloudflare free tier.

- **Discord:** [discord.gg/genjiball](https://discord.gg/genjiball)

## Run it locally

You need Node.js 22 or newer.

```sh
npm ci
npm run db:migrate:local   # create the local D1 database
npm run dev                # http://localhost:8787
```

`npm run dev` runs the Worker with a local D1 (stored in `.wrangler/`), so nothing touches the real database.

| Command | Use |
|---|---|
| `npm run dev` | Run the Worker and website locally |
| `npm run check` | Typecheck, lint and test. What CI runs |
| `npm test` | Tests only (in the Workers runtime, with a local D1) |
| `npm run db:migrate:local` | Apply migrations to the local D1 |
| `npm run admin:token -- <name>` | Make an admin token, and the SQL file that adds the admin |

The admin page is at `/admin` ([api.md](docs/api.md), "Admin").

## Layout

| Path | What |
|---|---|
| `src/` | The Worker: API routes, parser, rating engine |
| `src/config.ts` | Every tunable and its default |
| `public/` | The website's static files |
| `migrations/` | D1 schema migrations. Tables and free-tier budget: [docs/database.md](docs/database.md) |
| `docs/` | [api.md](docs/api.md) (the upload and admin APIs), [rating.md](docs/rating.md), [database.md](docs/database.md) |
| `scripts/` | Small Node scripts (`admin:token`) |
| `test/` | Vitest tests |

## Contributing

Read [AGENTS.md](AGENTS.md) first (it's written for AI agents, but it's the short version of the rules for everyone). Open an issue or a PR; the templates say what to include.

## License

See [LICENSE.md](LICENSE.md). There is no open-source license yet.
