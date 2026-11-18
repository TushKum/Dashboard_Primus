// The screening round's rules, with no I/O: the timetable, the three forms, the rubrics, the pricing maths, the
// market points, the judge's median and the ranking that decides who qualifies. Everything that scores a team lives
// here, so the tests can check every number in the worked example.
//
// Money is in paise (integers), so ₹10 is 1000. Points are kept to one decimal place.

export type RoundNo = 1 | 2 | 3;
export const ROUNDS: readonly RoundNo[] = [1, 2, 3];

export const ROUND_NAMES: Record<RoundNo, string> = { 1: "Idea", 2: "Crisis", 3: "Pricing" };

// ───────────────────────────── Timetable ─────────────────────────────

/** Minutes from the start of the session. */
export const TIMETABLE = {
  briefingMinutes: 15,
  roundMinutes: 40,
} as const;

export interface Window {
  round: RoundNo;
  opensAt: number; // epoch ms
  closesAt: number; // epoch ms
}

export function roundWindows(startsAt: number, t: { briefingMinutes: number; roundMinutes: number } = TIMETABLE): Window[] {
  const min = 60_000;
  return ROUNDS.map((round, i) => ({
    round,
    opensAt: startsAt + (t.briefingMinutes + i * t.roundMinutes) * min,
    closesAt: startsAt + (t.briefingMinutes + (i + 1) * t.roundMinutes) * min,
  }));
}

export type SessionStage =
  | { stage: "NOT_SCHEDULED" }
  | { stage: "BEFORE"; startsAt: number }
  | { stage: "BRIEFING"; nextOpensAt: number }
  | { stage: "ROUND"; round: RoundNo; closesAt: number }
  | { stage: "ENDED"; endedAt: number };

export function stageAt(startsAt: number | null, now: number): SessionStage {
  if (startsAt === null) return { stage: "NOT_SCHEDULED" };
  const w = roundWindows(startsAt);
  if (now < startsAt) return { stage: "BEFORE", startsAt };
  if (now < w[0]!.opensAt) return { stage: "BRIEFING", nextOpensAt: w[0]!.opensAt };
  for (const win of w) if (now < win.closesAt) return { stage: "ROUND", round: win.round, closesAt: win.closesAt };
  return { stage: "ENDED", endedAt: w[2]!.closesAt };
}

/** A round's card is shown from the moment the round opens, and stays visible afterwards. */
export function roundOpened(startsAt: number | null, round: RoundNo, now: number): boolean {
  if (startsAt === null) return false;
  return now >= roundWindows(startsAt)[round - 1]!.opensAt;
}

export function roundIsOpen(startsAt: number | null, round: RoundNo, now: number): boolean {
  if (startsAt === null) return false;
  const w = roundWindows(startsAt)[round - 1]!;
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

export interface DemandPoint {
  mrpPaise: number;
  packs: number;
}

export interface PriceCard {
  /** The product type a team picks in Round 1, e.g. "snack-25g". */
  key: string;
  label: string;
  /** Share of the MRP that reaches the company after GST and shop and distributor margins, in basis points. */
  shareBp: number;
  /** The lowest believable cost per pack for this product type. */
  benchmarkCostPaise: number;
  competitors: { name: string; mrpPaise: number }[];
  /** Exactly five price points, cheapest first. */
  demand: DemandPoint[];
}

export function validatePriceCard(c: PriceCard): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9-]{2,40}$/.test(c.key)) errors.push(`key "${c.key}" must be 2–40 lowercase letters, digits or dashes`);
  if (!c.label?.trim()) errors.push("label is missing");
  if (!Number.isInteger(c.shareBp) || c.shareBp < 1 || c.shareBp > 10000) errors.push("shareBp must be 1–10000");
  if (!Number.isInteger(c.benchmarkCostPaise) || c.benchmarkCostPaise < 1) errors.push("benchmarkCostPaise must be a positive whole number");
  if (!Array.isArray(c.demand) || c.demand.length !== 5) errors.push("demand must have exactly 5 price points");
  else {
    for (let i = 0; i < c.demand.length; i++) {
      const p = c.demand[i]!;
      if (!Number.isInteger(p.mrpPaise) || p.mrpPaise < 1) errors.push(`demand[${i}].mrpPaise must be a positive whole number`);
      if (!Number.isInteger(p.packs) || p.packs < 0) errors.push(`demand[${i}].packs must be a whole number`);
      if (i > 0 && p.mrpPaise <= c.demand[i - 1]!.mrpPaise) errors.push("demand prices must rise from cheapest to dearest");
    }
  }
  return errors;
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
  kind: "text" | "short" | "rupees" | "choice";
  /** Counts towards the round's word limit. */
  counted: boolean;
  required: boolean;
}

