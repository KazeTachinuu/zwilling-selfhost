/**
 * Security hardening regression tests. Each test PROVES one of the findings from
 * graphql-cop + the live pentest is closed. The suite runs against the fully
 * hardened path (DEV=false, non-default JWT secret; see vitest.config.ts), so
 * the graphql-armor query-shape limiters, the POST+JSON-only transport rule, the
 * disabled GraphiQL IDE, and the closed first-login-provision flow are all live.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { login } from "../src/resolvers";
import type { Env, GraphQLContext } from "../src/types";

const ENDPOINT = "https://example.com/graphql";

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await SELF.fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return { res, body: (await res.json()) as any };
}

// ── 1. Alias overloading (HIGH) ──────────────────────────────────────────────
describe("alias overloading is rejected", () => {
  it("a query with 100 aliases is rejected", async () => {
    const aliases = Array.from(
      { length: 100 },
      (_, i) => `a${i}: foodgroupList(bucket: ZWILLING, locale: "en") { cloudId }`,
    ).join(" ");
    const { body } = await gql(`{ ${aliases} }`);
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.errors)).toMatch(/alias/i);
    // Never executed: no data leaked.
    expect(body.data ?? null).toBeNull();
  });
});

// ── 2. Directive overloading (HIGH) ──────────────────────────────────────────
describe("directive overloading is rejected", () => {
  it("a query with many duplicated directives is rejected", async () => {
    // 12 fields each carrying an @include directive => 12 directives > limit 10,
    // while staying under the alias limit so the DIRECTIVE limiter is what fires.
    const fields = Array.from(
      { length: 12 },
      (_, i) =>
        `a${i}: foodgroupList(bucket: ZWILLING, locale: "en") @include(if: true) { cloudId }`,
    ).join(" ");
    const { body } = await gql(`{ ${fields} }`);
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.errors)).toMatch(/directive/i);
  });
});

// ── depth limit ──────────────────────────────────────────────────────────────
describe("overly deep queries are rejected", () => {
  it("a 20-level-deep query is rejected", async () => {
    let q = "x";
    for (let i = 0; i < 20; i++) q = `x { ${q} }`;
    const { body } = await gql(`{ ${q} }`);
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.errors)).toMatch(/depth/i);
  });
});

// ── 3. GET + non-JSON transport (MED, CSRF surface) ──────────────────────────
describe("GraphQL transport is POST + application/json only", () => {
  it("GET /graphql returns 405 (non-200, non-HTML)", async () => {
    const res = await SELF.fetch(ENDPOINT, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/i);
  });

  it("a non-JSON (form-encoded) POST returns 415", async () => {
    const res = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "query={__typename}",
    });
    expect(res.status).toBe(415);
  });
});

// ── 4. GraphiQL IDE served in production (LOW) ───────────────────────────────
describe("GraphiQL IDE is not served in production", () => {
  it("GET /graphql with an HTML Accept header does not return the GraphiQL page", async () => {
    const res = await SELF.fetch(ENDPOINT, {
      method: "GET",
      headers: { Accept: "text/html" },
    });
    expect(res.status).not.toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).not.toMatch(/text\/html/i);
    const text = await res.text();
    expect(text).not.toMatch(/graphiql/i);
  });
});

// ── 5. Account takeover via NULL-password first login (MED) ──────────────────
/** Build a full Env from the test bindings, overriding the provided vars. */
function envWith(overrides: Partial<Env>): Env {
  return {
    DB: env.DB,
    BUCKET: env.BUCKET,
    JWT_SECRET: env.JWT_SECRET,
    JWT_TTL: env.JWT_TTL,
    ALLOW_REGISTRATION: "false",
    DEV: "false",
    ...overrides,
  } as Env;
}

async function provisionNullPasswordUser(email: string): Promise<string> {
  const id = crypto.randomUUID();
  // password_hash omitted -> NULL: a pre-provisioned, unclaimed account.
  await env.DB.prepare("INSERT INTO users (id, email, name, locale) VALUES (?,?,?,?)")
    .bind(id, email, null, "en")
    .run();
  return id;
}

async function passwordHashOf(email: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email=?")
    .bind(email)
    .first<{ password_hash: string | null }>();
  return row?.password_hash ?? null;
}

describe("NULL-password account takeover is closed by default", () => {
  it("with ALLOW_FIRST_LOGIN_PROVISION unset/false, login is rejected and the password is NOT set", async () => {
    const email = "unclaimed-default@example.com";
    await provisionNullPasswordUser(email);

    const { body } = await gql(
      `mutation($s: CommerceSiteId!, $u: String!, $p: String!) {
         authLogin(siteId: $s, username: $u, password: $p) { token }
       }`,
      { s: "DE", u: email, p: "attacker-chosen-password" },
    );

    // Generic failure: the attacker cannot tell this account exists.
    expect(body.data?.authLogin ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe("AUTHENTICATION_FAILED");
    expect(body.errors?.[0]?.message).toBe("Invalid credentials");

    // Critically: the account is still unclaimed (password never set).
    expect(await passwordHashOf(email)).toBeNull();
  });

  it("with ALLOW_FIRST_LOGIN_PROVISION=true, the first login sets the password", async () => {
    const email = "unclaimed-optin@example.com";
    await provisionNullPasswordUser(email);
    expect(await passwordHashOf(email)).toBeNull();

    const ctx: GraphQLContext = {
      env: envWith({ ALLOW_FIRST_LOGIN_PROVISION: "true" }),
      user: null,
      ip: "203.0.113.7",
    };
    const result = await login(ctx, {
      siteId: "DE",
      username: email,
      password: "owner-chosen-password",
    });

    expect(result.token.split(".")).toHaveLength(3); // a real JWT
    // The opt-in flow set the password on first login.
    expect(await passwordHashOf(email)).not.toBeNull();
  });
});
