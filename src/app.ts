// The web app: JSON routes for the team page and the organiser console, and the static pages in public/.

import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cookieValue, makeSession, readSession, safeEqual, teamPassword, type Session } from "./auth.ts";
import { parseCsv, toCsv } from "./csv.ts";
import type { Db } from "./db.ts";
import { FORMS, ROUNDS, roundWindows, type CrisisCard, type ProblemCard, type RoundNo } from "./rules.ts";
import { ActionError, createService } from "./service.ts";

export interface AppConfig {
  db: Db;
  sessionSecret: string;
  loginSecret: string;
  adminPassword: string;
  now?: () => number;
  secureCookies?: boolean;
  random?: () => number;
}

const COOKIE = "ps_session";
const dataFile = (name: string) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

export function loadDefaultCards(db: Db) {
  if (!db.problemCards().length) db.replaceProblemCards(problemCardsFromCsv(readFileSync(dataFile("problem-cards.csv"), "utf8")));
  if (!db.crisisCards().length) db.replaceCrisisCards(crisisCardsFromCsv(readFileSync(dataFile("crisis-cards.csv"), "utf8")));
}

function problemCardsFromCsv(text: string): ProblemCard[] {
  const cards = parseCsv(text).map((r, i) => ({ number: Number(r.number || i + 1), title: r.title ?? "", body: r.body ?? "" }));
  if (!cards.length || cards.some((c) => !Number.isInteger(c.number) || !c.title || !c.body)) throw new ActionError("Problem cards need columns number, title, body, all filled in.");
  return cards;
}

function crisisCardsFromCsv(text: string): CrisisCard[] {
  const cards = parseCsv(text).map((r, i) => ({ number: Number(r.number || i + 1), category: r.category ?? "", title: r.title ?? "", body: r.body ?? "" }));
  if (!cards.length || cards.some((c) => !Number.isInteger(c.number) || !c.category || !c.title || !c.body)) throw new ActionError("Crisis cards need columns number, category, title, body, all filled in.");
  return cards;
}

const asRound = (v: unknown): RoundNo => {
  const n = Number(v);
  if (n !== 1 && n !== 2) throw new ActionError("No such round.", 404);
  return n;
};

const minutes = (v: unknown, name: string, min: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > 600) throw new ActionError(`${name} must be a whole number of minutes from ${min} to 600.`);
  return n;
};

