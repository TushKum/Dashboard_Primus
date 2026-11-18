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
  // The case's six decisions (brand name, product, audience, pricing, marketing, revenue), plus expansion.
  1: {
    wordLimit: 800,
    fields: [
      { key: "brand", label: "03 · Brand name", hint: "What will you name your brand?", kind: "short", counted: false },
      { key: "product", label: "01 · Product or service", hint: "What are you launching, and what is its unique selling point compared to existing electric scooters?", kind: "text", counted: true },
      { key: "audience", label: "02 · Target audience", hint: "Which college students and young professionals, in which cities, making which short trips?", kind: "text", counted: true },
      { key: "pricing", label: "04 · Pricing", hint: "What will riders pay, and how does it compare with autos, cabs and other e-mobility options?", kind: "text", counted: true },
      { key: "marketing", label: "05 · Marketing and competition", hint: "How will you market it and compete with existing brands?", kind: "text", counted: true },
      { key: "revenue", label: "06 · How you make money", hint: "Your revenue model, main costs and path to profit", kind: "text", counted: true },
      { key: "expansion", label: "Expansion", hint: "How the model realistically expands to more Indian cities", kind: "text", counted: true },
    ],
  },
  // ZIPGO's crisis: the five challenge areas, then the revised model in brief.
  2: {
    wordLimit: 400,
    fields: [
      { key: "technology", label: "Technology", hint: "How should the bicycle respond when the paid riding duration expires?", kind: "text", counted: true },
      { key: "pricing", label: "Pricing", hint: "Alerts, a grace period, automatic extensions or a different pricing structure?", kind: "text", counted: true },
      { key: "retention", label: "Customer retention", hint: "How will ZIPGO stop customers switching to competitors?", kind: "text", counted: true },
      { key: "revenue", label: "Revenue", hint: "How can ZIPGO charge fairly for extra usage without discouraging repeat rides?", kind: "text", counted: true },
      { key: "viability", label: "Financial viability", hint: "How can ZIPGO roll this out across its fleet while controlling costs?", kind: "text", counted: true },
      { key: "model", label: "Revised business model", hint: "Your revised model in brief: transparency, customer experience, retention and profitability", kind: "text", counted: true },
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
