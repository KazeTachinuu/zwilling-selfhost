#!/usr/bin/env node

/**
 * Admin: create or reset a family account WITHOUT email/registration.
 *
 * Computes a PBKDF2-SHA256 hash byte-for-byte compatible with src/auth.ts
 * (`pbkdf2$sha256$100000$<saltB64>$<hashB64>`) and upserts a `users` row via
 * `wrangler d1 execute`. Creating and resetting are the same operation: the
 * ON CONFLICT clause overwrites the password for an existing email.
 *
 * Usage:
 *   node scripts/admin-user.mjs <email> <password> [--local|--remote] [--print]
 *   npm run admin:create-user -- alice@family.test 'a strong passphrase' --remote
 *
 * Flags:
 *   --local   run against the local (miniflare) D1     (default)
 *   --remote  run against the deployed Cloudflare D1
 *   --print   only print the SQL; do not touch the database
 *
 * Closed registration (ALLOW_REGISTRATION unset/false) means this script is the
 * ONLY way new accounts appear in production.
 */

import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;
const SALT_LEN = 16;
const DATABASE = "zwilling"; // matches database_name in wrangler.jsonc

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node scripts/admin-user.mjs <email> <password> [--local|--remote] [--print]",
  );
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

if (flags.has("--help") || flags.has("-h")) usage();
const [email, password] = positional;
if (!email || !password) usage("email and password are required");
if (!email.includes("@")) usage("email looks invalid");

const target = flags.has("--remote") ? "--remote" : "--local";

// PBKDF2 hash, identical encoding to src/auth.ts hashPassword().
const salt = randomBytes(SALT_LEN);
const derived = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, "sha256");
const hash = `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${derived.toString("base64")}`;

const id = randomUUID();
const sqlEmail = email.trim().toLowerCase().replace(/'/g, "''");
const sqlHash = hash.replace(/'/g, "''");

const sql =
  `INSERT INTO users (id, email, password_hash, name, locale) ` +
  `VALUES ('${id}', '${sqlEmail}', '${sqlHash}', NULL, 'en') ` +
  `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, modified = unixepoch();`;

if (flags.has("--print")) {
  console.log(sql);
  process.exit(0);
}

console.log(`Upserting account '${sqlEmail}' into D1 (${target}) ...`);
try {
  execFileSync("bunx", ["wrangler", "d1", "execute", DATABASE, target, "--command", sql], {
    stdio: "inherit",
  });
  console.log(`Done. '${sqlEmail}' can now log in with the given password.`);
} catch (_err) {
  console.error("wrangler d1 execute failed.");
  console.error("You can also run this SQL manually (printed below):\n");
  console.error(sql);
  process.exit(1);
}
