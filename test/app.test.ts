// Plays a whole screening session through the web routes, with a fake clock.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, loadDefaultCards } from "../src/app.ts";
import { teamPassword } from "../src/auth.ts";
import { parseCsv } from "../src/csv.ts";
import { openDb } from "../src/db.ts";

const START = Date.parse("2026-11-19T10:00:00Z");
const MIN = 60_000;
let clock = START - 60 * MIN;
const db = openDb(":memory:");
loadDefaultCards(db);
const { app } = createApp({
  db,
  sessionSecret: "test-session",
  loginSecret: "test-login",
  adminPassword: "organiser",
  now: () => clock,
  random: (() => {
    let s = 7;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
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
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

let admin = "";
const teams: Record<string, string> = {};
const words = (n: number) => Array(n).fill("word").join(" ");

describe("a screening session", () => {
  it("keeps the console behind the password", async () => {
    expect((await call("/api/admin/state")).status).toBe(401);
    expect((await call("/api/admin/login", { body: { password: "wrong" } })).status).toBe(401);
    admin = (await call("/api/admin/login", { body: { password: "organiser" } })).cookie;
    expect((await call("/api/admin/state", { cookie: admin })).status).toBe(200);
  });

  it("imports teams, sets the timetable and deals the cards", async () => {
    expect((await call("/api/admin/teams", { csv: "code,name\nS001,Team Alpha\nS002,Team Beta\n", cookie: admin })).json.teams).toBe(2);
    const s = await call("/api/admin/settings", { body: { startsAt: new Date(START).toISOString(), briefingMinutes: 15, round1Minutes: 60, round2Minutes: 45 }, cookie: admin });
    expect(s.status).toBe(200);
    expect((await call("/api/admin/deal", { body: {}, cookie: admin })).json).toEqual({ teams: 2, problemCards: 12, crisisCards: 8 });
    expect((await call("/api/admin/logins.csv", { cookie: admin })).json).toContain(`S001,Team Alpha,${teamPassword("test-login", "S001")}`);
  });

  it("signs teams in with the derived password only", async () => {
    expect((await call("/api/login", { body: { code: "S001", password: "nope" } })).status).toBe(401);
    for (const code of ["S001", "S002"]) {
      const r = await call("/api/login", { body: { code, password: teamPassword("test-login", code) } });
      expect(r.status).toBe(200);
      teams[code] = r.cookie;
    }
  });

  it("hides the problem card and locks the form until Round 1 opens", async () => {
    clock = START + 5 * MIN;
    const s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.stage.stage).toBe("BRIEFING");
    expect(s.json.cards.problem).toBeNull();
    expect((await call("/api/team/round/1", { method: "PUT", body: { content: { problem: "x" } }, cookie: teams.S001 })).status).toBe(409);
  });

  it("takes the product up to 800 words and refuses more", async () => {
    clock = START + 30 * MIN;
    const s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.stage).toMatchObject({ stage: "ROUND", round: 1 });
    expect(s.json.cards.problem.title).toBeTruthy();
    expect(s.json.cards.crisis).toBeNull();
    const over = await call("/api/team/round/1", { method: "PUT", body: { content: { problem: words(500), product: words(301) } }, cookie: teams.S001 });
    expect(over.status).toBe(400);
    expect(over.json.error).toContain("801 words");
    const ok = await call("/api/team/round/1", { method: "PUT", body: { content: { company: "MilletBite", problem: words(500), product: words(300), cost: "4.50" } }, cookie: teams.S001 });
    expect(ok.json).toMatchObject({ words: 800, complete: false });
    expect((await call("/api/team/round/2", { method: "PUT", body: { content: { diagnosis: "x" } }, cookie: teams.S001 })).status).toBe(409);
  });

  it("locks Round 1 and opens the crisis with a 400-word limit", async () => {
    clock = START + 80 * MIN;
    expect((await call("/api/team/round/1", { method: "PUT", body: { content: { problem: "late" } }, cookie: teams.S001 })).status).toBe(409);
    const s = await call("/api/team/state", { cookie: teams.S001 });
    expect(s.json.cards.crisis.title).toBeTruthy();
    expect((await call("/api/team/round/2", { method: "PUT", body: { content: { diagnosis: words(401) } }, cookie: teams.S001 })).status).toBe(400);
    const ok = await call("/api/team/round/2", { method: "PUT", body: { content: { diagnosis: words(400) } }, cookie: teams.S001 });
    expect(ok.json.words).toBe(400);
  });

  it("shows organisers every submission and exports them as CSV", async () => {
    clock = START + 130 * MIN;
    expect((await call("/api/team/round/2", { method: "PUT", body: { content: { diagnosis: "late" } }, cookie: teams.S001 })).status).toBe(409);
    const st = (await call("/api/admin/state", { cookie: admin })).json;
    const alpha = st.teams.find((t: any) => t.code === "S001");
    expect(alpha.rounds[1].words).toBe(800);
    expect(alpha.rounds[2].words).toBe(400);
    expect(st.teams.find((t: any) => t.code === "S002").rounds[1]).toBeNull();
    const detail = (await call("/api/admin/team/S001", { cookie: admin })).json;
    expect(detail.rounds[0].submission.content.company).toBe("MilletBite");
    const rows = parseCsv((await call("/api/admin/submissions.csv", { cookie: admin })).json);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: "S001", r1_words: "800", r1_company: "MilletBite", r1_cost: "4.50", r2_words: "400" });
    expect(rows[1]).toMatchObject({ code: "S002", r1_words: "" });
  });
});
