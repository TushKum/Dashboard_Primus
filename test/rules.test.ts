import { describe, expect, it } from "vitest";
import { checkForm, dealEvenly, parseRupees, roundIsOpen, roundWindows, shuffle, stageAt, FORMS } from "../src/rules.ts";

const words = (n: number) => Array(n).fill("word").join(" ");

describe("word limits", () => {
  it("are 800 for the product and 400 for the crisis", () => {
    expect(FORMS[1].wordLimit).toBe(800);
    expect(FORMS[2].wordLimit).toBe(400);
  });
  it("count every text field together, but not names or amounts", () => {
    const c = checkForm(1, { brand: "VoltRide", product: words(400), audience: words(400) });
    expect(c.words).toBe(800);
    expect(c.errors).toEqual([]);
    expect(checkForm(1, { product: words(400), audience: words(401) }).errors).toContain("801 words: the limit is 800");
    expect(checkForm(2, { technology: words(401) }).errors).toContain("401 words: the limit is 400");
    expect(checkForm(2, { technology: words(400) }).errors).toEqual([]);
  });
  it("allow a partial save and list what is still empty", () => {
    const c = checkForm(2, { technology: "Warn at 2 minutes left, then slow to a safe stop." });
    expect(c.errors).toEqual([]);
    expect(c.missing).toContain("Customer retention");
  });
  it("check amounts", () => {
    expect(parseRupees("4.50")).toBe(450);
    expect(parseRupees("₹1,200")).toBe(120000);
    expect(parseRupees("abc")).toBeNull();
  });
});

describe("timetable", () => {
  const start = Date.parse("2026-11-19T10:00:00Z");
  const t = { briefingMinutes: 15, roundMinutes: { 1: 60, 2: 45 } } as const;
  it("runs the briefing, then Round 1, then Round 2", () => {
    const w = roundWindows(start, t);
    expect(w.map((x) => [(x.opensAt - start) / 60000, (x.closesAt - start) / 60000])).toEqual([
      [15, 75],
      [75, 120],
    ]);
  });
  it("knows the stage and locks exactly on time", () => {
    expect(stageAt(null, start).stage).toBe("NOT_SCHEDULED");
    expect(stageAt(start, start - 1, t).stage).toBe("BEFORE");
    expect(stageAt(start, start + 60_000, t).stage).toBe("BRIEFING");
    expect(stageAt(start, start + 80 * 60_000, t)).toMatchObject({ stage: "ROUND", round: 2 });
    expect(stageAt(start, start + 120 * 60_000, t).stage).toBe("ENDED");
    expect(roundIsOpen(start, 1, start + 75 * 60_000, t)).toBe(false);
  });
});

describe("dealing", () => {
  it("spreads cards evenly", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const d = dealEvenly(shuffle(ids, () => 0.42), [1, 2, 3, 4, 5, 6, 7, 8]);
    const counts = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [...d.values()].filter((v) => v === n).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(d.size).toBe(150);
  });
});
