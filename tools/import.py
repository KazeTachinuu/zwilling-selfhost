#!/usr/bin/env python3
"""
Import a ZWILLING export (export.json + photos/) into your self-hosted backend.

Uses the backend's OWN GraphQL mutations, so every field is stored exactly the
way the app would store it, including re-uploading photos through the real
signed-upload path. Idempotent: a small state file maps original ids to imported
ids, so re-running skips what's already in.

  ./import.py export.json --backend http://localhost:8788/graphql \
              --email you@home.local --password 'your passphrase'
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export as core  # gql, colors, ok/err/step/info, GqlError

def http_put(url: str, data: bytes, headers: dict) -> int:
    req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0

# ── mutations ────────────────────────────────────────────────────────────────
M = {
    "login": "mutation($s:CommerceSiteId!,$u:String!,$p:String!){authLogin(siteId:$s,username:$u,password:$p){token}}",
    "container": ("mutation($id:String!,$t:String!,$sz:String!,$st:StorageType!,$info:NfcContainerSaveAdditionalInfo)"
                  "{containerSave(containerId:$id,containerType:$t,size:$sz,storageType:$st,info:$info){success}}"),
    "storage": "mutation($n:String!){freshandsaveAddStorage(name:$n){id}}",
    "group": ("mutation($n:String!,$sec:String,$icon:String,$pos:Int,$st:[FoodGroupCreateStorable])"
              "{foodgroupCreate(name:$n,section:$sec,iconName:$icon,position:$pos,storable:$st){cloudId}}"),
    "item": ("mutation($n:String!,$e:String!,$d:String,$cid:String,$fg:String,$sp:Storage,$sc:ID,"
             "$sealed:Boolean,$fl:FreshAndSaveStorageFillLevel,$ty:StorageType)"
             "{freshandsaveCreate(name:$n,expire:$e,description:$d,containerId:$cid,foodgroupId:$fg,"
             "storageplace:$sp,storageCloudId:$sc,sealed:$sealed,fillLevel:$fl,type:$ty){cloudId}}"),
    "uploadUrl": ("mutation($c:ID!,$u:UploadUrlUsage!,$f:UploadUrlFileTypes!)"
                  "{requestUploadUrl(cloudId:$c,usedFor:$u,fileType:$f){url headers{name value}}}"),
}

FILETYPE = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}


def main():
    ap = argparse.ArgumentParser(description="Import a ZWILLING export into your backend.")
    ap.add_argument("export", help="path to export.json")
    ap.add_argument("--backend", default="http://localhost:8788/graphql")
    ap.add_argument("--email", required=True, help="account in YOUR backend to import into")
    ap.add_argument("--password", default=os.environ.get("BACKEND_PASSWORD", ""))
    ap.add_argument("--site", default="DE")
    ap.add_argument("--photos", help="photos dir (default: <export dir>/photos)")
    ap.add_argument("--state", help="idempotency state file (default: <export>.import-state.json)")
    args = ap.parse_args()

    print(core.CYN("  ZWILLING import  ->  your backend\n"))
    ep = args.backend
    exp = json.loads(Path(args.export).read_text())
    data = exp.get("data") or exp
    photos_dir = Path(args.photos) if args.photos else Path(args.export).resolve().parent / "photos"
    state_file = Path(args.state) if args.state else Path(str(args.export) + ".import-state.json")
    state = json.loads(state_file.read_text()) if state_file.exists() else {"items": {}, "storages": {}, "groups": {}}
    def save_state(): state_file.write_text(json.dumps(state, indent=1))

    # login to OUR backend
    core.step(f"authenticating to backend {core.DIM(ep)}")
    try:
        d = core.gql(ep, M["login"], {"s": args.site, "u": args.email, "p": args.password})
        token = ((d.get("authLogin") or {}).get("token"))
        if not token: raise core.GqlError("no token")
        core.ok("logged in")
    except core.GqlError as e:
        core.err(f"login failed: {e}  (create the account first: npm run admin:create-user)"); sys.exit(1)

    def mut(query, variables):
        return core.gql(ep, query, variables, token)

    # containers (idempotent on the backend via container_id)
    conts = data.get("containers") or []
    core.step(f"containers ({len(conts)})")
    for c in conts:
        try:
            mut(M["container"], {"id": c["containerId"], "t": c.get("type") or "FRESHANDSAVE",
                                 "sz": c.get("size") or "M", "st": c.get("storageType") or "FRESHANDSAVE",
                                 "info": {"amountOfGrams": c.get("amountOfGrams"), "variant": c.get("variant"),
                                          "year": c.get("year"), "code": c.get("code")}})
            core.ok(f"container {c['containerId']}")
        except core.GqlError as e:
            core.err(f"container {c.get('containerId')}: {e}")

    # storages (remap original id -> new id)
    stors = data.get("storages") or []
    core.step(f"storages ({len(stors)})")
    for s in stors:
        if s["id"] in state["storages"]:
            continue
        try:
            r = mut(M["storage"], {"n": s.get("name") or "Storage"})
            state["storages"][s["id"]] = r["freshandsaveAddStorage"]["id"]; save_state()
            core.ok(f"storage {s.get('name')}")
        except core.GqlError as e:
            core.err(f"storage {s.get('name')}: {e}")

    # custom food groups (remap)
    groups = data.get("customGroups") or []
    core.step(f"custom food groups ({len(groups)})")
    for g in groups:
        if g["cloudId"] in state["groups"]:
            continue
        try:
            st = [{"location": x["location"], "days": x["days"], "icon": x.get("icon")}
                  for x in (g.get("storable") or [])]
            r = mut(M["group"], {"n": g.get("name") or "Group", "sec": g.get("section"),
                                 "icon": g.get("iconName"), "pos": g.get("position") or 0, "st": st})
            state["groups"][g["cloudId"]] = r["foodgroupCreate"]["cloudId"]; save_state()
            core.ok(f"food group {g.get('name')}")
        except core.GqlError as e:
            core.err(f"food group {g.get('name')}: {e}")

    # items (+ photos)
    items = data.get("items") or []
    core.step(f"inventory items ({len(items)})")
    origin = f"{urlparse(ep).scheme}://{urlparse(ep).netloc}"
    imported = photos_done = 0
    for it in items:
        if it["cloudId"] in state["items"]:
            continue
        vessel = it.get("vessel") or {}
        cid = vessel.get("containerId") if vessel.get("__typename") == "NfcContainer" else None
        fg = it.get("foodgroup") or {}
        fgid = state["groups"].get(fg.get("cloudId"), fg.get("cloudId"))  # remap custom, keep preset
        scid = state["storages"].get(it.get("storageCloudId"))
        if it.get("storageCloudId") and scid is None:
            core.warn(f"item {it.get('name')}: storage {it.get('storageCloudId')} was not imported this run; "
                      "location dropped")
        try:
            r = mut(M["item"], {"n": it.get("name") or "Item", "e": it.get("expire") or "",
                                "d": it.get("description"), "cid": cid, "fg": fgid,
                                "sp": it.get("storageplace"), "sc": scid,
                                "sealed": it.get("sealed"), "fl": it.get("fillLevel"), "ty": it.get("type")})
            new_id = r["freshandsaveCreate"]["cloudId"]
            state["items"][it["cloudId"]] = new_id; save_state()
            imported += 1
            core.ok(f"item {core.DIM(it.get('name',''))}")
        except core.GqlError as e:
            core.err(f"item {it.get('name')}: {e}"); continue

        # photos for this item (files named <origCloudId>_*.ext)
        for pf in sorted(photos_dir.glob(f"{it['cloudId']}_*")) if photos_dir.exists() else []:
            ext = pf.suffix.lstrip(".").lower()
            ft = FILETYPE.get(ext, "JPEG")
            try:
                u = mut(M["uploadUrl"], {"c": new_id, "u": "FRESHANDSAVE", "f": ft})
                up = u["requestUploadUrl"]
                url = up["url"]
                # rewrite to the backend origin (export URLs point at the prod media host)
                url = origin + urlparse(url).path + (("?" + urlparse(url).query) if urlparse(url).query else "")
                hdrs = {h["name"]: h["value"] for h in (up.get("headers") or [])}
                if http_put(url, pf.read_bytes(), hdrs) == 200:
                    photos_done += 1
                    print(f"  {core.GRN('[+]')} photo {core.DIM(pf.name)}")
                else:
                    print(f"  {core.RED('[-]')} photo {pf.name}")
            except core.GqlError as e:
                print(f"  {core.RED('[-]')} photo {pf.name}: {e}")

    save_state()
    print()
    core.ok(f"import complete: {core.GRN(str(imported))} items imported, {core.GRN(str(photos_done))} photos uploaded")
    core.info(f"re-run is safe; state kept in {core.DIM(str(state_file))}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(); core.err("aborted"); sys.exit(130)
