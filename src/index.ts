// The app, configured from the environment. Vercel runs this file as one function (its default export); `npm start`
// runs it on a local port through local.ts.
//
// Needs SESSION_SECRET, LOGIN_SECRET and ADMIN_PASSWORD, and on Vercel a Postgres DATABASE_URL (or POSTGRES_URL).
// Locally, without a database URL, it keeps its data in an embedded Postgres under data/pglite.

import express from "express";
import { dbFromEnv } from "./db.js";
import { createApp } from "./routes.js";

const env = process.env;
const onVercel = Boolean(env.VERCEL);

export function missingSettings(e: NodeJS.ProcessEnv = env): string[] {
  const missing = ["SESSION_SECRET", "LOGIN_SECRET", "ADMIN_PASSWORD"].filter((k) => !e[k]?.trim());
  if (e.VERCEL && !e.DATABASE_URL?.trim() && !e.POSTGRES_URL?.trim()) missing.push("DATABASE_URL");
  return missing;
}

function build(): express.Express {
  const missing = missingSettings();
  if (missing.length) {
    // Say what is wrong instead of crashing, so the deployment explains itself.
    const app = express();
    app.use((_req, res) => {
      res.status(500).json({ error: `Missing settings: ${missing.join(", ")}. Add them in Vercel → Settings → Environment Variables, then redeploy.` });
    });
    return app;
  }
  return createApp({
    openDb: () => dbFromEnv(env, env.PGLITE_DIR?.trim() || "data/pglite"),
    sessionSecret: env.SESSION_SECRET!,
    loginSecret: env.LOGIN_SECRET!,
    adminPassword: env.ADMIN_PASSWORD!,
    secureCookies: onVercel || env.SECURE_COOKIES === "1",
  });
}

const app = build();
export default app;
