// Plays a whole screening session through the web routes, with a fake clock and the fake judge.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, loadDefaultCards } from "../src/app.ts";
import { teamPassword } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { fakeJudge } from "../src/judge.ts";

const START = Date.parse("2026-11-19T10:00:00Z");
const MIN = 60_000;
let clock = START - 60 * MIN;
const db = openDb(":memory:");
loadDefaultCards(db);
const { app } = createApp({
  db,
  judge: fakeJudge,
  sessionSecret: "test-session",
  loginSecret: "test-login",
  adminPassword: "organiser",
  now: () => clock,
  random: (() => {
    let s = 7;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })(),
});
let server: Server;
let base = "";

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function call(path: string, opts: { method?: string; body?: unknown; csv?: string; cookie?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body !== undefined || opts.csv !== undefined ? "POST" : "GET"),
    headers: { "content-type": opts.csv !== undefined ? "text/csv" : "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.csv ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

let admin = "";
const teams: Record<string, string> = {};

const pitch = (product: string, cost: string) => ({
  company: "MilletBite",
  ticker: "mlbt",
  productType: "snack-25g",
  problem: "College students want a healthy snack under ₹20; most millet snacks cost ₹50.",
  product: `${product}: baked ragi chips, 25 g, two flavours, four-month shelf life.`,
  buyer: "Students aged 18 to 24 in Tier-2 towns.",
  whyWins: "Same ₹10 price as fried chips, but baked and made with millet.",
  whereSells: "Kirana shops near 50 campuses in 4 towns.",
  cost,
  costReason: "Ragi is 30% of the cost; packaging ₹0.60.",
});

describe("a screening session", () => {
  it("refuses the console without the password", async () => {
    expect((await call("/api/admin/state")).status).toBe(401);
    expect((await call("/api/admin/login", { body: { password: "wrong" } })).status).toBe(401);
    admin = (await call("/api/admin/login", { body: { password: "organiser" } })).cookie;
    expect((await call("/api/admin/state", { cookie: admin })).status).toBe(200);
  });

  it("imports teams, sets the time and deals the cards", async () => {
    const csv = "code,name\nS001,Team Alpha\nS002,Team Beta\nS003,Team Gamma\n";
    expect((await call("/api/admin/teams", { csv, cookie: admin })).json.teams).toBe(3);
    expect((await call("/api/admin/settings", { body: { startsAt: new Date(START).toISOString(), qualifyCount: 2 }, cookie: admin })).status).toBe(200);
    const deal = await call("/api/admin/deal", { body: {}, cookie: admin });
    expect(deal.json).toEqual({ teams: 3, problemCards: 12, crisisCards: 8 });
    const logins = await call("/api/admin/logins.csv", { cookie: admin });
    expect(logins.json).toContain(`S001,Team Alpha,${teamPassword("test-login", "S001")}`);
  });

  it("signs teams in with the derived password only", async () => {
    expect((await call("/api/login", { body: { code: "S001", password: "nope" } })).status).toBe(401);
    for (const code of ["S001", "S002", "S003"]) {
      const r = await call("/api/login", { body: { code: code.toLowerCase(), password: teamPassword("test-login", code) } });
      expect(r.status).toBe(200);
      teams[code] = r.cookie;
    }
  });

  it("hides the cards until each round opens, and locks forms outside their window", async () => {
    clock = START + 5 * MIN; // briefing
    let s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.stage.stage).toBe("BRIEFING");
    expect(s.json.cards.problem).toBeNull();
    expect((await call("/api/team/round/1", { method: "PUT", body: { content: pitch("x", "4.50") }, cookie: teams.S001 })).status).toBe(409);

    clock = START + 20 * MIN;
    s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.stage).toMatchObject({ stage: "ROUND", round: 1 });
    expect(s.json.cards.problem.title).toBeTruthy();
    expect(s.json.cards.crisis).toBeNull();
    expect((await call("/api/team/round/2", { method: "PUT", body: { content: { diagnosis: "x" } }, cookie: teams.S001 })).status).toBe(409);
  });

  it("saves drafts and complete rounds, and refuses bad values", async () => {
    const draft = await call("/api/team/round/1", { method: "PUT", body: { content: { problem: "Students want snacks" } }, cookie: teams.S001 });
    expect(draft.json.complete).toBe(false);
    const bad = await call("/api/team/round/1", { method: "PUT", body: { content: { ...pitch("x", "4.50"), productType: "rockets" } }, cookie: teams.S001 });
    expect(bad.status).toBe(400);
    for (const [code, cost] of [["S001", "4.50"], ["S002", "4.80"], ["S003", "5.00"]] as const) {
      const r = await call("/api/team/round/1", { method: "PUT", body: { content: pitch(code, cost) }, cookie: teams[code] });
      expect(r.json.complete).toBe(true);
    }
  });

  it("refuses to judge a round that is still open", async () => {
    expect((await call("/api/admin/judge/1", { body: {}, cookie: admin })).status).toBe(409);
  });

  it("runs Round 2 with the crisis card and judges Round 1 meanwhile", async () => {
    clock = START + 60 * MIN;
    const s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.cards.crisis.title).toBeTruthy();
    expect((await call("/api/team/round/1", { method: "PUT", body: { content: pitch("late", "1") }, cookie: teams.S001 })).status).toBe(409);
    for (const [code, fix] of [["S001", "4.70"], ["S002", "4.00"], ["S003", "5.20"]] as const) {
      const r = await call("/api/team/round/2", {
        method: "PUT",
        body: {
          content: {
            diagnosis: "A cost problem, not a demand problem.",
            optionA: "Raise the price to ₹12.",
            optionB: "Blend in jowar and keep ₹10.",
            recommendation: "Option B protects the price point.",
            costAfterCrisis: "5.04",
            costAfterFix: fix,
            weeks: "Week 1 trial, week 2 taste test, week 3 labels, week 4 in shops.",
            risk: "Taste may change: launch only if 70% of testers like it.",
          },
        },
        cookie: teams[code],
      });
      expect(r.json.complete).toBe(true);
    }
    const j = await call("/api/admin/judge/1", { body: {}, cookie: admin });
    expect(j.status).toBe(200);
    await waitForJudging(1);
    const st = await call("/api/admin/state", { cookie: admin });
    expect(st.json.rounds[0].judged).toBe(3);
  });

  it("prices in Round 3 from the team's card, with its own cost floored at the benchmark", async () => {
    clock = START + 100 * MIN;
    const s1 = await call("/api/team/state", { cookie: teams.S001 });
    expect(s1.json.cards.price).toMatchObject({ key: "snack-25g", costPaise: 470 });
    const s2 = await call("/api/team/state", { cookie: teams.S002 });
    expect(s2.json.cards.price.costPaise).toBe(460); // ₹4.00 claimed, benchmark ₹4.60 used
    expect((await call("/api/team/round/3", { method: "PUT", body: { content: { mrp: "1200", maths: "x", reasoning: "y" } }, cookie: teams.S001 })).status).toBe(400);
    for (const [code, mrp] of [["S001", "1000"], ["S002", "1500"], ["S003", "2000"]] as const) {
      const r = await call("/api/team/round/3", { method: "PUT", body: { content: { mrp, maths: "MRP → reach → cost → profit", reasoning: "Fits students." } }, cookie: teams[code] });
      expect(r.json.complete).toBe(true);
    }
  });

  it("judges Rounds 2 and 3 after the session and ranks the teams", async () => {
    clock = START + 140 * MIN;
    await call("/api/admin/judge/2", { body: {}, cookie: admin });
    await waitForJudging(2);
    await call("/api/admin/judge/3", { body: {}, cookie: admin });
    await waitForJudging(3);
    const st = (await call("/api/admin/state", { cookie: admin })).json;
    expect(st.rounds.map((r: any) => r.judged)).toEqual([3, 3, 3]);
    const byCode = Object.fromEntries(st.results.map((r: any) => [r.code, r]));
    // Profits at ₹10 / ₹15 / ₹20 with costs 4.70 / 4.60 / 5.20: S002's ₹15 is the best on the snack card.
    expect(byCode.S002.r3Market).toBe(50);
    expect(byCode.S001.r3Market).toBe(Math.round((50 * 12_480_000) / 15_686_000 * 10) / 10);
    expect(st.results.filter((r: any) => r.qualified)).toHaveLength(2);
    const qualified = await call("/api/admin/qualified.csv", { cookie: admin });
    expect(String(qualified.json).split("\r\n").filter(Boolean)).toHaveLength(3);
  });

  it("shows teams their result only once published", async () => {
    expect((await call("/api/team/state", { cookie: teams.S001 })).json.results).toBeNull();
    await call("/api/admin/publish", { body: { published: true }, cookie: admin });
    const r = (await call("/api/team/state", { cookie: teams.S001 })).json.results;
    expect(r.total).toBeGreaterThan(0);
    expect(r.verdicts[1].rationale).toContain("fake judge");
  });

  it("lets organisers penalise and disqualify", async () => {
    await call("/api/admin/team/S003", { body: { disqualified: true }, cookie: admin });
    const st = (await call("/api/admin/state", { cookie: admin })).json;
    expect(st.results.find((r: any) => r.code === "S003")).toMatchObject({ rank: null, qualified: false });
  });
});

async function waitForJudging(round: number) {
  for (let i = 0; i < 100; i++) {
    const st = (await call("/api/admin/state", { cookie: admin })).json;
    const r = st.rounds[round - 1];
    if (!r.progress?.running && r.judged + r.failed >= r.saved) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`round ${round} did not finish judging`);
}
