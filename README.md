# PRIMUS Screening Round

A simple submission dashboard for the Market Simulation Competition's screening round. Each team gets a problem card
and writes a product idea (up to **800 words**), then gets a crisis card and writes a plan to save its product (up to
**400 words**). Organisers watch submissions come in, read any team's work, and download everything as one CSV to mark.
There is no automatic judging.

It is a small, standalone app: Node 22, TypeScript, Express, and one SQLite file (Node's built-in `node:sqlite`).
There is no database server to set up and no build step.

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

## Run it

You need Node 22.5 or newer (`node -v`).

```bash
npm install
cp .env.example .env      # set SESSION_SECRET, LOGIN_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000 for teams, http://localhost:3000/admin for organisers
```

## On the day

1. **Before:** open `/admin`. Import the teams (CSV `code,name`), set the start time and durations, check the cards
   (sample decks the ZIPGO case loads on first start), then **Hand out the case**. Download the login sheet and
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
npm test          # word limits, timetable, dealing, and a full session through the web routes
npm run typecheck
```

| Path | What |
|---|---|
| `src/rules.ts` | The timetable, the two forms and their word limits, dealing |
| `src/service.ts` | What a team sees, saving a round, dealing the cards |
| `src/app.ts` | The JSON routes, the CSV exports and the static pages |
| `src/db.ts` | The SQLite schema and queries |
| `public/` | The team page (`index.html`) and the organiser console (`admin.html`) |

## Deploy

Any host that runs Node 22 with a persistent disk works (a small VM, Render, Railway, Fly.io). Keep `DATABASE_PATH`
on the persistent disk, serve over HTTPS and set `SECURE_COOKIES=1`. Vercel's serverless functions do not keep files
between requests, so they are not a fit for this app as built.
