# Patched ZWILLING app (personal use)

The real ZWILLING app, redirected to your own backend. Every backend endpoint
(`https://{eu,na,ap}[-stage].quillons.zwgaws.io/graphql`) was rewritten to
`https://your-backend.example.com/graphql`, the config splits were merged in,
and the result was re-signed.

The deliverable is **`zwilling-universal.apk`**: one self-contained APK
(arm64 + v7a) you install by tapping it. No adb, no developer mode.

## Files
- `zwilling-universal.apk` (what you install)
- `com.zwilling.rapier.apk`, `config.armeabi_v7a.apk`, `config.xhdpi.apk` -
  the original split pieces, kept only as build inputs.

## Install (no adb, no developer mode)
1. Uninstall the Play Store version first (different signature): on the phone,
   **Settings -> Apps -> ZWILLING -> Uninstall**.
2. Get `zwilling-universal.apk` onto the phone (easiest: download it from your
   backend's `/app` page) and **tap it**. Allow **"install unknown apps"** when
   prompted, then tap **Install**.

To go back to the real app, uninstall from **Settings -> Apps** the same way and
reinstall the original store build.

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

1. **Repoint** the base with `../patch_endpoint.py` (byte-patches the endpoint
   URL in place, same-byte-length).
2. **Build** the universal APK with `../apk-build/build.sh` (+ `../apk-build/patch.py`):
   full apktool decompile with four smali patches, config splits merged into a
   single `zwilling-universal.apk`, signed with uber-apk-signer.

No cert pinning in the app, so no other changes are needed.
</content>
