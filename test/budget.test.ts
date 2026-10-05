import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { queryBudget } from "../src/budget";

describe("queryBudget", () => {
  it("counts every statement run, each one of a batch too, through bind", async () => {
    const budget = queryBudget(env.DB, 10);
    const { db } = budget;
    expect(await db.prepare("SELECT ?1 AS n").bind(7).first("n")).toBe(7);
    await db.prepare("SELECT 1").all();
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT ?").bind(2), db.prepare("SELECT 3")]);
    expect(budget.used()).toBe(5);
    expect(budget.left()).toBe(5);
  });

  it("doesn't count a statement only prepared", () => {
    const budget = queryBudget(env.DB, 10);
    budget.db.prepare("SELECT 1").bind();
    expect(budget.used()).toBe(0);
  });
});
