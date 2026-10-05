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
  type RatingMatch,
  type Ratings,
} from "../src/rating/engine";

const config = defaults;

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
  const rounds = Array.from({ length: 20 }, () => [1, 2, 3, 4]);

  it("count more than a normal match", () => {
    const uncapped = { ...config, tournamentMaxChange: Infinity };
    const normal: Ratings = new Map();
    const tourney: Ratings = new Map();
    rateMatch(normal, match(1, rounds), uncapped);
    rateMatch(tourney, { ...match(1, rounds), tournament: true }, uncapped);
    expect(displayRating(tourney.get(1)!, uncapped)).toBeGreaterThan(displayRating(normal.get(1)!, uncapped));
  });

  it("never move anyone more than tournamentMaxChange either way", () => {
    const capped = { ...config, tournamentMaxChange: 50 };
    const ratings: Ratings = new Map();
    rateMatch(ratings, { ...match(1, rounds), tournament: true }, capped);
    const moved = (id: number) => displayRating(ratings.get(id)!, capped) - capped.displayCenter;
    // The winner of every round would gain far more, and is held to the cap (to within rounding).
    expect(moved(1)).toBeGreaterThanOrEqual(capped.tournamentMaxChange - 1);
    expect(moved(1)).toBeLessThanOrEqual(capped.tournamentMaxChange);
    for (const id of [2, 3, 4]) expect(Math.abs(moved(id))).toBeLessThanOrEqual(capped.tournamentMaxChange);
    // The loser is held the other way: below the center the curve is flatter, so test from above it.
    const strong: Ratings = new Map([1, 2, 3, 4].map((id) => [id, { ...newRating(capped), mu: 40 }]));
    const start = displayRating(strong.get(4)!, capped);
    rateMatch(strong, { ...match(1, rounds), tournament: true }, capped);
    expect(start - displayRating(strong.get(4)!, capped)).toBeGreaterThanOrEqual(capped.tournamentMaxChange - 1);
    expect(start - displayRating(strong.get(4)!, capped)).toBeLessThanOrEqual(capped.tournamentMaxChange);
  });

  it("leave a change within the cap alone", () => {
    const uncapped: Ratings = new Map();
    const capped: Ratings = new Map();
    const short = { ...match(1, [[1, 2, 3, 4]]), tournament: true };
    rateMatch(uncapped, short, { ...config, tournamentMaxChange: Infinity });
    rateMatch(capped, short, config);
    expect(capped.get(1)!.mu).toBe(uncapped.get(1)!.mu);
  });
});
