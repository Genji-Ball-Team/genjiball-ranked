import { rate } from "openskill";
import { describe, expect, it } from "vitest";
import { defaults } from "../src/config";
import {
  displayRating,
  newRating,
  rateMatch,
  rateRound,
  recompute,
  tierFor,
  tournamentMaxLoss,
  tournamentStandings,
  tournamentWinValue,
  type RatingMatch,
  type Ratings,
} from "../src/rating/engine";

// Most tests start from new players, so they rate from the first round; `ratingUnratedRounds` has its own tests.
const config = { ...defaults, ratingUnratedRounds: 0 };

function match(id: number, rounds: number[][], playedAt = `2026-10-${String(id).padStart(2, "0")}T20:00:00Z`): RatingMatch {
  return { id, playedAt, rounds };
}

/** A small deterministic generator, so the long tests are the same every run. */
function random(seed: number): () => number {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function shuffle(ids: readonly number[], next: () => number): number[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("rateRound", () => {
  it("raises the winner, lowers the last and keeps the order of the ratings", () => {
    const ratings: Ratings = new Map();
    expect(rateRound(ratings, [1, 2, 3, 4], config)).toBe(true);
    const mu = [1, 2, 3, 4].map((id) => ratings.get(id)!.mu);
    expect(mu[0]).toBeGreaterThan(config.ratingMu);
    expect(mu[3]).toBeLessThan(config.ratingMu);
    expect(mu).toEqual([...mu].sort((a, b) => b - a));
  });

  it("counts rounds and wins", () => {
    const ratings: Ratings = new Map();
    rateRound(ratings, [1, 2], config);
    rateRound(ratings, [2, 1], config);
    rateRound(ratings, [1, 2], config);
    expect(ratings.get(1)).toMatchObject({ rounds: 3, wins: 2 });
    expect(ratings.get(2)).toMatchObject({ rounds: 3, wins: 1 });
  });

  it("counts win streaks: a round finished in another place ends one, a round left out doesn't", () => {
    const ratings: Ratings = new Map();
    rateRound(ratings, [1, 2, 3], config);
    rateRound(ratings, [1, 3, 2], config);
    rateRound(ratings, [2, 3], config); // 1 left this round: their streak goes on
    rateRound(ratings, [1, 2, 3], config);
    expect(ratings.get(1)).toMatchObject({ streak: 3, bestStreak: 3 });
    rateRound(ratings, [3, 1, 2], config);
    expect(ratings.get(1)).toMatchObject({ streak: 0, bestStreak: 3 });
    expect(ratings.get(2)).toMatchObject({ streak: 0, bestStreak: 1 });
    expect(ratings.get(3)).toMatchObject({ streak: 1, bestStreak: 1 });
  });

  it("carries a win streak from one match to the next, in play order", () => {
    const { ratings } = recompute([match(2, [[1, 2], [1, 2]]), match(1, [[2, 1], [1, 2]])], config);
    expect(ratings.get(1)).toMatchObject({ streak: 3, bestStreak: 3 });
    expect(ratings.get(2)).toMatchObject({ streak: 0, bestStreak: 1 });
  });

  it("with no damping, is exactly an OpenSkill game", () => {
    const undamped = { ...config, ratingRoundsPerMatch: 1, ratingTau: 0 };
    const ratings: Ratings = new Map();
    rateRound(ratings, [3, 1, 2], undamped);
    const fresh = { mu: config.ratingMu, sigma: config.ratingSigma };
    const [[a], [b], [c]] = rate([[fresh], [fresh], [fresh]], {
      mu: config.ratingMu,
      sigma: config.ratingSigma,
      beta: config.ratingBeta,
      tau: 0,
    }) as [[{ mu: number }], [{ mu: number }], [{ mu: number }]];
    expect(ratings.get(3)!.mu).toBeCloseTo(a.mu, 10);
    expect(ratings.get(1)!.mu).toBeCloseTo(b.mu, 10);
    expect(ratings.get(2)!.mu).toBeCloseTo(c.mu, 10);
  });

  it("damps a round's mu move to 1/N of a full game, and gives sigma the full update", () => {
    const n = 8;
    const full: Ratings = new Map();
    const damped: Ratings = new Map();
    rateRound(full, [1, 2, 3], { ...config, ratingRoundsPerMatch: 1, ratingTau: 0 });
    rateRound(damped, [1, 2, 3], { ...config, ratingRoundsPerMatch: n, ratingTau: 0 });
    for (const id of [1, 2, 3]) {
      const fullMove = full.get(id)!.mu - config.ratingMu;
      expect(damped.get(id)!.mu - config.ratingMu).toBeCloseTo(fullMove / n, 10);
      expect(damped.get(id)!.sigma).toBeCloseTo(full.get(id)!.sigma, 10);
    }
  });

  it("settles: a regular's sigma keeps shrinking, so beating far weaker players earns little", () => {
    // The strong player wins every round against two weak ones. With sigma damped too, sigma stayed
    // near 6 and every win kept paying (test.genjiball.us match 198).
    const ratings: Ratings = new Map([
      [1, { ...newRating(config), mu: 40 }],
      [2, { ...newRating(config), mu: 15 }],
      [3, { ...newRating(config), mu: 15 }],
    ]);
    for (let i = 0; i < 300; i++) rateRound(ratings, i % 2 ? [1, 2, 3] : [1, 3, 2], config);
    expect(ratings.get(1)!.sigma).toBeLessThan(config.ratingSigma / 2);
    const mu = ratings.get(1)!.mu;
    rateRound(ratings, [1, 2, 3], config);
    expect(displayRating(ratings.get(1)!, config) - displayRating({ mu, sigma: 0 }, config)).toBeLessThanOrEqual(2);
  });

  it("doesn't rate a round with fewer than two players or a player listed twice", () => {
    const ratings: Ratings = new Map();
    expect(rateRound(ratings, [], config)).toBe(false);
    expect(rateRound(ratings, [1], config)).toBe(false);
    expect(rateRound(ratings, [1, 2, 1], config)).toBe(false);
    expect(ratings.size).toBe(0);
  });

  it("leaves a player who left the round alone, and rates the others as if they weren't there", () => {
    // Player 9 left round 2: the parser drops them from its finishing order.
    const withLeaver: Ratings = new Map();
    rateRound(withLeaver, [9, 1, 2, 3], config);
    const leaverAfterRound1 = { ...withLeaver.get(9)! };
    rateRound(withLeaver, [2, 3, 1], config);
    expect(withLeaver.get(9)).toEqual(leaverAfterRound1);

    const others: Ratings = new Map();
    rateRound(others, [9, 1, 2, 3], config);
    others.delete(9);
    rateRound(others, [2, 3, 1], config);
    for (const id of [1, 2, 3]) expect(withLeaver.get(id)).toEqual(others.get(id));
  });
});

describe("stability", () => {
  it("doesn't let one round swing an established player", () => {
    const ratings: Ratings = new Map();
    const next = random(7);
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let round = 0; round < 500; round++) {
      rateRound(ratings, shuffle(ids, next), config);
    }
    const before = displayRating(ratings.get(1)!, config);
    rateRound(ratings, [2, 3, 4, 5, 6, 7, 8, 1], config);
    const afterLoss = displayRating(ratings.get(1)!, config);
    expect(before - afterLoss).toBeGreaterThan(0);
    // Under 10% of the gap between two tiers.
    expect(before - afterLoss).toBeLessThan(30);
  });

  it("keeps players of the same skill near the start over many rounds", () => {
    const ratings: Ratings = new Map();
    const next = random(42);
    const ids = [1, 2, 3, 4, 5, 6];
    for (let round = 0; round < 3000; round++) {
      rateRound(ratings, shuffle(ids, next), config);
    }
    for (const id of ids) expect(Math.abs(ratings.get(id)!.mu - config.ratingMu)).toBeLessThan(3);
  });

  it("ranks a better player above a worse one after enough rounds", () => {
    const ratings: Ratings = new Map();
    const next = random(3);
    // Each round, a player finishes by skill plus a lot of luck: player 1 is a bit better than 2, 2 than 3.
    const skill = new Map([[1, 0.3], [2, 0], [3, -0.3]]);
    for (let round = 0; round < 1000; round++) {
      const performance = new Map([1, 2, 3].map((id) => [id, skill.get(id)! + next()]));
      rateRound(ratings, [1, 2, 3].sort((a, b) => performance.get(b)! - performance.get(a)!), config);
    }
    expect(ratings.get(1)!.mu).toBeGreaterThan(ratings.get(2)!.mu);
    expect(ratings.get(2)!.mu).toBeGreaterThan(ratings.get(3)!.mu);
  });
});

describe("rateMatch", () => {
  it("rates the rounds in order and returns each player's rating after the match", () => {
    const ratings: Ratings = new Map();
    const history = rateMatch(ratings, match(1, [[1, 2, 3], [2, 1, 3], [3]]), config);
    expect(history.map((entry) => entry.playerId).sort()).toEqual([1, 2, 3]);
    for (const entry of history) {
      const rating = ratings.get(entry.playerId)!;
      expect(entry).toEqual({
        playerId: entry.playerId,
        matchId: 1,
        playedAt: "2026-10-01T20:00:00Z",
        mu: rating.mu,
        sigma: rating.sigma,
        display: displayRating(rating, config),
        rounds: rating.rounds,
        wins: rating.wins,
        streak: rating.streak,
        bestStreak: rating.bestStreak,
      });
      expect(rating.lastPlayedAt).toBe("2026-10-01T20:00:00Z");
    }
    expect(ratings.get(3)!.rounds).toBe(2);
  });

  it("gives no history to a player with no rated round", () => {
    const ratings: Ratings = new Map();
    expect(rateMatch(ratings, match(1, [[5]]), config)).toEqual([]);
    expect(rateMatch(ratings, match(2, []), config)).toEqual([]);
    expect(ratings.size).toBe(0);
  });
});

describe("recompute", () => {
  const matches = [
    match(1, [[1, 2, 3, 4], [2, 1, 4, 3]]),
    match(2, [[3, 4, 1], [4, 3, 1]]),
    match(3, [[1, 3, 2, 5], [5, 1, 3, 2]]),
    match(4, [[2, 5, 4]]),
  ];

  it("gives the same ratings for the same matches, in any order", () => {
    const first = recompute(matches, config);
    const shuffled = recompute([matches[2]!, matches[0]!, matches[3]!, matches[1]!], config);
    expect(shuffled).toEqual(first);
    expect(recompute(matches, config)).toEqual(first);
  });

  it("is the same as rating each match as it arrives", () => {
    const ratings: Ratings = new Map();
    const history = matches.flatMap((m) => rateMatch(ratings, m, config));
    expect(recompute(matches, config)).toEqual({ ratings, history });
  });

  it("orders by playedAt, then id", () => {
    const early = match(9, [[1, 2]], "2026-09-01T00:00:00Z");
    const late = match(1, [[2, 1]], "2026-11-01T00:00:00Z");
    expect(recompute([late, early], config).history.map((entry) => entry.matchId)).toEqual([9, 9, 1, 1]);
    const tieA = match(5, [[1, 2]], "2026-10-10T00:00:00Z");
    const tieB = match(4, [[2, 1]], "2026-10-10T00:00:00Z");
    expect(recompute([tieA, tieB], config).history.map((entry) => entry.matchId)).toEqual([4, 4, 5, 5]);
  });

  it("after a void, is as if the match was never played", () => {
    const all = recompute(matches, config);
    const voided = recompute(matches.filter((m) => m.id !== 2), config);
    expect(voided).toEqual(recompute([matches[0]!, matches[2]!, matches[3]!], config));
    expect(voided.ratings.get(4)).not.toEqual(all.ratings.get(4));
    expect(voided.history.some((entry) => entry.matchId === 2)).toBe(false);
  });

  it("rates legacy matches like any other, in play order", () => {
    // A legacy (v1.3.2) match rebuilt by #4 comes before the new ones.
    const legacy = match(100, [[4, 3, 2, 1]], "2025-01-01T00:00:00Z");
    const withLegacy = recompute([...matches, legacy], config);
    expect(withLegacy.history[0]).toMatchObject({ matchId: 100 });
    expect(withLegacy.ratings.get(4)!.rounds).toBe(recompute(matches, config).ratings.get(4)!.rounds + 1);
  });
});

describe("displayRating", () => {
  it("is displayCenter for a new player and displayScale per point of mu above it", () => {
    expect(displayRating({ mu: config.ratingMu, sigma: config.ratingSigma }, config)).toBe(config.displayCenter);
    expect(displayRating({ mu: config.ratingMu + 2, sigma: 0 }, config)).toBe(config.displayCenter + 2 * config.displayScale);
  });

  it("uses the conservative rating mu − z·sigma when displayZ is set, rounded", () => {
    const withZ = { ...config, displayZ: 3 };
    expect(displayRating({ mu: 40, sigma: 2.01 }, withZ)).toBe(
      Math.round(withZ.displayCenter + withZ.displayScale * (40 - withZ.displayZ * 2.01 - withZ.ratingMu)),
    );
  });

  it("follows mu alone with the default displayZ of 0, so a shrinking sigma doesn't lift anyone", () => {
    expect(config.displayZ).toBe(0);
    expect(displayRating({ mu: 30, sigma: 8 }, config)).toBe(displayRating({ mu: 30, sigma: 2 }, config));
  });

  it("eases toward displayFloor below the center instead of falling in a straight line", () => {
    const at = (mu: number) => displayRating({ mu, sigma: 0 }, config);
    const room = config.displayCenter - config.displayFloor;
    // Just below the center it falls as fast as it rises above it...
    expect(config.displayCenter - at(config.ratingMu - 0.1)).toBeCloseTo(0.1 * config.displayScale, -1);
    // ...but it flattens out: further down, a whole point of mu costs a small fraction of that.
    expect(at(config.ratingMu - 4) - at(config.ratingMu - 5)).toBeLessThan(config.displayScale / 5);
    expect(at(config.ratingMu - 3)).toBeGreaterThan(config.displayFloor);
    expect(at(config.ratingMu - 3)).toBeLessThan(config.displayFloor + room / 2);
  });

  it("only goes up as mu goes up, and never below displayFloor", () => {
    let last = -Infinity;
    for (let mu = -20; mu <= 60; mu += 0.5) {
      const shown = displayRating({ mu, sigma: 0 }, config);
      expect(shown).toBeGreaterThanOrEqual(last);
      expect(shown).toBeGreaterThanOrEqual(config.displayFloor);
      last = shown;
    }
    expect(displayRating({ mu: -1000, sigma: config.ratingSigma }, config)).toBe(config.displayFloor);
  });
});

describe("tierFor", () => {
  const tiers = config.tiers;

  it("has six tiers, lowest first, each higher than the last", () => {
    expect(tiers.map((t) => [t.label, t.threshold])).toEqual([
      ["Apprentice", 1300],
      ["Master", 1600],
      ["Grandmaster", 1900],
      ["Ascendant", 2200],
      ["Champion", 2500],
      ["God", 2800],
    ]);
  });

  it("is null below the first tier", () => {
    expect(tierFor(tiers[0]!.threshold - 1, tiers)).toBeNull();
    expect(tierFor(config.displayCenter, tiers)).toBeNull();
  });

  it("is the highest tier reached, from its threshold on", () => {
    expect(tierFor(tiers[0]!.threshold, tiers)?.label).toBe("Apprentice");
    expect(tierFor(tiers[1]!.threshold - 1, tiers)?.label).toBe("Apprentice");
    expect(tierFor(tiers[1]!.threshold, tiers)?.label).toBe("Master");
    expect(tierFor(99999, tiers)?.label).toBe("God");
  });
});

describe("the per-match cap", () => {
  const rounds = Array.from({ length: 40 }, () => [1, 2, 3, 4]);

  it("holds everyone to ratingMatchMaxChange either way in a normal match", () => {
    const capped = { ...config, ratingMatchMaxChange: 50 };
    const ratings: Ratings = new Map([1, 2, 3, 4].map((id) => [id, { ...newRating(capped), mu: 40 }]));
    const start = displayRating(ratings.get(1)!, capped);
    rateMatch(ratings, match(1, rounds), capped);
    const moved = (id: number) => displayRating(ratings.get(id)!, capped) - start;
    expect(moved(1)).toBeGreaterThanOrEqual(capped.ratingMatchMaxChange - 1);
    expect(moved(1)).toBeLessThanOrEqual(capped.ratingMatchMaxChange);
    expect(moved(4)).toBeLessThanOrEqual(-capped.ratingMatchMaxChange + 1);
    expect(moved(4)).toBeGreaterThanOrEqual(-capped.ratingMatchMaxChange);
  });

  it("leaves a change within the cap alone", () => {
    const uncapped: Ratings = new Map();
    const capped: Ratings = new Map();
    rateMatch(uncapped, match(1, [[1, 2, 3, 4]]), { ...config, ratingMatchMaxChange: Infinity });
    rateMatch(capped, match(1, [[1, 2, 3, 4]]), config);
    expect(capped.get(1)!.mu).toBe(uncapped.get(1)!.mu);
  });
});

describe("tournaments", () => {
  const tourney = (rounds: number[][], kills: Record<number, number> = {}): RatingMatch => ({
    ...match(1, rounds),
    tournament: true,
    kills: new Map(Object.entries(kills).map(([id, n]) => [Number(id), n])),
  });
  const at = (display: number, sigma = 2.5) => ({ ...newRating(config), mu: config.ratingMu + (display - config.displayCenter) / config.displayScale, sigma });
  const change = (ratings: Ratings, id: number, from: number) => displayRating(ratings.get(id)!, config) - from;

  it("worth more per win in a bigger lobby", () => {
    expect([4, 5, 6, 7, 8, 10, 12].map((n) => tournamentWinValue(n, config))).toEqual([5, 7, 9, 11, 14, 19, 25]);
  });

  it("rank the standings by wins × win value + kills, a leaver keeping what they had", () => {
    // 3 plays the first two rounds only and wins both; 4 players at the start, so a win is worth 5.
    const rounds = [[3, 1, 2, 4], [3, 2, 1, 4], [1, 2, 4], [2, 1, 4], [1, 4, 2]];
    const standings = tournamentStandings(rounds, new Map([[1, 2], [2, 9], [3, 1]]), config);
    expect(standings).toEqual([
      { playerId: 2, wins: 1, kills: 9, score: 14 },
      { playerId: 1, wins: 2, kills: 2, score: 12 },
      { playerId: 3, wins: 2, kills: 1, score: 11 },
      { playerId: 4, wins: 0, kills: 0, score: 0 },
    ]);
  });

  it("rate the rounds like a ranked lobby's, then the standings on top", () => {
    const rounds = Array.from({ length: 6 }, (_, i) => (i % 2 ? [2, 1, 3, 4] : [1, 2, 3, 4]));
    const ranked: Ratings = new Map([1, 2, 3, 4].map((id) => [id, at(1500)]));
    const tourneyRatings: Ratings = new Map([1, 2, 3, 4].map((id) => [id, at(1500)]));
    rateMatch(ranked, match(1, rounds), config);
    rateMatch(tourneyRatings, tourney(rounds, { 2: 1 }), { ...config, tournamentWinnerBonus: 0 });
    // Same rounds, so same streaks and counts; 2 tops the standings on a kill and gains more.
    for (const id of [1, 2, 3, 4]) {
      expect(tourneyRatings.get(id)!.rounds).toBe(ranked.get(id)!.rounds);
      expect(tourneyRatings.get(id)!.wins).toBe(ranked.get(id)!.wins);
      expect(tourneyRatings.get(id)!.streak).toBe(ranked.get(id)!.streak);
    }
    expect(tourneyRatings.get(2)!.mu).toBeGreaterThan(ranked.get(2)!.mu);
    expect(tourneyRatings.get(4)!.mu).toBeLessThan(ranked.get(4)!.mu);
  });

  it("doubles the standings game with tournamentBonusWeight 2", () => {
    const rounds = [[1, 2, 3, 4]];
    const once: Ratings = new Map([1, 2, 3, 4].map((id) => [id, at(1500)]));
    const twice: Ratings = new Map([1, 2, 3, 4].map((id) => [id, at(1500)]));
    const plain = { ...config, tournamentWinnerBonus: 0, tournamentMaxGain: Infinity, tournamentMaxLoss: Infinity, tournamentMaxLossBands: [] };
    rateMatch(once, tourney(rounds), { ...plain, tournamentBonusWeight: 1 });
    rateMatch(twice, tourney(rounds), { ...plain, tournamentBonusWeight: 2 });
    const roundsOnly: Ratings = new Map([1, 2, 3, 4].map((id) => [id, at(1500)]));
    rateRound(roundsOnly, rounds[0]!, config);
    for (const id of [1, 2, 3, 4]) {
      const base = roundsOnly.get(id)!.mu;
      expect(twice.get(id)!.mu - base).toBeCloseTo(2 * (once.get(id)!.mu - base), 9);
    }
  });

  it("caps losses by the rating before: 50 under 1300, 75 under 1600, 100 from 1600", () => {
    expect([900, 1299, 1300, 1599, 1600, 1900, 2500].map((d) => tournamentMaxLoss(d, config))).toEqual([50, 50, 75, 75, 100, 100, 100]);
    // Everyone far stronger than 1 and finishing last in every round loses past their cap.
    const rounds = Array.from({ length: 30 }, () => [1, 2, 3, 4]);
    for (const [start, cap] of [[1250, 50], [1500, 75], [2000, 100]] as const) {
      const ratings: Ratings = new Map([[1, at(start - 600, 6)], [2, at(start)], [3, at(start)], [4, at(start)]]);
      rateMatch(ratings, tourney(rounds), config);
      expect(change(ratings, 4, start)).toBeGreaterThanOrEqual(-cap);
      expect(change(ratings, 4, start)).toBeLessThanOrEqual(-cap + 1);
    }
  });

  it("caps gains at 250, then adds the winner's 50", () => {
    const rounds = Array.from({ length: 30 }, () => [1, 2, 3, 4]);
    const ratings: Ratings = new Map([[1, at(1100, 6)], [2, at(2200)], [3, at(2200)], [4, at(2200)]]);
    rateMatch(ratings, tourney(rounds), config);
    expect(change(ratings, 1, 1100)).toBeGreaterThanOrEqual(config.tournamentMaxGain + config.tournamentWinnerBonus - 1);
    expect(change(ratings, 1, 1100)).toBeLessThanOrEqual(config.tournamentMaxGain + config.tournamentWinnerBonus);
  });

  it("gives the winner's bonus to everyone tied first, below the center too", () => {
    const ratings: Ratings = new Map([1, 2, 3].map((id) => [id, at(950)]));
    const without: Ratings = new Map([1, 2, 3].map((id) => [id, at(950)]));
    const rounds = [[1, 2, 3], [2, 1, 3]];
    rateMatch(ratings, tourney(rounds), config);
    rateMatch(without, tourney(rounds), { ...config, tournamentWinnerBonus: 0 });
    for (const id of [1, 2]) {
      const gained = displayRating(ratings.get(id)!, config) - displayRating(without.get(id)!, config);
      expect(Math.abs(gained - config.tournamentWinnerBonus)).toBeLessThanOrEqual(1);
    }
    expect(ratings.get(3)!.mu).toBe(without.get(3)!.mu);
  });

  it("ignores kills and its own caps in a normal match", () => {
    const rounds = [[1, 2, 3, 4]];
    const plain: Ratings = new Map();
    const withKills: Ratings = new Map();
    rateMatch(plain, match(1, rounds), config);
    rateMatch(withKills, { ...match(1, rounds), kills: new Map([[4, 50]]) }, config);
    expect(withKills).toEqual(plain);
  });

  it("rates tourney #1 (EU match 459) as agreed", () => {
    // Real ratings before it and its 30 rated rounds (finishing orders), with kills.
    const before: [number, number, number, number][] = [
      // id, mu, sigma, kills
      [465, 43.082221467403215, 2.3561593185520424, 34],
      [596, 34.884177775437919, 2.4559969598797218, 39],
      [660, 34.746472578390808, 2.4861541777210099, 27],
      [321, 29.451501077787363, 3.3182551755596048, 24],
      [1738, 33.055851950584518, 4.3016948587237067, 28],
      [429, 34.40728612494452, 2.3469116499676486, 15],
      [32, 27.54281270534727, 2.4486893799249367, 13],
    ];
    const placings = [
      "465 321 1738 429 660 596 32", "660 321 1738 596 32 429 465", "465 596 429 321 1738 660 32",
      "465 321 1738 660 596 429 32", "596 660 321 465 429 1738 32", "1738 596 321 660 465 32 429",
      "596 429 660 465 321 32 1738", "596 660 32 1738 321 429 465", "465 660 1738 32 321 429 596",
      "1738 465 660 596 321 429 32", "465 429 596 32 321 1738 660", "596 660 1738 465 429 32 321",
      "465 660 429 321 1738 596 32", "465 1738 596 429 32 660 321", "660 1738 32 429 465 321 596",
      "465 660 596 32 429 321 1738", "321 465 660 1738 429 596 32", "465 596 321 32 660 1738 429",
      "660 465 429 1738 32 596 321", "32 596 1738 321 465 429 660", "660 596 465 32 321 429 1738",
      "596 660 321 32 429 1738 465", "429 1738 596 465 660 321 32", "596 429 32 660 321 465 1738",
      "321 596 32 1738 429 465 660", "465 321 596 429 32 660 1738", "1738 429 32 596 660 321 465",
      "321 1738 429 660 32 596 465", "321 465 429 660 32 596 1738", "596 321 429 1738 32 465 660",
    ].map((round) => round.split(" ").map(Number));
    const ratings: Ratings = new Map(before.map(([id, mu, sigma]) => [id, { ...newRating(config), mu, sigma }]));
    const starts = new Map(before.map(([id]) => [id, displayRating(ratings.get(id)!, config)]));
    const kills = Object.fromEntries(before.map(([id, , , k]) => [id, k]));
    rateMatch(ratings, tourney(placings, kills), config);
    expect(before.map(([id]) => change(ratings, id, starts.get(id)!))).toEqual([7, 75, 36, 132, -38, -56, -50]);
  });
});

describe("ratingUnratedRounds", () => {
  const unrated = { ...defaults, ratingUnratedRounds: 3 };

  it("rates nobody for a player's first rounds, but counts them", () => {
    const ratings: Ratings = new Map();
    // 1 and 2 are past their first rounds; 3 is new.
    for (const id of [1, 2]) ratings.set(id, { ...newRating(unrated), rounds: 3 });
    rateMatch(ratings, match(1, [[3, 1, 2], [3, 2, 1], [3, 1, 2]]), unrated);
    const alone: Ratings = new Map();
    for (const id of [1, 2]) alone.set(id, { ...newRating(unrated), rounds: 3 });
    rateMatch(alone, match(1, [[1, 2], [2, 1], [1, 2]]), unrated);
    expect(ratings.get(3)).toMatchObject({ mu: unrated.ratingMu, sigma: unrated.ratingSigma, rounds: 3, wins: 3, streak: 3 });
    expect(ratings.get(1)!.mu).toBeCloseTo(alone.get(1)!.mu, 12);
    expect(ratings.get(2)!.mu).toBeCloseTo(alone.get(2)!.mu, 12);
    // The new player won every round, so nobody else won one.
    expect(ratings.get(1)!.wins).toBe(0);
    expect(ratings.get(2)!.wins).toBe(0);
  });

  it("rates a player from their fourth round", () => {
    const ratings: Ratings = new Map();
    rateMatch(ratings, match(1, [[1, 2], [1, 2], [1, 2], [1, 2]]), unrated);
    expect(ratings.get(1)!.rounds).toBe(4);
    expect(ratings.get(1)!.mu).toBeGreaterThan(unrated.ratingMu);
    expect(ratings.get(2)!.mu).toBeLessThan(unrated.ratingMu);
  });
});
