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

  it("damps a round to 1/N of a full game", () => {
    const n = 8;
    const full: Ratings = new Map();
    const damped: Ratings = new Map();
    rateRound(full, [1, 2, 3], { ...config, ratingRoundsPerMatch: 1, ratingTau: 0 });
    rateRound(damped, [1, 2, 3], { ...config, ratingRoundsPerMatch: n, ratingTau: 0 });
    for (const id of [1, 2, 3]) {
      const fullMove = full.get(id)!.mu - config.ratingMu;
      expect(damped.get(id)!.mu - config.ratingMu).toBeCloseTo(fullMove / n, 10);
      expect(damped.get(id)!.sigma).toBeGreaterThan(full.get(id)!.sigma);
      expect(damped.get(id)!.sigma).toBeLessThan(config.ratingSigma);
    }
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
    // Under 5% of the gap between two tiers.
    expect(before - afterLoss).toBeLessThan(15);
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
  it("is displayCenter for a new player's mu with no uncertainty, displayScale per point of mu", () => {
    expect(displayRating({ mu: config.ratingMu, sigma: 0 }, config)).toBe(config.displayCenter);
    expect(displayRating({ mu: config.ratingMu + 2, sigma: 0 }, config)).toBe(
      config.displayCenter + 2 * config.displayScale,
    );
  });

  it("uses the conservative rating, rounded", () => {
    expect(displayRating({ mu: 40, sigma: 2.01 }, config)).toBe(
      Math.round(config.displayCenter + config.displayScale * (40 - config.displayZ * 2.01 - config.ratingMu)),
    );
  });

  it("never goes below displayFloor, so a new player shows the floor", () => {
    expect(displayRating(newRating(config), config)).toBe(config.displayFloor);
  });
});

describe("tierFor", () => {
  const tiers = config.tiers;

  it("is null below the first tier", () => {
    expect(tierFor(tiers[0]!.threshold - 1, tiers)).toBeNull();
  });

  it("is the highest tier reached, from its threshold on", () => {
    expect(tierFor(tiers[0]!.threshold, tiers)?.label).toBe("Master");
    expect(tierFor(tiers[1]!.threshold - 1, tiers)?.label).toBe("Master");
    expect(tierFor(tiers[1]!.threshold, tiers)?.label).toBe("Grandmaster");
    expect(tierFor(99999, tiers)?.label).toBe("God");
  });
});
