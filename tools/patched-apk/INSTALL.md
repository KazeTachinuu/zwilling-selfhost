# Patched ZWILLING app (personal use)

The real ZWILLING app, redirected to your own backend. Every backend endpoint
(`https://{eu,na,ap}[-stage].quillons.zwgaws.io/graphql`) was rewritten to
`https://your-backend.example.com/graphql`. Rebuilt with apktool, re-signed.

This deliverable is the **3-split set** (base + two config splits, installed
together). The full universal rebuild (`build.sh`) instead emits a single
`zwilling-universal.apk`; see the canonical pipeline note below.

## Files (a split install set, install all three together)
- `com.zwilling.rapier.apk` (base, patched)
- `config.armeabi_v7a.apk` (native libs split)
- `config.xhdpi.apk` (resources split)

## Install
Uninstall the Play Store version first (different signature), then:
```
adb install-multiple com.zwilling.rapier.apk config.armeabi_v7a.apk config.xhdpi.apk
```
(Or copy all three to the phone and use a split-APK installer like SAI.)

## It will NOT work until the backend is live
The app now talks only to `https://your-backend.example.com/graphql`. It needs:
- that backend deployed and reachable, and
- a valid public TLS cert for the host (Cloudflare provides this automatically;
  the app will not trust a self-signed cert).

## Signing
Signed here with a throwaway DEBUG key (CN=Android Debug) just to prove the
pipeline. For the family deployment, re-sign with a DEDICATED keystore so only
you can push updates:
```
keytool -genkeypair -v -keystore zwilling.jks -alias zw -keyalg RSA -keysize 2048 -validity 10000
java -jar uber-apk-signer.jar -a <folder> --ks zwilling.jks --allowResign --overwrite
```

## Rebuild from scratch (reproduce)
Do not hand-edit smali here. Use the canonical pipeline in `../README.md`:

- **Build A - endpoint repoint** (`../patch_endpoint.py`): byte-patches the
  endpoint URL in place and re-signs the 3-split set. This is what produced the
  files above.
- **Build B - full universal rebuild** (`../apk-build/build.sh` +
  `../apk-build/patch.py`): full apktool decompile with four smali patches,
  merged into a single `zwilling-universal.apk`.

Both paths sign with uber-apk-signer:
```
java -jar uber-apk-signer.jar -a <folder> --allowResign --overwrite
```
No cert pinning in the app, so no other changes are needed.
