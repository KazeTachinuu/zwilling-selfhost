# ZWILLING app -> self-hosted backend redirect tooling

Tools to point the real **ZWILLING** Android app (`com.zwilling.rapier`) at a
backend you host yourself, by byte-patching the hardcoded GraphQL endpoint
URL inside the base APK and re-signing the split set.

## PERSONAL USE ONLY

This is for **your own device and your own copy of the app**. Modifying the
app, bypassing its backend, or redistributing the patched APK may violate the
app's Terms of Service and Zwilling's rights. Do **not** distribute the
patched APK, and do **not** point it at, or test it against, Zwilling's
production infrastructure. You run everything here at your own risk.

---

## What the app looks like (feasibility summary)

These facts were established by static analysis of the shipped XAPK and drive
every step below:

- **No TLS certificate pinning.** `okhttp3/CertificatePinner` exists only as
  unused OkHttp library metadata; no real `sha256/...` pins, no TrustKit, no
  `<pin-set>`. The app trusts any certificate that chains to a CA it trusts.
  **Nothing to strip.**
- **No `network_security_config.xml`** in the base APK and no
  `android:networkSecurityConfig` in the manifest. On this app's target
  (minSdk 26 / targetSdk 36) the **platform default** applies: cleartext HTTP
  is off, and **user-installed CA certificates are NOT trusted** (only the
  system CA store). So a self-signed / private-CA server cert will fail TLS
  unless you either serve a publicly-trusted cert or add an NSC that trusts
  user certs (see step 5).
- **Endpoint is a hardcoded string table.** Six literal URLs live in
  `classes6.dex`:
  - prod: `https://na.quillons.zwgaws.io/graphql`,
    `https://eu.quillons.zwgaws.io/graphql`,
    `https://ap.quillons.zwgaws.io/graphql` (37 bytes each)
  - stage: the same three with `-stage` (43 bytes each)

  There is **no user-facing custom-URL field**, so redirection means patching
  the string. A `DataCenter` enum picks which prod URL is used, so the safe
  move is to **patch all three prod URLs to the same host**.
- **Auth is not cryptographically verified on device.** Login is a GraphQL
  `authLogin` mutation returning `accessToken` (a JWT the app stores and
  forwards verbatim, never validating the signature), a `refreshToken`, and a
  user object. `AuthInterceptor` attaches `Authorization: Bearer <token>` to
  every request; `checkToken` must keep returning "valid". Any well-formed
  JWT-looking string works for a stub backend. (Building the stub GraphQL
  server is out of scope for these tools.)
- **XAPK / split install.** Base `com.zwilling.rapier.apk` +
  `config.armeabi_v7a.apk` + `config.xhdpi.apk`, signed v2/v3 only. Only the
  **base** APK needs editing, but **all splits must be re-signed with one new
  key** and installed together.

---

## Files

There are two build paths:

- **Build A (in-place repoint)** - `patch_endpoint.py` only. Byte-patches the
  hardcoded endpoint URL in the base DEX same-byte-length, re-signs the
  original split set. Fast, minimal, no full rebuild. This is what most of the
  steps below describe.
- **Build B (full universal rebuild)** - `apk-build/build.sh` + `apk-build/patch.py`.
  Full apktool decompile/rebuild that applies four smali patches and merges the
  config splits into a single universal APK. See "Build B" below.

| File | Purpose |
|------|---------|
| `patch_endpoint.py` | Build A. Finds and replaces the endpoint URL strings in the DEX, in place and same-byte-length, and recomputes DEX integrity fields. Pure Python 3 stdlib, no Java. |
| `apk-build/build.sh` | Build B. Full pipeline: fresh apktool decompile, apply `patch.py`, rebuild, inject arm64 CameraX libs, merge the config splits into one universal APK, sign (uber-apk-signer), optional on-device smoke test. |
| `apk-build/patch.py` | Build B. The four smali patches applied to the decompile (firebase / tabs / sticker / network). |
| `README.md` | This guide. |

---

## Step 0 - Prerequisites

