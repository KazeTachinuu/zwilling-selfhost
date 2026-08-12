/**
 * Family GROUP sharing tests. Proves the group model and its group-scoped
 * inventory sharing (src/groups.ts, box.ts memberScope integration), plus the
 * onboarding-gate settings default. Runs against the fully hardened path
 * (DEV=false, non-default JWT secret; see vitest.config.ts).
 *
 * Coverage:
 *   1. groupCreate -> creator is an owner member
 *   2. groupJoinHash + groupJoin -> a second user becomes a member
 *   3. group-scoped sharing: A and B in one group SEE and MODIFY each other's
 *      freshandsave items and storages
 *   4. IDOR: user C in NO group with A can neither see nor modify A's items
 *   5. groupLeave by the owner promotes the remaining member; leave by the last
 *      member deletes the group
 *   6. settings returns isOnboardingCompleted=true by default
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ENDPOINT = "https://example.com/graphql";

async function run(doc: string, variables: Record<string, unknown>, token: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: doc, variables }),
  });
  expect(res.status, `HTTP ${res.status} for ${doc.slice(0, 60)}`).toBe(200);
  return (await res.json()) as { data?: any; errors?: any };
}

/** authLogin provisions the account on first sight (ALLOW_REGISTRATION=true in test env). */
async function login(email: string): Promise<string> {
  const d = await run(
    "mutation($s:CommerceSiteId!,$u:String!,$p:String!){authLogin(siteId:$s,username:$u,password:$p){token}}",
    { s: "DE", u: email, p: "pw" },
    null,
  );
  expect(d.errors, JSON.stringify(d.errors)).toBeUndefined();
  return d.data.authLogin.token as string;
}

async function createItem(token: string, name: string): Promise<string> {
  const r = await run(
    "mutation($e:String!,$n:String!){freshandsaveCreate(name:$n,expire:$e,storageplace:FRIDGE){cloudId}}",
    { n: name, e: "2027-01-01T00:00:00.000Z" },
    token,
  );
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data.freshandsaveCreate.cloudId as string;
}

async function listItemNames(token: string): Promise<string[]> {
  const r = await run("query{freshandsaveList{items{cloudId name}}}", {}, token);
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return (r.data.freshandsaveList.items as { name: string }[]).map((i) => i.name);
}

async function createGroup(token: string, name: string): Promise<string> {
  const r = await run(
    "mutation($n:String!){groupCreate(name:$n){success groupId}}",
    { n: name },
    token,
  );
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  expect(r.data.groupCreate.success).toBe(true);
  return r.data.groupCreate.groupId as string;
}

// ── 1 + 2. create + join ──────────────────────────────────────────────────────
describe("group create + join", () => {
  it("groupCreate makes the creator an owner member; groupJoin adds a second member", async () => {
    const a = await login("g-a1@example.com");
    const b = await login("g-b1@example.com");
    const groupId = await createGroup(a, "Family");

    // Creator sees the group in their profile and is the owner.
    const prof = await run(
      "query{profile(siteId:DE){groups{groupId name members{userId owner}}}}",
      {},
      a,
    );
    expect(prof.errors, JSON.stringify(prof.errors)).toBeUndefined();
    const grp = (prof.data.profile.groups as any[]).find((g) => g.groupId === groupId);
    expect(grp).toBeTruthy();
    expect(grp.name).toBe("Family");
    expect(grp.members).toHaveLength(1);
    expect(grp.members[0].owner).toBe(true);

    // Owner mints a permanent join hash.
    const hashResp = await run(
      "query($g:String!){groupJoinHash(groupId:$g,mode:PERMANENT){hash groupId}}",
      { g: groupId },
      a,
    );
    expect(hashResp.errors, JSON.stringify(hashResp.errors)).toBeUndefined();
    const hash = hashResp.data.groupJoinHash.hash as string;
    expect(hash.length).toBeGreaterThanOrEqual(16);

    // B joins with the hash.
    const joinResp = await run("mutation($h:String!){groupJoin(hash:$h){success}}", { h: hash }, b);
    expect(joinResp.errors, JSON.stringify(joinResp.errors)).toBeUndefined();
    expect(joinResp.data.groupJoin.success).toBe(true);

    // Group now has 2 members, exactly one owner.
    const prof2 = await run(
      "query{profile(siteId:DE){groups{groupId members{userId owner}}}}",
      {},
      a,
    );
    const grp2 = (prof2.data.profile.groups as any[]).find((g) => g.groupId === groupId);
    expect(grp2.members).toHaveLength(2);
    expect(grp2.members.filter((m: any) => m.owner)).toHaveLength(1);

    // A bad/unknown hash fails cleanly.
    const bad = await run('mutation{groupJoin(hash:"nope-not-a-real-hash"){success}}', {}, b);
    expect(bad.data.groupJoin.success).toBe(false);
  });
});

