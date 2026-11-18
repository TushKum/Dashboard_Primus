// The AI judge. Each submission is read BASE_RUNS times (plus EXTRA_RUNS when the runs disagree), without the team's
// name, and the median counts. Round 1 goes to Claude Opus 5.5, Rounds 2 and 3 to Claude Sonnet 5.5 (override with
// JUDGE_MODEL_R1..R3). JUDGE_FAKE=1 swaps in a deterministic scorer for rehearsals and tests.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASE_RUNS,
  EXTRA_RUNS,
  FORMS,
  RUBRICS,
  formatRupees,
  median,
  needsExtraRuns,
  rubricMax,
  stripInjections,
  validateJudgeOutput,
  type Content,
  type JudgeOutput,
  type RoundNo,
} from "./rules.ts";
import type { JudgementRun } from "./db.ts";

export type JudgeFn = (round: RoundNo, system: string, userText: string, runNo: number) => Promise<JudgementRun>;

const DEFAULT_MODELS: Record<RoundNo, string> = { 1: "claude-opus-5-5", 2: "claude-sonnet-5-5", 3: "claude-sonnet-5-5" };

export function judgeModel(round: RoundNo, env: NodeJS.ProcessEnv = process.env): string {
  return env[`JUDGE_MODEL_R${round}`]?.trim() || DEFAULT_MODELS[round];
}

const PROMPT_FILES: Record<RoundNo, string> = { 1: "idea.md", 2: "crisis.md", 3: "pricing.md" };

export function loadPrompt(round: RoundNo): string {
  const path = fileURLToPath(new URL(`../prompts/${PROMPT_FILES[round]}`, import.meta.url));
  const rubric = RUBRICS[round].map((l) => `- \`${l.key}\` (0–${l.max}): ${l.label}`).join("\n");
  return readFileSync(path, "utf8").replace("{{RUBRIC}}", rubric).replace("{{MAX}}", String(rubricMax(round)));
}

export function outputSchema(round: RoundNo): Record<string, unknown> {
  const rubric = RUBRICS[round];
  return {
    type: "object",
    properties: {
      breakdown: {
        type: "object",
        properties: Object.fromEntries(rubric.map((l) => [l.key, { type: "integer", description: `${l.label}: 0 to ${l.max}` }])),
        required: rubric.map((l) => l.key),
        additionalProperties: false,
      },
      total: { type: "integer", description: `The sum of the breakdown, 0 to ${rubricMax(round)}.` },
      rationale: { type: "string", description: "Three sentences explaining the score." },
    },
    required: ["breakdown", "total", "rationale"],
    additionalProperties: false,
  };
}

// ───────────────────────────── What the judge reads ─────────────────────────────

function formText(round: RoundNo, content: Content): string {
  return FORMS[round].fields
    .filter((f) => f.key !== "company" && f.key !== "ticker")
    .map((f) => `## ${f.label}\n${content[f.key] ?? ""}`)
    .join("\n\n");
}

export interface JudgeContext {
  pitch?: Content | null;
  productTypeLabel?: string;
  crisisCard?: { title: string; body: string } | null;
  crisisPlan?: Content | null;
  priceCardText?: string;
  marketLine?: string;
}

/** The user message for one submission, with lines aimed at the judge removed. Never includes the team's name. */
export function buildRequest(round: RoundNo, content: Content, ctx: JudgeContext): { text: string; removed: string[] } {
  const removed: string[] = [];
  const clean = (t: string) => {
    const s = stripInjections(t);
    removed.push(...s.removed);
    return s.text;
  };
  const parts: string[] = [];
  if (round >= 2 && ctx.pitch) parts.push(`# The team's Round 1 pitch (context only, already scored)\n\n${clean(formText(1, ctx.pitch))}`);
  if (round >= 2 && ctx.crisisCard) parts.push(`# The crisis card\n\n${ctx.crisisCard.title}: ${ctx.crisisCard.body}`);
  if (round === 3 && ctx.crisisPlan) parts.push(`# The team's Round 2 crisis plan (context only, already scored)\n\n${clean(formText(2, ctx.crisisPlan))}`);
  if (round === 3 && ctx.priceCardText) parts.push(`# The price card\n\n${ctx.priceCardText}`);
  if (round === 3 && ctx.marketLine) parts.push(`# What the website computed\n\n${ctx.marketLine}`);
  const own = round === 3 ? { ...content, mrp: content.mrp ? formatRupees(Number(content.mrp)) : "" } : content;
  const header = round === 1 && ctx.productTypeLabel ? `Product type: ${ctx.productTypeLabel}\n\n` : "";
  parts.push(`# The submission to score\n\n${header}${clean(formText(round, own))}`);
  return { text: parts.join("\n\n---\n\n"), removed };
}

