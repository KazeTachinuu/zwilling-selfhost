/**
 * Security hardening tests. These run against the FULLY HARDENED path: the test
 * env sets a non-default JWT secret with DEV=false, so introspection is off,
 * field suggestions are stripped, depth/cost limits apply, and login
 * rate-limiting is active (see vitest.config.ts).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ENDPOINT = "https://example.com/graphql";

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return { res, body: (await res.json()) as any };
}

describe("GraphQL hardening", () => {
  it("introspection is disabled (no __schema)", async () => {
    const { body } = await gql(`query { __schema { queryType { name } } }`);
    expect(body.data?.__schema ?? null).toBeNull();
    expect(body.errors?.length).toBeGreaterThan(0);
  });

  it("field suggestions are stripped from errors", async () => {
    // "foodgroupLis" is a near-miss for "foodgroupList" -> graphql would normally
    // append: Did you mean "foodgroupList"?
    const { body } = await gql(
      `query { foodgroupLis(bucket: ZWILLING, locale: "en") { cloudId } }`,
    );
    expect(body.errors?.length).toBeGreaterThan(0);
    const joined = JSON.stringify(body.errors);
    expect(joined).not.toMatch(/Did you mean/i);
  });

  it("query batching is disabled", async () => {
    const res = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ query: "{ __typename }" }, { query: "{ __typename }" }]),
    });
    // With batching off, an array body is not a valid single request.
    expect(res.status).toBe(400);
  });
});

describe("transport hardening", () => {
  it("security headers are present on every response", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("CORS default-denies an unknown browser Origin", async () => {
    const res = await SELF.fetch("https://example.com/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("login rate-limiting", () => {
  const login = (u: string, p: string) =>
    gql(
      `mutation($s: CommerceSiteId!, $u: String!, $p: String!) {
         authLogin(siteId: $s, username: $u, password: $p) { token }
       }`,
      { s: "DE", u, p },
    );

  it("locks out after repeated failures and returns a generic error", async () => {
    const u = "ratelimit@example.com";
    // First login sets the password (open registration in the test env).
    const created = await login(u, "correct-password");
    expect(created.body.data?.authLogin?.token).toBeTruthy();

    // Five wrong attempts trip the lockout (threshold = 5).
    for (let i = 0; i < 5; i++) {
      const wrong = await login(u, "wrong");
      expect(wrong.body.errors?.[0]?.extensions?.code).toBe("AUTHENTICATION_FAILED");
      // Generic message: never reveals whether the account exists.
      expect(wrong.body.errors?.[0]?.message).toBe("Invalid credentials");
    }

    // Now even the CORRECT password is locked out.
    const locked = await login(u, "correct-password");
    expect(locked.body.data?.authLogin ?? null).toBeNull();
    expect(locked.body.errors?.[0]?.extensions?.code).toBe("AUTHENTICATION_FAILED");
  });
});
