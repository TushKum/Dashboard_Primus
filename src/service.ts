// The screening round's actions, on top of the database and the rules: what a team sees, saving a round, dealing the
// cards, judging a round and the results. The web routes (app.ts) only check who is calling and pass through.

import { randomInt } from "node:crypto";
import type { Db, TeamRow } from "./db.ts";
import { buildRequest, judgeSubmission, loadPrompt, pool, type JudgeFn } from "./judge.ts";
import {
  FORMS,
  ROUNDS,
  RUBRICS,
  checkForm,
  dealEvenly,
  formatRupees,
  marketCostPaise,
  monthlyProfitPaise,
  parseRupees,
  priceTable,
  roundIsOpen,
  roundOpened,
  roundWindows,
  rubricMax,
  scoreTeams,
  shuffle,
  stageAt,
  type Content,
  type PriceCard,
  type RoundNo,
  type TeamResult,
} from "./rules.ts";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  running: boolean;
  errors: string[];
}

export function createService(db: Db, opts: { judge: JudgeFn; concurrency?: number; random?: () => number }) {
  const random = opts.random ?? (() => randomInt(0, 2 ** 32) / 2 ** 32);
  const progress = new Map<RoundNo, Progress>();

  const priceCardFor = (teamId: number): PriceCard | null => {
    const cards = db.priceCards();
    const type = db.submission(teamId, 1)?.content.productType;
    return cards.find((c) => c.key === type) ?? cards[0] ?? null;
  };

  /** The cost the market uses and, when a price was chosen, the monthly profit. */
  const pricingOf = (teamId: number) => {
    const card = priceCardFor(teamId);
    if (!card) return null;
    const r1 = parseRupees(db.submission(teamId, 1)?.content.cost);
    const r2 = parseRupees(db.submission(teamId, 2)?.content.costAfterFix);
    const cost = marketCostPaise(card, r1, r2);
    const mrp = Number(db.submission(teamId, 3)?.content.mrp);
    const chosen = card.demand.some((d) => d.mrpPaise === mrp) ? mrp : null;
    return { card, cost, mrp: chosen, profit: chosen === null ? null : monthlyProfitPaise(card, cost, chosen) };
  };

  const priceCardText = (card: PriceCard, cost: number) =>
    [
      `Product type: ${card.label}`,
      `Share of the MRP that reaches the company: ${(card.shareBp / 100).toFixed(1)}%`,
      `Benchmark cost per pack: ${formatRupees(card.benchmarkCostPaise)}`,
      `Competitors: ${card.competitors.map((c) => `${c.name} at ${formatRupees(c.mrpPaise)}`).join("; ")}`,
      "Demand table (MRP → packs sold a month → profit a month at this team's cost):",
      ...priceTable(card, cost).map(
        (r) => `- ${formatRupees(r.mrpPaise)} → ${r.packs.toLocaleString("en-IN")} packs → ${r.monthlyProfitPaise > 0 ? formatRupees(r.monthlyProfitPaise) : "loss"}`,
      ),
    ].join("\n");

  const results = (): TeamResult[] => {
    const judgements = db.judgements();
    return scoreTeams(
      db.teams().map((t) => {
        const p = pricingOf(t.id);
        return {
          teamId: String(t.id),
          code: t.code,
          name: t.name,
          disqualified: t.disqualified === 1,
          penalty: t.penalty,
          judge: Object.fromEntries(ROUNDS.map((r) => [r, judgements.find((j) => j.team_id === t.id && j.round === r)?.score ?? null])),
          pricing: p && p.mrp !== null && p.profit !== null ? { cardKey: p.card.key, profitPaise: p.profit } : null,
        };
      }),
      db.qualifyCount(),
    );
  };

  return {
    results,
    pricingOf,

    teamState(team: TeamRow, now: number) {
      const startsAt = db.startsAt();
      const deal = db.dealFor(team.id);
      const problem = deal && roundOpened(startsAt, 1, now) ? db.problemCards().find((c) => c.number === deal.problem_number) ?? null : null;
      const crisis = deal && roundOpened(startsAt, 2, now) ? db.crisisCards().find((c) => c.number === deal.crisis_number) ?? null : null;
      const p = roundOpened(startsAt, 3, now) ? pricingOf(team.id) : null;
      const published = db.published();
      const mine = published ? results().find((r) => r.teamId === String(team.id)) ?? null : null;
      return {
        now,
        team: { code: team.code, name: team.name },
        startsAt,
        stage: stageAt(startsAt, now),
        windows: startsAt === null ? [] : roundWindows(startsAt),
        forms: FORMS,
        rubrics: RUBRICS,
        productTypes: db.priceCards().map((c) => ({ key: c.key, label: c.label })),
        cards: {
          problem,
          crisis,
          price: p ? { ...p.card, costPaise: p.cost, table: priceTable(p.card, p.cost) } : null,
        },
        submissions: Object.fromEntries(ROUNDS.map((r) => [r, db.submission(team.id, r)])),
        results: mine
          ? {
              ...mine,
              verdicts: Object.fromEntries(
                ROUNDS.map((r) => {
                  const j = db.judgement(team.id, r);
                  return [r, j && j.score !== null ? { score: j.score, max: rubricMax(r), breakdown: j.breakdown, rationale: j.rationale } : null];
                }),
              ),
            }
          : null,
      };
    },

    save(team: TeamRow, round: RoundNo, content: Content, now: number) {
      if (team.disqualified) throw new ActionError("Your team is disqualified.", 403);
      if (!roundIsOpen(db.startsAt(), round, now)) throw new ActionError(`Round ${round} is not open: the form is locked.`, 409);
      if (!db.dealFor(team.id)) throw new ActionError("Your cards have not been dealt yet. Tell an organiser.", 409);
      const ctx =
        round === 1
          ? { productTypes: db.priceCards().map((c) => c.key) }
          : round === 3
            ? { mrpChoices: priceCardFor(team.id)?.demand.map((d) => d.mrpPaise) ?? [] }
            : {};
      const check = checkForm(round, content, ctx);
      const blocking = check.errors.filter((e) => !e.endsWith("is empty"));
      if (blocking.length) throw new ActionError(blocking.join(". "));
      db.saveSubmission(team.id, round, check.clean, check.words, check.ok, now);
      return { words: check.words, complete: check.ok, missing: check.errors, savedAt: now };
    },

    deal(now: number, force = false) {
      if (!force && roundOpened(db.startsAt(), 1, now)) throw new ActionError("Round 1 has started: the cards can no longer be re-dealt.", 409);
      const teams = db.teams();
      const problems = db.problemCards();
      const crises = db.crisisCards();
      if (!teams.length) throw new ActionError("Import the teams first.");
      if (!problems.length || !crises.length) throw new ActionError("Load the problem and crisis cards first.");
      const p = dealEvenly(shuffle(teams.map((t) => String(t.id)), random), problems);
      const c = dealEvenly(shuffle(teams.map((t) => String(t.id)), random), crises);
      db.replaceDeals(teams.map((t) => ({ teamId: t.id, problem: p.get(String(t.id))!.number, crisis: c.get(String(t.id))!.number })));
      return { teams: teams.length, problemCards: problems.length, crisisCards: crises.length };
    },

    progress(round: RoundNo): Progress | null {
      return progress.get(round) ?? null;
    },

    /** Judges every saved submission of a closed round that has no score yet (or all of them with `rejudge`). */
    async judgeRound(round: RoundNo, now: number, rejudge = false): Promise<Progress> {
      if (progress.get(round)?.running) throw new ActionError(`Round ${round} is already being judged.`, 409);
      const startsAt = db.startsAt();
      if (startsAt === null || now < roundWindows(startsAt)[round - 1]!.closesAt) throw new ActionError(`Round ${round} has not closed yet.`, 409);
      const system = loadPrompt(round);
      const done = new Set(db.judgements(round).filter((j) => j.score !== null).map((j) => j.team_id));
      const todo = db
        .submissions(round)
        .filter((s) => (round === 3 ? s.content.mrp || s.words > 0 : s.words > 0))
        .filter((s) => rejudge || !done.has(s.team_id));
      const state: Progress = { total: todo.length, done: 0, failed: 0, running: true, errors: [] };
      progress.set(round, state);
      try {
        await pool(todo, opts.concurrency ?? 5, async (s) => {
          const deal = db.dealFor(s.team_id);
          const crisis = deal ? db.crisisCards().find((c) => c.number === deal.crisis_number) ?? null : null;
          const pitch = db.submission(s.team_id, 1)?.content ?? null;
          const p = round === 3 ? pricingOf(s.team_id) : null;
          const req = buildRequest(round, s.content, {
            pitch,
            productTypeLabel: db.priceCards().find((c) => c.key === pitch?.productType)?.label,
            crisisCard: crisis,
            crisisPlan: db.submission(s.team_id, 2)?.content ?? null,
            ...(p
              ? {
                  priceCardText: priceCardText(p.card, p.cost),
                  marketLine:
                    p.mrp === null
                      ? "No valid price was chosen."
                      : `Chosen MRP ${formatRupees(p.mrp)}; cost per pack used ${formatRupees(p.cost)}; monthly profit ${p.profit! > 0 ? formatRupees(p.profit!) : "a loss"}.`,
                }
              : {}),
          });
          try {
            const v = await judgeSubmission(opts.judge, round, system, req.text);
            db.saveJudgement(
              { team_id: s.team_id, round, runs: v.runs, score: v.score, breakdown: v.shown.breakdown, rationale: v.shown.rationale, model: v.shown.model, removed_lines: req.removed, error: null },
              Date.now(),
            );
            state.done++;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            db.saveJudgement(
              { team_id: s.team_id, round, runs: [], score: null, breakdown: null, rationale: null, model: null, removed_lines: req.removed, error: message.slice(0, 500) },
              Date.now(),
            );
            state.failed++;
            if (state.errors.length < 5) state.errors.push(message.slice(0, 200));
          }
        });
      } finally {
        state.running = false;
      }
      return state;
    },
  };
}

export type Service = ReturnType<typeof createService>;
