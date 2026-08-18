/**
 * Worker entrypoint.
 *
 *   GET  /health   -> lightweight JSON status (+ preset count)
 *   POST /graphql  -> GraphQL via graphql-yoga (hardened)
 *   PUT/GET /media -> R2-backed photo upload/serving
 *   OPTIONS *      -> CORS preflight
 *
 * Security posture (see src/security.ts and DEPLOY.md):
 *   - Refuses to run in production with the dev-default JWT secret.
 *   - Default-deny CORS; the native app sends no Origin and is unaffected.
 *   - Security headers on every response.
 *   - GraphQL: introspection + field suggestions off (unless DEV), query
 *     batching off, depth + complexity limits on.
 */

import { createYoga } from "graphql-yoga";
import { userFromRequest } from "./auth";
import { runDailyReminders } from "./fcm";
import { handleMedia } from "./resolvers/photos";
import { schema } from "./schema";
import {
  corsHeaders,
  isDev,
  productionSecretGuard,
  securityHeaders,
  securityPlugins,
} from "./security";
import type { Env, GraphQLContext } from "./types";

export { schema } from "./schema";
// Re-export the seed routine so it can be driven from tests / scripts.
export { seedPresets } from "./seed";

function json(body: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Yoga is built lazily on first request (env is only available inside fetch) and
// cached for the isolate. env is stable per isolate, so the security plugin's
// DEV posture is fixed at build time.
let yogaInstance: ReturnType<
  typeof createYoga<{ env: Env; ctx: ExecutionContext }, GraphQLContext>
> | null = null;

function getYoga(env: Env) {
  if (!yogaInstance) {
    yogaInstance = createYoga<{ env: Env; ctx: ExecutionContext }, GraphQLContext>({
      schema,
      graphqlEndpoint: "/graphql",
      // No landing page and no GraphiQL IDE in production: both are dev-only
      // affordances and must never ship enabled. GraphiQL is served only when
      // DEV is explicitly on.
      landingPage: false,
      graphiql: isDev(env),
      // CORS is handled by the outer fetch handler so /health, /media and
      // /graphql share one policy.
      cors: false,
      // Disable query batching: it multiplies work per request and dodges
      // per-operation rate limits.
      batching: false,
      plugins: securityPlugins(env),
      context: async ({ request }) => ({
        env,
        user: await userFromRequest(request, env),
        ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
      }),
    });
  }
  return yogaInstance;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env, request);
    const base = { ...securityHeaders(), ...cors };

    // Hard guard: never serve a production request with the dev-default secret.
    const guard = productionSecretGuard(env, base);
    if (guard) return guard;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: base });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      let seeded = 0;
      try {
        const row = await env.DB.prepare(
          "SELECT count(*) AS c FROM foodgroups WHERE bucket='ZWILLING'",
        ).first<{ c: number }>();
        seeded = Number(row?.c ?? 0);
      } catch {
        // DB not migrated yet: still report ok so health checks pass.
      }
      return json({ status: "ok", service: "zwilling-food-organizer", seeded }, base);
    }

    // Self-hosted APK distribution: /app is a plain install page, /app/download
    // streams the current build from R2 (key "_dist/zwilling.apk").
    if (request.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
      const origin = url.origin;
      const s = APP_STRINGS[(env.APP_LOCALE || "en").toLowerCase()] ?? APP_STRINGS.en;
      const html = APP_PAGE.replaceAll("__ORIGIN__", origin)
        .replaceAll("__LANG__", s.lang)
        .replaceAll("__DESC__", s.desc)
        .replaceAll("__DOWNLOAD__", s.download)
        .replaceAll("__NOTE__", s.note);
      return new Response(html, {
        status: 200,
        headers: {
          ...base,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          // The API's default-src 'none' CSP blocks this page's inline <style>.
          // Relax just enough for a self-contained HTML page: inline styles, same-origin nav.
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        },
      });
    }
    // Link-preview card for /app (og:image). Served from R2 key "_dist/og.png".
    // Crawlers fetch this absolute URL; a long cache is fine (it rarely changes).
    if (request.method === "GET" && url.pathname === "/app/og.png") {
      const og = await env.BUCKET.get("_dist/og.png");
      if (!og) return json({ error: "no og image" }, base, 404);
      const h = new Headers(base);
      h.set("Content-Type", "image/png");
      h.set("Cache-Control", "public, max-age=86400");
      h.set("Content-Length", String(og.size));
      // og:image must load for crawlers regardless of the API's default-src 'none'.
      h.set("Content-Security-Policy", "default-src 'none'; img-src 'self'");
      return new Response(og.body, { status: 200, headers: h });
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/app/download"
    ) {
      const apk = await env.BUCKET.get("_dist/zwilling.apk");
      if (!apk) return json({ error: "no build published yet" }, base, 404);
      const h = new Headers(base);
      h.set("Content-Type", "application/vnd.android.package-archive");
      h.set("Content-Disposition", 'attachment; filename="zwilling-fresh-and-save.apk"');
      h.set("Cache-Control", "no-cache");
      h.set("Content-Length", String(apk.size));
      return new Response(request.method === "HEAD" ? null : apk.body, { status: 200, headers: h });
    }

    // Photo upload (PUT) and serving (GET/HEAD) live on /media/*.
    if (url.pathname.startsWith("/media/")) {
      const media = await handleMedia(request, env, url);
      if (media) {
        const headers = new Headers(media.headers);
        for (const [k, v] of Object.entries(base)) headers.set(k, v);
        return new Response(media.body, { status: media.status, headers });
      }
    }

    // Transport hardening for the GraphQL endpoint (skipped in DEV so GraphiQL
    // and its GET-based introspection keep working locally). In production the
    // endpoint accepts ONLY POST + application/json: this removes the CSRF
    // surface of GET / form-encoded GraphQL and the simple-request bypass.
    if (url.pathname === "/graphql" && !isDev(env)) {
      if (request.method !== "POST") {
        return json(
          { errors: [{ message: "Method Not Allowed. Use POST." }] },
          { ...base, Allow: "POST" },
          405,
        );
      }
      const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        return json(
          { errors: [{ message: "Unsupported Media Type. Use application/json." }] },
          base,
          415,
        );
      }
    }

    const response = await getYoga(env).fetch(request, { env, ctx });
    // Merge CORS + security headers onto the Yoga response.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(base)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },

  // Cron entrypoint (see wrangler.jsonc "triggers.crons"). Runs the FCM daily
  // reminder scan; secret-gated inside runDailyReminders (no-op when FCM is
  // unconfigured). waitUntil keeps the isolate alive until the scan resolves.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyReminders(env));
  },
};

