/**
 * FCM (Firebase Cloud Messaging) daily push reminders.
 *
 * Fully self-contained on Web Crypto (crypto.subtle) — no Node builtins, no npm
 * deps. Driven by the Worker's `scheduled()` cron (see index.ts). The whole path
 * is secret-gated: with no FCM_SERVICE_ACCOUNT / FCM_PROJECT_ID configured,
 * runDailyReminders() is a no-op, so the Worker ships safe with push disabled.
 *
 * Flow:
 *   1. getAccessToken() — mint a short-lived OAuth2 access token from the service
 *      account, by signing a JWT (RS256) and exchanging it at Google's token
 *      endpoint (the standard two-legged service-account grant).
 *   2. sendPush() — POST an FCM HTTP v1 message to a device token.
 *   3. runDailyReminders() — for each stored device token, if that user owns any
 *      live item expiring within ~2 days, send ONE generic, privacy-safe push.
 *      Tokens FCM reports as UNREGISTERED (or 404) are deleted.
 *
 * Privacy: the push body names no food and no count — just "something expires
 * soon". Item names never leave the DB.
 */

import type { Env } from "./types";
import { all, run } from "./db";

/** Google service-account JSON (the fields we use). */
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

// ── base64url ────────────────────────────────────────────────────────────────

/** Bytes -> base64url (no padding), the JOSE wire encoding. */
export function base64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** UTF-8 string -> base64url. Used for the JWT header + claim set. */
export function base64urlFromString(s: string): string {
  return base64urlFromBytes(new TextEncoder().encode(s));
}

/** Standard base64 (from a PEM body) -> bytes. */
function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip a PKCS#8 PEM's header/footer/newlines and base64-decode to DER. */
function pkcs8DerFromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return bytesFromBase64(body);
}

// ── OAuth2 access token (service-account JWT grant) ──────────────────────────

/**
 * Mint an OAuth2 access token for the FCM scope from a service account.
 * Signs a JWT with RS256 (RSASSA-PKCS1-v1_5 / SHA-256) using the SA private key,
 * then exchanges it at Google's token endpoint.
 */
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const signingInput =
    base64urlFromString(JSON.stringify(header)) + "." + base64urlFromString(JSON.stringify(claim));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    // BufferSource: pass the ArrayBuffer view's buffer.
    pkcs8DerFromPem(sa.private_key).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = signingInput + "." + base64urlFromBytes(new Uint8Array(sig));

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`FCM token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("FCM token exchange: no access_token");
  return json.access_token;
}

// ── send one message (FCM HTTP v1) ───────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  status: number;
  /** True when FCM reports the token is no longer valid (delete it). */
  unregistered: boolean;
}

/** POST one notification to a device token via the FCM HTTP v1 API. */
export async function sendPush(
  accessToken: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
): Promise<SendResult> {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { token, notification: { title, body } } }),
  });
  if (resp.ok) return { ok: true, status: resp.status, unregistered: false };

  const text = await resp.text();
  const unregistered = resp.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(text);
  return { ok: false, status: resp.status, unregistered };
}

// ── daily scan ───────────────────────────────────────────────────────────────

const PUSH_TITLE = "FRESH & SAVE";
const PUSH_BODY = "Un aliment expire bientôt.";

/**
 * Secret-gated daily reminder scan. For every stored device token, if that token's
 * user owns at least one live item (state 'OK') expiring within ~2 days, send one
 * generic push. Deletes tokens FCM reports as unregistered.
 *
 * No-op (and logs) when FCM_SERVICE_ACCOUNT / FCM_PROJECT_ID are unset, so the
 * Worker runs fine with push disabled.
 */
export async function runDailyReminders(env: Env): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT || !env.FCM_PROJECT_ID) {
    console.log("push not configured");
    return;
  }

  let sa: ServiceAccount;
  try {
    sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    console.log("push not configured: FCM_SERVICE_ACCOUNT is not valid JSON");
    return;
  }
  if (!sa.client_email || !sa.private_key) {
    console.log("push not configured: service account missing fields");
    return;
  }

  const tokens = await all<{ owner_id: string; type: string; token: string }>(
    env,
    "SELECT owner_id, type, token FROM device_tokens",
  );
  if (tokens.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const soon = now + 2 * 86400; // within 2 days

  // Which users own a live item expiring within the window? One query, cached.
  const expiringByUser = new Map<string, boolean>();
  async function userHasExpiring(userId: string): Promise<boolean> {
    const cached = expiringByUser.get(userId);
    if (cached !== undefined) return cached;
    // `expire` is an ISO string ("2026-08-18" or "2026-08-18T00:00:00.000Z"), NOT a
    // unix timestamp — compare on the YYYY-MM-DD prefix vs the window's calendar date.
    const rows = await all<{ c: number }>(
      env,
      "SELECT count(*) AS c FROM freshandsave_items " +
        "WHERE owner_id=? AND state='OK' AND expire IS NOT NULL AND substr(expire,1,10) <= date(?, 'unixepoch')",
      userId,
      soon,
    );
    const has = Number(rows[0]?.c ?? 0) > 0;
    expiringByUser.set(userId, has);
    return has;
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch (err) {
    console.log("push: could not obtain access token:", String(err));
    return;
  }

  const projectId = env.FCM_PROJECT_ID;
  for (const t of tokens) {
    try {
      if (!(await userHasExpiring(t.owner_id))) continue;
      const res = await sendPush(accessToken, projectId, t.token, PUSH_TITLE, PUSH_BODY);
      if (res.unregistered) {
        await run(
          env,
          "DELETE FROM device_tokens WHERE owner_id=? AND type=? AND token=?",
          t.owner_id,
          t.type,
          t.token,
        );
      }
    } catch (err) {
      // Never let one bad token abort the batch.
      console.log("push: send failed for a token:", String(err));
    }
  }
}
