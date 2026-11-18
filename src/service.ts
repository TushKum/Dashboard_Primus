// The screening round's actions, on top of the database and the rules: what a team sees, saving a round and dealing
// the cards. The web routes (app.ts) only check who is calling and pass through.

import { randomInt } from "node:crypto";
import type { Db, TeamRow } from "./db.ts";
import { FORMS, ROUNDS, checkForm, dealEvenly, roundIsOpen, roundOpened, roundWindows, shuffle, stageAt, type Content, type RoundNo } from "./rules.ts";

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
    teamState(team: TeamRow, now: number) {
      const startsAt = db.startsAt();
      const t = db.timetable();
      const deal = db.dealFor(team.id);
      return {
        now,
        team: { code: team.code, name: team.name },
        startsAt,
        stage: stageAt(startsAt, now, t),
        windows: startsAt === null ? [] : roundWindows(startsAt, t),
        forms: FORMS,
        cards: {
          problem: deal && roundOpened(startsAt, 1, now, t) ? db.problemCards().find((c) => c.number === deal.problem_number) ?? null : null,
          crisis: deal && roundOpened(startsAt, 2, now, t) ? db.crisisCards().find((c) => c.number === deal.crisis_number) ?? null : null,
        },
        submissions: Object.fromEntries(ROUNDS.map((r) => [r, db.submission(team.id, r)])),
      };
    },

    save(team: TeamRow, round: RoundNo, content: Content, now: number) {
      if (!roundIsOpen(db.startsAt(), round, now, db.timetable())) throw new ActionError(`Round ${round} is not open: the form is locked.`, 409);
      if (!db.dealFor(team.id)) throw new ActionError("The case has not been handed out to your team yet. Tell an organiser.", 409);
      const check = checkForm(round, content);
      if (check.errors.length) throw new ActionError(check.errors.join(". "));
      const complete = check.missing.length === 0;
      db.saveSubmission(team.id, round, check.clean, check.words, complete, now);
      return { words: check.words, complete, missing: check.missing, savedAt: now };
    },

    deal(now: number, force = false) {
      if (!force && roundOpened(db.startsAt(), 1, now, db.timetable())) throw new ActionError("Round 1 has started: the case can no longer be handed out again.", 409);
      const teams = db.teams();
      const problems = db.problemCards();
      const crises = db.crisisCards();
      if (!teams.length) throw new ActionError("Import the teams first.");
      if (!problems.length || !crises.length) throw new ActionError("Load the Round 1 case and the Round 2 crisis first.");
      const p = dealEvenly(shuffle(teams.map((t) => String(t.id)), random), problems);
      const c = dealEvenly(shuffle(teams.map((t) => String(t.id)), random), crises);
      db.replaceDeals(teams.map((t) => ({ teamId: t.id, problem: p.get(String(t.id))!.number, crisis: c.get(String(t.id))!.number })));
      return { teams: teams.length, problemCards: problems.length, crisisCards: crises.length };
    },
  };
}

export type Service = ReturnType<typeof createService>;
