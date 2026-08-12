import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedPresets } from "../src/seed";

const ENDPOINT = "https://example.com/graphql";

async function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("ZWILLING Food Organizer worker", () => {
  it("(a) GET /health returns ok", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; seeded: number };
    expect(body.status).toBe("ok");
    expect(body.seeded).toBe(21);
  });

  it("seedPresets() is idempotent and reports 21 groups", async () => {
    // Migrations already seeded; running the JS routine again must not error and
    // must not create duplicates.
    const n = await seedPresets(env);
    expect(n).toBe(21);
    const row = await env.DB.prepare(
      "SELECT count(*) AS c FROM foodgroups WHERE bucket='ZWILLING'",
    ).first<{ c: number }>();
    expect(row?.c).toBe(21);
  });

  it("(b) authLogin returns a JWT", async () => {
    const { status, body } = await gql(
      `mutation($s: CommerceSiteId!, $u: String!, $p: String!) {
         authLogin(siteId: $s, username: $u, password: $p) { token }
       }`,
      { s: "DE", u: "alice@example.com", p: "correct horse battery staple" },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const token = body.data.authLogin.token as string;
    expect(token.split(".")).toHaveLength(3); // header.payload.signature
  });

  it("authLogin: first login sets password, wrong password later fails", async () => {
    const login = (p: string) =>
      gql(
        `mutation($s: CommerceSiteId!, $u: String!, $p: String!) {
           authLogin(siteId: $s, username: $u, password: $p) { token }
         }`,
        { s: "DE", u: "bob@example.com", p },
      );

    const first = await login("hunter2");
    expect(first.body.errors).toBeUndefined();
    expect(first.body.data.authLogin.token).toBeTruthy();

    // Correct password on a subsequent login still works.
    const again = await login("hunter2");
    expect(again.body.errors).toBeUndefined();

    // Wrong password -> AUTHENTICATION_FAILED.
    const wrong = await login("nope");
    expect(wrong.body.data?.authLogin ?? null).toBeNull();
    expect(wrong.body.errors?.[0]?.extensions?.code).toBe("AUTHENTICATION_FAILED");
  });

  it("(c) foodgroupList(ZWILLING, 'de') returns 21 groups each with storable days", async () => {
    const { status, body } = await gql(
      `query($locale: String!, $bucket: FoodGroupBucket!) {
         foodgroupList(locale: $locale, bucket: $bucket) {
           cloudId
           name
           storable { location days }
         }
       }`,
      { locale: "de", bucket: "ZWILLING" },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const groups = body.data.foodgroupList as Array<{
      cloudId: string;
      name: string;
      storable: Array<{ location: string; days: number }>;
    }>;
    expect(groups).toHaveLength(21);
    for (const g of groups) {
      expect(g.name).toBeTruthy(); // localized (German) name present
      expect(g.storable.length).toBeGreaterThan(0);
      for (const s of g.storable) {
        expect(typeof s.days).toBe("number");
        expect(s.days).toBeGreaterThan(0);
      }
    }
    // Spot-check a known German name.
    const beef = groups.find((g) => g.cloudId === "4HD7ErEPKa5DJPlpjwEcIM");
    expect(beef?.name).toBe("Rindfleisch (frisch)");
  });

  it("(d) a guest hitting a user-scoped field gets AUTHENTICATION_FAILED", async () => {
    const { status, body } = await gql(`query { freshandsaveList { hash } }`);
    expect(status).toBe(200);
    expect(body.data?.freshandsaveList ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions?.code).toBe("AUTHENTICATION_FAILED");
  });

  it("shop/recipe/content operations resolve empty instead of erroring (empty layer)", async () => {
    const { body } = await gql(
      `query($siteId: CommerceSiteId!, $locale: String!) {
         commerceProductPopularSearchTerms(locale: $locale, siteId: $siteId)
         recipeList(locale: $locale) { total numberOfRecipesReturned data { identifier } }
       }`,
      { siteId: "DE", locale: "de" },
    );
    expect(body.errors).toBeUndefined();
    // Nullable list ([String!]) -> null is the schema-valid empty value.
    expect(body.data.commerceProductPopularSearchTerms).toBeNull();
    // Non-null object (RecipeListResponse!) -> filled minimal object, whose
    // non-null Int leaves are 0 and non-null list ([Recipe!]!) is [].
    expect(body.data.recipeList.total).toBe(0);
    expect(body.data.recipeList.numberOfRecipesReturned).toBe(0);
    expect(Array.isArray(body.data.recipeList.data)).toBe(true);
    expect(body.data.recipeList.data).toHaveLength(0);
  });
});