// ── 3. group-scoped sharing ───────────────────────────────────────────────────
describe("group-scoped sharing: members see and modify each other's data", () => {
  it("A and B in one group share freshandsave items and storages both ways", async () => {
    const a = await login("g-a2@example.com");
    const b = await login("g-b2@example.com");
    const groupId = await createGroup(a, "Shared");
    const hashResp = await run(
      "query($g:String!){groupJoinHash(groupId:$g){hash}}",
      { g: groupId },
      a,
    );
    await run(
      "mutation($h:String!){groupJoin(hash:$h){success}}",
      { h: hashResp.data.groupJoinHash.hash },
      b,
    );

    // A creates an item; B creates an item.
    const itemA = await createItem(a, "A-Steak");
    const itemB = await createItem(b, "B-Milk");

    // Both see BOTH items (shared inventory).
    expect((await listItemNames(a)).sort()).toEqual(["A-Steak", "B-Milk"]);
    expect((await listItemNames(b)).sort()).toEqual(["A-Steak", "B-Milk"]);

    // B can fetch A's item by id.
    const single = await run(
      "query($c:ID!){freshandsave(cloudId:$c){cloudId name}}",
      { c: itemA },
      b,
    );
    expect(single.data.freshandsave?.name).toBe("A-Steak");

    // B modifies A's item; A modifies B's item.
    const modAbyB = await run(
      'mutation($c:ID!){freshandsaveModify(cloudId:$c,change:{name:"A-Steak-edited"}){success}}',
      { c: itemA },
      b,
    );
    expect(modAbyB.data.freshandsaveModify.success).toBe(true);
    const modBbyA = await run(
      'mutation($c:ID!){freshandsaveModify(cloudId:$c,change:{name:"B-Milk-edited"}){success}}',
      { c: itemB },
      a,
    );
    expect(modBbyA.data.freshandsaveModify.success).toBe(true);
    expect((await listItemNames(a)).sort()).toEqual(["A-Steak-edited", "B-Milk-edited"]);

    // Storages are shared too: A adds one, B sees and modifies it.
    const stResp = await run('mutation{freshandsaveAddStorage(name:"Pantry"){id}}', {}, a);
    const storageId = stResp.data.freshandsaveAddStorage.id as string;
    const bStorages = await run("query{freshandsaveListStorage{id name}}", {}, b);
    expect((bStorages.data.freshandsaveListStorage as any[]).some((s) => s.id === storageId)).toBe(
      true,
    );
    const stMod = await run(
      'mutation($c:ID!){freshandsaveModifyStorage(cloudId:$c,name:"Pantry-B"){id name}}',
      { c: storageId },
      b,
    );
    expect(stMod.data.freshandsaveModifyStorage.name).toBe("Pantry-B");
  });
});

// ── 4. IDOR: no-group user is blocked ─────────────────────────────────────────
describe("IDOR: a user in no group cannot read or modify another user's data", () => {
  it("C (no group) can neither see nor modify A's items", async () => {
    const a = await login("g-a3@example.com");
    const c = await login("g-c3@example.com");
    const itemA = await createItem(a, "A-Private");

    // C's own listing does not include A's item.
    expect(await listItemNames(c)).not.toContain("A-Private");

    // C cannot fetch A's item by id.
    const single = await run(
      "query($x:ID!){freshandsave(cloudId:$x){cloudId name}}",
      { x: itemA },
      c,
    );
    expect(single.data.freshandsave ?? null).toBeNull();

    // C's modify is a no-op (not in scope) -> success:false, and A's item is unchanged.
    const mod = await run(
      'mutation($x:ID!){freshandsaveModify(cloudId:$x,change:{name:"hacked"}){success}}',
      { x: itemA },
      c,
    );
    expect(mod.data.freshandsaveModify.success).toBe(false);
    expect(await listItemNames(a)).toContain("A-Private");
  });
});

