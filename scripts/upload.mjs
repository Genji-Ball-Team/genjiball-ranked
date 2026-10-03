/* global process, console, fetch, URL */
// Uploads Workshop log files by hand, the way the host tool will: `npm run upload -- <server> <file>...`
// with the host token in GENJIBALL_HOST_TOKEN. For playtests before the host tool exists (#37).
// Files go oldest first, so the copies of one match arrive in order. X-Log-Started-At comes from the
// file name (Log-2026-10-03-20-15-33.txt, read in this computer's time zone, so run it in the
// host's), or the file's modified time when the name has no date.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const [server, ...files] = process.argv.slice(2);
const token = process.env.GENJIBALL_HOST_TOKEN?.trim();
if (!server || files.length === 0 || !token) {
  console.error("Usage: GENJIBALL_HOST_TOKEN=<host token> npm run upload -- <server URL> <log file>...");
  process.exit(1);
}

// The host token goes in a header: never over plain HTTP, except to a server on this computer.
const url = new URL("/api/upload", server);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
  console.error(`Use an https:// server URL (http:// only for localhost), not ${server}`);
  process.exit(1);
}

function startedAt(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(basename(file));
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : statSync(file).mtime;
}

const sorted = files.map((file) => ({ file, started: startedAt(file) })).sort((a, b) => a.started - b.started);
let failed = 0;
for (const { file, started } of sorted) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      // A redirect would send the log on to somewhere else: count it as a failure instead.
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8",
        "X-Log-File": basename(file),
        "X-Log-Started-At": started.toISOString(),
      },
      body: readFileSync(file),
    });
  } catch (error) {
    failed++;
    console.log(`${basename(file)}: ${error.message}`);
    continue;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    failed++;
    console.log(`${basename(file)}: ${res.status} ${body.error ?? ""} ${body.message ?? ""}`);
    continue;
  }
  const matches = (body.matches ?? []).map((m) => {
    const why = m.rejection?.code ?? (m.reviewReasons?.length ? m.reviewReasons.join(",") : "");
    return `${m.matchKey} ${m.action} ${m.status}${why ? ` (${why})` : ""}`;
  });
  console.log(`${basename(file)}: ${body.result}${matches.length ? `\n  ${matches.join("\n  ")}` : ""}`);
}
process.exit(failed ? 1 : 0);
