// The web app: JSON routes for the team page and the organiser console, and the static pages in public/.

import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cookieValue, makeSession, readSession, safeEqual, teamPassword, type Session } from "./auth.ts";
import { parseCsv, toCsv } from "./csv.ts";
import type { Db } from "./db.ts";
import type { JudgeFn } from "./judge.ts";
import { ROUNDS, rubricMax, validatePriceCard, type CrisisCard, type PriceCard, type ProblemCard, type RoundNo } from "./rules.ts";
import { ActionError, createService } from "./service.ts";

export interface AppConfig {
  db: Db;
  judge: JudgeFn;
  sessionSecret: string;
  loginSecret: string;
  adminPassword: string;
  now?: () => number;
  secureCookies?: boolean;
  concurrency?: number;
  random?: () => number;
}

const COOKIE = "ps_session";
const dataFile = (name: string) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

export function loadDefaultCards(db: Db) {
  if (!db.problemCards().length) db.replaceProblemCards(problemCardsFromCsv(readFileSync(dataFile("problem-cards.csv"), "utf8")));
  if (!db.crisisCards().length) db.replaceCrisisCards(crisisCardsFromCsv(readFileSync(dataFile("crisis-cards.csv"), "utf8")));
  if (!db.priceCards().length) db.replacePriceCards(priceCardsFromJson(readFileSync(dataFile("price-cards.json"), "utf8")));
}

function problemCardsFromCsv(text: string): ProblemCard[] {
  const rows = parseCsv(text);
  const cards = rows.map((r, i) => ({ number: Number(r.number || i + 1), title: r.title ?? "", body: r.body ?? "" }));
  if (!cards.length || cards.some((c) => !Number.isInteger(c.number) || !c.title || !c.body)) throw new ActionError("Problem cards need columns number, title, body, all filled in.");
  return cards;
}

function crisisCardsFromCsv(text: string): CrisisCard[] {
  const rows = parseCsv(text);
  const cards = rows.map((r, i) => ({ number: Number(r.number || i + 1), category: r.category ?? "", title: r.title ?? "", body: r.body ?? "" }));
  if (!cards.length || cards.some((c) => !Number.isInteger(c.number) || !c.category || !c.title || !c.body)) throw new ActionError("Crisis cards need columns number, category, title, body, all filled in.");
  return cards;
}

function priceCardsFromJson(text: string): PriceCard[] {
  let cards: PriceCard[];
  try {
    cards = JSON.parse(text) as PriceCard[];
  } catch {
    throw new ActionError("Price cards must be a JSON array.");
  }
  if (!Array.isArray(cards) || !cards.length) throw new ActionError("Price cards must be a non-empty JSON array.");
  const errors = cards.flatMap((c, i) => validatePriceCard(c).map((e) => `card ${i + 1}: ${e}`));
  if (new Set(cards.map((c) => c.key)).size !== cards.length) errors.push("card keys must be unique");
  if (errors.length) throw new ActionError(errors.join("; "));
  return cards;
}

const asRound = (v: unknown): RoundNo => {
  const n = Number(v);
  if (n !== 1 && n !== 2 && n !== 3) throw new ActionError("No such round.", 404);
  return n;
};

