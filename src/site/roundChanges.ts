import { capChange, displayRating, newRating, rateRound, rateTournament, regionRatingConfig, tournamentStandings, type PlayerRating, type RatingConfig, type Ratings } from "../rating/engine";
import type { MatchDetail } from "./store";

/** Each rated round's change to each player's display rating, and what the match did after its rounds. */
export interface RoundChanges {
  /** By round number, then player id: display points the round moved them (rounded display after minus before). */
  rounds: Map<number, Map<number, number>>;
  /**
   * By player id: display points the match moved them after its last round: the match cap
   * (`ratingMatchMaxChange`), or a tournament's standings bonus and caps. Zero when nothing did.
   */
  after: Map<number, number>;
}

/**
 * Where a match's rating changes came from, round by round (docs/api.md, `/api/matches/:id`). Nothing
 * stores them: this replays the match's rated rounds with the rating engine from each player's
 * rating before the match, as `rateMatch` (src/rating/engine.ts) rated it, and reads the display
 * after every round. Each player's round changes and `after` add up to their whole change.
 *
 * Null when the replay can't be trusted to be what was rated: a match with no rated rounds, or more
 * than `maxRounds` (the CPU it would take), or one whose replay doesn't land on the stored ratings
 * before and after it for every player (ratings being recomputed, or an engine change since).
 */
export function roundChanges(detail: MatchDetail, ratingConfig: RatingConfig, maxRounds: number): RoundChanges | null {
  const { match, players, rounds, roundPlayers, ratingsBefore } = detail;
  const config = regionRatingConfig(ratingConfig, match.region);
  const rated = rounds.filter((r) => r.rated).sort((a, b) => a.number - b.number);
  if (match.void || !rated.length || rated.length > maxRounds) return null;

  // The finishing orders the ratings were made from: rated rounds, by position (`roundsSql`, src/rating/store.ts).
  const playerOf = new Map(players.map((p) => [p.logId, p.playerId]));
  const ranked = new Map<number, { position: number; playerId: number | undefined }[]>();
  for (const rp of roundPlayers) {
    if (rp.position === null) continue;
    const list = ranked.get(rp.roundId) ?? [];
    list.push({ position: rp.position, playerId: playerOf.get(rp.logId) });
    ranked.set(rp.roundId, list);
  }
  const orders: { number: number; order: number[] }[] = [];
  for (const round of rated) {
    const list = (ranked.get(round.id) ?? []).sort((a, b) => a.position - b.position);
    if (!list.length) continue;
    if (list.some((x) => x.playerId === undefined)) return null;
    orders.push({ number: round.number, order: list.map((x) => x.playerId!) });
  }

  // From here as `rateMatch`, reading the display after each round.
  const ratings: Ratings = new Map([...ratingsBefore].map(([id, rating]) => [id, { ...rating }]));
  const scaleAfter = Date.parse(match.playedAt) >= Date.parse(config.displayScaleAfterFrom);
  const started = new Map<number, PlayerRating>();
  for (const { order } of orders) {
    for (const id of order) {
      if (started.has(id)) continue;
      const rating = ratings.get(id);
      if (rating && scaleAfter && rating.scaleBaseMu === null) rating.scaleBaseMu = rating.mu;
      started.set(id, { ...(rating ?? newRating(config, match.playedAt)) });
    }
  }
  const shown = new Map([...started].map(([id, rating]) => [id, displayRating(rating, config)]));

  const byRound = new Map<number, Map<number, number>>();
  const played = new Set<number>();
  const ratedOrders: number[][] = [];
  for (const { number, order } of orders) {
    if (!rateRound(ratings, order, config, match.playedAt)) continue;
    const changes = new Map<number, number>();
    for (const id of order) {
      played.add(id);
      const display = displayRating(ratings.get(id)!, config);
      changes.set(id, display - shown.get(id)!);
      shown.set(id, display);
    }
    byRound.set(number, changes);
    ratedOrders.push(order);
  }
  if (match.tournament) {
    const kills = new Map<number, number>();
    for (const p of players) kills.set(p.playerId, (kills.get(p.playerId) ?? 0) + p.kills);
    rateTournament(ratings, started, tournamentStandings(ratedOrders, kills, config), config);
  } else {
    for (const id of played) capChange(ratings.get(id)!, started.get(id)!, config.ratingMatchMaxChange, config.ratingMatchMaxChange, config);
  }

  // Only what lands exactly on the stored ratings is shown.
  const after = new Map<number, number>();
  for (const p of players) {
    if (after.has(p.playerId)) continue;
    if (played.has(p.playerId) !== (p.ratingAfter !== null)) return null;
    if (p.ratingAfter === null) continue;
    const display = displayRating(ratings.get(p.playerId)!, config);
    if (display !== p.ratingAfter) return null;
    if (p.ratingBefore !== null && displayRating(started.get(p.playerId)!, config) !== p.ratingBefore) return null;
    after.set(p.playerId, display - shown.get(p.playerId)!);
  }
  if (after.size !== played.size) return null;
  return { rounds: byRound, after };
}
