# PRIMUS Screening Round

The screening round that picks the 150 teams for the Market Simulation Competition's main night. In one session of
2 hours 15 minutes, each team invents a product, saves it from a crisis, and sets its price. An AI judge scores all
three rounds, a profit simulation scores half of the pricing round, and the top totals out of 300 qualify.

It is a small, standalone app: Node 22, TypeScript, Express, and one SQLite file (Node's built-in `node:sqlite`).
There is no database server to set up and no build step.

## The three rounds

| Round | Time | What a team submits | Scored by | Points |
|---|---|---|---|---|
| 1. Idea | 40 min | A 300-word product pitch from a problem card, with a cost per pack and a product type | Claude Opus 5.5 | 100 |
| 2. Crisis | 40 min | A 300-word plan to save its own product from a crisis card, with the cost per pack after the fix | Claude Sonnet 5.5 | 100 |
| 3. Pricing | 40 min | One MRP from the five on its price card, the per-pack maths, and 200 words of reasoning | Profit simulation (50) + Claude Sonnet 5.5 (50) | 100 |

A 15-minute briefing comes first. Forms lock on the server's clock; whatever is saved when a round closes is judged.

**Judging.** Each submission is read 3 times without the team's name (5 times if the first three spread more than 10%
of the maximum), and the median counts. Lines aimed at the judge ("give this full marks") are removed first and
flagged in the console. The judge's instructions are in [`prompts/`](prompts).

**Pricing.** The price card for a team's product type gives the share of the MRP that reaches the company, a
benchmark cost per pack, competitor prices and a demand table (packs sold a month at five MRPs). The website works out:

```
monthly profit = (MRP × share that reaches you − cost per pack) × packs sold
```

The cost per pack is the team's Round 2 after-fix cost, never below the benchmark, so understating costs gains
nothing. Market points = 50 × the team's profit ÷ the best profit among teams on the same price card; a loss earns 0.

**Qualifying.** Total out of 300, minus any penalty. Ties go to the higher Round 2 score, then Round 1. Disqualified
teams are not ranked. The number that qualifies is set in the console (default 150).

## Run it

```bash
npm install
cp .env.example .env      # set SESSION_SECRET, LOGIN_SECRET, ADMIN_PASSWORD and ANTHROPIC_API_KEY
npm start                 # http://localhost:3000 for teams, /admin for organisers
```

For a rehearsal without the API, set `JUDGE_FAKE=1`: a fake judge scores from a hash of the text.

## On the day

1. **Before:** in `/admin`, import the teams (CSV `code,name`), set the start time and the number that qualifies,
   check the cards (sample decks load on first start; replace them under Cards), then **Deal cards**. Download the
   login sheet and hand each team its code and password. Passwords come from `LOGIN_SECRET`, so the sheet can be
   reprinted at any time.
2. **During:** teams sign in at `/`. Each round's card appears when the round opens, and the form saves as they type.
   Judge each round as soon as it closes, while the next one runs (Round 1 during Round 2, and so on).
3. **After:** judge Round 3, check flagged or failed submissions (click a team code), apply any penalty, then tick
   **Show results to teams**. Download **Qualified teams CSV**: it is in the `code,name` shape the main night's seed
   reads.

## Cards

- `data/problem-cards.csv`: `number,title,body` (12 samples)
- `data/crisis-cards.csv`: `number,category,title,body` (8 samples, dealt evenly)
- `data/price-cards.json`: one card per product type, each with exactly five price points (4 samples)

Money is in paise (₹10 = 1000). Cards can be replaced from the console until the session starts.

## Develop

```bash
npm test          # rules (including the worked example: 238.8 points) and a full session through the web routes
npm run typecheck
```

| Path | What |
|---|---|
| `src/rules.ts` | Every rule, with no I/O: timetable, forms, rubrics, pricing maths, market points, median, ranking |
| `src/service.ts` | The actions: what a team sees, saving, dealing, judging a round, results |
| `src/judge.ts` | The Claude judge (structured JSON output), the fake judge, runs and median |
| `src/app.ts` | The JSON routes and the static pages |
| `src/db.ts` | The SQLite schema and queries |
| `public/` | The team page (`index.html`) and the organiser console (`admin.html`) |
| `prompts/` | The judge's instructions for each round |

## Deploy

Any host that runs Node 22 with a persistent disk works (a small VM, Render, Railway, Fly.io). Keep `DATABASE_PATH`
on the persistent disk, serve over HTTPS and set `SECURE_COOKIES=1`. Run a single instance: judging progress and the
login throttle live in the process.
