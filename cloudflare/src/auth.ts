/**
 * Auth primitives, all built on the Web Crypto global (crypto.subtle).
 * No node:crypto, no bcrypt, no jsonwebtoken.
 *
 *   - Password hashing: PBKDF2-HMAC-SHA-256 with a random salt.
 *   - Token: hand-rolled HS256 JWT (header.payload.signature).
 *   - All comparisons of secret material are constant-time.
 */

import type { Env, UserRow } from "./types";

// PBKDF2 iterations. Login is infrequent, so we can afford a strong count while
// staying comfortably inside the Workers free-tier ~10ms CPU/request budget.
// 100k iterations of PBKDF2-SHA256 over a single 32-byte block measures ~2-4ms
// in the Workers runtime.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEYLEN = 32; // bytes
const SALT_LEN = 16; // bytes

const enc = new TextEncoder();

// ── base64 / base64url helpers ──────────────────────────────────────────────
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function b64urlEncodeString(s: string): string {
  return b64url(enc.encode(s));
}

function b64urlDecodeToString(s: string): string {
  return new TextDecoder().decode(b64urlDecodeToBytes(s));
}

/** Constant-time byte comparison. Returns false on length mismatch. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── password hashing (PBKDF2) ───────────────────────────────────────────────
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: PBKDF2_HASH },
    key,
    PBKDF2_KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a password. Encoded string is self-describing so the parameters travel
 * with the hash:  pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(derived)}`;
}

/** Constant-time verify against a stored `hashPassword()` string. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64ToBytes(parts[3]);
    expected = b64ToBytes(parts[4]);
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(derived, expected);
}

// ── HS256 JWT ───────────────────────────────────────────────────────────────
interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function ttlFromEnv(env: Env): number {
  const n = Number(env.JWT_TTL);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

/** Sign an HS256 JWT with claims { sub, iat, exp }. */
export async function signToken(sub: string, env: Env, ttlSeconds?: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (ttlSeconds ?? ttlFromEnv(env));
  const header = b64urlEncodeString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncodeString(JSON.stringify({ sub, iat, exp } satisfies JwtPayload));
  const data = `${header}.${payload}`;
  const key = await hmacKey(env.JWT_SECRET);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}

/** Verify signature + expiry. Returns the payload, or null if invalid. */
export async function verifyToken(token: string | null, env: Env): Promise<JwtPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const key = await hmacKey(env.JWT_SECRET);
  let given: Uint8Array;
  try {
    given = b64urlDecodeToBytes(sig);
  } catch {
    return null;
  }
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  if (!timingSafeEqual(given, expected)) return null;
  let claims: JwtPayload;
  try {
    claims = JSON.parse(b64urlDecodeToString(payload));
  } catch {
    return null;
  }
  if (!claims.sub) return null;
  if (claims.exp && Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}

// ── request -> user ─────────────────────────────────────────────────────────
/** Read the Bearer token from a request and resolve it to a user row (or null). */
export async function userFromRequest(request: Request, env: Env): Promise<UserRow | null> {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const claims = await verifyToken(header.slice(7), env);
  if (!claims?.sub) return null;
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(claims.sub).first<UserRow>();
}
