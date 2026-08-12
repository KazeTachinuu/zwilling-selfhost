#!/usr/bin/env python3
"""
ZWILLING Food Organizer - personal data export.

Pull YOUR OWN data out of ZWILLING's backend before it shuts down (2026-12-31),
since the app has no export button. Self-service: you enter your own login.

  ./export.py                      # interactive
  ./export.py -e you@mail.com -s DE
  ZW_PASSWORD=... ./export.py -e you@mail.com -s DE   # non-interactive password

Output: <outdir>/export.json  +  <outdir>/photos/*.  Stdlib only, no deps.
Your password is used once to obtain a session token, then discarded. Only the
short-lived token is cached (~/.zwilling-export, chmod 600), never the password.
"""
from __future__ import annotations
import argparse, getpass, hashlib, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

# ── pretty output ────────────────────────────────────────────────────────────
_TTY = sys.stdout.isatty()
def _c(code: str, s: str) -> str: return f"\033[{code}m{s}\033[0m" if _TTY else s
def GRN(s): return _c("1;32", s)
def RED(s): return _c("1;31", s)
def CYN(s): return _c("1;36", s)
def YEL(s): return _c("1;33", s)
def DIM(s): return _c("2", s)
def BLD(s): return _c("1", s)

def ok(msg):   print(f"{GRN('[+]')} {msg}")
def err(msg):  print(f"{RED('[-]')} {msg}")
def info(msg): print(f"{CYN('[*]')} {msg}")
def warn(msg): print(f"{YEL('[!]')} {msg}")
def step(msg): print(f"{CYN('[>]')} {BLD(msg)}")

BANNER = CYN(r"""
  ______          _ _ _ _
 |___  /         (_) | (_)
    / /_      __ _ _| | |_ _ __   __ _   export
   / /\ \ /\ / /| | | | | | '_ \ / _` |  FRESH & SAVE data rescue
  / /__\ V  V / | | | | | | | | | (_| |
 /_____|\_/\_/  |_|_|_|_|_|_| |_|\__, |  before 2026-12-31
                                  __/ |
                                 |___/
""")

# ── endpoint (country -> data centre) ────────────────────────────────────────
REGION_BY_SITE = {
    "DE": "eu", "FR": "eu", "IT": "eu", "ES": "eu", "BE": "eu", "DK": "eu",
    "UK": "eu", "GLOBAL": "eu", "TR": "eu",
    "US": "na", "CA": "na",
    "JP": "ap",
}
def endpoint(site: str, region: str | None) -> str:
    r = region or REGION_BY_SITE.get(site.upper(), "eu")
    return f"https://{r}.quillons.zwgaws.io/graphql"

# ── graphql client ───────────────────────────────────────────────────────────
class GqlError(Exception): pass

