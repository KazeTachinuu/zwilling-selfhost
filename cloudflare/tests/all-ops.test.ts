/**
 * Acceptance gate: run EVERY shipped operation document with zero GraphQL errors.
 *
 * The ZWILLING app ships 97 distinct root operations (extracted from the APK,
 * preserved verbatim in preserved/operations.graphql). This drives all of them
 * against the Worker (local D1 + R2 via @cloudflare/vitest-pool-workers) and
 * asserts none returns a GraphQL `errors` key.
 *
 * Food Organizer + account operations run with real, functional behavior; SHOP /
 * RECIPES / DISCOVER / PROMOTIONS operations (whose upstream services were shut
 * down) still return schema-valid EMPTY responses via the generic empty layer.
 * Either way: no errors.
 *
 * This is a faithful port of backend-py/tests/test_all_ops.py.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// Imported as a text module (wrangler.jsonc Text rule for **/*.graphql). The
// Workers runtime has no filesystem, so the extract is bundled in as a string.
import operationsText from "../../preserved/operations.graphql";

const ENDPOINT = "https://example.com/graphql";

// A single corrupt sentinel line in the extract ("query cannot be empty") is not
// a real shipped operation and is not valid GraphQL; skipped explicitly (reported).
const SENTINEL = "query cannot be empty";

// Enum types that appear as required variables -> a valid member value.
const ENUM_VALUE: Record<string, string> = {
  CommerceSiteId: "DE",
  CommerceSite: "ZWILLING_DE",
  CommerceRecommender: "PDP",
  NotificationType: "ANDROID_FIREBASE",
  FoodGroupBucket: "ZWILLING",
  StorageType: "FRESHANDSAVE",
  UploadUrlFileTypes: "JPEG",
  UploadUrlUsage: "FRESHANDSAVE",
  SettingType: "GENERAL",
  FreshAndSaveSorting: "CREATION_DESC",
  ApplicationOS: "ANDROID",
  FreshAndSaveStorageFillLevel: "FULL",
  Storage: "FRIDGE",
};

// Input-object types that appear as required variables -> a minimal valid shape.
const DEVICE_USER: Record<string, string> = {};
for (const k of "title firstname lastname email address1 address2 streetNo city phonenumber state zip brand".split(
  " ",
)) {
  DEVICE_USER[k] = "x";
}
DEVICE_USER.country = "DE";
DEVICE_USER.locale = "en";
DEVICE_USER.email = "a@b.co";

const INPUT_VALUE: Record<string, Record<string, unknown>> = {
  NotificationGeneralInput: { title: "Reminder", body: "Your item expires soon" },
  NotificationOptionsInput: {},
  deviceRegisterUserInput: DEVICE_USER,
  CustomerAddressFieldsInput: { firstName: "Ada", lastName: "L", countryCode: "DE" },
  CustomerProfileInput: { firstName: "Ada", preferredLocale: "en" },
  FreshAndSaveModifyInput: { name: "Renamed" },
  GroupModifyInput: { name: "Family" },
  CustomerLoginInfoInput: {},
  CommerceBasketInput: {},
};

// Operations that are public (no user token): pre-auth account flows + guest catalog.
const PUBLIC = new Set([
  "authLogin",
  "authRegister",
  "authQLogin",
  "requestPasswordReset",
  "authPasswordReset",
  "SocialLoginProviderDetails",
  "verifySocialLoginCodes",
  "QuillonsFoodGroupList",
]);

interface VarDef {
  name: string;
  type: string;
}
interface ParsedOp {
  kind: string;
  name: string;
  vardefs: VarDef[];
}

/** Every non-empty operation line is one self-contained document (op + fragments). */
function loadDocuments(): string[] {
  const docs: string[] = [];
  for (const raw of operationsText.split("\n")) {
    const line = raw.trim();
    if (!line || !/^(query|mutation|subscription)\b/.test(line)) continue;
    docs.push(line);
  }
  return docs;
}

/** Return {kind, name, vardefs} for an operation document. */
function parseOp(doc: string): ParsedOp {
  const m = doc.match(/^(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*(\(([^)]*)\))?/);
  if (!m) throw new Error(`unparseable operation: ${doc.slice(0, 60)}`);
  const kind = m[1];
  const name = m[2];
  const varblock = m[4] ?? "";
  const vardefs: VarDef[] = [];
  const re = /\$(\w+):\s*([^,]+?)(?=(?:,\s*\$)|$)/g;
  let vm: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex exec loop
  while ((vm = re.exec(varblock)) !== null) {
    vardefs.push({ name: vm[1], type: vm[2].trim() });
  }
  return { kind, name, vardefs };
}