- **Python 3.10+** to run `patch_endpoint.py` (no Java, no third-party libs).
- The **XAPK unpacked** into its component APKs. If you only have a `.xapk`
  or `.apks`, it is just a ZIP: `unzip yourapp.xapk -d xapk/`. You need the
  base `com.zwilling.rapier.apk` plus every `config.*.apk` split.
- For re-signing and installing (later steps) you need the Android build
  tools, which **do require a Java runtime** (`apksigner` is a Java program):
  - **Arch Linux (this machine):**
    ```
    sudo pacman -S jdk-openjdk android-tools
    # android-tools gives you adb; for apksigner + zipalign install the SDK
    # build-tools, e.g. via the AUR:
    #   yay -S android-sdk-build-tools android-sdk-cmdline-tools-latest
    # then apksigner/zipalign live under
    #   $ANDROID_HOME/build-tools/<version>/
    ```
  - Or grab the SDK "command-line tools" from
    <https://developer.android.com/studio#command-tools>, then
    `sdkmanager "build-tools;35.0.0" "platform-tools"`.
  - Verify: `java -version`, `apksigner --version`, `zipalign`, `adb version`.

> The **patch script never needs Java**. Java is only for `apksigner` /
> `zipalign` in Step 4 and `adb` in Step 6.

---

## Step 1 - Pick a redirect host (the same-byte-length rule)

The endpoint is stored as a length-prefixed DEX string:
`ULEB128(len) || bytes || 0x00`, and a separate offset table points at it. If
your replacement is a different length, the prefix and every following offset
shift and the app won't load. **The replacement must be exactly as long as
the original: 37 bytes for prod, 43 for stage.**

`https://` (8) + host + `/graphql` (8) = 37, so the **ideal host is exactly
21 bytes** (e.g. `mybackend.zwilhome.io` = 21). Then the prod URL becomes a
clean `https://<host>/graphql`.

If your host isn't 21 bytes, `patch_endpoint.py` pads the URL to the exact
length with an **ignored query string** (`https://<host>/graphql?aaaa`).
Your server still routes on the path `/graphql` and ignores the query, so the
pad is transparent. The only hard limit: the host cannot exceed
`37 - len("https:///graphql") = 21` bytes for prod. **Need a longer host?**
Use the apktool rebuild path in the Appendix instead of the in-place patch.

Ideas for a 21-byte host:
- a subdomain you control: `api.mykitchen.dev` (17) padded, or exactly
  `zwilling.myhome.link` (20) padded by one byte;
- a local name you resolve via DNS/hosts to your server (see Step 7).

---

## Step 2 - Dry-run the patch (writes nothing)

Always look before you leap:

```bash
python3 patch_endpoint.py com.zwilling.rapier.apk --host mybackend.zwilhome.io --dry-run
```

It prints every match, its file offset, and the exact old -> new string.
Confirm it finds the three prod URLs in `classes6.dex`.

You can also run the built-in tests (no APK/Java needed):

```bash
python3 patch_endpoint.py --self-test
```

---

## Step 3 - Apply the patch

Operate directly on the base APK (recommended). This writes a new **unsigned**
APK and leaves the original untouched:

```bash
python3 patch_endpoint.py com.zwilling.rapier.apk \
    --host mybackend.zwilhome.io \
    --include-stage \
    -o com.zwilling.rapier.patched.apk
```

- `--include-stage` also rewrites the 43-byte `-stage` slots (padded query),
  so no traffic can leak to Zwilling regardless of environment. Harmless to
  include.
- The script recomputes each patched DEX's **SHA-1 signature** and
  **Adler-32 checksum** so Android's verifier accepts it, stores the patched
  `classes*.dex` uncompressed (ready for `zipalign`), and copies every other
  entry unchanged.

**Alternative (manual repackage)** if you prefer to edit an extracted DEX:

```bash
# patch just the dex
python3 patch_endpoint.py classes6.dex --host mybackend.zwilhome.io -o classes6.dex
# verify integrity
python3 patch_endpoint.py --verify classes6.dex
# put it back into a COPY of the base apk, stored (not deflated), then align
cp com.zwilling.rapier.apk base.apk
zip -0 -X base.apk classes6.dex          # replace the entry, no compression
zipalign -p -f 4 base.apk com.zwilling.rapier.patched.apk
```

---