def gql(ep: str, query: str, variables: dict | None = None, token: str | None = None) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": "okhttp/4.12.0"}
    if token: headers["Authorization"] = f"Bearer {token}"
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(ep, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise GqlError(f"HTTP {e.code}: {e.read()[:200].decode('utf-8','ignore')}")
    except Exception as e:
        raise GqlError(str(e))
    if data.get("errors"):
        raise GqlError(data["errors"][0].get("message", "graphql error"))
    return data.get("data") or {}

# ── session cache (token only, never the password) ───────────────────────────
SESSION_DIR = Path(os.path.expanduser("~/.zwilling-export"))
def _session_file(email: str) -> Path:
    return SESSION_DIR / (hashlib.sha256(email.encode()).hexdigest()[:16] + ".json")
def load_session(email: str) -> str | None:
    f = _session_file(email)
    if not f.exists(): return None
    try:
        d = json.loads(f.read_text())
        if d.get("exp", 0) > time.time() + 60: return d.get("token")
    except Exception: pass
    return None
def save_session(email: str, token: str):
    SESSION_DIR.mkdir(mode=0o700, exist_ok=True)
    f = _session_file(email)
    # decode exp from the JWT payload if present, else assume 30 days
    exp = int(time.time()) + 30 * 86400
    try:
        import base64
        pl = token.split(".")[1]
        pad = "=" * (-len(pl) % 4)
        exp = json.loads(base64.urlsafe_b64decode(pl + pad)).get("exp", exp)
    except Exception: pass
    f.write_text(json.dumps({"token": token, "exp": exp}))
    os.chmod(f, 0o600)

Q_LOGIN = ("mutation($s:CommerceSiteId!,$u:String!,$p:String!)"
           "{authLogin(siteId:$s,username:$u,password:$p){token}}")

def login(ep: str, site: str, email: str, password: str) -> str:
    d = gql(ep, Q_LOGIN, {"s": site, "u": email, "p": password})
    tok = ((d.get("authLogin") or {}).get("token"))
    if not tok: raise GqlError("no token returned")
    return tok

# ── social login (Google / Apple / …) ────────────────────────────────────────
# Accounts created with "Continue with Google/Apple" have no password, so authLogin
# can't be used. ZWILLING's own flow is a two-code exchange (traced from the APK):
#   1. getLinkToSocialProvider -> {link, code}           (code == initiationCode)
#   2. open link in a browser, authenticate with the provider
#   3. provider redirects to zwilling://...?code=<exchangeCode>
#   4. exchangeCode(exchangeCode, initiationCode) -> {token}
Q_PROVIDERS = "query($s:CommerceSiteId!){providers:getListOfAvailbleSocialLoginProviders(siteId:$s)}"
Q_SOCIAL_LINK = ("mutation($s:CommerceSiteId!,$p:String!)"
                 "{details:getLinkToSocialProvider(siteId:$s,provider:$p){link provider code}}")
Q_SOCIAL_EXCHANGE = ("mutation($e:String!,$i:String!)"
                     "{authResult:exchangeCode(exchangeCode:$e,initiationCode:$i){token refreshToken}}")

def social_login(ep: str, site: str, provider: str | None) -> str:
    provs = gql(ep, Q_PROVIDERS, {"s": site}).get("providers") or []
    if not provs:
        raise GqlError("this site advertises no social login providers")
    if provider is None:
        provider = provs[0] if len(provs) == 1 else None
        while provider not in provs:
            info(f"available providers: {', '.join(provs)}")
            provider = input(f"{CYN('[?]')} provider: ").strip()
    det = (gql(ep, Q_SOCIAL_LINK, {"s": site, "p": provider}).get("details") or {})
    link, initiation = det.get("link"), det.get("code")
    if not link or not initiation:
        raise GqlError("backend returned no social login link")
    print()
    step(f"open this URL in a browser and sign in with {BLD(provider)}:")
    print(f"\n  {CYN(link)}\n")
    info("after signing in your browser will try to open a 'zwilling://…?code=…' URL")
    info("(it will look like it failed — that's fine). Copy that whole URL or just the code=… value.")
    raw = input(f"{CYN('[?]')} paste the redirect URL or code: ").strip()
    exchange = raw
    if "code=" in raw:
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(raw).query)
        if q.get("error"):
            raise GqlError(f"provider returned error: {q['error'][0]}")
        exchange = (q.get("code") or [raw])[0]
    if not exchange:
        raise GqlError("no code found in what you pasted")
    res = (gql(ep, Q_SOCIAL_EXCHANGE, {"e": exchange, "i": initiation}).get("authResult") or {})
    tok = res.get("token")
    if not tok:
        raise GqlError("code exchange returned no token (it may have expired — try again)")
    return tok

# ── the export surface (what we pull) ────────────────────────────────────────
Q = {
    "items": ("query($l:String){freshandsaveList(locale:$l){hash items{"
              "cloudId name description expire created modified sealed fillLevel state "
              "storageplace storageName storageCloudId type "
              "foodgroup(locale:$l){cloudId name} photo{type url} "
              # Container.size/type are String, NfcContainer.size/type are String! — a union
              # can't select the same response key with conflicting types, so alias the Container branch.
              "vessel{__typename ... on Container{year code variant containerSize: size containerKind: type} "
              "... on NfcContainer{containerId type size storageType amountOfGrams variant year code}}}}}"),
    "containers": ("query{containerList{options{type sizes} containers{"
                   "containerId type size storageType amountOfGrams variant year code}}}"),
    "storages": ("query{freshandsaveListStorage(showActive:true,showInactive:true){id name type owner}}"),
    "customGroups": ("query($l:String!){foodgroupList(bucket:CUSTOM,locale:$l){"
                     "cloudId name section iconName position storable{location days icon}}}"),
    "profile": ("query($s:CommerceSiteId!){profile(siteId:$s){customerId email firstName lastName "
                "preferredLocale houseHoldPeople subscribedNewsletter photo{type url} "
                "groups{name groupId joinHash members{name owner userId photo{type url}}}}}"),
    "shoppinglists": ("query{shoppinglists{entries{cloudId name position state "
                      "categories{name position entries{name value unit position state}}}}}"),
    "settings": ("query($s:CommerceSiteId!){settings(siteId:$s){settings{key value}}}"),
}

