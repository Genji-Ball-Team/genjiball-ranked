/* global process, console, fetch, URL */
// Imports old v1.3.2 logs as legacy matches (#13, docs/legacy.md):
// `npm run import:legacy -- <server> <host id> <file or folder>...` with an admin token in
// GENJIBALL_ADMIN_TOKEN. A folder means every .txt file in it (a folder of logs is too many names for
// a Windows command line).
// Files go oldest first, so the ratings are built in the order the matches were played. A file whose
// KILL lines are the start of another file's is a shorter copy of that match and is left out (legacy
// logs have no matchKey to tell copies apart). X-Log-Started-At comes from the file name, read in
// this computer's time zone, so run it in the host's.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const [server, hostId, ...args] = process.argv.slice(2);
const files = args.flatMap((arg) =>
  statSync(arg).isDirectory()
    ? readdirSync(arg)
        .filter((name) => name.toLowerCase().endsWith(".txt"))
        .map((name) => join(arg, name))
    : [arg],
);
const token = process.env.GENJIBALL_ADMIN_TOKEN?.trim();
if (!server || !/^\d+$/.test(hostId ?? "") || files.length === 0 || !token) {
  console.error("Usage: GENJIBALL_ADMIN_TOKEN=<admin token> npm run import:legacy -- <server URL> <host id> <log file or folder>...");
  process.exit(1);
}

function startedAt(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(basename(file));
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : statSync(file).mtime;
}

const killLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[\d+:\d{2}:\d{2}\] ?/, "").trim())
    .filter((line) => line.startsWith("KILL|"));

const logs = files
  .map((file) => {
    const text = readFileSync(file);
    return { file, text, started: startedAt(file), kills: killLines(text.toString("utf8")) };
  })
  .sort((a, b) => a.started - b.started);

const isCopy = (log) =>
  logs.some(
    (other) =>
      other !== log &&
      (other.kills.length > log.kills.length || (other.kills.length === log.kills.length && logs.indexOf(other) > logs.indexOf(log))) &&
      log.kills.every((line, i) => other.kills[i] === line),
  );

let failed = 0;
for (const log of logs) {
  const name = basename(log.file);
  if (!log.kills.length) {
    console.log(`${name}: skipped, no KILL lines`);
    continue;
  }
  if (isCopy(log)) {
    console.log(`${name}: skipped, a shorter copy of another file`);
    continue;
  }
  const url = new URL("/api/admin/legacy-import", server);
  url.searchParams.set("host", hostId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Log-File": name,
      "X-Log-Started-At": log.started.toISOString(),
    },
    body: log.text,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    failed++;
    console.log(`${name}: ${res.status} ${body.error ?? ""} ${body.message ?? ""}`);
    continue;
  }
  const m = body.matches?.[0];
  const why = m?.rejection?.code ?? "";
  console.log(`${name}: ${body.result}${m ? ` ${m.action} ${m.status}${why ? ` (${why})` : ""}` : ""}`);
}
process.exit(failed ? 1 : 0);