// ── 5. groupLeave semantics ───────────────────────────────────────────────────
describe("groupLeave: owner leaving promotes; last member leaving deletes", () => {
  it("owner leave promotes the remaining member to owner", async () => {
    const a = await login("g-a4@example.com");
    const b = await login("g-b4@example.com");
    const groupId = await createGroup(a, "Promote");
    const hashResp = await run(
      "query($g:String!){groupJoinHash(groupId:$g){hash}}",
      { g: groupId },
      a,
    );
    await run(
      "mutation($h:String!){groupJoin(hash:$h){success}}",
      { h: hashResp.data.groupJoinHash.hash },
      b,
    );

    // Owner A leaves.
    const leave = await run(
      "mutation($g:String!){groupLeave(groupId:$g){success}}",
      { g: groupId },
      a,
    );
    expect(leave.data.groupLeave.success).toBe(true);

    // B remains and is now the owner; A no longer sees the group.
    const bProf = await run(
      "query{profile(siteId:DE){groups{groupId members{userId owner}}}}",
      {},
      b,
    );
    const grp = (bProf.data.profile.groups as any[]).find((g) => g.groupId === groupId);
    expect(grp).toBeTruthy();
    expect(grp.members).toHaveLength(1);
    expect(grp.members[0].owner).toBe(true);
    const aProf = await run("query{profile(siteId:DE){groups{groupId}}}", {}, a);
    expect((aProf.data.profile.groups as any[]).some((g) => g.groupId === groupId)).toBe(false);
  });

  it("last member leaving deletes the group and its join hashes", async () => {
    const a = await login("g-a5@example.com");
    const groupId = await createGroup(a, "Solo");
    // Mint a hash so we can prove it is invalidated on group deletion.
    const hashResp = await run(
      "query($g:String!){groupJoinHash(groupId:$g){hash}}",
      { g: groupId },
      a,
    );
    const hash = hashResp.data.groupJoinHash.hash as string;

    const leave = await run(
      "mutation($g:String!){groupLeave(groupId:$g){success}}",
      { g: groupId },
      a,
    );
    expect(leave.data.groupLeave.success).toBe(true);

    // Group row gone from D1.
    const grpRow = await env.DB.prepare("SELECT id FROM groups WHERE id=?").bind(groupId).first();
    expect(grpRow).toBeNull();
    const hashRow = await env.DB.prepare("SELECT hash FROM group_join_hashes WHERE hash=?")
      .bind(hash)
      .first();
    expect(hashRow).toBeNull();

    // The now-dangling hash can no longer be joined.
    const b = await login("g-b5@example.com");
    const join = await run("mutation($h:String!){groupJoin(hash:$h){success}}", { h: hash }, b);
    expect(join.data.groupJoin.success).toBe(false);
  });
});

// ── 6. onboarding gate ────────────────────────────────────────────────────────
describe("settings default", () => {
  it("returns isOnboardingCompleted=true unless the user stored a value", async () => {
    const a = await login("g-a6@example.com");
    const r = await run("query{settings(type:GENERAL){settings{key value}}}", {}, a);
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    const entries = r.data.settings.settings as { key: string; value: string }[];
    const onboarding = entries.filter((e) => e.key === "isOnboardingCompleted");
    expect(onboarding).toHaveLength(1);
    expect(onboarding[0].value).toBe("true");

    // A stored real value overrides and is not duplicated.
    await run(
      'mutation{settingSet(type:GENERAL,key:"isOnboardingCompleted",value:"false"){success}}',
      {},
      a,
    );
    const r2 = await run("query{settings(type:GENERAL){settings{key value}}}", {}, a);
    const onboarding2 = (r2.data.settings.settings as { key: string; value: string }[]).filter(
      (e) => e.key === "isOnboardingCompleted",
    );
    expect(onboarding2).toHaveLength(1);
    expect(onboarding2[0].value).toBe("false");
  });
});