def _cli_emit(ev: dict):
    """Default progress sink: render events as the colored CLI markers."""
    t = ev.get("t")
    if t == "login":
        step("authenticating ...") if ev.get("state") == "start" else ok("logged in")
    elif t == "start":
        step(f"fetching {ev['label']} ...")
    elif t == "ok":
        ok(f"{ev['label']}: {GRN(str(ev['count']))}")
    elif t == "err":
        err(f"{ev['label']}: {ev.get('error')}")
    elif t == "photo":
        mark = GRN("[+]") if ev.get("ok") else RED("[-]")
        print(f"  {mark} photo {ev['i']}/{ev['n']}")
    elif t == "photos":
        ok(f"photos saved: {GRN(str(ev['got']))}/{ev['total']}") if ev["total"] else info("no photos to download")


def pull(ep: str, token: str, site: str, locale: str, emit=None) -> dict:
    emit = emit or _cli_emit
    out, raw = {}, {}
    def grab(label, key, query, variables, extract):
        emit({"t": "start", "label": label, "key": key})
        try:
            d = gql(ep, query, variables, token)
            raw[key] = d
            val = extract(d)
            out[key] = val
            n = len(val) if isinstance(val, list) else (1 if val else 0)
            emit({"t": "ok", "label": label, "key": key, "count": n})
            return val
        except GqlError as e:
            emit({"t": "err", "label": label, "key": key, "error": str(e)})
            out[key] = None
            return None

    items = grab("inventory items", "items", Q["items"], {"l": locale},
                 lambda d: ((d.get("freshandsaveList") or {}).get("items")) or [])
    grab("registered boxes", "containers", Q["containers"], {},
         lambda d: ((d.get("containerList") or {}).get("containers")) or [])
    grab("storage places", "storages", Q["storages"], {},
         lambda d: d.get("freshandsaveListStorage") or [])
    grab("custom food groups", "customGroups", Q["customGroups"], {"l": locale},
         lambda d: d.get("foodgroupList") or [])
    grab("profile + family", "profile", Q["profile"], {"s": site},
         lambda d: d.get("profile"))
    grab("shopping lists", "shoppinglists", Q["shoppinglists"], {},
         lambda d: ((d.get("shoppinglists") or {}).get("entries")) or [])
    grab("settings", "settings", Q["settings"], {"s": site},
         lambda d: ((d.get("settings") or {}).get("settings")) or [])
    return {"normalized": out, "raw": raw, "_items": items or []}

# ── photo download ───────────────────────────────────────────────────────────
def download_photos(outdir: Path, items: list, profile: dict | None, emit=None) -> int:
    emit = emit or _cli_emit
    urls: list[tuple[str, str]] = []
    for it in items or []:
        for p in (it.get("photo") or []):
            if p.get("url"): urls.append((it["cloudId"], p["url"]))
    if profile:
        for p in (profile.get("photo") or []):
            if p.get("url"): urls.append(("profile", p["url"]))
    if not urls:
        emit({"t": "photos", "got": 0, "total": 0})
        return 0
    pdir = outdir / "photos"; pdir.mkdir(parents=True, exist_ok=True)
    got = 0
    for i, (name, url) in enumerate(urls, 1):
        ext = url.split("?")[0].rsplit(".", 1)[-1][:4] or "jpg"
        dst = pdir / f"{name}_{i}.{ext}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "okhttp/4.12.0"})
            dst.write_bytes(urllib.request.urlopen(req, timeout=30).read())
            got += 1
            emit({"t": "photo", "i": i, "n": len(urls), "ok": True})
        except Exception:
            emit({"t": "photo", "i": i, "n": len(urls), "ok": False})
    emit({"t": "photos", "got": got, "total": len(urls)})
    return got

# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Export your ZWILLING Food Organizer data.")
    ap.add_argument("-e", "--email")
    ap.add_argument("-s", "--site", default="DE", help="country / CommerceSiteId (DE, US, UK, ...)")
    ap.add_argument("--region", help="override data centre: eu | na | ap")
    ap.add_argument("-l", "--locale", default="en")
    ap.add_argument("-o", "--outdir", default="zwilling-export")
    ap.add_argument("--relogin", action="store_true", help="ignore cached session token")
    ap.add_argument("--social", action="store_true", help="log in with Google/Apple instead of a password (no password on the account)")
    ap.add_argument("--provider", help="social provider to use (skip the prompt), e.g. Google")
    ap.add_argument("--token", help="use this Bearer token directly and skip login (any login method)")
    args = ap.parse_args()

    print(BANNER)

    site = (args.site or "DE").upper()
    ep = endpoint(site, args.region)
    info(f"endpoint {DIM(ep)}")

    env_token = args.token or os.environ.get("ZW_TOKEN")
    email = args.email

    if env_token:                                   # any login method: paste the Bearer token
        token = env_token
        email = email or "token-login"
        ok("using provided Bearer token (login skipped)")
    elif args.social:                               # Google / Apple: no password on the account
        email = email or "social-login"
        try:
            token = social_login(ep, site, args.provider)
            save_session(email, token); ok("logged in via social provider, token cached")
        except GqlError as e:
            err(f"social login failed: {e}"); sys.exit(1)
    else:                                           # email + password
        email = email or input(f"{CYN('[?]')} ZWILLING email: ").strip()
        token = None if args.relogin else load_session(email)
        if token:
            ok("using cached session token")
        else:
            password = (os.environ.get("ZW_PASSWORD")
                        or getpass.getpass(f"{CYN('[?]')} ZWILLING password (hidden): "))
            step("authenticating ...")
            try:
                token = login(ep, site, email, password)
                del password  # discard immediately
                save_session(email, token)
                ok("logged in, session token cached (password discarded)")
            except GqlError as e:
                err(f"login failed: {e}")
                warn("no password? use --social for Google/Apple, or --token. Wrong site -> wrong data centre.")
                sys.exit(1)

    print()
    step("pulling your data")
    bundle = pull(ep, token, site, args.locale)
    items = bundle.pop("_items")

    print()
    step("downloading photos")
    nphotos = download_photos(Path(args.outdir), items, bundle["normalized"].get("profile"))

    outdir = Path(args.outdir); outdir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "account": email, "site": site, "endpoint": ep, "locale": args.locale,
        "counts": {k: (len(v) if isinstance(v, list) else (1 if v else 0))
                   for k, v in bundle["normalized"].items()},
        "photos": nphotos,
        "data": bundle["normalized"],
        "raw": bundle["raw"],
    }
    (outdir / "export.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    print()
    c = manifest["counts"]
    line = "─" * 46
    print(GRN(f"┌{line}┐"))
    print(GRN("│") + BLD("  EXPORT COMPLETE".ljust(46)) + GRN("│"))
    print(GRN(f"├{line}┤"))
    for label, key in [("inventory items", "items"), ("registered boxes", "containers"),
                       ("storage places", "storages"), ("custom food groups", "customGroups")]:
        print(GRN("│") + f"  {label:<24} {GRN(str(c.get(key, 0))):>16}  " + GRN("│"))
    print(GRN("│") + f"  {'photos':<24} {GRN(str(nphotos)):>16}  " + GRN("│"))
    print(GRN(f"└{line}┘"))
    info(f"shopping lists exported for reference (not re-imported): {c.get('shoppinglists', 0)}")
    ok(f"written {BLD(str(outdir / 'export.json'))}  (+ photos/)")
    info("keep this file safe. import into your backend with:  ./import.py " + str(outdir / "export.json"))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(); err("aborted"); sys.exit(130)
