# PRIMUS Screening Round

A simple submission dashboard for the Market Simulation Competition's screening round. Each team gets a problem card
and writes a product idea (up to **800 words**), then gets a crisis card and writes a plan to save its product (up to
**400 words**). Organisers watch submissions come in, read any team's work, and download everything as one CSV to mark.
There is no automatic judging.

It is a small Express app in TypeScript with a Postgres database. It deploys to Vercel as one function, with the pages
served by Vercel's CDN. Locally it needs no database server: without `DATABASE_URL` it keeps its data in an embedded
Postgres (PGlite) under `data/pglite`.

## The two rounds

The case is the ZIPGO Mobility Case Competition, the same for every team. Each team sees a round's brief only when
that round opens, so nobody can read the crisis early.

| Round | Default time | Brief | What a team writes | Word limit |
|---|---|---|---|---|
| 1. Product | 60 min | Build the next affordable urban mobility brand (an electric mobility startup for students and young professionals) | Brand name, product or service and its USP, target audience, pricing, marketing and competition, how it makes money, expansion to more cities | 800 |
| 2. Crisis | 45 min | The Unrestricted Ride: ZIPGO's bicycles keep running after the paid time and customers are charged extra | Technology, pricing, customer retention, revenue, financial viability, the revised business model | 400 |

A briefing (default 15 minutes) comes first; all three durations can be changed in the console. The word limit counts
every text field of the round together (names and ₹ amounts are not counted). The form saves as teams type and locks
on the server's clock when the round ends: whatever is saved then is what gets handed in.

## Run it locally

You need Node 22 or newer (`node -v`).

```bash
npm install
cp .env.example .env      # set SESSION_SECRET, LOGIN_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000 for teams, http://localhost:3000/admin for organisers
```

## Deploy on Vercel

1. **Import the repo:** Vercel → Add New → Project → `TushKum/Dashboard_Primus`. Vercel detects Express; keep the
   default build settings.
2. **Add a database:** in the project, Storage (or Marketplace) → Neon Postgres → create and connect it to the
   project. That sets `DATABASE_URL` for every environment. Any Postgres works: paste its URL as `DATABASE_URL`.
3. **Add the settings:** Settings → Environment Variables → `SESSION_SECRET`, `LOGIN_SECRET`, `ADMIN_PASSWORD`
   (Production, and Preview if you use it).
4. **Deploy** (or redeploy after adding variables). Open `https://<project>.vercel.app/admin`. The tables and the ZIPGO
   case are created on the first request. If a setting is missing, every page says which one.

To reset after a rehearsal, run this in the Neon SQL editor, then reload `/admin`:

```sql
drop table if exists submissions, deals, crisis_cards, problem_cards, teams, settings cascade;
```

## On the day

1. **Before:** open `/admin`. Import the teams (CSV `code,name`), set the start time and durations,
   check the case is loaded (the ZIPGO case loads on first start), then **Hand out the case**. Download the login sheet and
   hand each team its code and password. Passwords come from `LOGIN_SECRET`, so the sheet can be reprinted any time.
2. **During:** teams sign in at `/`. Each round's brief appears when the round opens. The Submissions table shows each
   team's word count, whether every field is filled in, and when it last saved.
3. **After:** click a team code to read its work in full, or **Download all (CSV)**: one row per team, one column per
   field, with the brief each team got.

## The case

- `data/problem-cards.csv`: the Round 1 brief (`number,title,body`)
- `data/crisis-cards.csv`: the Round 2 crisis (`number,category,title,body`)

These load into a new database on first start. To use a different case, upload new CSVs in the console under Case
(several rows per file spread different briefs evenly across teams), then hand it out again before Round 1 opens.

## Develop

```bash
npm test          # word limits, timetable, handing out, and a full session through the routes (embedded Postgres)
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test   # the same session through the pg driver on a throwaway Postgres
```

| Path | What |
|---|---|
| `src/index.ts` | The app from the environment: Vercel's entry point (its default export) |
| `src/local.ts` | `npm start`: the same app on a local port |
| `src/routes.ts` | The JSON routes and the CSV exports |
| `src/service.ts` | What a team sees, saving a round, handing out the case |
| `src/rules.ts` | The timetable, the two forms and their word limits |
| `src/db.ts` | The Postgres schema and queries (pg on Vercel, PGlite locally and in tests) |
| `src/case.ts` | The ZIPGO case a new database starts with |
| `public/` | The team page (`index.html`) and the organiser console (`admin.html`) |