export function createApp(cfg: AppConfig) {
  const { db } = cfg;
  const now = cfg.now ?? Date.now;
  const service = createService(db, cfg.random ? { random: cfg.random } : {});
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }));

  const session = (req: Request): Session | null => readSession(cfg.sessionSecret, cookieValue(req.headers.cookie, COOKIE), now());
  const setSession = (res: Response, s: Session) =>
    res.cookie(COOKIE, makeSession(cfg.sessionSecret, s, now()), { httpOnly: true, sameSite: "lax", secure: cfg.secureCookies ?? false, maxAge: 12 * 3_600_000, path: "/" });

  const asTeam = (req: Request) => {
    const s = session(req);
    const team = s?.role === "team" ? db.teamById(s.teamId) : null;
    if (!team) throw new ActionError("Please sign in.", 401);
    return team;
  };
  const asAdmin = (req: Request) => {
    if (session(req)?.role !== "admin") throw new ActionError("Organisers only.", 401);
  };

  // Every route body runs through this, so an ActionError becomes a JSON answer with its status.
  const route =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out ?? { ok: true });
      } catch (e) {
        if (e instanceof ActionError) res.status(e.status).json({ error: e.message });
        else next(e);
      }
    };

  // ── Sign in ──
  const attempts = new Map<string, { n: number; until: number }>();
  app.post(
    "/api/login",
    route((req, res) => {
      const code = String(req.body?.code ?? "").trim().toUpperCase();
      const password = String(req.body?.password ?? "").trim().toLowerCase();
      const a = attempts.get(code);
      if (a && a.n >= 10 && a.until > now()) throw new ActionError("Too many tries. Wait a minute.", 429);
      const team = db.teamByCode(code);
      if (!team || !safeEqual(teamPassword(cfg.loginSecret, team.code), password)) {
        attempts.set(code, { n: (a && a.until > now() ? a.n : 0) + 1, until: now() + 60_000 });
        throw new ActionError("Wrong team code or password.", 401);
      }
      attempts.delete(code);
      setSession(res, { role: "team", teamId: team.id });
      return { ok: true, team: { code: team.code, name: team.name } };
    }),
  );
  app.post(
    "/api/admin/login",
    route((req, res) => {
      if (!cfg.adminPassword || !safeEqual(cfg.adminPassword, String(req.body?.password ?? ""))) throw new ActionError("Wrong password.", 401);
      setSession(res, { role: "admin" });
      return { ok: true };
    }),
  );
  app.post(
    "/api/logout",
    route((_req, res) => {
      res.clearCookie(COOKIE, { path: "/" });
      return { ok: true };
    }),
  );

  // ── Team ──
  app.get("/api/team/state", route((req) => service.teamState(asTeam(req), now())));
  app.put(
    "/api/team/round/:round",
    route((req) => {
      const team = asTeam(req);
      const content = req.body?.content;
      if (!content || typeof content !== "object") throw new ActionError("Nothing to save.");
      return service.save(team, asRound(req.params.round), content as Record<string, string>, now());
    }),
  );

  // ── Organiser ──
  app.get(
    "/api/admin/state",
    route((req) => {
      asAdmin(req);
      const startsAt = db.startsAt();
      const subs = db.submissions();
      const deals = db.deals();
      const problems = db.problemCards();
      const crises = db.crisisCards();
      return {
        now: now(),
        startsAt,
        timetable: db.timetable(),
        windows: startsAt === null ? [] : roundWindows(startsAt, db.timetable()),
        dealt: deals.length,
        cards: { problem: problems.length, crisis: crises.length },
        limits: Object.fromEntries(ROUNDS.map((r) => [r, FORMS[r].wordLimit])),
        teams: db.teams().map((t) => {
          const d = deals.find((x) => x.team_id === t.id);
          return {
            code: t.code,
            name: t.name,
            problem: d ? problems.find((c) => c.number === d.problem_number)?.title ?? null : null,
            crisis: d ? crises.find((c) => c.number === d.crisis_number)?.title ?? null : null,
            rounds: Object.fromEntries(
              ROUNDS.map((r) => {
                const s = subs.find((x) => x.team_id === t.id && x.round === r);
                return [r, s ? { words: s.words, complete: s.complete, savedAt: s.saved_at } : null];
              }),
            ),
          };
        }),
      };
    }),
  );
  app.post(
    "/api/admin/settings",
    route((req) => {
      asAdmin(req);
      const { startsAt, briefingMinutes, round1Minutes, round2Minutes } = req.body ?? {};
      if (startsAt !== undefined) {
        const ms = startsAt === null ? null : Date.parse(String(startsAt));
        if (ms !== null && Number.isNaN(ms)) throw new ActionError("Start time is not a date.");
        db.setStartsAt(ms);
      }
      if (briefingMinutes !== undefined || round1Minutes !== undefined || round2Minutes !== undefined) {
        const t = db.timetable();
        db.setTimetable({
          briefingMinutes: briefingMinutes === undefined ? t.briefingMinutes : minutes(briefingMinutes, "Briefing", 0),
          roundMinutes: {
            1: round1Minutes === undefined ? t.roundMinutes[1] : minutes(round1Minutes, "Round 1", 1),
            2: round2Minutes === undefined ? t.roundMinutes[2] : minutes(round2Minutes, "Round 2", 1),
          },
        });
      }
      return { ok: true };
    }),
  );
  app.post(
    "/api/admin/teams",
    route((req) => {
      asAdmin(req);
      const teams = parseCsv(String(req.body ?? "")).map((r) => ({ code: (r.code ?? "").toUpperCase(), name: r.name ?? "" }));
      if (!teams.length || teams.some((t) => !/^[A-Z0-9-]{2,12}$/.test(t.code) || !t.name)) throw new ActionError("Teams CSV needs columns code, name (codes: 2–12 letters or digits).");
      if (new Set(teams.map((t) => t.code)).size !== teams.length) throw new ActionError("Team codes must be unique.");
      db.upsertTeams(teams);
      return { ok: true, teams: db.teams().length };
    }),
  );
  app.get(
    "/api/admin/logins.csv",
    route((req, res) => {
      asAdmin(req);
      res.type("text/csv").attachment("screening-logins.csv").send(toCsv(["code", "name", "password"], db.teams().map((t) => [t.code, t.name, teamPassword(cfg.loginSecret, t.code)])));
    }),
  );
  app.post(
    "/api/admin/cards/:kind",
    route((req) => {
      asAdmin(req);
      const startsAt = db.startsAt();
      if (startsAt !== null && now() >= startsAt && db.deals().length) throw new ActionError("The session has started: cards are locked.", 409);
      const body = String(req.body ?? "");
      if (req.params.kind === "problem") db.replaceProblemCards(problemCardsFromCsv(body));
      else if (req.params.kind === "crisis") db.replaceCrisisCards(crisisCardsFromCsv(body));
      else throw new ActionError("No such card kind.", 404);
      return { ok: true };
    }),
  );
  app.post(
    "/api/admin/deal",
    route((req) => {
      asAdmin(req);
      return service.deal(now(), req.body?.force === true);
    }),
  );
  app.get(
    "/api/admin/team/:code",
    route((req) => {
      asAdmin(req);
      const team = db.teamByCode(String(req.params.code).toUpperCase());
      if (!team) throw new ActionError("No such team.", 404);
      const deal = db.dealFor(team.id);
      return {
        team,
        problem: deal ? db.problemCards().find((c) => c.number === deal.problem_number) ?? null : null,
        crisis: deal ? db.crisisCards().find((c) => c.number === deal.crisis_number) ?? null : null,
        forms: FORMS,
        rounds: ROUNDS.map((r) => ({ round: r, submission: db.submission(team.id, r) })),
      };
    }),
  );
  // Every team's two submissions, one row per team, one column per field: for marking offline.
  app.get(
    "/api/admin/submissions.csv",
    route((req, res) => {
      asAdmin(req);
      const deals = db.deals();
      const problems = db.problemCards();
      const crises = db.crisisCards();
      const header = [
        "code",
        "name",
        "problem_card",
        "crisis_card",
        ...ROUNDS.flatMap((r) => [`r${r}_words`, `r${r}_saved_at`, ...FORMS[r].fields.map((f) => `r${r}_${f.key}`)]),
      ];
      const rows = db.teams().map((t) => {
        const d = deals.find((x) => x.team_id === t.id);
        return [
          t.code,
          t.name,
          d ? problems.find((c) => c.number === d.problem_number)?.title ?? "" : "",
          d ? crises.find((c) => c.number === d.crisis_number)?.title ?? "" : "",
          ...ROUNDS.flatMap((r) => {
            const s = db.submission(t.id, r);
            return [s?.words ?? "", s ? new Date(s.saved_at).toISOString() : "", ...FORMS[r].fields.map((f) => s?.content[f.key] ?? "")];
          }),
        ];
      });
      res.type("text/csv").attachment("screening-submissions.csv").send(toCsv(header, rows));
    }),
  );

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });
  return { app, service };
}
