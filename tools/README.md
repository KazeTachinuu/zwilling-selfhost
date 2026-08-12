# ZWILLING app -> self-hosted backend redirect tooling

Tools to point the real **ZWILLING** Android app (`com.zwilling.rapier`) at a
backend you host yourself, by rewriting the hardcoded GraphQL endpoint URL
inside the app and re-signing it. The recommended output is **one universal
APK you install by tapping it on the phone**: no adb, no developer mode.

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
  user certs (see the advanced notes).
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
  **base** APK needs editing; the universal build merges the splits back into a
  single installable APK for you.

---

## The build

There is one recommended path and one repoint helper it depends on:

- **Universal build (recommended)** - `apk-build/build.sh` + `apk-build/patch.py`.
  Full apktool decompile/rebuild that applies four smali patches, injects the
  arm64 CameraX libs, and **merges the config splits into a single
  `zwilling-universal.apk`** (arm64 + v7a). You install it by tapping the file
  on the phone. This is the path a normal user can follow.
- **Endpoint repoint** - `patch_endpoint.py`. Byte-patches the hardcoded
  endpoint URL in the base DEX, same-byte-length, and recomputes DEX integrity
  fields. It is the first step that produces the domain-patched base you feed to
  `build.sh`. Pure Python 3 stdlib, no Java.

| File | Purpose |
|------|---------|
| `patch_endpoint.py` | Repoints the endpoint URL strings in the base DEX, in place and same-byte-length, and recomputes DEX integrity fields. Pure Python 3 stdlib, no Java. |
| `apk-build/build.sh` | The recommended pipeline: fresh apktool decompile, apply `patch.py`, rebuild, inject arm64 CameraX libs, merge the config splits into one universal APK, sign (uber-apk-signer), optional on-device smoke test. |
| `apk-build/patch.py` | The four smali patches applied to the decompile (firebase / tabs / sticker / network). |
| `README.md` | This guide. |

---

## Step 0 - Prerequisites

- **Python 3.10+** to run `patch_endpoint.py` (no Java, no third-party libs).
- **Java 17+** for `build.sh` (apktool, APKEditor, and uber-apk-signer are Java
  programs). `build.sh` downloads those jars itself.
- Your **`google-services.json`** (from your own Firebase project) if you want
  push; `build.sh` bakes it in.
- The **source XAPK/APKS** that carries the `config.*` splits. If you only have
  a `.xapk` or `.apks`, it is just a ZIP: `unzip yourapp.xapk -d xapk/`. You need
  the base `com.zwilling.rapier.apk` plus every `config.*.apk` split. Point the
  `XAPK` env var at this file when you run `build.sh`.

On Arch Linux (this machine): `sudo pacman -S jdk-openjdk`. Verify with
`java -version`.

---

## Step 1 - Repoint the base at your host

The endpoint is stored as a length-prefixed DEX string
(`ULEB128(len) || bytes || 0x00`) with a separate offset table, so the
replacement **must be exactly as long as the original: 37 bytes for prod, 43
for stage**. `https://` (8) + host + `/graphql` (8) = 37, so the host must be
**at most 21 bytes**. If it is shorter, `patch_endpoint.py` pads the URL with an
**ignored query string** (`https://<host>/graphql?aaaa`); your server routes on
the path `/graphql` and ignores the query, so the pad is transparent. Need a
longer host? See the advanced notes.

Dry-run first (writes nothing) to confirm it finds the three prod URLs in
`classes6.dex`:

```bash
python3 patch_endpoint.py patched-apk/com.zwilling.rapier.apk \
    --host your-backend.example.com --dry-run
```

Then apply, writing a new base APK in place of the one `build.sh` will pick up:

```bash
python3 patch_endpoint.py patched-apk/com.zwilling.rapier.apk \
    --host your-backend.example.com \
    --include-stage \
    -o patched-apk/com.zwilling.rapier.apk
```

- `--include-stage` also rewrites the 43-byte `-stage` slots (padded query), so
  no traffic can leak to Zwilling regardless of environment. Harmless to
  include.
- The script recomputes each patched DEX's **SHA-1 signature** and **Adler-32
  checksum** so Android's verifier accepts it.

You can run the built-in tests any time (no APK/Java needed):

```bash
python3 patch_endpoint.py --self-test
```

---

## Step 2 - Build the universal APK

`build.sh` takes the domain-patched base, applies the four smali patches, merges
the config splits, and signs one self-contained APK:

```bash
XAPK=/path/to/ZWILLING.xapk \
  ./apk-build/build.sh [BASE_APK] [google-services.json] [OUT_APK]
```

Defaults: base `patched-apk/com.zwilling.rapier.apk`, config
`~/Downloads/google-services.json`, output
`patched-apk/zwilling-universal.apk`. Signing uses uber-apk-signer.

