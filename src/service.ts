// The screening round's actions, on top of the database and the rules: what a team sees, saving a round and handing
// out the case. The web routes (routes.ts) only check who is calling and pass through.

import { randomInt } from "node:crypto";
import type { Db, TeamRow } from "./db.js";
import { FORMS, ROUNDS, checkForm, dealEvenly, roundIsOpen, roundOpened, roundWindows, shuffle, stageAt, type Content, type RoundNo } from "./rules.js";

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function createService(db: Db, opts: { random?: () => number } = {}) {
  const random = opts.random ?? (() => randomInt(0, 2 ** 32) / 2 ** 32);

  return {
    async teamState(team: TeamRow, now: number) {
      const [startsAt, t, deal] = await Promise.all([db.startsAt(), db.timetable(), db.dealFor(team.id)]);
      const problem = deal && roundOpened(startsAt, 1, now, t) ? (await db.problemCards()).find((c) => c.number === deal.problem_number) ?? null : null;
      const crisis = deal && roundOpened(startsAt, 2, now, t) ? (await db.crisisCards()).find((c) => c.number === deal.crisis_number) ?? null : null;
      const subs = await Promise.all(ROUNDS.map((r) => db.submission(team.id, r)));
      return {
        now,
        team: { code: team.code, name: team.name },
        startsAt,
        stage: stageAt(startsAt, now, t),
        windows: startsAt === null ? [] : roundWindows(startsAt, t),
        forms: FORMS,
        cards: { problem, crisis },
        submissions: Object.fromEntries(ROUNDS.map((r, i) => [r, subs[i]])),
      };
    },

    async save(team: TeamRow, round: RoundNo, content: Content, now: number) {
      const [startsAt, t, deal] = await Promise.all([db.startsAt(), db.timetable(), db.dealFor(team.id)]);
      if (!roundIsOpen(startsAt, round, now, t)) throw new ActionError(`Round ${round} is not open: the form is locked.`, 409);
      if (!deal) throw new ActionError("The case has not been handed out to your team yet. Tell an organiser.", 409);
      const check = checkForm(round, content);
      if (check.errors.length) throw new ActionError(check.errors.join(". "));
      const complete = check.missing.length === 0;
      await db.saveSubmission(team.id, round, check.clean, check.words, complete, now);
      return { words: check.words, complete, missing: check.missing, savedAt: now };
    },

    async deal(now: number, force = false) {
      const [startsAt, t, teams, problems, crises] = await Promise.all([db.startsAt(), db.timetable(), db.teams(), db.problemCards(), db.crisisCards()]);
      if (!force && roundOpened(startsAt, 1, now, t)) throw new ActionError("Round 1 has started: the case can no longer be handed out again.", 409);
      if (!teams.length) throw new ActionError("Import the teams first.");
      if (!problems.length || !crises.length) throw new ActionError("Load the Round 1 case and the Round 2 crisis first.");
      const p = dealEvenly(shuffle(teams.map((x) => String(x.id)), random), problems);
      const c = dealEvenly(shuffle(teams.map((x) => String(x.id)), random), crises);
      await db.replaceDeals(teams.map((x) => ({ teamId: x.id, problem: p.get(String(x.id))!.number, crisis: c.get(String(x.id))!.number })));
      return { teams: teams.length, problemCards: problems.length, crisisCards: crises.length };
    },
  };
}

export type Service = ReturnType<typeof createService>;
