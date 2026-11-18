// The screening round's rules, with no I/O: the timetable, the two forms and their word limits, and dealing the cards.

export type RoundNo = 1 | 2;
export const ROUNDS: readonly RoundNo[] = [1, 2];

export const ROUND_NAMES: Record<RoundNo, string> = { 1: "Product", 2: "Crisis" };

// ───────────────────────────── Timetable ─────────────────────────────

export interface Timetable {
  briefingMinutes: number;
  roundMinutes: Record<RoundNo, number>;
}

export const DEFAULT_TIMETABLE: Timetable = { briefingMinutes: 15, roundMinutes: { 1: 60, 2: 45 } };

export interface Window {
  round: RoundNo;
  opensAt: number; // epoch ms
  closesAt: number; // epoch ms
}

export function roundWindows(startsAt: number, t: Timetable = DEFAULT_TIMETABLE): Window[] {
  const min = 60_000;
  let at = startsAt + t.briefingMinutes * min;
  return ROUNDS.map((round) => {
    const w = { round, opensAt: at, closesAt: at + t.roundMinutes[round] * min };
    at = w.closesAt;
    return w;
  });
}

export type SessionStage =
  | { stage: "NOT_SCHEDULED" }
  | { stage: "BEFORE"; startsAt: number }
  | { stage: "BRIEFING"; nextOpensAt: number }
  | { stage: "ROUND"; round: RoundNo; closesAt: number }
  | { stage: "ENDED"; endedAt: number };

export function stageAt(startsAt: number | null, now: number, t: Timetable = DEFAULT_TIMETABLE): SessionStage {
  if (startsAt === null) return { stage: "NOT_SCHEDULED" };
  const w = roundWindows(startsAt, t);
  if (now < startsAt) return { stage: "BEFORE", startsAt };
  if (now < w[0]!.opensAt) return { stage: "BRIEFING", nextOpensAt: w[0]!.opensAt };
  for (const win of w) if (now < win.closesAt) return { stage: "ROUND", round: win.round, closesAt: win.closesAt };
  return { stage: "ENDED", endedAt: w[w.length - 1]!.closesAt };
}

/** A round's card is shown from the moment the round opens, and stays visible afterwards. */
export function roundOpened(startsAt: number | null, round: RoundNo, now: number, t: Timetable = DEFAULT_TIMETABLE): boolean {
  return startsAt !== null && now >= roundWindows(startsAt, t)[round - 1]!.opensAt;
}

export function roundIsOpen(startsAt: number | null, round: RoundNo, now: number, t: Timetable = DEFAULT_TIMETABLE): boolean {
  if (startsAt === null) return false;
  const w = roundWindows(startsAt, t)[round - 1]!;
  return now >= w.opensAt && now < w.closesAt;
}

// ───────────────────────────── Cards ─────────────────────────────

export interface ProblemCard {
  number: number;
  title: string;
  body: string;
}

export interface CrisisCard {
  number: number;
  category: string;
  title: string;
  body: string;
}

/**
 * Deals cards evenly: the teams in the given (shuffled) order take cards 0, 1, 2, … in turn, so every card is used
 * by the same number of teams, give or take one.
 */
export function dealEvenly<T>(teamIds: readonly string[], cards: readonly T[]): Map<string, T> {
  if (cards.length === 0) throw new Error("no cards to deal");
  const out = new Map<string, T>();
  teamIds.forEach((id, i) => out.set(id, cards[i % cards.length]!));
  return out;
}

/** Fisher–Yates with an injectable random source (crypto in production, seeded in tests). */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ───────────────────────────── Forms ─────────────────────────────

export interface Field {
  key: string;
  label: string;
  hint: string;
  kind: "text" | "short" | "rupees";
  /** Counts towards the round's word limit. */
  counted: boolean;
}

