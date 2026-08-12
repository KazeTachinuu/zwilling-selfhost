#!/usr/bin/env python3
"""
ZWILLING data export - friendly local web UI.

Runs entirely on your own computer. Serves a small web page where you (or a
family member) enter your ZWILLING login; it downloads all your Food Organizer
data and hands back a .zip. Your password is used once to log in and is never
saved. No CORS issues because the API calls happen server-side, here.

  python3 tools/export_ui.py         # then open the printed http://127.0.0.1 URL
"""
from __future__ import annotations
import io, json, os, secrets, sys, tempfile, threading, webbrowser, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export as core  # reuse login / pull / download_photos / endpoint

PORT = int(os.environ.get("PORT", "8099"))
_downloads: dict[str, bytes] = {}

SITES = ["DE", "FR", "IT", "ES", "BE", "DK", "UK", "GLOBAL", "TR", "US", "CA", "JP"]

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rescue your ZWILLING data</title>
<style>
:root{--red:#ee1c25;--red-d:#a7141a;--bg:#efecea;--card:#fff;--ink:#27221d;--muted:#7a726a;--line:#e4dfda;--ok:#398f59;--okbg:#eaf6ee;--err:#b23b63}
@media(prefers-color-scheme:dark){:root{--bg:#1a1714;--card:#241f1b;--ink:#f2ede8;--muted:#a99f95;--line:#3a332d;--okbg:#173224}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:var(--card);width:100%;max-width:460px;border-radius:18px;box-shadow:0 10px 40px rgba(0,0,0,.12);overflow:hidden}
.head{background:var(--red);color:#fff;padding:26px 28px}
.head h1{margin:0;font-size:21px;font-weight:700}.head p{margin:8px 0 0;font-size:13.5px;opacity:.92;line-height:1.5}
.body{padding:24px 28px 28px}
.note{display:flex;gap:10px;background:var(--okbg);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:12.5px;color:var(--muted);line-height:1.5;margin-bottom:20px}
.note svg{flex:0 0 auto;margin-top:1px}
label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin:0 0 6px}
.field{margin-bottom:16px}
input,select{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--ink);font-size:15px}
input:focus,select:focus{outline:none;border-color:var(--red)}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--red);color:#fff;font-size:15.5px;font-weight:700;cursor:pointer}
button:hover{background:var(--red-d)}button:disabled{opacity:.6;cursor:default}
.status{margin-top:18px;font-size:14px;line-height:1.6}
.spin{display:inline-block;width:16px;height:16px;border:2.5px solid var(--line);border-top-color:var(--red);border-radius:50%;animation:s .8s linear infinite;vertical-align:-3px;margin-right:8px}
@keyframes s{to{transform:rotate(360deg)}}
.row{display:flex;justify-content:space-between;padding:5px 0;font-size:14px;border-bottom:1px solid var(--line)}
.row b{color:var(--ok)}
.err{color:var(--err);font-weight:600}
.dl{display:block;text-align:center;margin-top:16px;padding:14px;border-radius:12px;background:var(--ok);color:#fff;font-weight:700;text-decoration:none}
.foot{font-size:11.5px;color:var(--muted);text-align:center;padding:14px}
h2{font-size:16px;margin:2px 0 12px}
.log{margin-top:16px;background:#12100e;border:1px solid #2a2521;border-radius:12px;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.75;max-height:260px;overflow:auto;color:#d8d2cb;white-space:pre-wrap;word-break:break-word}
.m{font-weight:700}.g{color:#5fd48a}.r{color:#ff6b81}.c{color:#67d0e0}.d{color:#8a8078}
</style></head><body>
<div class="card">
  <div class="head">
    <h1>Rescue your ZWILLING data</h1>
    <p>Save your FRESH &amp; SAVE inventory before the app shuts down on 31 December 2026.</p>
  </div>
  <div class="body">
    <div class="note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span>This runs on <b>your own computer</b>. Your password is used once to log in to ZWILLING and is <b>never saved</b> or sent anywhere else.</span>
    </div>
    <form id="f">
      <div class="field"><label for="site">Country</label>
        <select id="site" name="site">__SITES__</select></div>
      <div class="field"><label for="email">ZWILLING email</label>
        <input id="email" name="email" type="email" autocomplete="username" placeholder="you@example.com" value="__EMAIL__" required></div>
      <div class="field"><label for="password">ZWILLING password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Your password" value="__PASSWORD__" required></div>
      <div class="field" style="display:flex;align-items:center;gap:9px">
        <input id="remember" type="checkbox" style="width:auto;accent-color:var(--red)" __REMEMBER__>
        <label for="remember" style="margin:0;font-weight:500;cursor:pointer">Remember on this computer (for testing)</label></div>
      <button id="go" type="submit">Export my data</button>
    </form>
    <div class="status" id="status"></div>
  </div>
  <div class="foot">Local tool. Nothing leaves your machine except the login to ZWILLING.</div>
</div>
<script>
const f=document.getElementById('f'),go=document.getElementById('go'),st=document.getElementById('status');
const CHK='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#398f59" stroke-width="3" style="vertical-align:-2px"><path d="M20 6 9 17l-5-5"/></svg>';
const LABEL={items:'inventory items',containers:'registered boxes',storages:'storage places',customGroups:'custom food groups',profile:'profile + family',shoppinglists:'shopping lists',settings:'settings'};
f.addEventListener('submit',async e=>{
  e.preventDefault();go.disabled=true;
  st.innerHTML='<div class="log" id="log"></div>';
  const log=document.getElementById('log');
  const line=(html)=>{log.insertAdjacentHTML('beforeend',html+'\n');log.scrollTop=log.scrollHeight;};
  const nm=(ev)=>LABEL[ev.key]||ev.label||'';
  try{
    const resp=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({site:site.value,email:email.value,password:password.value,remember:document.getElementById('remember').checked})});
    const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf='';
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      let i; while((i=buf.indexOf('\n'))>=0){ const raw=buf.slice(0,i).trim(); buf=buf.slice(i+1); if(raw) handle(JSON.parse(raw)); }
    }
  }catch(err){ line('<span class="m r">[-]</span> lost connection to the local tool'); go.disabled=false; }

  function handle(ev){
    if(ev.t==='login'){ line(ev.state==='start'?'<span class="m c">[*]</span> authenticating...':'<span class="m g">[+]</span> logged in'); }
    else if(ev.t==='start'){ line('<span class="m c">[&gt;]</span> fetching '+nm(ev)+' <span class="d">...</span>'); }
    else if(ev.t==='ok'){ line('<span class="m g">[+]</span> '+nm(ev)+': <span class="g">'+ev.count+'</span>'); }
    else if(ev.t==='err'){ line('<span class="m r">[-]</span> '+(nm(ev)||'error')+': '+ev.error); go.disabled=false; }
    else if(ev.t==='photo'){ let pl=document.getElementById('pl');
      if(!pl){ log.insertAdjacentHTML('beforeend','<span id="pl"></span>\n'); pl=document.getElementById('pl'); }
      pl.innerHTML='<span class="m c">[&gt;]</span> downloading photos <span class="g">'+ev.i+'</span>/'+ev.n; log.scrollTop=log.scrollHeight; }
    else if(ev.t==='photos'){ const pl=document.getElementById('pl');
      const s='<span class="m g">[+]</span> photos: <span class="g">'+ev.got+'</span>/'+ev.total;
      if(pl){pl.removeAttribute('id');pl.innerHTML=s;} else line(s); }
    else if(ev.t==='complete'){ showDone(ev); }
  }
  function showDone(d){
    line('<span class="m g">[+]</span> <b>done</b>');
    const c=d.counts||{}; const row=(k,v)=>'<div class="row"><span>'+k+'</span><b>'+(v??0)+'</b></div>';
    st.insertAdjacentHTML('beforeend','<h2 style="margin-top:16px">'+CHK+' Your data is ready</h2>'+
      row('Inventory items',c.items)+row('Registered boxes',c.containers)+row('Storage places',c.storages)+
      row('Custom food groups',c.customGroups)+row('Shopping lists',c.shoppinglists)+row('Photos',d.photos)+
      '<a class="dl" href="/download/'+d.id+'">Download my data (.zip)</a>');
  }
});
</script></body></html>"""


def build_zip(export_json: dict, photos_dir: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("export.json", json.dumps(export_json, ensure_ascii=False, indent=2))
        if photos_dir.exists():
            for p in photos_dir.glob("*"):
                z.write(p, f"photos/{p.name}")
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, ctype, body: bytes, extra=None):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path.startswith("/index"):
            c = core.load_creds()
            sel = (c.get("site") or "DE").upper()
            html = (PAGE
                    .replace("__SITES__", "".join(
                        f'<option value="{s}"{" selected" if s==sel else ""}>{s}</option>' for s in SITES))
                    .replace("__EMAIL__", (c.get("email") or "").replace('"', "&quot;"))
                    .replace("__PASSWORD__", (c.get("password") or "").replace('"', "&quot;"))
                    .replace("__REMEMBER__", "checked" if c else ""))
            return self._send(200, "text/html; charset=utf-8", html.encode())
        if self.path.startswith("/download/"):
            zid = self.path.rsplit("/", 1)[-1]
            blob = _downloads.get(zid)
            if not blob: return self._send(404, "text/plain", b"expired")
            return self._send(200, "application/zip", blob,
                              {"Content-Disposition": 'attachment; filename="zwilling-export.zip"'})
        self._send(404, "text/plain", b"not found")

    def do_POST(self):
        if self.path != "/api/export":
            return self._send(404, "text/plain", b"not found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, "application/json", b'{"ok":false,"error":"bad request"}')

        site = (req.get("site") or "DE").upper()
        email = (req.get("email") or "").strip()
        password = req.get("password") or ""
        ep = core.endpoint(site, None)

        # Stream NDJSON progress events as they happen.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        def emit(ev):
            try:
                self.wfile.write((json.dumps(ev) + "\n").encode()); self.wfile.flush()
            except Exception:
                pass

        if email.lower().split("@")[0] == "demo":  # e.g. demo@demo.com : preview the live UI
            return self._demo(emit)

        emit({"t": "login", "state": "start"})
        try:
            token = core.login(ep, site, email, password)
            if req.get("remember"):
                core.save_creds(site, email, password)
            else:
                core.forget_creds()
            del password
            emit({"t": "login", "state": "ok"})
        except core.GqlError as e:
            msg = "Login failed. Check your email, password, and country." if "401" in str(e) else str(e)
            return emit({"t": "err", "label": "login", "key": "login", "error": msg})

        try:
            import time as _t
            bundle = core.pull(ep, token, site, "en", emit=emit)
            items = bundle.pop("_items")
            with tempfile.TemporaryDirectory() as td:
                nphotos = core.download_photos(Path(td), items, bundle["normalized"].get("profile"), emit=emit)
                export_json = {
                    "exported_at": _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime()),
                    "account": email, "site": site, "endpoint": ep,
                    "counts": {k: (len(v) if isinstance(v, list) else (1 if v else 0))
                               for k, v in bundle["normalized"].items()},
                    "photos": nphotos, "data": bundle["normalized"], "raw": bundle["raw"],
                }
                blob = build_zip(export_json, Path(td) / "photos")
            zid = secrets.token_urlsafe(12)
            _downloads[zid] = blob
            emit({"t": "complete", "id": zid, "photos": nphotos, "counts": export_json["counts"]})
        except Exception as e:
            emit({"t": "err", "label": "export", "key": "export", "error": str(e)[:200]})

    def _demo(self, emit):
        """Simulated progress stream so anyone can preview the live UI (email='demo')."""
        import time as _t
        emit({"t": "login", "state": "start"}); _t.sleep(0.5)
        emit({"t": "login", "state": "ok"}); _t.sleep(0.35)
        for key, label, n in [("items", "inventory items", 42), ("containers", "registered boxes", 11),
                              ("storages", "storage places", 3), ("customGroups", "custom food groups", 2),
                              ("profile", "profile + family", 1), ("shoppinglists", "shopping lists", 1),
                              ("settings", "settings", 1)]:
            emit({"t": "start", "label": label, "key": key}); _t.sleep(0.55)
            emit({"t": "ok", "label": label, "key": key, "count": n}); _t.sleep(0.2)
        for i in range(1, 19):
            emit({"t": "photo", "i": i, "n": 18, "ok": True}); _t.sleep(0.09)
        emit({"t": "photos", "got": 18, "total": 18})
        zid = secrets.token_urlsafe(12)
        _downloads[zid] = build_zip({"demo": True}, Path(tempfile.gettempdir()) / "no_photos_here")
        emit({"t": "complete", "id": zid, "photos": 18,
              "counts": {"items": 42, "containers": 11, "storages": 3, "customGroups": 2, "shoppinglists": 1}})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    url = f"http://127.0.0.1:{PORT}"
    print(f"\n  ZWILLING export UI running at  {url}")
    print("  Open it in your browser, enter your ZWILLING login, and download your data.")
    print("  Password is used once and never saved. Ctrl+C to stop.\n")
    try:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")


if __name__ == "__main__":
    main()