## Step 4 - Re-sign every split with one new key (needs Java)

Re-signing destroys the original v2/v3 signature (expected). **All splits in
an install set must share the same signer**, so sign the patched base **and**
every unchanged `config.*.apk` with the same key. We standardize on
**uber-apk-signer** everywhere (Build B and INSTALL.md use it too), so all
paths produce a consistent signature.

Grab uber-apk-signer once:

```bash
curl -sL -o uber-apk-signer.jar \
  https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar
```

Put the patched base and both unchanged splits in one folder and sign them all
in a single pass. Point every split at the **same** keystore so the whole set
matches; omit `--ks ...` to have uber-apk-signer generate a throwaway debug key
instead (fine for personal testing).

Create a dedicated keystore once (recommended over a debug key):

```bash
keytool -genkeypair -v -keystore my-release.jks \
    -alias zwilling -keyalg RSA -keysize 2048 -validity 10000
```

Sign the folder:

```bash
mkdir -p signset
cp com.zwilling.rapier.patched.apk config.armeabi_v7a.apk config.xhdpi.apk signset/
java -jar uber-apk-signer.jar -a signset \
    --ks my-release.jks --ksAlias zwilling \
    --allowResign --overwrite
```

uber-apk-signer aligns (zipalign) and signs (v1/v2/v3) each APK in the folder,
then verifies. No separate `zipalign`/`apksigner verify` step is needed.

> Note: `patch_endpoint.py` only touched the base APK; the `config.*` splits
> are byte-identical to the originals but **still must be re-signed** with the
> new key so the whole set matches.

---

## Step 5 - (Only if your TLS cert is NOT publicly trusted)

