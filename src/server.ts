// Starts the screening app. Settings come from the environment (see .env.example).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp, loadDefaultCards } from "./app.ts";
import { openDb } from "./db.ts";
import { createJudge } from "./judge.ts";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Set ${name} (see .env.example).`);
    process.exit(1);
  }
  return v;
}

const dbPath = process.env.DATABASE_PATH?.trim() || "data/screening.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
loadDefaultCards(db);

const { app } = createApp({
  db,
  judge: createJudge(),
  sessionSecret: required("SESSION_SECRET"),
  loginSecret: required("LOGIN_SECRET"),
  adminPassword: required("ADMIN_PASSWORD"),
  secureCookies: process.env.SECURE_COOKIES === "1",
  concurrency: Number(process.env.JUDGE_CONCURRENCY || 5),
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Screening round on http://localhost:${port}  (team page /, organisers /admin)`);
  if (process.env.JUDGE_FAKE === "1") console.log("JUDGE_FAKE=1: the fake judge is on. Turn it off for the real screening.");
});
