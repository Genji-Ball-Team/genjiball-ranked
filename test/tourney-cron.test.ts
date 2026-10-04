import { createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM screenshot_deletions"),
    env.DB.prepare("INSERT OR IGNORE INTO rating_state (board) VALUES ('ranked')"),
  ]);
});

async function pendingScreenshot(key: string): Promise<void> {
  await env.PROOFS.put(key, "proof");
  await env.DB.prepare("INSERT INTO screenshot_deletions (key, bytes, queued_at, delete_after) VALUES (?, 5, ?, ?)")
    .bind(key, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    .run();
}

async function expectRemoved(key: string): Promise<void> {
  expect(await env.PROOFS.get(key)).toBeNull();
  expect(await env.DB.prepare("SELECT key FROM screenshot_deletions WHERE key = ?").bind(key).first()).toBeNull();
}

describe("tourney screenshot cron", () => {
  it("retries queued deletes even when rating work fails", async () => {
    const key = "cron-rating-failure.png";
    await pendingScreenshot(key);
    await env.DB.prepare("DELETE FROM rating_state").run();

    await expect(worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env))
      .rejects.toThrow("rating_state has no row for ranked");
    await expectRemoved(key);
  });

  it("retries queued deletes when age expiry is disabled", async () => {
    const key = "cron-age-expiry-disabled.png";
    await pendingScreenshot(key);

    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "*/10 * * * *" }), env);
    await expectRemoved(key);
  });
});