If you serve a **publicly-valid cert** (e.g. Let's Encrypt) for your patched
host, **skip this step** - the platform default trusts it and there is no NSC
to add.

If you must use a **self-signed / private-CA** cert, the app has to be told to
trust user-installed CAs. This needs a Network Security Config, which means
editing the (binary) `AndroidManifest.xml` and adding an XML resource, so it
is best done with **apktool** rather than the in-place patch:

```bash
apktool d com.zwilling.rapier.patched.apk -o base_src
# create base_src/res/xml/network_security_config.xml:
cat > base_src/res/xml/network_security_config.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="user"/>
      <certificates src="system"/>
    </trust-anchors>
  </base-config>
</network-security-config>
XML
# in base_src/AndroidManifest.xml add to <application ...>:
#   android:networkSecurityConfig="@xml/network_security_config"
apktool b base_src -o com.zwilling.rapier.patched.apk
# then re-align + re-sign (Step 4) again.
```

Then install your CA cert on the device (Settings -> Security -> Encryption &
credentials -> Install a certificate -> CA certificate). **A publicly-valid
cert avoids all of this**, so prefer it.

---

## Step 6 - Install (uninstall the store version first)

The store build is signed by Zwilling; your re-signed build has a different
signer, so you must remove the original first. Splits install atomically:

```bash
adb uninstall com.zwilling.rapier

adb install-multiple \
    com.zwilling.rapier.patched.apk \
    config.armeabi_v7a.apk \
    config.xhdpi.apk
```

If you see `INSTALL_FAILED_...`: make sure **every** split from the original
set is included, all signed with the **same** key, and the old app is fully
uninstalled. `adb install-multiple` (not `adb install`) is required for a
split set.

---

## Step 7 - Point the host at your backend and serve valid TLS

The patched app now resolves your chosen host (e.g. `mybackend.zwilhome.io`)
and expects **HTTPS on port 443** answering GraphQL at `/graphql`.

Make the host resolve to your server, using whichever fits:

- **Real DNS** (cleanest, and required for a public Let's Encrypt cert):
  create an `A`/`AAAA` record for your host pointing at your server, then
  issue a cert with certbot/caddy. Caddy will even auto-provision TLS:
  ```
  mybackend.zwilhome.io {
      reverse_proxy localhost:8080   # your stub GraphQL server
  }
  ```
- **Local override** (private testing): a DNS server on your LAN (Pi-hole /
  dnsmasq) or the device's hosts file (rooted) mapping the host to your
  server's LAN IP. With a local override you can't get a public cert for that
  name, so you'll need the private-CA + NSC route in Step 5.

Your backend must speak the app's GraphQL schema well enough that:
1. `authLogin` returns a syntactically valid JWT `accessToken`, a non-empty
   `refreshToken`, and a `user` with `isGuest=false` and a valid `id`/`email`;
2. `checkToken` reports the session valid (so it isn't downgraded to guest);
3. subsequent queries accept `Authorization: Bearer <token>` and return data.

Because the token is never cryptographically checked on device, any
well-formed JWT-looking string is accepted. Reproducing enough of the wider
schema is the largest remaining effort and is **not** part of these tools.

---

## Reverting

To go back to the real app: `adb uninstall com.zwilling.rapier` and reinstall
the original store XAPK. The patch script never modifies your original APKs,
so keep them around as your clean restore point.

---

## Build B - full universal rebuild (`apk-build/`)

Build A repoints the endpoint in place and keeps the three-split set. Build B is
the heavier path: it fully decompiles the base with apktool, applies four smali
patches, rebuilds, injects the arm64 CameraX libs, and **merges the config
splits into a single `zwilling-universal.apk`** you can install with a plain
`adb install`. Use it when you want one self-contained APK and the extra
functional patches (not just an endpoint repoint).

**Inputs:**
- A **domain-patched base APK** - run Build A first (or the Appendix rebuild) to
  point the endpoint at your host, and feed that APK in as the base.
- Your **`google-services.json`** (Firebase console, for your own FCM project) -
  patch 1 swaps ZWILLING's FCM config for yours.
- The **source XAPK/APKS** that carries the `config.*` splits
  (`config.armeabi_v7a.apk`, `config.xhdpi.apk`) - these are merged into the
  universal APK. Set the `XAPK` env var to it (the script errors out if unset).

**The four smali patches (`patch.py`):**
1. **Firebase repoint** - swap ZWILLING's FCM config for yours.
2. **Dead tabs** - hide the recipes / discover / shop tabs.
3. **Goodbye sticker** - force `ShowGoodbyeInteractor.isGoodbyeDate = false`.
4. **Network check** - force `Network.isConnected() = true` (fixes photo
   uploads on modern Android, where the legacy connectivity API returns false).

**Run it:**

```bash
XAPK=/path/to/ZWILLING.xapk \
  ./apk-build/build.sh [BASE_APK] [google-services.json] [OUT_APK]
```

Defaults: base `../patched-apk/com.zwilling.rapier.apk`, config
`~/Downloads/google-services.json`, output
`../patched-apk/zwilling-universal.apk`. Signing uses uber-apk-signer (Step 4).
With a phone on `adb`, the script finishes with an on-device smoke test.

**Output:** a single `zwilling-universal.apk` (base + both config splits merged,
both ABIs present), installable with `adb install zwilling-universal.apk`.

---

## Appendix - When you need a host longer than 21 bytes (full rebuild)

The in-place patch is constrained to same-byte-length. If you truly need a
longer host/path, rebuild the DEX with apktool so string lengths and offsets
are regenerated:

```bash
apktool d com.zwilling.rapier.apk -o base_src
# edit the smali/URL constants, e.g. grep for the host:
grep -rn "quillons.zwgaws.io" base_src/smali*/
# replace the string literals with your (any-length) URL,
apktool b base_src -o com.zwilling.rapier.patched.apk
# then align + sign (Step 4) and install (Step 6).
```

This is heavier (full disassemble/reassemble, slower, more failure modes) but
removes the length constraint entirely. Prefer the in-place patch whenever a
21-byte host works.

---

## Command reference

```
python3 patch_endpoint.py --self-test                 # run built-in tests
python3 patch_endpoint.py --verify FILE.dex           # check DEX integrity
python3 patch_endpoint.py INPUT --host H --dry-run     # preview, write nothing
python3 patch_endpoint.py INPUT --host H -o OUT        # apply
python3 patch_endpoint.py INPUT --url 'https://...'    # exact 37-byte URL
    --include-stage   also patch the 43-byte *-stage slots (needs --host)
INPUT may be a .apk, a single .dex, or a directory of classes*.dex.
```