// ───────────────────────────── Claude ─────────────────────────────

export function claudeJudge(client: Anthropic = new Anthropic(), env: NodeJS.ProcessEnv = process.env): JudgeFn {
  const effort = (env.JUDGE_EFFORT?.trim() || "medium") as "low" | "medium" | "high";
  return async (round, system, userText) => {
    const model = judgeModel(round, env);
    let lastError = "no answer";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const message = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
        output_config: { effort, format: { type: "json_schema", schema: outputSchema(round) } },
      });
      if (message.stop_reason === "refusal") {
        lastError = "the model declined to score this submission";
        continue;
      }
      if (message.stop_reason !== "end_turn") {
        lastError = `unexpected stop: ${String(message.stop_reason)}`;
        continue;
      }
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const check = validateJudgeOutput(round, text);
      if (!check.ok) {
        lastError = check.errors.join("; ");
        continue;
      }
      return { ...check.value, model: message.model || model };
    }
    throw new Error(`no valid answer in 3 attempts: ${lastError}`);
  };
}

// ───────────────────────────── The fake judge (rehearsals, tests) ─────────────────────────────

export function fakeJudgeOutput(round: RoundNo, userText: string, runNo: number): JudgeOutput {
  const base = createHash("sha256").update(userText).digest();
  const perRun = createHash("sha256").update(`${userText}#${runNo}`).digest();
  const quality = 0.35 + (((base[0]! << 8) | base[1]!) / 0xffff) * 0.6;
  const breakdown: Record<string, number> = {};
  RUBRICS[round].forEach((l, i) => {
    breakdown[l.key] = Math.min(l.max, Math.max(0, Math.round(l.max * quality) + ((perRun[i]! % 5) - 2)));
  });
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { breakdown, total, rationale: `Rehearsal score from the fake judge (run ${runNo}): ${total} out of ${rubricMax(round)}. It does not read the text.` };
}

export const fakeJudge: JudgeFn = async (round, _system, userText, runNo) => ({ ...fakeJudgeOutput(round, userText, runNo), model: "fake-judge" });

export function createJudge(env: NodeJS.ProcessEnv = process.env): JudgeFn {
  return env.JUDGE_FAKE === "1" ? fakeJudge : claudeJudge(new Anthropic(), env);
}

// ───────────────────────────── One submission, all its runs ─────────────────────────────

export interface Verdict {
  runs: JudgementRun[];
  score: number;
  /** The run whose total is closest to the median (its breakdown and reason are shown to the team). */
  shown: JudgementRun;
}

export async function judgeSubmission(judge: JudgeFn, round: RoundNo, system: string, userText: string): Promise<Verdict> {
  const runs: JudgementRun[] = [];
  for (let i = 1; i <= BASE_RUNS; i++) runs.push(await judge(round, system, userText, i));
  if (needsExtraRuns(round, runs.map((r) => r.total))) {
    for (let i = 1; i <= EXTRA_RUNS; i++) runs.push(await judge(round, system, userText, BASE_RUNS + i));
  }
  const score = median(runs.map((r) => r.total));
  const shown = [...runs].sort((a, b) => Math.abs(a.total - score) - Math.abs(b.total - score))[0]!;
  return { runs, score, shown };
}

/** Runs `work` over `items` with at most `limit` at a time. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(lanes);
}