**The four smali patches (`patch.py`):**
1. **Firebase repoint** - swap ZWILLING's FCM config for yours.
2. **Dead tabs** - hide the recipes / discover / shop tabs.
3. **Goodbye sticker** - force `ShowGoodbyeInteractor.isGoodbyeDate = false`.
4. **Network check** - force `Network.isConnected() = true` (fixes photo
   uploads on modern Android, where the legacy connectivity API returns false).

**Output:** a single `zwilling-universal.apk` (base + both config splits merged,
both ABIs present).

> Optional developer note: if a phone is attached over adb, `build.sh` finishes
> with an on-device smoke test (install, launch, check for crashes). With no
> device it **auto-skips** that gate. adb is never required to build or install.

---

## Step 3 - Install (no adb, no developer mode)

1. **Uninstall the store version first.** The store build is signed by Zwilling;
   your re-signed build has a different signer, so Android refuses to install
   over it. On the phone: **Settings -> Apps -> ZWILLING -> Uninstall** (or
   long-press the icon -> Uninstall).
2. **Get `zwilling-universal.apk` onto the phone and tap it.** The easiest way
   is to download it from your backend's `/app` page (see below). When the phone
   asks, allow **"install unknown apps"** for your browser or file manager. Tap
   **Install**. That's it.

To go back to the real app later, uninstall from **Settings -> Apps** the same
way and reinstall the original store build. `patch_endpoint.py` never modifies
your original APKs, so keep them as your clean restore point.

---

## Step 4 - Point the host at your backend and serve valid TLS

The patched app now resolves your chosen host (e.g. `your-backend.example.com`)
and expects **HTTPS on port 443** answering GraphQL at `/graphql`.

Make the host resolve to your server:

- **Real DNS** (cleanest, and required for a public Let's Encrypt cert): create
  an `A`/`AAAA` record for your host pointing at your server, then issue a cert
  with certbot/caddy. Caddy will auto-provision TLS:
  ```
  your-backend.example.com {
      reverse_proxy localhost:8080   # your stub GraphQL server
  }
  ```
- **Local override** (private testing): a DNS server on your LAN (Pi-hole /
  dnsmasq) or the device's hosts file (rooted) mapping the host to your server's
  LAN IP. With a local override you can't get a public cert for that name, so
  you'll need the private-CA + NSC route in the advanced notes.

Your backend must speak the app's GraphQL schema well enough that:
1. `authLogin` returns a syntactically valid JWT `accessToken`, a non-empty
   `refreshToken`, and a `user` with `isGuest=false` and a valid `id`/`email`;
2. `checkToken` reports the session valid (so it isn't downgraded to guest);
3. subsequent queries accept `Authorization: Bearer <token>` and return data.

Because the token is never cryptographically checked on device, any well-formed
JWT-looking string is accepted. Reproducing enough of the wider schema is the
largest remaining effort and is **not** part of these tools.

---

## Advanced notes

### Self-signed / private-CA TLS cert

If you serve a **publicly-valid cert** (e.g. Let's Encrypt, or Cloudflare in
front), skip this - the platform default trusts it.

If you must use a **self-signed / private-CA** cert, the app has to be told to
trust user-installed CAs via a Network Security Config, which means editing the
(binary) `AndroidManifest.xml` and adding an XML resource with apktool:

```bash
apktool d patched-apk/com.zwilling.rapier.apk -o base_src
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
apktool b base_src -o patched-apk/com.zwilling.rapier.apk
```

Then feed that base back through `build.sh` (Step 2) and install your CA cert on
the device (Settings -> Security -> Encryption & credentials -> Install a
certificate -> CA certificate). **A publicly-valid cert avoids all of this**, so
prefer it.

### Host longer than 21 bytes

The in-place repoint is constrained to same-byte-length. If you truly need a
longer host/path, rebuild the DEX with apktool so string lengths and offsets are
regenerated, then use that base for Step 2:

```bash
apktool d patched-apk/com.zwilling.rapier.apk -o base_src
grep -rn "quillons.zwgaws.io" base_src/smali*/    # find the URL constants
# replace the string literals with your (any-length) URL, then:
apktool b base_src -o patched-apk/com.zwilling.rapier.apk
```

This is heavier (full disassemble/reassemble, slower, more failure modes) but
removes the length constraint entirely. Prefer the in-place repoint whenever a
21-byte host works.

### Installing the raw 3-split set instead of the universal APK

`patch_endpoint.py` only edits the base APK; the untouched `config.*` splits are
byte-identical to the originals but **still must be re-signed with the same new
key** so the whole set matches. Sign all three in one pass with uber-apk-signer:

```bash
mkdir -p signset
cp patched-apk/com.zwilling.rapier.apk \
   patched-apk/config.armeabi_v7a.apk \
   patched-apk/config.xhdpi.apk signset/
java -jar uber-apk-signer.jar -a signset --allowResign --overwrite
```

A split set is **not** a single tappable file: it can only be installed with a
split-APK installer app (e.g. SAI) or with adb (`adb install-multiple`). This is
why the universal build above is the recommended path for anyone without a
developer setup.

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
</content>
</invoke>
