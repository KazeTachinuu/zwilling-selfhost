#!/usr/bin/env bash
#
# One-shot self-host installer for the ZWILLING Food Organizer backend.
# Creates your Cloudflare D1 + R2, wires them into wrangler.jsonc, sets a strong
# JWT secret, migrates + seeds the database, deploys the Worker, and creates your
# first account. Safe to re-run: it reuses resources that already exist.
#
#   ./install.sh
#
# Requires: bun, python3, openssl, and a Cloudflare account.
set -euo pipefail
cd "$(dirname "$0")/cloudflare"

# ── things you might want to change ──────────────────────────────────────────
DB_NAME="zwilling"          # D1 database name
BUCKET="zwilling-photos"    # R2 bucket name (photos + the APK)
WR="wrangler.jsonc"

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else B= D= R= G= Y= C= X=; fi
say(){  printf '  %s[*]%s %s\n' "$C" "$X" "$*"; }
ok(){   printf '  %s[+]%s %s\n' "$G" "$X" "$*"; }
skip(){ printf '  %s[!]%s %s\n' "$Y" "$X" "$*"; }
die(){  printf '  %s[-]%s %s\n' "$R" "$X" "$*" >&2; exit 1; }
wr(){ bunx wrangler "$@"; }

printf '\n  %sFRESH & SAVE%s  self-host installer\n' "$B" "$X"
printf '  %s------------------------------------%s\n\n' "$D" "$X"

# ── prerequisites ────────────────────────────────────────────────────────────
say "checking prerequisites"
need(){ command -v "$1" >/dev/null 2>&1 && ok "$1 $2" || die "missing '$1' — install it and re-run"; }
need bun     "$(bun --version 2>/dev/null)"
need python3 "$(python3 -V 2>/dev/null | awk '{print $2}')"
need openssl "$(openssl version 2>/dev/null | awk '{print $2}')"
[ -f package.json ] || die "run from the repo root (cloudflare/ must exist)"
echo

say "installing dependencies"; bun install >/dev/null 2>&1 || die "bun install failed"; ok "dependencies ready"

say "Cloudflare account"
if wr whoami >/dev/null 2>&1; then ok "logged in"; else wr login; fi

# ── D1: reuse if it exists, else create ──────────────────────────────────────
say "D1 database '$DB_NAME'"
find_db(){ wr d1 list --json 2>/dev/null | python3 -c \
  "import sys,json;print(next((d.get('uuid') or d.get('database_id','') for d in json.load(sys.stdin) if d.get('name')=='$DB_NAME'),''))" 2>/dev/null; }
DBID=$(find_db || true)
if [ -z "$DBID" ]; then wr d1 create "$DB_NAME" >/dev/null; DBID=$(find_db)
  [ -n "$DBID" ] || die "could not resolve D1 id for '$DB_NAME'"; ok "created ($DBID)"
else ok "found ($DBID)"; fi

# ── R2: create if missing ────────────────────────────────────────────────────
say "R2 bucket '$BUCKET'"
if wr r2 bucket list 2>/dev/null | grep -qE "name: *$BUCKET|^$BUCKET\b"; then ok "found"
else wr r2 bucket create "$BUCKET" >/dev/null || die "could not create R2 bucket (is R2 enabled in the dashboard?)"; ok "created"; fi

# ── custom domain (optional) ─────────────────────────────────────────────────
echo; read -r -p "  Custom domain (blank = free *.workers.dev): " DOMAIN
DOMAIN="$(echo "$DOMAIN" | xargs)"
read -r -p "  Allow open self-registration? Anyone can create an account (y/N): " REG
case "$REG" in [yY]*) OPENREG=true;; *) OPENREG=false;; esac

# ── write config into wrangler.jsonc (surgical; keeps comments) ──────────────
say "configuring wrangler.jsonc"
DBID="$DBID" DOMAIN="$DOMAIN" OPENREG="$OPENREG" python3 - "$WR" <<'PY'
import os, re, sys
p=sys.argv[1]; s=open(p).read()
dbid=os.environ["DBID"]; domain=os.environ["DOMAIN"]; openreg=os.environ["OPENREG"]
s=re.sub(r'("database_id":\s*")[^"]*(")', lambda m:m.group(1)+dbid+m.group(2), s, count=1)
route='"routes": [{ "pattern": "%s", "custom_domain": true }],'%domain if domain else '"workers_dev": true,'
s=re.sub(r'"routes":\s*\[[^\]]*\],|"workers_dev":\s*(?:true|false),', route, s, count=1)
s=re.sub(r'("ALLOW_REGISTRATION":\s*")(?:true|false)(")', lambda m:m.group(1)+openreg+m.group(2), s, count=1)
open(p,"w").write(s)
PY
ok "database + ${DOMAIN:-workers.dev} + registration=${OPENREG}"

# ── migrate (also seeds via 0002) + deploy ───────────────────────────────────
say "applying migrations (tables + seed food data)"
bun run migrate:remote >/dev/null || die "database migration failed"; ok "database ready"

say "deploying the Worker"
OUT=$(wr deploy 2>&1) || die "deploy failed:\n$OUT"
if [ -n "$DOMAIN" ]; then BASE="https://$DOMAIN"
else BASE=$(echo "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1); fi
[ -n "$BASE" ] || die "could not determine deployed URL"
ok "live at $BASE"

# ── JWT secret (Worker must exist before `wrangler secret put`) ───────────────
say "JWT secret"
if wr secret list 2>/dev/null | grep -q 'JWT_SECRET'; then skip "already set"
else openssl rand -base64 48 | tr -d '\n' | wr secret put JWT_SECRET >/dev/null || die "could not store JWT secret"; ok "generated + stored"; fi

# point photo URLs at THIS deployment, then redeploy once
say "setting MEDIA_BASE_URL"
BASE="$BASE" python3 - "$WR" <<'PY'
import os,re,sys
p=sys.argv[1]; s=open(p).read(); base=os.environ["BASE"]
if '"MEDIA_BASE_URL"' in s:
    s=re.sub(r'("MEDIA_BASE_URL":\s*")[^"]*(")', lambda m:m.group(1)+base+m.group(2), s, count=1)
else:
    s=re.sub(r'("vars":\s*\{)', lambda m:m.group(1)+'\n    "MEDIA_BASE_URL": "%s",'%base, s, count=1)
open(p,"w").write(s)
PY
wr deploy >/dev/null || die "redeploy failed"; ok "$BASE"

# ── first account (registration is closed; this is the only way in) ──────────
echo; say "create your first account"
read -r -p "  email:    " EMAIL
read -r -s -p "  password: " PASS; echo
if [ -n "$EMAIL" ] && [ -n "$PASS" ]; then
  bun run admin:create-user -- "$EMAIL" "$PASS" --remote >/dev/null && ok "account '$EMAIL' created"
else skip "no account created (run admin:create-user later)"; fi

# ── done ─────────────────────────────────────────────────────────────────────
printf '\n  %sdone.%s\n\n' "$G" "$X"
echo "  backend    $BASE"
echo "  health     $BASE/health"
echo "  app page   $BASE/app"
echo "  add users  cd cloudflare && bun run admin:create-user -- name@home 'pass' --remote"
echo
