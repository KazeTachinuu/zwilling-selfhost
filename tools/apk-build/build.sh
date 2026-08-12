#!/usr/bin/env bash
# Reproducible, self-verifying build of the self-hosted ZWILLING universal APK.
#
#   ./build.sh [BASE_APK] [google-services.json] [OUT_APK]
#
# Pipeline (every step idempotent):
#   fresh decompile -> patch (firebase/tabs/sticker/network) -> build (internal dex, no cache)
#   -> inject arm64 CameraX libs -> merge to universal -> sign -> on-device smoke test.
#
# Requires: java (17+), adb (only for the smoke test), curl, python3, unzip.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${1:-$HERE/../patched-apk/com.zwilling.rapier.apk}"        # domain-patched base
GS="${2:-$HOME/Downloads/google-services.json}"                  # your Firebase config
OUT="${3:-$HERE/../patched-apk/zwilling-universal.apk}"
XAPK="${XAPK:-}"                                                # source of config splits (set this)
if [ -z "$XAPK" ]; then
  echo "error: set XAPK to your original ZWILLING XAPK/APKS (the one carrying the config.* splits)." >&2
  echo "       e.g.  XAPK=/path/to/ZWILLING.xapk ./build.sh" >&2
  exit 1
fi
CAMERA_VER=1.4.2
W="${WORK:-/tmp/zwilling-apk-build}"; mkdir -p "$W/tools"
APKE="$W/tools/APKEditor.jar"; SIGNER="$W/tools/uber-apk-signer.jar"

say(){ printf '\033[36m==>\033[0m %s\n' "$*"; }

APKTOOL="$W/tools/apktool.jar"
say "tools"
[ -f "$APKE" ]    || curl -sL -o "$APKE"    https://github.com/REAndroid/APKEditor/releases/download/V1.4.3/APKEditor-1.4.3.jar
[ -f "$SIGNER" ]  || curl -sL -o "$SIGNER"  https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar
[ -f "$APKTOOL" ] || curl -sL -o "$APKTOOL" https://github.com/iBotPeaches/Apktool/releases/download/v2.10.0/apktool_2.10.0.jar

say "arm64 CameraX libs (Google Maven)"
AAR="$W/camera-core-$CAMERA_VER.aar"
[ -f "$AAR" ] || curl -sL -o "$AAR" "https://dl.google.com/dl/android/maven2/androidx/camera/camera-core/$CAMERA_VER/camera-core-$CAMERA_VER.aar"
rm -rf "$W/arm64"; mkdir -p "$W/arm64"
python3 - "$AAR" "$W/arm64" <<'PY'
import zipfile,sys,os
z=zipfile.ZipFile(sys.argv[1]); need={'libimage_processing_util_jni.so','libsurface_util_jni.so'}
for n in z.namelist():
    if 'arm64-v8a' in n and os.path.basename(n) in need:
        open(os.path.join(sys.argv[2],os.path.basename(n)),'wb').write(z.read(n))
PY

say "decompile base with apktool (reliable smali<->dex; preserves Kotlin suspend/metadata)"
rm -rf "$W/dec"; java -jar "$APKTOOL" d "$BASE" -o "$W/dec" -f >/dev/null

say "patch (firebase / tabs / sticker / network)"
python3 "$HERE/patch.py" "$W/dec" "$GS"

say "build base with apktool"
rm -f "$W/base.apk"
java -jar "$APKTOOL" b "$W/dec" -o "$W/base.apk" >/dev/null

say "assemble config splits (inject arm64 libs into the abi split)"
rm -rf "$W/mergein"; mkdir -p "$W/mergein"; cp "$W/base.apk" "$W/mergein/base.apk"
python3 - "$XAPK" "$W/mergein" "$W/arm64" <<'PY'
import zipfile,sys,os,shutil
xapk,mergein,arm64=sys.argv[1:4]
z=zipfile.ZipFile(xapk)
for n in z.namelist():
    if n in ('config.armeabi_v7a.apk','config.xhdpi.apk'):
        open(os.path.join(mergein,os.path.basename(n)),'wb').write(z.read(n))
# add arm64 .so into the abi split so the merge picks up BOTH arches
abi=os.path.join(mergein,'config.armeabi_v7a.apk')
with zipfile.ZipFile(abi,'a',zipfile.ZIP_STORED) as za:
    have=set(za.namelist())
    for so in os.listdir(arm64):
        arc=f'lib/arm64-v8a/{so}'
        if arc not in have: za.write(os.path.join(arm64,so),arc)
PY

say "merge -> universal"
rm -f "$W/universal.apk"
java -jar "$APKE" m -i "$W/mergein" -o "$W/universal.apk" >/dev/null

say "sign (preserve page alignment)"
rm -rf "$W/signed"; java -jar "$SIGNER" -a "$W/universal.apk" --skipZipAlign --allowResign -o "$W/signed" >/dev/null
cp "$W"/signed/*.apk "$OUT"
say "built: $OUT ($(du -h "$OUT" | cut -f1))"

# ---- smoke-test gate (only if a device is attached) -------------------------
if command -v adb >/dev/null && adb get-state 2>/dev/null | grep -q device; then
  say "smoke test on attached device"
  adb shell am force-stop com.zwilling.rapier >/dev/null 2>&1 || true
  adb install -r "$OUT" >/dev/null
  adb logcat -c
  adb shell am start -n com.zwilling.rapier/.activity.MainActivity >/dev/null
  sleep 12
  crash=$(adb logcat -d | grep -c 'FATAL EXCEPTION' || true)
  focus=$(adb shell dumpsys window | grep -o 'com.zwilling.rapier/[^ }]*' | head -1 || true)
  if [ "$crash" = 0 ] && [ -n "$focus" ]; then
    say "SMOKE TEST: PASS (no crash, app in foreground)"
  else
    echo "SMOKE TEST: FAIL (crash=$crash focus=$focus)"; adb logcat -d | grep -A6 'FATAL EXCEPTION' | head; exit 1
  fi
else
  say "no device attached, skipping smoke test (run again with a phone on adb to gate it)"
fi
