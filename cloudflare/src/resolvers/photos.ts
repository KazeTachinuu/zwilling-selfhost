/**
 * PHOTOS domain (real, R2-backed).
 * =================================
 *
 * The Python reference only stubbed uploads (`requestUploadUrl` returned a fake
 * presigned URL and no bytes were ever stored). This port makes it real:
 *
 *   1. `requestUploadUrl(cloudId, usedFor, fileType)` returns
 *        { url, headers } where `url` is a working, short-lived, signed PUT
 *        endpoint on this Worker:  <base>/media/<usedFor>/<cloudId>?token=...
 *      The token is an HMAC (JWT_SECRET) over { owner, usedFor, cloudId, ext,
 *      contentType, exp }, so the upload is authorized without a second login.
 *   2. `PUT /media/:usedFor/:cloudId?token=...` verifies the token, streams the
 *      body into R2 under key  <usedFor>/<owner>/<cloudId>.<ext>, and upserts the
 *      `photos` index row (idempotent: re-upload overwrites the same key/row).
 *   3. `GET /media/<usedFor>/<owner>/<cloudId>.<ext>` streams the object back.
 *   4. `FreshAndSave.photo` / `CustomerProfile.photo` read the `photos` table and
 *      return [{ type, url }] with url pointing at <base>/media/<r2_key>.
 *
 * GET /media is an unauthenticated capability URL: the R2 key embeds the owner
 * and cloud UUIDs, so a URL is unguessable but NOT access-controlled (anyone
 * holding the URL can fetch the bytes). Only the GraphQL read path is
 * ownership-scoped; it returns URLs solely for the authenticated owner's rows.
 */

import type { ResolverSlice } from "./index";
import { requireUser } from "./index";
import { first, run } from "../db";
import type { Env } from "../types";

// ── file-type ↔ extension / content-type maps ───────────────────────────────
const EXT: Record<string, string> = { JPEG: "jpg", PNG: "png", WEBP: "webp" };
const CONTENT_TYPE: Record<string, string> = {
  JPEG: "image/jpeg",
  PNG: "image/png",
  WEBP: "image/webp",
};

const DEFAULT_MEDIA_BASE = "https://your-backend.example.com";
const UPLOAD_TTL_SECONDS = 15 * 60; // signed upload URL lifetime

/** Base URL that photo/upload URLs are built on (configurable via MEDIA_BASE_URL). */
export function mediaBase(env: Env): string {
  return (env.MEDIA_BASE_URL || DEFAULT_MEDIA_BASE).replace(/\/+$/, "");
}

interface PhotoRow {
  owner_id: string;
  entity_type: string;
  entity_id: string;
  content_type: string;
  r2_key: string;
}

// ── signed media tokens (HMAC-SHA256 over JWT_SECRET) ────────────────────────
interface MediaClaims {
  o: string; // owner id
  u: string; // usedFor
  c: string; // cloudId
  e: string; // extension
  t: string; // content type
  exp: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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

async function signMediaToken(env: Env, claims: MediaClaims): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const key = await hmacKey(env.JWT_SECRET);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

async function verifyMediaToken(env: Env, token: string | null): Promise<MediaClaims | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const key = await hmacKey(env.JWT_SECRET);
  let given: Uint8Array;
  try {
    given = b64urlToBytes(sig);
  } catch {
    return null;
  }
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  if (!timingSafeEqual(given, expected)) return null;
  let claims: MediaClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
  } catch {
    return null;
  }
  if (!claims.exp || Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}