export function createApp(cfg: AppConfig) {
  const { db } = cfg;
  const now = cfg.now ?? Date.now;
  const service = createService(db, { judge: cfg.judge, concurrency: cfg.concurrency ?? 5, ...(cfg.random ? { random: cfg.random } : {}) });
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
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
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
      const teams = db.teams();
      const subs = db.submissions();
      const judgements = db.judgements();
      return {
        now: now(),
        startsAt: db.startsAt(),
        qualifyCount: db.qualifyCount(),
        published: db.published(),
        teams: teams.length,
        dealt: db.deals().length,
        cards: { problem: db.problemCards().length, crisis: db.crisisCards().length, price: db.priceCards().map((c) => c.label) },
        rounds: ROUNDS.map((r) => ({
          round: r,
          max: rubricMax(r),
          saved: subs.filter((s) => s.round === r).length,
          complete: subs.filter((s) => s.round === r && s.complete).length,
          judged: judgements.filter((j) => j.round === r && j.score !== null).length,
          failed: judgements.filter((j) => j.round === r && j.score === null).length,
          flagged: judgements.filter((j) => j.round === r && j.removed_lines.length > 0).length,
          progress: service.progress(r),
        })),
        results: service.results(),
      };
    }),
  );
  app.post(
    "/api/admin/settings",
    route((req) => {
      asAdmin(req);
      const { startsAt, qualifyCount } = req.body ?? {};
      if (startsAt !== undefined) {
        const ms = startsAt === null ? null : Date.parse(String(startsAt));
        if (ms !== null && Number.isNaN(ms)) throw new ActionError("Start time is not a date.");
        db.setStartsAt(ms);
      }
      if (qualifyCount !== undefined) {
        const n = Number(qualifyCount);
        if (!Number.isInteger(n) || n < 1) throw new ActionError("How many qualify must be a whole number.");
        db.setQualifyCount(n);
      }
      return { ok: true };
    }),
  );
  app.post(
    "/api/admin/teams",
    route((req) => {
      asAdmin(req);
      const rows = parseCsv(String(req.body ?? ""));
      const teams = rows.map((r) => ({ code: (r.code ?? "").toUpperCase(), name: r.name ?? "" }));
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
      if (db.startsAt() !== null && now() >= db.startsAt()! && db.deals().length) throw new ActionError("The session has started: cards are locked.", 409);
      const body = String(req.body ?? "");
      if (req.params.kind === "problem") db.replaceProblemCards(problemCardsFromCsv(body));
      else if (req.params.kind === "crisis") db.replaceCrisisCards(crisisCardsFromCsv(body));
      else if (req.params.kind === "price") db.replacePriceCards(priceCardsFromJson(body));
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
  app.post(
    "/api/admin/judge/:round",
    route((req) => {
      asAdmin(req);
      const round = asRound(req.params.round);
      // Judging takes minutes: start it and let the console poll /api/admin/state for progress.
      const started = service.judgeRound(round, now(), req.body?.rejudge === true);
      started.catch(() => undefined);
      return new Promise((resolve, reject) => {
        // Refusals (round still open, already running) come back at once; otherwise answer "started".
        const t = setTimeout(() => resolve({ ok: true, started: true }), 50);
        started.then(
          (p) => {
            clearTimeout(t);
            resolve({ ok: true, progress: p });
          },
          (e) => {
            clearTimeout(t);
            reject(e);
          },
        );
      });
    }),
  );
  app.post(
    "/api/admin/publish",
    route((req) => {
      asAdmin(req);
      db.setPublished(req.body?.published === true);
      return { ok: true };
    }),
  );
  app.post(
    "/api/admin/team/:code",
    route((req) => {
      asAdmin(req);
      const team = db.teamByCode(String(req.params.code).toUpperCase());
      if (!team) throw new ActionError("No such team.", 404);
      const { disqualified, penalty } = req.body ?? {};
      if (penalty !== undefined && (typeof penalty !== "number" || penalty < 0 || penalty > 300)) throw new ActionError("Penalty must be 0–300 points.");
      db.updateTeam(team.id, {
        ...(typeof disqualified === "boolean" ? { disqualified } : {}),
        ...(penalty !== undefined ? { penalty } : {}),
      });
      return { ok: true };
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
        problem: deal ? db.problemCards().find((c) => c.number === deal.problem_number) : null,
        crisis: deal ? db.crisisCards().find((c) => c.number === deal.crisis_number) : null,
        pricing: service.pricingOf(team.id),
        rounds: ROUNDS.map((r) => ({ round: r, submission: db.submission(team.id, r), judgement: db.judgement(team.id, r) })),
      };
    }),
  );
  app.get(
    "/api/admin/results.csv",
    route((req, res) => {
      asAdmin(req);
      const rows = service.results();
      res
        .type("text/csv")
        .attachment("screening-results.csv")
        .send(
          toCsv(
            ["rank", "code", "name", "round1_idea", "round2_crisis", "round3_judge", "round3_market", "round3_pricing", "penalty", "total", "qualified", "disqualified"],
            rows.map((r) => [r.rank ?? "", r.code, r.name, r.r1, r.r2, r.r3Judge, r.r3Market, r.r3, r.penalty, r.total, r.qualified ? "yes" : "no", r.disqualified ? "yes" : "no"]),
          ),
        );
    }),
  );
  // The qualifying teams, in the shape the main night's seed expects (code,name).
  app.get(
    "/api/admin/qualified.csv",
    route((req, res) => {
      asAdmin(req);
      res.type("text/csv").attachment("qualified-teams.csv").send(toCsv(["code", "name"], service.results().filter((r) => r.qualified).map((r) => [r.code, r.name])));
    }),
  );

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });
  return { app, service };
}