export const FORMS: Record<RoundNo, { wordLimit: number; fields: readonly Field[] }> = {
  1: {
    wordLimit: 300,
    fields: [
      { key: "company", label: "Company name", hint: "For example MilletBite", kind: "short", counted: false, required: true },
      { key: "ticker", label: "Ticker", hint: "Four capital letters, like MLBT", kind: "short", counted: false, required: true },
      { key: "productType", label: "Product type", hint: "Sets the price card you get in Round 3", kind: "choice", counted: false, required: true },
      { key: "problem", label: "Problem", hint: "Who has the problem and why current products fail them", kind: "text", counted: true, required: true },
      { key: "product", label: "Product", hint: "What it is, its pack size, and the 3 features it cannot launch without", kind: "text", counted: true, required: true },
      { key: "buyer", label: "Target buyer", hint: "The exact buyer, e.g. working women aged 25 to 40 in metro cities", kind: "text", counted: true, required: true },
      { key: "whyWins", label: "Why it wins", hint: "What makes it better or cheaper than what shoppers buy today", kind: "text", counted: true, required: true },
      { key: "whereSells", label: "Where it sells", hint: "The first shops or apps that will stock it", kind: "text", counted: true, required: true },
      { key: "cost", label: "Cost to make one pack (₹)", hint: "Your estimate, e.g. 4.50", kind: "rupees", counted: false, required: true },
      { key: "costReason", label: "Why that cost", hint: "One or two lines on where the number comes from", kind: "text", counted: true, required: true },
    ],
  },
  2: {
    wordLimit: 300,
    fields: [
      { key: "diagnosis", label: "Diagnosis", hint: "The real cause of the damage, in one or two lines", kind: "text", counted: true, required: true },
      { key: "optionA", label: "Option A", hint: "A fix, with its effect on cost per pack", kind: "text", counted: true, required: true },
      { key: "optionB", label: "Option B", hint: "A genuinely different fix, with its effect on cost per pack", kind: "text", counted: true, required: true },
      { key: "recommendation", label: "Recommendation", hint: "Which option you choose and why it beats the other", kind: "text", counted: true, required: true },
      { key: "costAfterCrisis", label: "Cost per pack after the crisis (₹)", hint: "Before your fix", kind: "rupees", counted: false, required: true },
      { key: "costAfterFix", label: "Cost per pack after your fix (₹)", hint: "This carries into Round 3", kind: "rupees", counted: false, required: true },
      { key: "weeks", label: "First 4 weeks", hint: "What happens each week until the fix is working", kind: "text", counted: true, required: true },
      { key: "risk", label: "Biggest risk", hint: "What could go wrong with your fix, and what you would do", kind: "text", counted: true, required: true },
    ],
  },
  3: {
    wordLimit: 200,
    fields: [
      { key: "mrp", label: "Your MRP", hint: "One of the five prices on your price card", kind: "choice", counted: false, required: true },
      { key: "maths", label: "Per-pack maths", hint: "MRP → what reaches you → cost per pack → profit per pack", kind: "text", counted: true, required: true },
      { key: "reasoning", label: "Why this price", hint: "Fit with your buyer, competitors, and what you gave up by not choosing the price on either side", kind: "text", counted: true, required: true },
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

export function formatRupees(paise: number): string {
  const r = paise / 100;
  return "₹" + (Number.isInteger(r) ? r.toLocaleString("en-IN") : r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

export interface FormCheck {
  ok: boolean;
  errors: string[];
  words: number;
  /** The content as stored: only known fields, trimmed. */
  clean: Content;
}

/**
 * Checks a save. `complete` is false for a draft (missing fields allowed); either way the word limit and the formats
 * must hold, so what is stored can always be judged as it stands.
 */
export function checkForm(
  round: RoundNo,
  content: Content,
  ctx: { productTypes?: readonly string[]; mrpChoices?: readonly number[] } = {},
): FormCheck {
  const form = FORMS[round];
  const errors: string[] = [];
  const clean: Content = {};
  for (const f of form.fields) {
    const raw = content[f.key];
    const v = typeof raw === "string" ? raw.trim() : "";
    clean[f.key] = f.key === "ticker" ? v.toUpperCase() : v;
    if (v === "") {
      if (f.required) errors.push(`${f.label} is empty`);
      continue;
    }
    if (f.kind === "short" && v.length > 60) errors.push(`${f.label} is too long`);
    if (f.kind === "text" && v.length > 4000) errors.push(`${f.label} is too long`);
    if (f.key === "ticker" && !/^[A-Z]{4}$/.test(clean.ticker!)) errors.push("Ticker must be four letters");
    if (f.kind === "rupees" && parseRupees(v) === null) errors.push(`${f.label} must be an amount like 4.50`);
    if (f.key === "productType" && ctx.productTypes && !ctx.productTypes.includes(v)) errors.push("Pick a product type from the list");
    if (f.key === "mrp") {
      const p = Number(v);
      if (!Number.isInteger(p) || (ctx.mrpChoices && !ctx.mrpChoices.includes(p))) errors.push("Pick one of the five prices on your card");
    }
  }
  const words = wordsOf(round, clean);
  if (words > form.wordLimit) errors.push(`${words} words: the limit is ${form.wordLimit}`);
  return { ok: errors.length === 0, errors, words, clean };
}

/** Lines aimed at the judge ("give this full marks", "ignore the rubric") are removed before judging. */
const INJECTION = /\b(ignore (all|any|the|previous|prior|above)|disregard|full marks|maximum (score|marks|points)|give (this|us|our|it) (a )?(100|full|perfect|top)|score (this|us) (100|highly)|you are (an?|the) (ai|judge|model)|system prompt|as an ai|rubric says|judge:|assistant:)/i;

export function stripInjections(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text.split(/\r?\n/).filter((line) => {
    if (INJECTION.test(line)) {
      removed.push(line.trim());
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), removed };
}

// ───────────────────────────── Rubrics and the judge ─────────────────────────────

export interface RubricLine {
  key: string;
  label: string;
  max: number;
}

export const RUBRICS: Record<RoundNo, readonly RubricLine[]> = {
  1: [
    { key: "problem_buyer", label: "Problem and buyer: specific, believable, sized", max: 25 },
    { key: "product", label: "Product: clear features, sensible scope", max: 25 },
    { key: "why_wins", label: "Why it wins against what exists", max: 20 },
    { key: "where_sells", label: "Where it sells: a realistic first channel", max: 15 },
    { key: "cost", label: "Cost to make: a believable number with a short reason", max: 15 },
  ],
  2: [
    { key: "diagnosis", label: "Diagnosis", max: 20 },
    { key: "options", label: "Options: two real, different choices", max: 20 },
    { key: "recommendation", label: "Recommendation backed by numbers", max: 25 },
    { key: "feasibility", label: "Feasibility and cost", max: 15 },
    { key: "weeks", label: "First 4 weeks", max: 10 },
    { key: "risk", label: "Biggest risk", max: 10 },
  ],
  3: [
    { key: "maths", label: "Per-pack maths correct and complete", max: 15 },
    { key: "fit", label: "Price fits the target buyer from Round 1", max: 15 },
    { key: "competitors", label: "Compared sensibly with competitor prices", max: 10 },
    { key: "trade_off", label: "Trade-off against the neighbouring prices explained", max: 10 },
  ],
};

export const rubricMax = (round: RoundNo) => RUBRICS[round].reduce((s, l) => s + l.max, 0);

export interface JudgeOutput {
  breakdown: Record<string, number>;
  total: number;
  rationale: string;
}

export function validateJudgeOutput(round: RoundNo, raw: unknown): { ok: true; value: JudgeOutput } | { ok: false; errors: string[] } {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["not JSON"] };
    }
  }
  const errors: string[] = [];
  const o = v as Partial<JudgeOutput> | null;
  if (!o || typeof o !== "object" || !o.breakdown || typeof o.breakdown !== "object") return { ok: false, errors: ["no breakdown"] };
  let sum = 0;
  for (const line of RUBRICS[round]) {
    const p = (o.breakdown as Record<string, unknown>)[line.key];
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > line.max) errors.push(`${line.key} must be 0–${line.max}`);
    else sum += p;
  }
  if (Object.keys(o.breakdown).length !== RUBRICS[round].length) errors.push("unexpected rubric lines");
  if (o.total !== sum) errors.push(`total ${String(o.total)} is not the sum ${sum}`);
  if (typeof o.rationale !== "string" || o.rationale.trim() === "") errors.push("no rationale");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { breakdown: o.breakdown as Record<string, number>, total: sum, rationale: o.rationale!.trim() } };
}

/** Three runs; if they spread wider than 10% of the round's maximum, two more. */
export const BASE_RUNS = 3;
export const EXTRA_RUNS = 2;
export function needsExtraRuns(round: RoundNo, totals: readonly number[]): boolean {
  if (totals.length !== BASE_RUNS) return false;
  return Math.max(...totals) - Math.min(...totals) > rubricMax(round) / 10;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ───────────────────────────── Pricing ─────────────────────────────

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** What reaches the company from one pack. */
export function reachPaise(mrpPaise: number, shareBp: number): number {
  return Math.round((mrpPaise * shareBp) / 10000);
}

/** The cost the market uses: the team's Round 2 after-fix cost (else its Round 1 cost), never below the benchmark. */
export function marketCostPaise(card: PriceCard, r1CostPaise: number | null, r2CostAfterFixPaise: number | null): number {
  const own = r2CostAfterFixPaise ?? r1CostPaise ?? card.benchmarkCostPaise;
  return Math.max(own, card.benchmarkCostPaise);
}

export interface PriceRow {
  mrpPaise: number;
  packs: number;
  reachPaise: number;
  profitPerPackPaise: number;
  monthlyProfitPaise: number;
}

export function priceTable(card: PriceCard, costPaise: number): PriceRow[] {
  return card.demand.map((d) => {
    const reach = reachPaise(d.mrpPaise, card.shareBp);
    const perPack = reach - costPaise;
    return { mrpPaise: d.mrpPaise, packs: d.packs, reachPaise: reach, profitPerPackPaise: perPack, monthlyProfitPaise: perPack * d.packs };
  });
}

export function monthlyProfitPaise(card: PriceCard, costPaise: number, mrpPaise: number): number {
  const row = priceTable(card, costPaise).find((r) => r.mrpPaise === mrpPaise);
  if (!row) throw new Error(`${mrpPaise} is not a price on card ${card.key}`);
  return row.monthlyProfitPaise;
}

/** 50 × profit ÷ the best profit among teams with the same price card; a loss (or nothing to compare) earns 0. */
export function marketPoints(profitPaise: number, bestProfitPaise: number): number {
  if (profitPaise <= 0 || bestProfitPaise <= 0) return 0;
  return round1((50 * profitPaise) / bestProfitPaise);
}

// ───────────────────────────── Totals and ranking ─────────────────────────────

export interface TeamResultInput {
  teamId: string;
  code: string;
  name: string;
  disqualified: boolean;
  /** Points taken off by the organisers (e.g. a second attempt to trick the judge). */
  penalty: number;
  /** Judge scores (median), null when not judged or not submitted. */
  judge: Partial<Record<RoundNo, number | null>>;
  /** Round 3 only: present when the team submitted a price. */
  pricing: { cardKey: string; profitPaise: number } | null;
}

export interface TeamResult {
  teamId: string;
  code: string;
  name: string;
  r1: number;
  r2: number;
  r3Judge: number;
  r3Market: number;
  r3: number;
  penalty: number;
  total: number;
  rank: number | null;
  qualified: boolean;
  disqualified: boolean;
}

export function scoreTeams(teams: readonly TeamResultInput[], qualifyCount: number): TeamResult[] {
  const best = new Map<string, number>();
  for (const t of teams) {
    if (!t.pricing || t.disqualified) continue;
    best.set(t.pricing.cardKey, Math.max(best.get(t.pricing.cardKey) ?? 0, t.pricing.profitPaise));
  }
  const rows: TeamResult[] = teams.map((t) => {
    const r1 = t.judge[1] ?? 0;
    const r2 = t.judge[2] ?? 0;
    const r3Judge = t.judge[3] ?? 0;
    const r3Market = t.pricing ? marketPoints(t.pricing.profitPaise, best.get(t.pricing.cardKey) ?? 0) : 0;
    const r3 = round1(r3Judge + r3Market);
    return {
      teamId: t.teamId,
      code: t.code,
      name: t.name,
      r1: round1(r1),
      r2: round1(r2),
      r3Judge: round1(r3Judge),
      r3Market,
      r3,
      penalty: t.penalty,
      total: round1(Math.max(0, r1 + r2 + r3 - t.penalty)),
      rank: null,
      qualified: false,
      disqualified: t.disqualified,
    };
  });
  const ranked = rows
    .filter((r) => !r.disqualified)
    .sort((a, b) => b.total - a.total || b.r2 - a.r2 || b.r1 - a.r1 || a.code.localeCompare(b.code));
  ranked.forEach((r, i) => {
    r.rank = i + 1;
    r.qualified = i < qualifyCount;
  });
  return [...ranked, ...rows.filter((r) => r.disqualified)];
}