// Install-page copy by locale (set APP_LOCALE; default "en"). The page itself is
// APP_PAGE below, with __LANG__/__DESC__/__DOWNLOAD__/__NOTE__ filled in per request.
const APP_STRINGS: Record<string, { lang: string; desc: string; download: string; note: string }> =
  {
    en: {
      lang: "en",
      desc: "Download the FRESH &amp; SAVE Android app.",
      download: "Download",
      note: "Android. Uninstall the official app first.",
    },
    fr: {
      lang: "fr",
      desc: "Télécharger l'application Android FRESH &amp; SAVE.",
      download: "Télécharger",
      note: "Android. Désinstallez d'abord l'app officielle.",
    },
  };

// Self-contained install page served at /app. No external resources, theme-aware,
// mirrors the app's cream/red FRESH & SAVE look. Icons are inline monochrome SVG.
const APP_PAGE = `<!doctype html><html lang="__LANG__"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FRESH &amp; SAVE</title>
<meta name="description" content="__DESC__">
<meta name="theme-color" content="#e2231a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="FRESH &amp; SAVE">
<meta property="og:title" content="FRESH &amp; SAVE">
<meta property="og:description" content="__DESC__">
<meta property="og:url" content="__ORIGIN__/app">
<meta property="og:image" content="__ORIGIN__/app/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="FRESH &amp; SAVE">
<meta name="twitter:description" content="__DESC__">
<meta name="twitter:image" content="__ORIGIN__/app/og.png">
<style>
:root{--bg:#f2ede5;--panel:#fff;--ink:#1b1a17;--sub:#8a847a;--line:#e6ded1;--brand:#e2231a}
@media(prefers-color-scheme:dark){:root{--bg:#0e0d0c;--panel:#191816;--ink:#f3efe8;--sub:#9c968b;--line:#2c2a26}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--ink);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);
border-radius:24px;padding:44px 32px;box-shadow:0 12px 48px rgba(0,0,0,.10);
display:flex;flex-direction:column;align-items:center;text-align:center;gap:22px}
.logo{width:76px;height:76px;border-radius:18px;display:block}
.mark{font-weight:800;letter-spacing:.18em;font-size:15px;color:var(--ink)}
.sub{margin:-8px 0 4px;font-size:13px;color:var(--sub)}
.dl{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;
background:var(--brand);color:#fff;text-decoration:none;font-weight:700;font-size:16px;
padding:15px;border-radius:14px;transition:opacity .15s}
.dl:active{opacity:.85}.dl svg{width:20px;height:20px}
</style></head><body>
<main class="card">
<img class="logo" src="data:image/png;base64,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" width="76" height="76" alt="ZWILLING">
<div>
<div class="mark">FRESH &amp; SAVE</div>
</div>
<a class="dl" href="/app/download" download="zwilling-fresh-and-save.apk">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>
__DOWNLOAD__
</a>
<div class="sub">__NOTE__</div>
</main></body></html>`;
