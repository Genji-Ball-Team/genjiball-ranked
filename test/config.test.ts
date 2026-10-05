import { describe, expect, it } from "vitest";
import { defaults, loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("uses the defaults when no var is set", () => {
    expect(loadConfig({})).toEqual(defaults);
  });

  it("overrides the log level from LOG_LEVEL", () => {
    expect(loadConfig({ LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
  });

  it("ignores an invalid LOG_LEVEL", () => {
    expect(loadConfig({ LOG_LEVEL: "loud" }).logLevel).toBe(defaults.logLevel);
  });

  it("turns the test server banner on from TEST_SERVER", () => {
    expect(loadConfig({ TEST_SERVER: "true" }).testServer).toBe(true);
    expect(loadConfig({ TEST_SERVER: "false" }).testServer).toBe(false);
  });

  it("overrides the matches rated a run from RATING_MATCHES_PER_RUN, ignoring a bad value", () => {
    expect(loadConfig({ RATING_MATCHES_PER_RUN: "10" }).ratingMatchesPerRun).toBe(10);
    for (const bad of ["", "0", "-5", "2.5", "many"]) {
      expect(loadConfig({ RATING_MATCHES_PER_RUN: bad }).ratingMatchesPerRun).toBe(defaults.ratingMatchesPerRun);
    }
  });

  it("overrides the dry-run recompute cap from RATING_DRY_RUN_MAX_MATCHES, ignoring a bad value", () => {
    expect(loadConfig({ RATING_DRY_RUN_MAX_MATCHES: "20" }).ratingDryRunMaxMatches).toBe(20);
    for (const bad of ["", "0", "-5", "2.5", "many"]) {
      expect(loadConfig({ RATING_DRY_RUN_MAX_MATCHES: bad }).ratingDryRunMaxMatches).toBe(defaults.ratingDryRunMaxMatches);
    }
  });

  it("doesn't share state between calls", () => {
    loadConfig({}).acceptedLogFormats.push(99);
    expect(defaults.acceptedLogFormats).toEqual([1]);
  });
});
