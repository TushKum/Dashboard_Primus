// Storage: one SQLite file (Node's built-in node:sqlite), so the app runs on any small server with no database to set
// up. Every write that matters (a save, a deal) is a single statement or a transaction.

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TIMETABLE, type Content, type CrisisCard, type ProblemCard, type RoundNo, type Timetable } from "./rules.ts";

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);
create table if not exists teams (
  id integer primary key,
  code text not null unique,
  name text not null
);
create table if not exists problem_cards (number integer primary key, title text not null, body text not null);
create table if not exists crisis_cards (number integer primary key, category text not null, title text not null, body text not null);
create table if not exists deals (
  team_id integer primary key references teams (id) on delete cascade,
  problem_number integer not null,
  crisis_number integer not null
);
create table if not exists submissions (
  team_id integer not null references teams (id) on delete cascade,
  round integer not null check (round between 1 and 2),
  content text not null,
  words integer not null,
  complete integer not null,
  saved_at integer not null,
  primary key (team_id, round)
);
`;

export interface TeamRow {
  id: number;
  code: string;
  name: string;
}

export interface SubmissionRow {
  team_id: number;
  round: RoundNo;
  content: Content;
  words: number;
  complete: boolean;
  saved_at: number;
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
    timetable(): Timetable {
      const v = getSetting("timetable");
      return v === null ? DEFAULT_TIMETABLE : (JSON.parse(v) as Timetable);
    },
    setTimetable(t: Timetable) {
      setSetting("timetable", JSON.stringify(t));
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

    // ── Cards ──
    problemCards(): ProblemCard[] {
      return db.prepare("select * from problem_cards order by number").all() as unknown as ProblemCard[];
    },
    crisisCards(): CrisisCard[] {
      return db.prepare("select * from crisis_cards order by number").all() as unknown as CrisisCard[];
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
  };
}
