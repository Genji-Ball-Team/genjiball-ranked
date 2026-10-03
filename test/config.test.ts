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

  it("doesn't share state between calls", () => {
    loadConfig({}).acceptedLogFormats.push(99);
    expect(defaults.acceptedLogFormats).toEqual([1]);
  });
});
