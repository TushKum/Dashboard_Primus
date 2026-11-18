// Storage: one SQLite file (Node's built-in node:sqlite), so the app runs on any small server with no database to set
// up. Every write that matters (a save, a judgement) is a single statement or a transaction.

import { DatabaseSync } from "node:sqlite";
import type { Content, CrisisCard, PriceCard, ProblemCard, RoundNo } from "./rules.ts";

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);
create table if not exists teams (
  id integer primary key,
  code text not null unique,
  name text not null,
  disqualified integer not null default 0,
  penalty real not null default 0
);
create table if not exists problem_cards (number integer primary key, title text not null, body text not null);
create table if not exists crisis_cards (number integer primary key, category text not null, title text not null, body text not null);
create table if not exists price_cards (key text primary key, data text not null);
create table if not exists deals (
  team_id integer primary key references teams (id) on delete cascade,
  problem_number integer not null,
  crisis_number integer not null
);
create table if not exists submissions (
  team_id integer not null references teams (id) on delete cascade,
  round integer not null check (round between 1 and 3),
  content text not null,
  words integer not null,
  complete integer not null,
  saved_at integer not null,
  primary key (team_id, round)
);
create table if not exists judgements (
  team_id integer not null references teams (id) on delete cascade,
  round integer not null check (round between 1 and 3),
  runs text not null,
  score real,
  breakdown text,
  rationale text,
  model text,
  removed_lines text not null default '[]',
  error text,
  judged_at integer not null,
  primary key (team_id, round)
);
`;

export interface TeamRow {
  id: number;
  code: string;
  name: string;
  disqualified: number;
  penalty: number;
}

export interface SubmissionRow {
  team_id: number;
  round: RoundNo;
  content: Content;
  words: number;
  complete: boolean;
  saved_at: number;
}

export interface JudgementRun {
  total: number;
  breakdown: Record<string, number>;
  rationale: string;
  model: string;
}

export interface JudgementRow {
  team_id: number;
  round: RoundNo;
  runs: JudgementRun[];
  score: number | null;
  breakdown: Record<string, number> | null;
  rationale: string | null;
  model: string | null;
  removed_lines: string[];
  error: string | null;
  judged_at: number;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  db.exec(SCHEMA);

  const tx = <T>(fn: () => T): T => {
    db.exec("begin immediate");
    try {
      const out = fn();
      db.exec("commit");
      return out;
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  };

  const getSetting = (key: string): string | null =>
    (db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const setSetting = (key: string, value: string | null) => {
    if (value === null) db.prepare("delete from settings where key = ?").run(key);
    else db.prepare("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
  };

  const parseSubmission = (r: Record<string, unknown>): SubmissionRow => ({
    team_id: Number(r.team_id),
    round: Number(r.round) as RoundNo,
    content: JSON.parse(String(r.content)) as Content,
    words: Number(r.words),
    complete: Number(r.complete) === 1,
    saved_at: Number(r.saved_at),
  });
  const parseJudgement = (r: Record<string, unknown>): JudgementRow => ({
    team_id: Number(r.team_id),
    round: Number(r.round) as RoundNo,
    runs: JSON.parse(String(r.runs)) as JudgementRun[],
    score: r.score === null ? null : Number(r.score),
    breakdown: r.breakdown === null ? null : (JSON.parse(String(r.breakdown)) as Record<string, number>),
    rationale: (r.rationale as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    removed_lines: JSON.parse(String(r.removed_lines)) as string[],
    error: (r.error as string | null) ?? null,
    judged_at: Number(r.judged_at),
  });

  return {
    raw: db,
    tx,
    close: () => db.close(),

    // ── Settings ──
    startsAt(): number | null {
      const v = getSetting("starts_at");
      return v === null ? null : Number(v);
    },
    setStartsAt(ms: number | null) {
      setSetting("starts_at", ms === null ? null : String(ms));
    },
    qualifyCount(): number {
      return Number(getSetting("qualify_count") ?? 150);
    },
    setQualifyCount(n: number) {
      setSetting("qualify_count", String(n));
    },
    published(): boolean {
      return getSetting("published") === "1";
    },
    setPublished(on: boolean) {
      setSetting("published", on ? "1" : "0");
    },

    // ── Teams ──
    teams(): TeamRow[] {
      return db.prepare("select * from teams order by code").all() as unknown as TeamRow[];
    },
    teamByCode(code: string): TeamRow | null {
      return (db.prepare("select * from teams where code = ?").get(code) as unknown as TeamRow | undefined) ?? null;
    },
    teamById(id: number): TeamRow | null {
      return (db.prepare("select * from teams where id = ?").get(id) as unknown as TeamRow | undefined) ?? null;
    },
    upsertTeams(rows: { code: string; name: string }[]) {
      tx(() => {
        const st = db.prepare("insert into teams (code, name) values (?, ?) on conflict (code) do update set name = excluded.name");
        for (const r of rows) st.run(r.code, r.name);
      });
    },
    updateTeam(id: number, patch: { disqualified?: boolean; penalty?: number }) {
      if (patch.disqualified !== undefined) db.prepare("update teams set disqualified = ? where id = ?").run(patch.disqualified ? 1 : 0, id);
      if (patch.penalty !== undefined) db.prepare("update teams set penalty = ? where id = ?").run(patch.penalty, id);
    },

    // ── Cards ──
    problemCards(): ProblemCard[] {
      return db.prepare("select * from problem_cards order by number").all() as unknown as ProblemCard[];
    },
    crisisCards(): CrisisCard[] {
      return db.prepare("select * from crisis_cards order by number").all() as unknown as CrisisCard[];
    },
    priceCards(): PriceCard[] {
      return (db.prepare("select data from price_cards order by key").all() as { data: string }[]).map((r) => JSON.parse(r.data) as PriceCard);
    },
    replaceProblemCards(cards: ProblemCard[]) {
      tx(() => {
        db.exec("delete from problem_cards");
        const st = db.prepare("insert into problem_cards (number, title, body) values (?, ?, ?)");
        for (const c of cards) st.run(c.number, c.title, c.body);
      });
    },
    replaceCrisisCards(cards: CrisisCard[]) {
      tx(() => {
        db.exec("delete from crisis_cards");
        const st = db.prepare("insert into crisis_cards (number, category, title, body) values (?, ?, ?, ?)");
        for (const c of cards) st.run(c.number, c.category, c.title, c.body);
      });
    },
    replacePriceCards(cards: PriceCard[]) {
      tx(() => {
        db.exec("delete from price_cards");
        const st = db.prepare("insert into price_cards (key, data) values (?, ?)");
        for (const c of cards) st.run(c.key, JSON.stringify(c));
      });
    },

    // ── Deals ──
    deals(): { team_id: number; problem_number: number; crisis_number: number }[] {
      return db.prepare("select * from deals").all() as unknown as { team_id: number; problem_number: number; crisis_number: number }[];
    },
    dealFor(teamId: number): { problem_number: number; crisis_number: number } | null {
      return (db.prepare("select problem_number, crisis_number from deals where team_id = ?").get(teamId) as
        | { problem_number: number; crisis_number: number }
        | undefined) ?? null;
    },
    replaceDeals(rows: { teamId: number; problem: number; crisis: number }[]) {
      tx(() => {
        db.exec("delete from deals");
        const st = db.prepare("insert into deals (team_id, problem_number, crisis_number) values (?, ?, ?)");
        for (const r of rows) st.run(r.teamId, r.problem, r.crisis);
      });
    },

    // ── Submissions ──
    submission(teamId: number, round: RoundNo): SubmissionRow | null {
      const r = db.prepare("select * from submissions where team_id = ? and round = ?").get(teamId, round) as Record<string, unknown> | undefined;
      return r ? parseSubmission(r) : null;
    },
    submissions(round?: RoundNo): SubmissionRow[] {
      const rows = (round === undefined
        ? db.prepare("select * from submissions").all()
        : db.prepare("select * from submissions where round = ?").all(round)) as Record<string, unknown>[];
      return rows.map(parseSubmission);
    },
    saveSubmission(teamId: number, round: RoundNo, content: Content, words: number, complete: boolean, at: number) {
      db.prepare(
        `insert into submissions (team_id, round, content, words, complete, saved_at) values (?, ?, ?, ?, ?, ?)
         on conflict (team_id, round) do update set content = excluded.content, words = excluded.words,
           complete = excluded.complete, saved_at = excluded.saved_at`,
      ).run(teamId, round, JSON.stringify(content), words, complete ? 1 : 0, at);
    },

    // ── Judgements ──
    judgement(teamId: number, round: RoundNo): JudgementRow | null {
      const r = db.prepare("select * from judgements where team_id = ? and round = ?").get(teamId, round) as Record<string, unknown> | undefined;
      return r ? parseJudgement(r) : null;
    },
    judgements(round?: RoundNo): JudgementRow[] {
      const rows = (round === undefined
        ? db.prepare("select * from judgements").all()
        : db.prepare("select * from judgements where round = ?").all(round)) as Record<string, unknown>[];
      return rows.map(parseJudgement);
    },
    saveJudgement(j: Omit<JudgementRow, "judged_at">, at: number) {
      db.prepare(
        `insert into judgements (team_id, round, runs, score, breakdown, rationale, model, removed_lines, error, judged_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (team_id, round) do update set runs = excluded.runs, score = excluded.score, breakdown = excluded.breakdown,
           rationale = excluded.rationale, model = excluded.model, removed_lines = excluded.removed_lines, error = excluded.error,
           judged_at = excluded.judged_at`,
      ).run(
        j.team_id,
        j.round,
        JSON.stringify(j.runs),
        j.score,
        j.breakdown === null ? null : JSON.stringify(j.breakdown),
        j.rationale,
        j.model,
        JSON.stringify(j.removed_lines),
        j.error,
        at,
      );
    },
    clearJudgements(round: RoundNo) {
      db.prepare("delete from judgements where round = ?").run(round);
    },
  };
}