export const FORMS: Record<RoundNo, { wordLimit: number; fields: readonly Field[] }> = {
  1: {
    wordLimit: 800,
    fields: [
      { key: "company", label: "Company name", hint: "For example MilletBite", kind: "short", counted: false },
      { key: "problem", label: "Problem", hint: "Who has the problem, how many of them, and why current products fail them", kind: "text", counted: true },
      { key: "product", label: "Product", hint: "What it is, its pack size, and the features it cannot launch without", kind: "text", counted: true },
      { key: "buyer", label: "Target buyer", hint: "The exact buyer, e.g. working women aged 25 to 40 in metro cities", kind: "text", counted: true },
      { key: "whyWins", label: "Why it wins", hint: "What makes it better or cheaper than what shoppers buy today", kind: "text", counted: true },
      { key: "whereSells", label: "Where it sells", hint: "The first shops or apps that will stock it, and how it gets there", kind: "text", counted: true },
      { key: "cost", label: "Cost to make one pack (₹)", hint: "Your estimate, e.g. 4.50", kind: "rupees", counted: false },
      { key: "price", label: "Price on the pack (₹)", hint: "The MRP you would print, e.g. 10", kind: "rupees", counted: false },
      { key: "money", label: "How it makes money", hint: "Price → what reaches you after tax and shop margins → cost → margin", kind: "text", counted: true },
      { key: "risks", label: "Risks", hint: "The biggest things that could go wrong, and your plan for each", kind: "text", counted: true },
    ],
  },
  2: {
    wordLimit: 400,
    fields: [
      { key: "diagnosis", label: "Diagnosis", hint: "The real cause of the damage, in one or two lines", kind: "text", counted: true },
      { key: "options", label: "Options", hint: "At least two genuinely different fixes, each with its effect on cost per pack", kind: "text", counted: true },
      { key: "recommendation", label: "Recommendation", hint: "Which option you choose and why it beats the others", kind: "text", counted: true },
      { key: "costAfterCrisis", label: "Cost per pack after the crisis (₹)", hint: "Before your fix", kind: "rupees", counted: false },
      { key: "costAfterFix", label: "Cost per pack after your fix (₹)", hint: "Once your fix is working", kind: "rupees", counted: false },
      { key: "timeline", label: "Timeline", hint: "What happens each week until the fix is working", kind: "text", counted: true },
      { key: "risk", label: "Biggest risk", hint: "What could go wrong with your fix, and what you would do", kind: "text", counted: true },
    ],
  },
};

export type Content = Record<string, string>;

export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export function wordsOf(round: RoundNo, content: Content): number {
  return FORMS[round].fields.filter((f) => f.counted).reduce((n, f) => n + countWords(content[f.key] ?? ""), 0);
}

/** "4.50" → 450 paise; null when it is not a sensible amount (₹0.01 to ₹10,000). */
export function parseRupees(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim().replace(/^₹\s*/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return paise >= 1 && paise <= 1_000_000 ? paise : null;
}

export interface FormCheck {
  /** Problems that stop a save: over the word limit, a bad amount, a field far too long. */
  errors: string[];
  /** Fields still empty (a save is allowed; the form is just not complete). */
  missing: string[];
  words: number;
  /** The content as stored: only known fields, trimmed. */
  clean: Content;
}

export function checkForm(round: RoundNo, content: Content): FormCheck {
  const form = FORMS[round];
  const errors: string[] = [];
  const missing: string[] = [];
  const clean: Content = {};
  for (const f of form.fields) {
    const raw = content[f.key];
    const v = typeof raw === "string" ? raw.trim() : "";
    clean[f.key] = v;
    if (v === "") {
      missing.push(f.label);
      continue;
    }
    if (f.kind === "short" && v.length > 80) errors.push(`${f.label} is too long`);
    if (f.kind === "text" && v.length > 10_000) errors.push(`${f.label} is too long`);
    if (f.kind === "rupees" && parseRupees(v) === null) errors.push(`${f.label} must be an amount like 4.50`);
  }
  const words = wordsOf(round, clean);
  if (words > form.wordLimit) errors.push(`${words} words: the limit is ${form.wordLimit}`);
  return { errors, missing, words, clean };
}
