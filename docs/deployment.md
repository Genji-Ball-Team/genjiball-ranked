# Deployment

How to run the ranked server on Cloudflare. Written for someone who hasn't used Cloudflare. Everything fits in the free tier.

Run every command from the `genjiball-ranked` folder. `npx wrangler` is Cloudflare's command line tool; `npm ci` installs it.

## What runs where

| | Production | Test server |
|---|---|---|
| Site | genjiball.us | test.genjiball.us |
| Worker | `genjiball-ranked` | `genjiball-ranked-test` |
| D1 database | `genjiball-ranked` | `genjiball-ranked-test` |
| R2 bucket (tourney screenshots) | `genjiball-proofs` | `genjiball-proofs-test` |
| Cron | every 10 minutes | every 10 minutes |
| Deploy | `npm run deploy` | `npm run deploy:test` |

- One Cloudflare account, the Genji Ball one (the genjiball.us zone). `account_id` in `wrangler.toml` pins it, so a deploy can't go to another account.
- The test server is `[env.test]` in `wrangler.toml`. The two share no data.
- Settings are `[vars]` in `wrangler.toml`; they override the defaults in `src/config.ts`. No wrangler secrets are used today. If one is ever needed: `npx wrangler secret put NAME` (add `--env test` for the test server). Never put a secret in `wrangler.toml`.

## First-time setup

Only needed to build the setup from nothing (a new account, or a new test server). The current one is already set up.

1. **Account.** Sign up at dash.cloudflare.com. Add the domain (genjiball.us) so Cloudflare runs its DNS. Copy the account id from the dashboard into `account_id` in `wrangler.toml`.
2. **Log in.** `npm ci`, then `npx wrangler login` (opens a browser). Check `npx wrangler whoami` lists the Genji Ball account. **If it shows another account, stop and log out (`npx wrangler logout`).** Never deploy to a personal account.
3. **D1 database.** `npx wrangler d1 create genjiball-ranked`. Put the printed `database_id` in `wrangler.toml` under `[[d1_databases]]`. Same for the test server: `genjiball-ranked-test` under `[[env.test.d1_databases]]`.
4. **R2 buckets.** Enable R2 in the dashboard (R2 Object Storage; it asks for a payment method, the free tier still applies). Then `npx wrangler r2 bucket create genjiball-proofs` and `... genjiball-proofs-test`.
5. **First deploy.** `npm run deploy`. It applies the migrations to the remote D1 (`migrations/`), then deploys the Worker, its cron and the website files in `public/`.
6. **Domain.** `routes` in `wrangler.toml` has `custom_domain = true`, so the deploy creates the DNS record and the certificate for genjiball.us itself. Don't add a DNS record by hand. The first time can take a few minutes. Open https://genjiball.us to check.
7. **Admin and hosts.** See "Admins and host tokens" below.
8. **Data.** Production starts empty. Import the old v1.3.2 logs once ([legacy.md](legacy.md)): they are in the workspace's `logs/` folder, and go into EU with `npm run import:legacy`. Never copy data from the test server.

## Updating

1. Merge the PR into `main`.
2. `git pull`, then `npm ci` (the dependencies may have changed).
3. `npm run check`. It must pass.
4. Try it on the test server first: `npm run deploy:test`, then click through https://test.genjiball.us.
5. `npm run deploy`.

Both deploy commands apply new migrations before the code goes out. A migration can't be undone by a rollback of the Worker (see "Rollback"). Never edit a migration that was merged; add a new one.

## The test server

For playtests and for trying changes. Its data never goes into production: don't copy, export or restore it into the production database. Admin tokens and host tokens are separate per server.

- Deploy: `npm run deploy:test`.
- Every `wrangler` command that touches its database or Worker needs `--env test`.
- More in the README, "Test server".

## Admins and host tokens

An **admin** signs in at `/admin` and manages hosts and matches. A **host** is whoever runs lobbies; the host tool uploads with the host's token.

Make an admin (the first one has to be made this way, later ones too):

1. `npm run admin:token -- <name>`. It prints the token **once** (give it to the admin; it isn't stored anywhere) and writes a SQL file to your temp folder.
2. Run the command it prints: `npx wrangler d1 execute DB --remote --file <file>`. Add `--env test` for the test server.
3. Delete the file.

To revoke an admin, see the last line the script prints.

Make a host: sign in at `/admin` with an admin token, add the host (name, trust, home region). The host token is shown **once**; send it to the host privately. The same is `POST /api/admin/hosts` ([api.md](api.md), "Admin"). A host token that leaks is revoked there, and the host gets a new one.

## Backups and restore

There are two ways. Both work on production (`--remote` is for the deployed database; without it wrangler uses the local one).

**Time Travel** keeps the database's history, so you can go back to any minute in the window. Free plans get a shorter window than paid ones; see Cloudflare's D1 Time Travel docs for the current number.

```sh
npx wrangler d1 time-travel info DB                        # the current bookmark
npx wrangler d1 time-travel restore DB --timestamp=<time>  # or --bookmark=<id>
```

A restore replaces the whole database in place. Note the bookmark `info` prints before you restore: that is how you undo the restore.

**Export** makes a file you keep:

```sh
npx wrangler d1 export DB --remote --output backup.sql
```

Do it before a risky change, and now and then, since Time Travel's window is short. Keep the file private: it has the hashes of the tokens. To restore from it, create an empty database and load the file with `d1 execute --file`.

Raw logs are kept for every match, so ratings and stats can be rebuilt from them ([database.md](database.md)).

## Rollback

A bad deploy:

```sh
npx wrangler rollback
```

It puts the previous version of the Worker back (pick one from the list it shows). Add `--env test` for the test server.

- It only changes the code. A migration that already ran stays. Keep migrations compatible with the previous code, or restore the database from Time Travel.
- Rolling back is a quick fix; then fix the bug in a PR and deploy again.
