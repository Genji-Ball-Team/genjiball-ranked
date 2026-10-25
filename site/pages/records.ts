// The records page (records.html): the bests of every accepted match in the region, how much was played
// over the last weeks, and the hosts who hosted the most.
import "@genji-ball-team/ui/bar-chart.js";
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/empty.js";
import "@genji-ball-team/ui/panel.js";
import "@genji-ball-team/ui/stat.js";
import type { Bar, GbBarChart } from "@genji-ball-team/ui/bar-chart.js";
import { api, inRegion, matchLink, playerLink } from "../lib/api";
import { count, date, dateTime, num, rating, title } from "../lib/format";
import { byId, html, render, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import { site } from "../lib/site";
import { start } from "../shell";

/** A record: its value, who set it, and where (a match, and the round in it, when it has them). */
interface RecordEntry {
  value: number;
  player: { id: number; name: string };
  matchId?: number;
  playedAt?: string;
  round?: number;
}

interface ActivityDay {
  date: string;
  matches: number;
  rounds: number;
  players: number;
}

/** `GET /api/records`. */
interface Records {
  region: string;
  /** When the records were last counted; null before the first count. */
  updatedAt: string | null;
  records: Partial<Record<string, RecordEntry>>;
  activity: { days: number; matches: number; rounds: number; players: number; perDay: ActivityDay[] };
  topHosts: { name: string; matches: number }[];
}

/** The date of the match a record was set in, as a link to it. */
const playedOn = (r: RecordEntry): Html | "" =>
  r.matchId && r.playedAt ? html`<a href="${matchLink(r.matchId)}">${date(r.playedAt)}</a>` : "";

// The records, in the order the page shows them: what it is, the value as shown, and where it was set.
const recordList: { key: string; label: string; show: (r: RecordEntry) => string; where: (r: RecordEntry) => Html | string }[] = [
  { key: "highestRating", label: "Highest rating", show: (r) => rating(r.value), where: (r) => html`after the match of ${playedOn(r)}` },
  { key: "winStreak", label: "Longest win streak", show: (r) => num(r.value), where: () => "rated rounds won in a row" },
  { key: "matchWins", label: "Most rounds won in a match", show: (r) => num(r.value), where: playedOn },
  { key: "matchKills", label: "Most kills in a match", show: (r) => num(r.value), where: playedOn },
  { key: "roundDeflects", label: "Most deflects in a round", show: (r) => num(r.value), where: (r) => html`round ${r.round}, ${playedOn(r)}` },
  {
    key: "fastestDeflect",
    label: "Fastest deflect",
    show: (r) => num(Math.round(r.value)),
    where: (r) => html`ball speed in m/s, round ${r.round}, ${playedOn(r)}`,
  },
  { key: "mostWins", label: "Most rounds won", show: (r) => num(r.value), where: () => "rated rounds, all time" },
  { key: "mostRounds", label: "Most rounds played", show: (r) => num(r.value), where: () => "rated rounds, all time" },
];

/** The records that exist, each as a row: the record, its value in gold (earned), and who set it. */
function recordRows(d: Records): Html {
  const set = recordList.filter((r) => d.records[r.key]);
  if (!set.length) {
    return html`<li><gb-empty>${
      d.updatedAt
        ? `No records in ${site.label(site.region)} yet: they come with the first matches.`
        : "The records are being counted. Check back in an hour."
    }</gb-empty></li>`;
  }
  return html`${set.map(({ key, label, show, where }) => {
    const r = d.records[key] as RecordEntry;
    return html`<li><span class="what">${label}</span><b class="value num">${show(r)}</b>
      <span class="who"><a href="${playerLink(r.player.id)}">${r.player.name}</a><small>${where(r)}</small></span></li>`;
  })}`;
}

const day = (iso: string, long = false): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(
    undefined,
    long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" },
  );

/** Rated rounds a day, oldest first, each bar's tooltip with the day's matches and players too. */
function activityBars(perDay: ActivityDay[]): Bar[] {
  return perDay.map((d, i) => ({
    value: d.rounds,
    label: day(d.date, true),
    text: count(d.rounds, "rated round"),
    detail: `${count(d.matches, "match", "matches")} · ${count(d.players, "player")}`,
    axis: i === perDay.length - 1 ? "Today" : day(d.date),
  }));
}

function activity(a: Records["activity"]): void {
  byId("activity-section").hidden = false;
  const stat = (label: string, value: string) => html`<gb-stat label="${label}">${value}</gb-stat>`;
  render(
    byId("activity-figures"),
    html`${stat("Matches", num(a.matches))}${stat("Rated rounds", num(a.rounds))}${stat("Players", num(a.players))}${stat("Over", count(a.days, "day"))}`,
  );
  byId<GbBarChart>("activity").bars = activityBars(a.perDay);
}

function topHosts(hosts: Records["topHosts"]): void {
  byId("hosts-section").hidden = false;
  render(
    byId("hosts"),
    html`${hosts.map(
      (h, i) => html`<li><span class="pos num">${i + 1}</span><b>${h.name}</b><span class="num">${count(h.matches, "match", "matches")}</span></li>`,
    )}`,
  );
}

async function recordsPage(): Promise<void> {
  title(`${site.short(site.region)} records`);
  const box = byId("records");
  try {
    const d = await api<Records>(`records?${inRegion()}`);
    byId("updated").textContent = d.updatedAt ? `Updated ${dateTime(d.updatedAt)}, about every hour.` : "";
    loaded(box, recordRows(d));
    if (d.activity.perDay.length) activity(d.activity);
    if (d.topHosts.length) topHosts(d.topHosts);
  } catch (error) {
    showError(box, error, "records");
  }
}

start("records", recordsPage);
