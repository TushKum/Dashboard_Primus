// Runs the app on a local port: `npm start`. On Vercel, src/index.ts is used directly instead.

import app, { missingSettings } from "./index.js";

const missing = missingSettings();
if (missing.length) {
  console.error(`Set ${missing.join(", ")} in .env (see .env.example).`);
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
const data = process.env.DATABASE_URL || process.env.POSTGRES_URL ? "Postgres from DATABASE_URL" : `embedded Postgres in ${process.env.PGLITE_DIR?.trim() || "data/pglite"}`;
app.listen(port, () => {
  console.log(`Screening round on http://localhost:${port}  (team page /, organisers /admin) · data: ${data}`);
});