function valueFor(varname: string, typestr: string, ids: Record<string, string>): unknown {
  const core = typestr.replace(/!+$/, "").trim();
  if (core.startsWith("[")) return []; // empty list satisfies every list variable, incl. [X!]!
  if (core in ENUM_VALUE) return ENUM_VALUE[core];
  if (core in INPUT_VALUE) return { ...INPUT_VALUE[core] };
  if (core === "Int") return 1;
  if (core === "Float") return 1.0;
  if (core === "Boolean") return true;
  if (core === "ID") return ids[varname] ?? "dummy-id";
  // String and any opaque custom scalar
  const lname = varname.toLowerCase();
  if (["locale", "language", "region", "sitelocale"].includes(lname)) return "en";
  if (lname === "cloudid") return ids.cloudId ?? "dummy-id";
  if (lname === "containerid") return ids.containerId ?? "dummy-container";
  if (["email", "username"].includes(lname)) return "user@example.com";
  if (lname === "newpassword" || lname === "password") return "pw";
  return "test";
}

function buildVariables(
  doc: string,
  ids: Record<string, string>,
  opName: string,
): Record<string, unknown> {
  const { vardefs } = parseOp(doc);
  const local: Record<string, string> = { ...ids };
  // The variable name `cloudId` refers to different entities across ops; point it
  // at the matching real entity so id-bearing ops exercise real data.
  if (opName === "freshandsaveModifyStorage") {
    local.cloudId = ids.storageId ?? "dummy-id";
  }
  const out: Record<string, unknown> = {};
  for (const { name, type } of vardefs) {
    if (type.endsWith("!")) {
      // supply required variables; optional ones are omitted
      out[name] = valueFor(name, type, local);
    }
  }
  return out;
}

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

async function login(): Promise<string> {
  const d = await run(
    "mutation($s:CommerceSiteId!,$u:String!,$p:String!){authLogin(siteId:$s,username:$u,password:$p){token}}",
    { s: "DE", u: "allops@example.com", p: "pw" },
    null,
  );
  return d.data.authLogin.token;
}

/** Create real entities so id-bearing ops exercise real data (not just null). */
async function seedRealIds(token: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  await run(
    'mutation{containerSave(containerId:"RB1",containerType:"FRESHANDSAVE",size:"M",storageType:FRESHANDSAVE){success}}',
    {},
    token,
  );
  ids.containerId = "RB1";
  const fgResp = await run('query{foodgroupList(bucket:ZWILLING,locale:"en"){cloudId}}', {}, null);
  const fg = fgResp.data.foodgroupList[0].cloudId as string;
  const itemResp = await run(
    'mutation($e:String!){freshandsaveCreate(name:"Steak",expire:$e,storageplace:FRIDGE,' +
      `containerId:"RB1",foodgroupId:"${fg}"){cloudId}}`,
    { e: "2027-01-01T00:00:00.000Z" },
    token,
  );
  ids.cloudId = itemResp.data.freshandsaveCreate.cloudId;
  const sResp = await run('mutation{freshandsaveAddStorage(name:"Pantry"){id}}', {}, token);
  ids.storageId = sResp.data.freshandsaveAddStorage.id;
  return ids;
}

const DOCS = loadDocuments();

describe("all shipped operations execute without errors", () => {
  it(`runs every genuine operation from operations.graphql with zero GraphQL errors`, async () => {
    const token = await login();
    const ids = await seedRealIds(token);

    let passed = 0;
    const skipped: string[] = [];
    const failures: Array<{ name: string; errors: unknown }> = [];

    for (const doc of DOCS) {
      if (doc === SENTINEL) {
        skipped.push("(sentinel)");
        continue;
      }
      const { name } = parseOp(doc);
      const tok = PUBLIC.has(name) ? null : token;
      const variables = buildVariables(doc, ids, name);
      const body = await run(doc, variables, tok);
      if (body.errors) {
        failures.push({ name, errors: body.errors });
      } else {
        passed += 1;
      }
    }

    const total = passed + failures.length;
    // eslint-disable-next-line no-console
    console.log(
      `\n${passed}/${total} operations passed (${skipped.length} skipped: ${JSON.stringify(skipped)})`,
    );
    if (failures.length) {
      const detail = failures.map((f) => `  - ${f.name}: ${JSON.stringify(f.errors)}`).join("\n");
      throw new Error(`${failures.length} operation(s) returned GraphQL errors:\n${detail}`);
    }

    // Every shipped document except the single corrupt sentinel line must pass.
    expect(passed).toBe(DOCS.length - 1);
  });
});
