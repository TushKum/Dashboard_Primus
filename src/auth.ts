// Logins. A team's password is derived from LOGIN_SECRET and its code (HMAC-SHA256), so nothing secret is stored and
// the login sheet can be reprinted at any time. Sessions are a signed cookie: "<role>.<team id>.<expiry>.<signature>".

import { createHmac, timingSafeEqual } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

export function teamPassword(secret: string, code: string): string {
  const mac = createHmac("sha256", secret).update(`team:${code.toUpperCase()}`).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[mac[i]! % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Session = { role: "team"; teamId: number } | { role: "admin" };

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(`session:${body}`).digest("base64url");

export function makeSession(secret: string, s: Session, now: number, hours = 12): string {
  const body = `${s.role}.${s.role === "team" ? s.teamId : 0}.${now + hours * 3_600_000}`;
  return `${body}.${sign(secret, body)}`;
}

export function readSession(secret: string, token: string | undefined, now: number): Session | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join(".");
  if (!safeEqual(sign(secret, body), parts[3]!)) return null;
  if (Number(parts[2]) < now) return null;
  if (parts[0] === "admin") return { role: "admin" };
  if (parts[0] === "team" && /^\d+$/.test(parts[1]!)) return { role: "team", teamId: Number(parts[1]) };
  return null;
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
