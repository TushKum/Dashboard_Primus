# Working on this repository

Read this first. It is the handover for anyone — person or Claude — picking the project up.

## What this is

A submission dashboard for the **screening round** of a one-night college business competition (PRIMUS / Market
Simulation Competition, Thapar). Teams of 3–4 students log in, read a case, and write two pieces of work against a
clock. Organisers watch submissions arrive and download them to mark by hand.

**There is no scoring and no AI judging in this app.** That is deliberate: an earlier version had an AI judge, three
rounds and a pricing simulation, and the owner cut it back to a plain submission dashboard. Do not add judging,
scores, ranking or a third round unless the owner asks.

| | Round 1 | Round 2 |
|---|---|---|
| Name | Product | Crisis |
| Default length | 60 min | 45 min |
| Word limit | 800 | 400 |
| Brief | "Build the next affordable urban mobility brand" | "The Unrestricted Ride: ZIPGO" |

A briefing (default 15 min) comes first. The case is the **ZIPGO Mobility Case Competition**, supplied by the owner
as a .docx and now held in `src/case.ts` (built in, so it ships with the function) and `data/*.csv` (the same text,
for uploading or editing). Every team gets the same case; a team sees each round's brief only when that round opens.

- Repository: `TushKum/Dashboard_Primus` (GitHub), branch `main`.
- Separate project, do not confuse: `TushKum/shutUpV` is the **main night** platform (150 teams, trading, AI judges).
  This repo is only the screening round that picks teams for that night.

## How it is built

TypeScript, Express 5, Postgres. No build step and no framework: the pages are hand-written HTML/CSS/JS in `public/`.

| Path | What |
|---|---|
| `src/rules.ts` | The timetable, the two forms and their word limits, card dealing. Pure, no I/O — the spec the tests pin down |
| `src/service.ts` | The actions: what a team sees, saving a round, handing out the case |
| `src/routes.ts` | Express routes (`/api/...`), the CSV exports, static files |
| `src/db.ts` | Postgres: schema, queries, and the TLS handling described below |
| `src/case.ts` | The ZIPGO case a new database starts with |
| `src/index.ts` | The app built from the environment. **Vercel's entry point** (its default export) |
| `src/local.ts` | `npm start`: the same app on a local port |
| `src/auth.ts`, `src/csv.ts` | Password derivation and session cookies; CSV reading and writing |
| `public/` | `index.html` + `team.js` (teams), `admin.html` + `admin.js` (organisers), `app.css` |
| `test/` | `rules.test.ts`, `db.test.ts` (pure), `app.test.ts` (a whole session through the routes) |

```bash
npm install
npm start          # http://localhost:3000 teams, /admin organisers; needs .env (see .env.example)
npm test           # 23 tests, on an embedded Postgres (PGlite) — no setup
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test    # the same tests through the pg driver on a throwaway Postgres
```

`npm start` with no `DATABASE_URL` keeps data in an embedded Postgres under `data/pglite`; delete that folder to start
over. Tests use the same engine in memory.

## Things that will bite you

Each of these was found the hard way. Do not undo them without a reason.

1. **TLS to a managed Postgres.** The `pg` driver obeys an `sslmode` in the URL and **ignores** an `ssl` option passed
   beside it, and this version reads `sslmode=require` as full verification. So a bare Supabase URL connects
   unencrypted (and is refused), and `sslmode=require` fails outright. `src/db.ts` therefore strips `sslmode` from the
   URL (`splitSsl`) and decides itself (`tlsFor`): remote is always encrypted, verified first, falling back **once** to
   encrypted-but-unverified with a warning; `verify-ca`/`verify-full` stay strict. Verified against a real Postgres
   serving an untrusted certificate.
2. **Vercel keeps no files.** Hence Postgres, not SQLite. Anything written to disk at runtime is lost.
3. **`tsconfig.json` must not set `"types": ["node"]`** — Vercel's TypeScript step fails to resolve it and the whole
   build errors. (It compiles fine locally either way, so a local `tsc` will not catch this.)
4. **`tsx` is a runtime dependency**, not a dev one, so `npm start` works on a host that skips dev dependencies.
5. **Imports use `.js` extensions** (`./rules.js`) even though the files are `.ts` — NodeNext resolution. Keep it.
6. **`/admin` redirects to `/admin.html`**, because on Vercel the CDN serves `public/` and never reaches the app for a
   path with no extension.
7. **Missing settings do not crash.** `src/index.ts` builds an app that answers every request with which variable is
   absent, so a half-configured deployment explains itself.
8. **`LOGIN_SECRET` must never change** once login sheets are printed: every team's password is derived from it
   (HMAC of the team code), which is why no passwords are stored.
9. **The login throttle is per server instance.** On Vercel that means weaker than it looks. Fine here: passwords are
   random, and it is a student competition.
10. **Forms lock on the server's clock.** There is no submit button: whatever is saved when a round ends is the
    submission. The team page auto-saves ~2.5 s after typing stops.

## Checking work

- `npm test` and `npm run typecheck` before any push.
- For UI changes, drive the real pages in a browser (Playwright and Chromium are available in the cloud sandbox) and
  look at a screenshot at phone width (390px) as well as desktop. Several real bugs were caught that way.
- Before changing anything about deployment, run Vercel's own build — it has caught errors a local build does not:
  copy the repo to a scratch directory, add `.vercel/project.json` with `{"settings":{"framework":"express"}}`,
  `npm ci`, then `npx vercel build --yes`.

## State and what is left

Working and pushed: both rounds, the case, the organiser console (import teams, hand out the case, set the timetable,
watch submissions, read a team's work, download login sheet and a submissions CSV), Vercel entry point, Postgres with
the TLS handling, CI on GitHub Actions.

Not done yet, as of the last session:

- **Nothing has been deployed by the owner yet.** They bought Supabase Pro (on an account separate from GitHub/Vercel)
  and are setting it up from the deployment guide. Supabase's own screens were never verified from a real account.
- No custom domain, no rehearsal on the real site, no final team list, no confirmed date for the screening session.
- The timetable defaults (15 / 60 / 45 minutes) are guesses; the owner sets the real ones in the console.

## Writing style

The pages and all documents speak plainly to students and organisers under time pressure: short sentences, no jargon,
British spelling, "handed in" rather than "submitted to the judge". Error messages say what to do next. Keep comments
in the code explaining *why*, not what.

## Documents that go with this (Claude artifacts, owned by the owner, private unless shared)

- Screening round rules: https://claude.ai/artifact/QtcD42dmkTPLbZ88f46Khs
- Deployment guide (Supabase + Vercel, with the SQL): https://claude.ai/artifact/2pdv48Q2DUqJLGSRBs93Aa
- The main night's rules: https://claude.ai/artifact/NwFJwrWmzbTbWywCj5Yb3a
- The main night's worked demo: https://claude.ai/artifact/G29JeFyrsVBpHKva13UM2x

The deployment guide is the one to keep in step with any deployment change.
