// Storage: Postgres. On Vercel (or any host) set DATABASE_URL (Vercel's Neon integration sets it; POSTGRES_URL works
// too). Without one, the app runs an embedded Postgres (PGlite) in a local folder, so `npm start` needs no setup;
// the tests use it in memory. Every query goes through `q`, so both behave the same.

import { DEFAULT_TIMETABLE, type Content, type CrisisCard, type ProblemCard, type RoundNo, type Timetable } from "./rules.js";

/** The one thing the app needs from a database: run a query, get rows back. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs several statements with no parameters (the schema). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in one transaction (all or nothing). */
  transaction<T>(fn: (tx: Pick<Sql, "query">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);
create table if not exists teams (
  id serial primary key,
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
  complete boolean not null,
  saved_at bigint not null,
  primary key (team_id, round)
);
`;

/**
 * Splits `sslmode` (or `ssl`) off a Postgres URL. The driver obeys whatever the URL says and ignores the `ssl`
 * option beside it, so the app takes the setting out of the URL and decides for itself (`tlsFor` below).
 * Only the query string is touched, and only after the last `@`, so a password with a `?` or `&` is left alone.
 */
export function splitSsl(url: string): { url: string; mode: string | null } {
  const at = url.lastIndexOf("@");
  const q = url.indexOf("?", at + 1);
  if (q === -1) return { url, mode: null };
  let mode: string | null = null;
  const kept: string[] = [];
  for (const part of url.slice(q + 1).split("&")) {
    const [k, v = ""] = part.split("=");
    if (k?.toLowerCase() === "sslmode") mode = v.toLowerCase();
    else if (k?.toLowerCase() === "ssl") mode = v === "0" || v.toLowerCase() === "false" ? "disable" : "require";
    else if (part !== "") kept.push(part);
  }
  return { url: url.slice(0, q) + (kept.length ? `?${kept.join("&")}` : ""), mode };
}

export type Tls = { ssl: false | { rejectUnauthorized: boolean }; mayRelax: boolean };

/**
 * What TLS to use. A local database needs none. `verify-ca` and `verify-full` are strict, as asked. Everything
 * else (including a plain URL, and `require`, which in Postgres itself means "encrypt", not "verify") is tried
 * verified first and may fall back to encrypted-but-unverified: managed hosts such as Supabase often present a
 * certificate chain that a server does not trust, and without this nothing connects at all.
 */
export function tlsFor(url: string, mode: string | null): Tls {
  const local = /@(localhost|127\.0\.0\.1|\[::1\]|::1)([:/?]|$)/i.test(url);
  if (mode === "disable" || (mode === null && local)) return { ssl: false, mayRelax: false };
  if (mode === "no-verify") return { ssl: { rejectUnauthorized: false }, mayRelax: false };
  if (mode === "verify-ca" || mode === "verify-full") return { ssl: { rejectUnauthorized: true }, mayRelax: false };
  return { ssl: { rejectUnauthorized: true }, mayRelax: !local };
}

/** Node's TLS errors that mean "this certificate chain is not trusted here", as opposed to a real refusal. */
const UNTRUSTED_CERT = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export const isUntrustedCert = (e: unknown): boolean => UNTRUSTED_CERT.has(String((e as { code?: unknown } | null)?.code ?? ""));

export async function pgSql(url: string): Promise<Sql> {
  const { default: pg } = await import("pg");
  const { url: connectionString, mode } = splitSsl(url);
  const tls = tlsFor(url, mode);
  // Small pool: on Vercel each function instance holds its own. Use the provider's pooled URL where offered.
  const options = { connectionString, max: 3, idleTimeoutMillis: 10_000 };
  let pool = new pg.Pool({ ...options, ssl: tls.ssl });
  let relaxed = !tls.mayRelax;

  /** Runs a piece of work on the pool; on an untrusted certificate, drops verification once and runs it again. */
  const run = async <T>(work: (p: InstanceType<typeof pg.Pool>) => Promise<T>): Promise<T> => {
    try {
      return await work(pool);
    } catch (e) {
      if (relaxed || !isUntrustedCert(e)) throw e;
      relaxed = true;
      console.warn(
        "Postgres TLS: the database's certificate is not signed by a certificate authority this machine trusts, " +
          "so the connection is encrypted but not verified. Add ?sslmode=verify-full to the database URL (with the " +
          "provider's CA certificate installed) to make it strict, or ?sslmode=no-verify to accept this silently.",
      );
      await pool.end().catch(() => undefined);
      pool = new pg.Pool({ ...options, ssl: { rejectUnauthorized: false } });
      return work(pool);
    }
  };

  return {
    query: (text, params) => run((p) => p.query(text, params as unknown[])) as never,
    exec: async (text) => {
      await run((p) => p.query(text));
    },
    // The whole transaction is retried, so nothing is half-applied: a certificate failure happens before `begin`.
    transaction: (fn) =>
      run(async (p) => {
        const client = await p.connect();
        try {
          await client.query("begin");
          const out = await fn({ query: (text, params) => client.query(text, params as unknown[]) as never });
          await client.query("commit");
          return out;
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      }),
    close: () => pool.end(),
  };
}

/** Embedded Postgres: in memory without a folder (tests), or kept in `dataDir` (local runs). */
export async function pgliteSql(dataDir?: string): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    query: (text, params) => db.query(text, params) as never,
    exec: async (text) => {
      await db.exec(text);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
    close: () => db.close(),
  };
}

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

export interface DealRow {
  team_id: number;
  problem_number: number;
  crisis_number: number;
}

export type Db = Awaited<ReturnType<typeof openDb>>;

const toSubmission = (r: Record<string, unknown>): SubmissionRow => ({
  team_id: Number(r.team_id),
  round: Number(r.round) as RoundNo,
  content: JSON.parse(String(r.content)) as Content,
  words: Number(r.words),
  complete: r.complete === true,
  saved_at: Number(r.saved_at),
});
const toTeam = (r: Record<string, unknown>): TeamRow => ({ id: Number(r.id), code: String(r.code), name: String(r.name) });
const toDeal = (r: Record<string, unknown>): DealRow => ({
  team_id: Number(r.team_id),
  problem_number: Number(r.problem_number),
  crisis_number: Number(r.crisis_number),
});

export async function openDb(sql: Sql) {
  await sql.exec(SCHEMA);
  const q = sql.query.bind(sql);

  const getSetting = async (key: string): Promise<string | null> =>
    ((await q<{ value: string }>("select value from settings where key = $1", [key])).rows[0]?.value ?? null);
  const setSetting = async (key: string, value: string | null) => {
    if (value === null) await q("delete from settings where key = $1", [key]);
    else await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
  };

  return {
    close: () => sql.close(),

    // ── Settings ──
    async startsAt(): Promise<number | null> {
      const v = await getSetting("starts_at");
      return v === null ? null : Number(v);
    },
    setStartsAt: (ms: number | null) => setSetting("starts_at", ms === null ? null : String(ms)),
    async timetable(): Promise<Timetable> {
      const v = await getSetting("timetable");
      return v === null ? DEFAULT_TIMETABLE : (JSON.parse(v) as Timetable);
    },
    setTimetable: (t: Timetable) => setSetting("timetable", JSON.stringify(t)),

    // ── Teams ──
    async teams(): Promise<TeamRow[]> {
      return (await q("select * from teams order by code")).rows.map(toTeam);
    },
    async teamByCode(code: string): Promise<TeamRow | null> {
      const r = (await q("select * from teams where code = $1", [code])).rows[0];
      return r ? toTeam(r) : null;
    },
    async teamById(id: number): Promise<TeamRow | null> {
      const r = (await q("select * from teams where id = $1", [id])).rows[0];
      return r ? toTeam(r) : null;
    },
    upsertTeams: (rows: { code: string; name: string }[]) =>
      sql.transaction(async (tx) => {
        for (const r of rows) await tx.query("insert into teams (code, name) values ($1, $2) on conflict (code) do update set name = excluded.name", [r.code, r.name]);
      }),

    // ── Cards ──
    async problemCards(): Promise<ProblemCard[]> {
      return (await q("select * from problem_cards order by number")).rows.map((r) => ({ number: Number(r.number), title: String(r.title), body: String(r.body) }));
    },
    async crisisCards(): Promise<CrisisCard[]> {
      return (await q("select * from crisis_cards order by number")).rows.map((r) => ({
        number: Number(r.number),
        category: String(r.category),
        title: String(r.title),
        body: String(r.body),
      }));
    },
    replaceProblemCards: (cards: ProblemCard[]) =>
      sql.transaction(async (tx) => {
        await tx.query("delete from problem_cards");
        for (const c of cards) await tx.query("insert into problem_cards (number, title, body) values ($1, $2, $3)", [c.number, c.title, c.body]);
      }),
    replaceCrisisCards: (cards: CrisisCard[]) =>
      sql.transaction(async (tx) => {
        await tx.query("delete from crisis_cards");
        for (const c of cards) await tx.query("insert into crisis_cards (number, category, title, body) values ($1, $2, $3, $4)", [c.number, c.category, c.title, c.body]);
      }),

    // ── Deals ──
    async deals(): Promise<DealRow[]> {
      return (await q("select * from deals")).rows.map(toDeal);
    },
    async dealFor(teamId: number): Promise<DealRow | null> {
      const r = (await q("select * from deals where team_id = $1", [teamId])).rows[0];
      return r ? toDeal(r) : null;
    },
    replaceDeals: (rows: { teamId: number; problem: number; crisis: number }[]) =>
      sql.transaction(async (tx) => {
        await tx.query("delete from deals");
        for (const r of rows) await tx.query("insert into deals (team_id, problem_number, crisis_number) values ($1, $2, $3)", [r.teamId, r.problem, r.crisis]);
      }),

    // ── Submissions ──
    async submission(teamId: number, round: RoundNo): Promise<SubmissionRow | null> {
      const r = (await q("select * from submissions where team_id = $1 and round = $2", [teamId, round])).rows[0];
      return r ? toSubmission(r) : null;
    },
    async submissions(): Promise<SubmissionRow[]> {
      return (await q("select * from submissions")).rows.map(toSubmission);
    },
    async saveSubmission(teamId: number, round: RoundNo, content: Content, words: number, complete: boolean, at: number) {
      await q(
        `insert into submissions (team_id, round, content, words, complete, saved_at) values ($1, $2, $3, $4, $5, $6)
         on conflict (team_id, round) do update set content = excluded.content, words = excluded.words,
           complete = excluded.complete, saved_at = excluded.saved_at`,
        [teamId, round, JSON.stringify(content), words, complete, at],
      );
    },
  };
}

/** The database from the environment: DATABASE_URL or POSTGRES_URL, else embedded Postgres in `localDir`. */
export async function dbFromEnv(env: NodeJS.ProcessEnv, localDir: string): Promise<Db> {
  const url = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim();
  return openDb(url ? await pgSql(url) : await pgliteSql(localDir));
}
