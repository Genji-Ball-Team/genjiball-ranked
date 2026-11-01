// How ranked works (ranked.html): the tiers and titles, how a rating moves, what isn't rated and how a
// tourney counts. The numbers come from `/api/rules`, the server's own config.
import "@genji-ball-team/ui/chip.js";
import "@genji-ball-team/ui/stat.js";
import { api } from "../lib/api";
import { count, num, tierChip, title } from "../lib/format";
import { byId, html, type Html } from "../lib/html";
import { loaded, showError } from "../lib/load";
import type { Rules, TitleName } from "../lib/types";
import { start } from "../shell";
import { titleChip } from "../titles";

const stat = (label: string, value: string): Html => html`<gb-stat label="${label}">${value}</gb-stat>`;

function tiers(r: Rules): Html {
  const ladder = [...r.tiers].reverse();
  return html`<section>
    <h2>Tiers</h2>
    <ol class="tier-ladder">
      ${r.titles.map(
        (t) => html`<li>${titleChip(t.label as TitleName)}<span class="muted">${t.max === 1 ? "One" : num(t.max)} per region, won in the 1v1 tourney</span></li>`,
      )}
      ${ladder.map(
        (t) => html`<li>${tierChip(t)}<span class="num">${num(t.threshold)}+</span>${t.siteOnly && html`<span class="muted">No rank tag in game</span>`}</li>`,
      )}
    </ol>
    <p class="note">You get a tier after ${count(r.minRankedRounds, "rated round")}. A title goes with your tier, not in place of it.</p>
  </section>`;
}

/** The start, then each region that starts elsewhere: "914 · NA 1000". */
function newPlayerStart(r: Rules): string {
  const others = Object.entries(r.newPlayerRatingByRegion ?? {}).map(([region, start]) => `${region.toUpperCase()} ${num(start)}`);
  return [num(r.newPlayerRating), ...others].join(" · ");
}

function rating(r: Rules): Html {
  return html`<section>
    <h2>Your rating</h2>
    <div class="rule-stats">
      ${stat("New players start at", newPlayerStart(r))}${stat("Most one match moves you", `±${num(r.matchMaxChange)}`)}${stat(
        "Rated rounds to show on the board",
        num(r.minRankedRounds),
      )}${stat("Inactive after", count(r.inactiveAfterDays, "day"))}
    </div>
    <dl class="rules-list">
      <dt>Every round counts</dt>
      <dd>Each round is ranked by finish: the winner first, then everyone in the order they went out, last out first. Finishing above higher-rated players moves you more.</dd>
      <dt>It moves slowly</dt>
      <dd>One lucky round or one bad night shouldn't move anyone far: each round moves you a little, and no match more than ${num(r.matchMaxChange)}.</dd>
      <dt>The bottom of the scale</dt>
      <dd>Under 1,000 the number eases toward ${num(r.floor)} and never reaches it. Win rounds and it climbs again.</dd>
      <dt>Inactive</dt>
      <dd>No rated round in ${count(r.inactiveAfterDays, "day")}: you stay on the board, marked inactive, without a rank tag in game. Your rating stays where it was.</dd>
    </dl>
  </section>`;
}

function unrated(): Html {
  return html`<section>
    <h2>What isn't rated</h2>
    <dl class="rules-list">
      <dt>Replayed rounds</dt>
      <dd>Everyone died before anyone won.</dd>
      <dt>Stopped rounds</dt>
      <dd>The round ended before anyone won.</dd>
      <dt>Broken rounds</dt>
      <dd>The log shows something that can't happen. The match page says what.</dd>
      <dt>Leaving</dt>
      <dd>A player who leaves isn't rated in that round: their rating doesn't change, and the others are rated without them. Leaving is never punished.</dd>
      <dt>Host AFK</dt>
      <dd>The host isn't rated in rounds they marked themselves AFK in the host tool. Their stats still count.</dd>
      <dt>Small rounds and void matches</dt>
      <dd>A round needs 2 players. A match an admin voids stays listed but doesn't count.</dd>
    </dl>
  </section>`;
}

function tourneys(t: Rules["tournament"]): Html {
  const loss = (band: Rules["tournament"]["maxLoss"][number], i: number) =>
    stat(band.below === null ? `Most lost from ${num(t.maxLoss[i - 1]?.below ?? 0)}` : `Most lost under ${num(band.below)}`, `−${num(band.maxLoss)}`);
  return html`<section>
    <h2>Tourneys</h2>
    <p class="lede">Tourney matches count on the same leaderboard. Their rounds are rated like any match, then the final standings count once more: rounds won and kills.</p>
    <div class="rule-stats">
      ${stat("Most gained", `+${num(t.maxGain)}`)}${stat("Winner's bonus", `+${num(t.winnerBonus)}`)}${t.maxLoss.map(loss)}
    </div>
  </section>`;
}

async function rankedPage(): Promise<void> {
  title("How ranked works");
  const box = byId("rules");
  try {
    const r = await api<Rules>("rules");
    loaded(box, html`${tiers(r)}${rating(r)}${unrated()}${tourneys(r.tournament)}`);
  } catch (error) {
    showError(box, error, "page");
  }
}

start("ranked", rankedPage);
