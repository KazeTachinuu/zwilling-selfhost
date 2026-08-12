#!/usr/bin/env bash
#
# Deployment doctor: point it at your deployed backend and it verifies that every
# moving part is wired correctly (TLS, Worker, D1 + seed, GraphQL, R2, push, app
# download). Read-only, creates nothing.
#
#   ./check.sh https://your-backend.example.com
#   ./check.sh                 # reads the URL from cloudflare/wrangler.jsonc
set -uo pipefail
cd "$(dirname "$0")"

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else B= D= R= G= Y= C= X=; fi

# ── resolve target URL ───────────────────────────────────────────────────────
# 1) explicit arg  2) wrangler.jsonc "pattern" (custom domain)
# 3) wrangler.jsonc "MEDIA_BASE_URL" var (workers.dev install writes no pattern)
# 4) prompt
URL="${1:-}"
if [ -z "$URL" ] && [ -f cloudflare/wrangler.jsonc ]; then
  URL=$(python3 - cloudflare/wrangler.jsonc <<'PY' 2>/dev/null || true
import re,sys
s=open(sys.argv[1]).read()
m=re.search(r'"pattern":\s*"([^"]+)"', s)
if m:
    print("https://"+m.group(1))
else:
    m=re.search(r'"MEDIA_BASE_URL":\s*"([^"]+)"', s)
    print(m.group(1) if m else "")
PY
)
fi
[ -z "$URL" ] && { read -r -p "Backend URL: " URL; }
URL="${URL%/}"
case "$URL" in http*://*) ;; *) URL="https://$URL";; esac

printf '\n  %sFRESH & SAVE%s  checking %s\n' "$B" "$X" "$URL"
printf '  %s----------------------------------------%s\n\n' "$D" "$X"

# ── prerequisites ────────────────────────────────────────────────────────────
command -v curl    >/dev/null 2>&1 || { printf '  %s[-]%s missing prerequisite: curl\n'    "$R" "$X" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { printf '  %s[-]%s missing prerequisite: python3\n' "$R" "$X" >&2; exit 1; }

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
pass=0; FAILED=""; MSG=""

# GET <path> -> echoes HTTP code, body in $TMP
GET(){  curl -sS -m15 -o "$TMP" -w '%{http_code}' "$URL$1" 2>/dev/null || echo 000; }
POST(){ curl -sS -m15 -o "$TMP" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$2" "$URL$1" 2>/dev/null || echo 000; }
jget(){ python3 -c "import sys,json;print(json.load(open('$TMP')).get('$1',''))" 2>/dev/null; }

# run "<label>" <fn> — TTY: prints [*], overwrites with [+]/[-]. non-TTY: one line.
run(){
  local label="$1" fn="$2"
  if [ -t 1 ]; then printf '  %s[*]%s %s' "$C" "$X" "$label"; fi
  if "$fn"; then
    if [ -t 1 ]; then printf '\r  %s[+]%s %s%*s\n' "$G" "$X" "$label" 20 ''
    else printf '  %s[+]%s %s\n' "$G" "$X" "$label"; fi
    pass=$((pass+1))
  else
    if [ -t 1 ]; then printf '\r  %s[-]%s %s  %s%s%s%*s\n' "$R" "$X" "$label" "$D" "$MSG" "$X" 6 ''
    else printf '  %s[-]%s %s  %s%s%s\n' "$R" "$X" "$label" "$D" "$MSG" "$X"; fi
    FAILED="$FAILED$label|"
  fi
}
info(){ printf '  %s[!]%s %s\n' "$Y" "$X" "$1"; }

# ── checks ───────────────────────────────────────────────────────────────────
t_tls(){     local c; c=$(GET /health); [ "$c" = 200 ] || { MSG="HTTP $c (unreachable / bad TLS / JWT_SECRET unset — the Worker refuses to boot without it)"; return 1; }; }
t_health(){  [ "$(jget status)" = ok ] || { MSG="status != ok"; return 1; }; }
t_seed(){    local n; n=$(jget seeded); [ "${n:-0}" -gt 0 ] 2>/dev/null || { MSG="0 rows seeded (migrations not applied?)"; return 1; }; }
t_graphql(){ local c; c=$(POST /graphql '{"query":"{__typename}"}'); { [ "$c" = 200 ] && grep -q '__typename' "$TMP"; } || { MSG="GraphQL not responding (HTTP $c)"; return 1; }; }
t_r2(){      local c; c=$(GET "/media/_selfcheck_missing_$$"); [ "$c" = 404 ] || { MSG="R2 not reachable (HTTP $c, expected 404)"; return 1; }; }

run "TLS + reachable       " t_tls
run "backend healthy       " t_health
run "database seeded (D1)   " t_seed
run "GraphQL responding     " t_graphql
run "photo storage (R2)     " t_r2

# ── informational (never a failure) ──────────────────────────────────────────
# push (FCM)
if command -v bunx >/dev/null 2>&1; then
  fcm_id=""
  if [ -f cloudflare/wrangler.jsonc ]; then
    fcm_id=$(python3 -c "import re;s=open('cloudflare/wrangler.jsonc').read();m=re.search(r'\"FCM_PROJECT_ID\":\s*\"([^\"]*)\"',s);print(m.group(1) if m else '')" 2>/dev/null)
  fi
  if bunx wrangler secret list 2>/dev/null | grep -q 'FCM_SERVICE_ACCOUNT' && [ -n "$fcm_id" ]; then
    info "push (FCM): enabled"
  else
    info "push (FCM): disabled (optional)"
  fi
else
  info "push (FCM): unknown (run from the repo with wrangler to check)"
fi

# app download
case "$(GET /app/download)" in
  200) info "app download: ready";;
  *)   info "app download: no APK published yet";;
esac

# ── summary ──────────────────────────────────────────────────────────────────
echo
if [ -z "$FAILED" ]; then
  printf '  %sall %d checks passed — your backend is configured correctly.%s\n\n' "$G" "$pass" "$X"
else
  printf '  %sfailed checks:%s\n' "$R" "$X"
  printf '%s' "$FAILED" | tr '|' '\n' | while IFS= read -r l; do
    [ -n "$l" ] && printf '    %s[-]%s %s\n' "$R" "$X" "$(printf '%s' "$l" | sed 's/ *$//')"
  done
  echo
  exit 1
fi
