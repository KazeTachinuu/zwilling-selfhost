#!/usr/bin/env python3
"""Apply the self-host patches to a fresh APKEditor decompile of the ZWILLING base APK.

Four patches, all idempotent:
  1. Firebase repoint  - swap ZWILLING's FCM config for yours (from google-services.json)
  2. Dead tabs         - hide recipes/discover/shop tabs (smali; menu XML untouched)
  3. Goodbye sticker   - force ShowGoodbyeInteractor.isGoodbyeDate = false (kills every path)
  4. Network check     - force Network.isConnected() = true (fixes uploads on modern Android)

Usage: patch.py <decompiled_dir> <google-services.json>
"""
import sys, os, re, json

dec, gs_path = sys.argv[1], sys.argv[2]
gs = json.load(open(gs_path))
pi = gs["project_info"]; client = gs["client"][0]
new = {
    "sender":  pi["project_number"],
    "api_key": client["api_key"][0]["current_key"],
    "app_id":  client["client_info"]["mobilesdk_app_id"],
    "bucket":  pi.get("storage_bucket", ""),
    "project": pi["project_id"],
}
# ZWILLING's original values baked into the shipped APK (the swap source)
OLD = {
    "sender": "1010996325451",
    "api_key": "AIzaSyBd6ok3i-WdIE7ht76vnz9UKQ6ZIP8c1xk",
    "app_id": "1:1010996325451:android:e5e12d73e694d80e0f71ce",
    "bucket": "zwilling-android.appspot.com",
    "project": "zwilling-android",
}

# Layout-agnostic: works for both apktool (res/, smali/, smali_classesN/) and
# APKEditor (resources/package_1/res/, smali/classesN/) decompile trees.
def find(name):
    for r, _, fs in os.walk(dec):
        if name in fs:
            return os.path.join(r, name)
    return None

def find_res(relpath):
    for cand in (os.path.join(dec, "res", relpath),
                 os.path.join(dec, "resources/package_1/res", relpath)):
        if os.path.exists(cand):
            return cand
    raise FileNotFoundError(relpath)

# 1) FIREBASE ------------------------------------------------------------------
sx = find_res("values/strings.xml")
s = open(sx).read()
swaps = {OLD["app_id"]: new["app_id"], OLD["api_key"]: new["api_key"],
         OLD["bucket"]: new["bucket"], OLD["project"]: new["project"],
         OLD["sender"]: new["sender"]}
for a, b in sorted(swaps.items(), key=lambda kv: -len(kv[0])):
    if b:
        s = s.replace(a, b)
open(sx, "w").write(s)
# fail loudly if the swap didn't take, otherwise we'd silently ship ZWILLING's Firebase
assert new["sender"] in s and OLD["sender"] not in s, "firebase swap failed (strings.xml drift?)"
print(f"  [1/4] firebase -> {new['project']} (sender {new['sender']})")

# 2) DEAD TABS (rewrite showHideShop to hide recipes+discover+shop) -------------
# several UI.smali exist; pick the screen/main one (works across smali*/ dirs)
ui = None
for r, _, fs in os.walk(dec):
    if r.replace("\\", "/").endswith("com/zwilling/rapier/screen/main") and "UI.smali" in fs:
        ui = os.path.join(r, "UI.smali")
