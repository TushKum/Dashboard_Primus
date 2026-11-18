// How a database URL is read. The driver obeys an `sslmode` in the URL and ignores the `ssl` option beside it, so
// the app takes that setting out of the URL and decides itself; these tests pin down what it decides.

import { describe, expect, it } from "vitest";
import { isUntrustedCert, splitSsl, tlsFor } from "../src/db.js";

const SUPABASE = "postgres://postgres.abcdef:s3cret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";

describe("splitSsl", () => {
  it("takes sslmode out and leaves the rest of the URL alone", () => {
    expect(splitSsl(`${SUPABASE}?sslmode=require`)).toEqual({ url: SUPABASE, mode: "require" });
    expect(splitSsl(`${SUPABASE}?sslmode=no-verify&application_name=screening`)).toEqual({
      url: `${SUPABASE}?application_name=screening`,
      mode: "no-verify",
    });
    expect(splitSsl(`${SUPABASE}?application_name=screening&sslmode=verify-full`)).toEqual({
      url: `${SUPABASE}?application_name=screening`,
      mode: "verify-full",
    });
  });
  it("leaves a URL with no options as it is", () => {
    expect(splitSsl(SUPABASE)).toEqual({ url: SUPABASE, mode: null });
  });
  it("reads the older ssl=true and ssl=false spellings", () => {
    expect(splitSsl(`${SUPABASE}?ssl=true`).mode).toBe("require");
    expect(splitSsl(`${SUPABASE}?ssl=0`).mode).toBe("disable");
  });
  it("does not mistake a password's punctuation for options", () => {
    const odd = "postgres://postgres:pa?ss&word@db.example.com:5432/postgres?sslmode=require";
    expect(splitSsl(odd)).toEqual({ url: "postgres://postgres:pa?ss&word@db.example.com:5432/postgres", mode: "require" });
  });
});

describe("tlsFor", () => {
  it("encrypts a remote database, verifying first but able to fall back", () => {
    // Managed hosts often present a chain a server does not trust; without the fallback nothing connects.
    expect(tlsFor(SUPABASE, null)).toEqual({ ssl: { rejectUnauthorized: true }, mayRelax: true });
    // In Postgres itself "require" means encrypt, not verify, so it may fall back too.
    expect(tlsFor(SUPABASE, "require")).toEqual({ ssl: { rejectUnauthorized: true }, mayRelax: true });
  });
  it("stays strict when strictness was asked for", () => {
    expect(tlsFor(SUPABASE, "verify-full")).toEqual({ ssl: { rejectUnauthorized: true }, mayRelax: false });
    expect(tlsFor(SUPABASE, "verify-ca").mayRelax).toBe(false);
  });
  it("skips verification, quietly, when told to", () => {
    expect(tlsFor(SUPABASE, "no-verify")).toEqual({ ssl: { rejectUnauthorized: false }, mayRelax: false });
  });
  it("leaves a local database unencrypted unless asked", () => {
    const local = "postgres://postgres@127.0.0.1:5432/postgres";
    expect(tlsFor(local, null)).toEqual({ ssl: false, mayRelax: false });
    expect(tlsFor("postgres://postgres@localhost:5432/postgres", null).ssl).toBe(false);
    expect(tlsFor(local, "require").ssl).toEqual({ rejectUnauthorized: true });
    expect(tlsFor(SUPABASE, "disable").ssl).toBe(false);
  });
});

describe("isUntrustedCert", () => {
  it("knows an untrusted chain from a real refusal", () => {
    expect(isUntrustedCert({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(true);
    expect(isUntrustedCert({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(true);
    expect(isUntrustedCert({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(true);
    expect(isUntrustedCert({ code: "28P01" })).toBe(false); // wrong password
    expect(isUntrustedCert({ code: "ECONNREFUSED" })).toBe(false);
    expect(isUntrustedCert(new Error("nope"))).toBe(false);
    expect(isUntrustedCert(null)).toBe(false);
  });
});