// ── photo lookups (used by resolvers and clearPhoto) ─────────────────────────
/** Parameterized "?,?,.." placeholder list for an IN clause. */
function inClause(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

/**
 * Return the schema-shaped [{ type, url }] photo list for an entity (or []).
 * `owners` is the member scope; a photo owned by any scoped user is visible.
 */
export async function photosFor(
  env: Env,
  owners: string[],
  entityType: string,
  entityId: string,
): Promise<{ type: string; url: string }[]> {
  const row = await first<PhotoRow>(
    env,
    `SELECT * FROM photos WHERE owner_id IN (${inClause(owners)}) AND entity_type=? AND entity_id=?`,
    ...owners,
    entityType,
    entityId,
  );
  if (!row) return [];
  return [{ type: row.entity_type, url: `${mediaBase(env)}/media/${row.r2_key}` }];
}

/** Delete an entity's photo (R2 object + index row). Idempotent. */
export async function deletePhoto(
  env: Env,
  owners: string[],
  entityType: string,
  entityId: string,
): Promise<void> {
  const row = await first<PhotoRow>(
    env,
    `SELECT owner_id, r2_key FROM photos WHERE owner_id IN (${inClause(
      owners,
    )}) AND entity_type=? AND entity_id=?`,
    ...owners,
    entityType,
    entityId,
  );
  if (!row) return;
  await env.BUCKET.delete(row.r2_key);
  await run(
    env,
    "DELETE FROM photos WHERE owner_id=? AND entity_type=? AND entity_id=?",
    row.owner_id,
    entityType,
    entityId,
  );
}

// ── HTTP handlers for /media/* (invoked from src/index.ts) ───────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Index of `needle` in `hay` at or after `from`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Extract the raw bytes of the `name="file"` part from a multipart/form-data body.
 * Binary-safe (does not go through text decoding) and filename-agnostic — the native
 * app sends the file part WITHOUT a filename, which the Workers formData() parser
 * mishandles. Returns null if no such part is found.
 */
export function extractMultipartFile(bytes: Uint8Array, boundary: string): Uint8Array | null {
  const delim = new TextEncoder().encode(`--${boundary}`);
  const sep = new TextEncoder().encode("\r\n\r\n");
  let pos = 0;
  while (true) {
    const start = indexOfBytes(bytes, delim, pos);
    if (start < 0) return null;
    let hStart = start + delim.length;
    if (bytes[hStart] === 0x2d && bytes[hStart + 1] === 0x2d) return null; // closing --boundary--
    if (bytes[hStart] === 0x0d && bytes[hStart + 1] === 0x0a) hStart += 2; // skip CRLF
    const hEnd = indexOfBytes(bytes, sep, hStart);
    if (hEnd < 0) return null;
    const headers = new TextDecoder().decode(bytes.subarray(hStart, hEnd));
    const dataStart = hEnd + sep.length;
    const next = indexOfBytes(bytes, delim, dataStart);
    const rawEnd = next < 0 ? bytes.length : next;
    // strip the CRLF that precedes the boundary delimiter — but only if it's actually there
    const dataEnd =
      rawEnd >= dataStart + 2 && bytes[rawEnd - 2] === 0x0d && bytes[rawEnd - 1] === 0x0a
        ? rawEnd - 2
        : rawEnd;
    // match the part whose Content-Disposition name is exactly "file" (not filename="file")
    if (/(^|;|\s)name="file"/i.test(headers))
      return bytes.slice(dataStart, Math.max(dataStart, dataEnd));
    pos = next < 0 ? bytes.length : next;
  }
}

/**
 * Handle any /media/* request. Returns a Response, or null if the path is not a
 * media path (so the caller can fall through to GraphQL).
 *   POST /media/:usedFor/:cloudId?token=...  -> upload (native app: multipart/form-data, "file" part)
 *   PUT  /media/:usedFor/:cloudId?token=...  -> upload (tools: raw image bytes as the body)
 *   GET  /media/<r2 key>                      -> stream object
 */
export async function handleMedia(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/media/")) return null;
  const rest = url.pathname.slice("/media/".length);

  if (request.method === "POST" || request.method === "PUT") {
    const segments = rest.split("/");
    if (segments.length !== 2) return jsonResponse({ error: "bad upload path" }, 400);
    const [usedFor, cloudId] = segments.map(decodeURIComponent);
    const claims = await verifyMediaToken(env, url.searchParams.get("token"));
    if (!claims || claims.u !== usedFor || claims.c !== cloudId) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const key = `${usedFor}/${claims.o}/${cloudId}.${claims.e}`;
    // Two upload shapes:
    //   - native app: multipart/form-data with the image in a "file" part. Retrofit
    //     sends @Part("file") as a RAW RequestBody with NO filename, which makes the
    //     Workers formData() parser return it as a binary-corrupting string, so we
    //     parse the multipart body ourselves to get the "file" part's exact bytes.
    //   - CLI tools: the raw image bytes as the request body.
    const ct = request.headers.get("content-type") || "";
    let body: ArrayBuffer | Uint8Array;
    if (ct.toLowerCase().includes("multipart/form-data")) {
      // NB: read the boundary from the ORIGINAL ct — boundaries are case-sensitive.
      const boundary = /boundary=("?)([^";]+)\1/i.exec(ct)?.[2];
      const filePart = boundary
        ? extractMultipartFile(new Uint8Array(await request.arrayBuffer()), boundary)
        : null;
      if (!filePart) return jsonResponse({ error: "missing file part" }, 400);
      body = filePart;
    } else {
      body = await request.arrayBuffer();
    }
    await env.BUCKET.put(key, body, { httpMetadata: { contentType: claims.t } });
    await run(
      env,
      "INSERT INTO photos (owner_id,entity_type,entity_id,content_type,r2_key) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET " +
        "content_type=excluded.content_type, r2_key=excluded.r2_key, created=unixepoch()",
      claims.o,
      usedFor,
      cloudId,
      claims.t,
      key,
    );
    return jsonResponse({ success: true, url: `${mediaBase(env)}/media/${key}` });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const key = rest.split("/").map(decodeURIComponent).join("/");
    if (!key) return jsonResponse({ error: "not found" }, 404);
    const object = await env.BUCKET.get(key);
    if (!object) return jsonResponse({ error: "not found" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

// ── resolver slice ───────────────────────────────────────────────────────────
export const photosResolvers: ResolverSlice = {
  Mutation: {
    // Returns a working, short-lived, signed PUT endpoint on this Worker.
    requestUploadUrl: async (_p, args, ctx) => {
      const user = requireUser(ctx);
      const fileType = String(args.fileType);
      const usedFor = String(args.usedFor);
      const cloudId = String(args.cloudId);
      const ext = EXT[fileType] ?? "bin";
      const contentType = CONTENT_TYPE[fileType] ?? "application/octet-stream";
      const token = await signMediaToken(ctx.env, {
        o: user.id,
        u: usedFor,
        c: cloudId,
        e: ext,
        t: contentType,
        exp: Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS,
      });
      const url = `${mediaBase(ctx.env)}/media/${encodeURIComponent(usedFor)}/${encodeURIComponent(
        cloudId,
      )}?token=${token}`;
      return {
        url,
        headers: [{ name: "Content-Type", value: contentType }],
      };
    },
  },

  FreshAndSave: {
    photo: (item, _a, ctx) => {
      const it = item as { cloudId?: string; _ownerId?: string };
      if (!it.cloudId || !it._ownerId) return [];
      // The item's owner is already within the caller's member scope, so its
      // exact owner id is a sufficient (and minimal) scope for the photo lookup.
      return photosFor(ctx.env, [it._ownerId], "FRESHANDSAVE", it.cloudId);
    },
  },

  CustomerProfile: {
    photo: (profile, _a, ctx) => {
      const p = profile as { customerId?: string };
      if (!p.customerId) return [];
      return photosFor(ctx.env, [p.customerId], "PROFILE", p.customerId);
    },
  },
};