assert ui, "screen/main/UI.smali not found"
s = open(ui).read()
hide = '''.method private final showHideShop(Z)Landroid/view/MenuItem;
    .locals 3

    invoke-direct {p0}, Lcom/zwilling/rapier/screen/main/UI;->getViewBinding()Lcom/zwilling/rapier/databinding/FragmentMainBinding;

    move-result-object v0

    iget-object v0, v0, Lcom/zwilling/rapier/databinding/FragmentMainBinding;->bottomMenu:Lcom/google/android/material/bottomnavigation/BottomNavigationView;

    invoke-virtual {v0}, Lcom/google/android/material/bottomnavigation/BottomNavigationView;->getMenu()Landroid/view/Menu;

    move-result-object v0

    const/4 v2, 0x0

    sget v1, Lcom/zwilling/rapier/R$id;->recipes_flow:I

    invoke-interface {v0, v1}, Landroid/view/Menu;->findItem(I)Landroid/view/MenuItem;

    move-result-object v1

    invoke-interface {v1, v2}, Landroid/view/MenuItem;->setVisible(Z)Landroid/view/MenuItem;

    sget v1, Lcom/zwilling/rapier/R$id;->discover_flow:I

    invoke-interface {v0, v1}, Landroid/view/Menu;->findItem(I)Landroid/view/MenuItem;

    move-result-object v1

    invoke-interface {v1, v2}, Landroid/view/MenuItem;->setVisible(Z)Landroid/view/MenuItem;

    sget v1, Lcom/zwilling/rapier/R$id;->shop_flow:I

    invoke-interface {v0, v1}, Landroid/view/Menu;->findItem(I)Landroid/view/MenuItem;

    move-result-object v0

    invoke-interface {v0, v2}, Landroid/view/MenuItem;->setVisible(Z)Landroid/view/MenuItem;

    move-result-object v0

    return-object v0
.end method'''
# NB: 'recipes_flow' also appears in setUpNavigation, so check the METHOD body, not the file.
cur = re.search(r'\.method private final showHideShop\(Z\)Landroid/view/MenuItem;.*?\.end method', s, re.S)
assert cur, "showHideShop method not found in UI.smali"
if "recipes_flow" in cur.group(0):
    print("  [2/4] tabs -> already patched, skipping")
else:
    s = s[:cur.start()] + hide + s[cur.end():]
    open(ui, "w").write(s)
    print("  [2/4] tabs -> Save + Vous only (recipes/discover/shop hidden)")

# 3) GOODBYE STICKER (constructor: isGoodbyeDate field -> false) ----------------
g = find("ShowGoodbyeInteractor.smali")
s = open(g).read()
iput = "    iput-boolean p1, p0, Lcom/zwilling/rapier/domain/common/interactor/ShowGoodbyeInteractor;->isGoodbyeDate:Z"
assert s.count(iput) == 1, "isGoodbyeDate iput not found"
if "const/4 p1, 0x0\n\n" + iput not in s:
    s = s.replace(iput, "    const/4 p1, 0x0\n\n" + iput, 1)
open(g, "w").write(s)
print("  [3/4] goodbye sticker -> permanently disabled")

# 4) NETWORK CHECK (Network.isConnected -> always true) -------------------------
# The app's Network.isConnected() uses ConnectivityManager.getNetworkInfo(TYPE_MOBILE/WIFI),
# a legacy API that returns null/unreliable on Android 10+ (and 17/GrapheneOS). It returns
# FALSE on modern devices, so the upload interceptor throws NoNetworkException and photos
# (and any client gated on it) never send. Force it true, the OkHttp call then surfaces
# any *real* network error itself.
# there are several Network.smali; pick com/zwilling/rapier/data/remote/network/Network.smali
n = None
for r, _, fs in os.walk(dec):
    if r.replace("\\", "/").endswith("com/zwilling/rapier/data/remote/network") and "Network.smali" in fs:
        n = os.path.join(r, "Network.smali")
assert n, "data/remote/network/Network.smali not found"
s = open(n).read()
new_conn = ('.method public final isConnected()Z\n'
            '    .locals 1\n\n'
            '    const/4 v0, 0x1\n\n'
            '    return v0\n'
            '.end method')
cur = re.search(r'\.method public final isConnected\(\)Z.*?\.end method', s, re.S)
assert cur, "isConnected() method not found in Network.smali"
if "isNetworkConnected" in cur.group(0):  # not yet patched
    s = s[:cur.start()] + new_conn + s[cur.end():]
    open(n, "w").write(s)
# fail loudly if the rewrite didn't take, otherwise uploads silently break on modern Android
cur = re.search(r'\.method public final isConnected\(\)Z.*?\.end method', s, re.S)
assert cur and "isNetworkConnected" not in cur.group(0), "network patch failed (Network.smali drift?)"
print("  [4/4] Network.isConnected() -> always true (fixes uploads on modern Android)")
print("patches applied.")
