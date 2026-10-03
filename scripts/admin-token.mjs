/* global process, console */
// Makes an admin token: `npm run admin:token -- <name>`. Prints the token (give it to the admin; it
// isn't stored anywhere) and the wrangler command that adds the admin with only its SHA-256.
import { createHash, randomBytes } from "node:crypto";

const name = process.argv.slice(2).join(" ").trim();
if (!name) {
  console.error("Usage: npm run admin:token -- <admin name>");
  process.exit(1);
}

const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const sql = `INSERT INTO admins (name, token_hash) VALUES ('${name.replaceAll("'", "''")}', '${hash}')`;

console.log(`Admin token for ${name} (shown once, keep it secret):\n\n  ${token}\n`);
console.log("Add the admin to the database (--local for npm run dev, --remote for the deployed one):\n");
console.log(`  npx wrangler d1 execute DB --remote --command "${sql.replaceAll('"', '\\"')}"\n`);
console.log(`Revoke it later with: UPDATE admins SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE name = '...'`);
