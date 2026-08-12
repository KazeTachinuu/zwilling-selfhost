#!/usr/bin/env python3
# patch_endpoint.py
#
# Redirect the ZWILLING (com.zwilling.rapier) Android app to a self-hosted
# GraphQL backend by byte-patching the hardcoded endpoint URL strings inside
# the base APK's DEX files.
#
# PERSONAL-USE ONLY. See README.md. This edits an app you own, on your own
# device. Do not redistribute the patched app or use it against Zwilling's
# infrastructure.
#
# Pure Python 3 standard library. Java is NOT required to run this script
# (java/apksigner are only needed later to re-sign the patched APK).
#
# What it does:
#   * Finds the hardcoded endpoint strings
#         https://na.quillons.zwgaws.io/graphql   (37 bytes, prod NA)
#         https://eu.quillons.zwgaws.io/graphql   (37 bytes, prod EU)
#         https://ap.quillons.zwgaws.io/graphql   (37 bytes, prod AP)
#     (and optionally the *-stage variants, 43 bytes) in classes*.dex.
#   * Overwrites them, IN PLACE and SAME BYTE LENGTH, with your host.
#   * Recomputes each DEX's SHA-1 signature and Adler-32 checksum so the
#     Android runtime verifier accepts the modified DEX.
#   * Always works on a COPY. The originals are never touched.
#
# Why "same byte length" is mandatory
# ------------------------------------
# In the DEX format every string is stored as a "string_data_item":
#       ULEB128(utf16_length)  ||  MUTF-8 bytes  ||  0x00
# and a separate string_ids table holds the *file offset* of each such item.
# The prod URLs are 37 chars, so their length prefix is the single byte 0x25
# (=37). If you swap in a host of a different length you change that prefix
# width and/or shift every following byte, which invalidates all the absolute
# offsets in string_ids and map_list -> the app will not load. Editing the
# 37 raw ASCII bytes in place keeps the prefix (0x25), the terminator (0x00),
# and every offset untouched: a surgical, reversible edit.
#
# So your replacement URL MUST be exactly as long as the original:
#       37 bytes for the prod slots, 43 bytes for the stage slots.
# `https://` (8) + host + `/graphql` (8) = 37  ->  host must be 21 bytes.
# If your host is not exactly 21 bytes, this script pads the URL with an
# ignored query string (e.g. `...graphql?aaaa`) so the total still lands on
# the required length while the request path your server routes on stays
# `/graphql`. If your host is longer than (target-16) bytes it cannot fit and
# you must use the apktool full-rebuild path documented in README.md instead.

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import zipfile
import zlib

# ---------------------------------------------------------------------------
# The endpoint strings baked into the app. Discovered dynamically at runtime;
# these are only defaults / documentation of what we look for.
# ---------------------------------------------------------------------------
PROD_URLS = [
    b"https://na.quillons.zwgaws.io/graphql",
    b"https://eu.quillons.zwgaws.io/graphql",
    b"https://ap.quillons.zwgaws.io/graphql",
]
STAGE_URLS = [
    b"https://na-stage.quillons.zwgaws.io/graphql",
    b"https://eu-stage.quillons.zwgaws.io/graphql",
    b"https://ap-stage.quillons.zwgaws.io/graphql",
]
PROD_LEN = 37
STAGE_LEN = 43

DEX_MAGIC = b"dex\n"


# ---------------------------------------------------------------------------
# DEX integrity: header layout (little-endian)
#   [0x00:0x08] magic
#   [0x08:0x0C] checksum   = adler32( file[0x0C:] )
#   [0x0C:0x20] signature  = sha1(    file[0x20:] )
#   [0x20:0x24] file_size
# The signature covers everything after it, and the checksum covers the
# signature, so recompute the SHA-1 FIRST, then the Adler-32.
# ---------------------------------------------------------------------------
def fix_dex_integrity(buf: bytearray) -> tuple[str, str]:
    if len(buf) < 0x28 or bytes(buf[0:4]) != DEX_MAGIC:
        raise ValueError("not a DEX file (bad magic)")
    sig = hashlib.sha1(bytes(buf[0x20:])).digest()
    buf[0x0C:0x20] = sig
    checksum = zlib.adler32(bytes(buf[0x0C:])) & 0xFFFFFFFF
    buf[0x08:0x0C] = checksum.to_bytes(4, "little")
    return (checksum.to_bytes(4, "little").hex(), sig.hex())


def verify_dex_integrity(buf: bytes) -> bool:
    if len(buf) < 0x28 or buf[0:4] != DEX_MAGIC:
        return False
    stored_sum = buf[0x08:0x0C]
    stored_sig = buf[0x0C:0x20]
    good_sig = hashlib.sha1(buf[0x20:]).digest()
    if stored_sig != good_sig:
        return False
    good_sum = (zlib.adler32(buf[0x0C:]) & 0xFFFFFFFF).to_bytes(4, "little")
    return stored_sum == good_sum


# ---------------------------------------------------------------------------
# Build a same-length replacement URL for a given target length.
# ---------------------------------------------------------------------------
def build_replacement(host: str, target_len: int) -> bytes:
    base = f"https://{host}/graphql"
    b = base.encode("ascii")
    if len(b) == target_len:
        return b
    if len(b) < target_len:
        pad = target_len - len(b)
        # Pad with an ignored query string. `?` then filler; servers route on
        # the path (/graphql) and ignore the query, so this is transparent.
        if pad == 1:
            b = b + b"?"
        else:
            b = b + b"?" + b"a" * (pad - 1)
        return b
    max_host = target_len - len(b"https:///graphql")
    raise ValueError(
        f"host {host!r} is too long: 'https://{host}/graphql' is "
        f"{len(b)} bytes but the slot is {target_len} bytes. "
        f"Max host length for this scheme/path is {max_host} bytes. "
        f"Use a shorter host, or rebuild the DEX with apktool (see README)."
    )


def validate_exact(url: bytes, target_len: int) -> bytes:
    if not all(0x20 <= c < 0x7F for c in url):
        raise ValueError("replacement URL must be printable 7-bit ASCII")
    if len(url) != target_len:
        raise ValueError(
            f"replacement URL is {len(url)} bytes, must be exactly "
            f"{target_len} bytes to fit the slot in place"
        )
    return url


# ---------------------------------------------------------------------------
# Core: find + replace occurrences inside a single DEX buffer.
# Returns list of (offset, old_bytes, new_bytes).
# ---------------------------------------------------------------------------
def patch_buffer(buf: bytearray, targets: list[tuple[bytes, bytes]]):
    changes = []
    for old, new in targets:
        assert len(old) == len(new), "internal: length mismatch"
        start = 0
        while True:
            idx = buf.find(old, start)
            if idx == -1:
                break
            # Sanity: the byte before should be the ULEB length prefix and the
            # byte after should be the 0x00 terminator for a real dex string.
            prefix = buf[idx - 1] if idx > 0 else None
            term = buf[idx + len(old)] if idx + len(old) < len(buf) else None
            note = ""
            if prefix != len(old):
                note = f" [warn: prefix byte {prefix!r} != {len(old)}]"
            if term != 0x00:
                note += f" [warn: no 0x00 terminator, got {term!r}]"
            changes.append((idx, old, new, note))
            if not note:
                buf[idx : idx + len(old)] = new
            start = idx + len(old)
    return changes


def build_targets(args) -> list[tuple[bytes, bytes]]:
    targets = []
    if args.url:
        repl_prod = validate_exact(args.url.encode("ascii"), PROD_LEN)
    else:
        repl_prod = build_replacement(args.host, PROD_LEN)
    for u in PROD_URLS:
        targets.append((u, repl_prod))
    if args.include_stage:
        # Stage slots are 43 bytes; reuse the same host, padded to length.
        # main() guarantees --host is set here (--include-stage requires it,
        # and --url is mutually exclusive with --host).
        repl_stage = build_replacement(args.host, STAGE_LEN)
        for u in STAGE_URLS:
            targets.append((u, repl_stage))
    return targets


# ---------------------------------------------------------------------------
# DEX-directory / single-DEX mode
# ---------------------------------------------------------------------------
def iter_dex_paths(path: str):
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            if name.startswith("classes") and name.endswith(".dex"):
                yield os.path.join(path, name)
    else:
        yield path


def run_dex_mode(args, targets):
    total = 0
    outputs = []
    for dex_path in iter_dex_paths(args.input):
        with open(dex_path, "rb") as f:
            buf = bytearray(f.read())
        changes = patch_buffer(buf, targets)
        applied = [c for c in changes if not c[3]]
        if not changes:
            continue
        print(f"\n[{os.path.basename(dex_path)}]")
        for off, old, new, note in changes:
            status = "DRY " if args.dry_run else ("SKIP" if note else "SET ")
            print(f"  {status} @0x{off:08x} ({off})")
            print(f"       - {old.decode()}")
            print(f"       + {new.decode()}{note}")
        total += len(applied)
        if args.dry_run:
            continue
        if not applied:
            continue
        chk, sig = fix_dex_integrity(buf)
        assert verify_dex_integrity(bytes(buf)), "integrity self-check failed"
        out = _out_path(dex_path, args.output)
        with open(out, "wb") as f:
            f.write(buf)
        print(f"  -> wrote {out}")
        print(f"     new checksum=0x{chk}  sha1={sig}")
        outputs.append(out)
    _summary(args, total, outputs)


def _out_path(src: str, output: str | None) -> str:
    if output:
        if os.path.isdir(output) or output.endswith(os.sep):
            os.makedirs(output, exist_ok=True)
            return os.path.join(output, os.path.basename(src))
        return output
    return src + ".patched"


# ---------------------------------------------------------------------------
# APK mode: patch the classes*.dex entries inside the zip, write a new APK.
# The patched DEX entries are stored UNCOMPRESSED (ZIP_STORED) so they can be
# 4-byte aligned with `zipalign` afterwards; all other entries are copied
# with their original compression. The resulting APK is UNSIGNED - re-sign it
# with apksigner (see README).
# ---------------------------------------------------------------------------
def run_apk_mode(args, targets):
    src = args.input
    out = args.output or (os.path.splitext(src)[0] + ".patched.apk")
    if os.path.abspath(out) == os.path.abspath(src):
        print("error: --output must differ from the input APK", file=sys.stderr)
        return 2

    total = 0
    patched_entries = []
    with zipfile.ZipFile(src, "r") as zin:
        infos = zin.infolist()
        # Pre-scan to report before writing anything.
        for info in infos:
            name = os.path.basename(info.filename)
            if not (name.startswith("classes") and name.endswith(".dex")):
                continue
            buf = bytearray(zin.read(info.filename))
            changes = patch_buffer(bytearray(buf), targets)  # scan copy
            if changes:
                print(f"\n[{info.filename}]")
                for off, old, new, note in changes:
                    status = "DRY " if args.dry_run else ("SKIP" if note else "SET ")
                    print(f"  {status} @0x{off:08x} ({off})")
                    print(f"       - {old.decode()}")
                    print(f"       + {new.decode()}{note}")

        if args.dry_run:
            _summary(args, None, [])
            return 0

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".apk", dir=os.path.dirname(os.path.abspath(out)) or ".")
        os.close(tmp_fd)
        with zipfile.ZipFile(tmp_path, "w") as zout:
            for info in infos:
                data = zin.read(info.filename)
                name = os.path.basename(info.filename)
                is_dex = name.startswith("classes") and name.endswith(".dex")
                if is_dex:
                    buf = bytearray(data)
                    changes = patch_buffer(buf, targets)
                    applied = [c for c in changes if not c[3]]
                    if applied:
                        chk, sig = fix_dex_integrity(buf)
                        assert verify_dex_integrity(bytes(buf)), "integrity self-check failed"
                        data = bytes(buf)
                        total += len(applied)
                        patched_entries.append(info.filename)
                        print(f"  -> {info.filename}: checksum=0x{chk} sha1={sig}")
                # Preserve entry metadata; store patched dex uncompressed.
                zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zi.external_attr = info.external_attr
                zi.internal_attr = info.internal_attr
                zi.create_system = info.create_system
                if is_dex and info.filename in patched_entries:
                    zi.compress_type = zipfile.ZIP_STORED
                else:
                    zi.compress_type = info.compress_type
                zout.writestr(zi, data)
    os.replace(tmp_path, out)
    print(f"\n  -> wrote UNSIGNED patched APK: {out}")
    print("     next: zipalign (optional) + apksigner sign  (see README.md)")
    _summary(args, total, [out])
    return 0


def _summary(args, total, outputs):
    print("\n" + "=" * 60)
    if args.dry_run:
        print("DRY RUN - nothing was written. Re-run without --dry-run to apply.")
    else:
        print(f"Applied {total} in-place replacement(s).")
        for o in outputs:
            print(f"  output: {o}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Self-test: build a minimal valid DEX-shaped buffer that embeds a prod URL,
# patch it, and assert (a) same byte length, (b) offsets unchanged,
# (c) recomputed checksum/signature verify. No java, no real APK needed.
# ---------------------------------------------------------------------------
def self_test() -> int:
    print("self-test: building synthetic DEX buffer...")
    url = PROD_URLS[0]  # 37 bytes
    # header(112) + [0x25 prefix][url][0x00] + padding
    body = bytes([len(url)]) + url + b"\x00" + b"\x00" * 64
    buf = bytearray(b"dex\n038\x00" + b"\x00" * (0x70 - 8) + body)
    fix_dex_integrity(buf)
    assert verify_dex_integrity(bytes(buf)), "baseline integrity failed"
    original_len = len(buf)
    url_off = buf.find(url)
    assert url_off != -1

    host = "mybackend.example.io"  # 20 chars -> needs 1 pad byte
    repl = build_replacement(host, PROD_LEN)
    print(f"  built replacement: {repl.decode()} (len={len(repl)})")
    assert len(repl) == PROD_LEN, "replacement not 37 bytes"

    changes = patch_buffer(buf, [(url, repl)])
    assert len(changes) == 1 and not changes[0][3], f"unexpected: {changes}"
    assert changes[0][0] == url_off, "offset moved"
    assert len(buf) == original_len, "buffer length changed"
    assert buf[url_off - 1] == PROD_LEN, "length prefix clobbered"
    assert buf[url_off + PROD_LEN] == 0x00, "terminator clobbered"

    chk, sig = fix_dex_integrity(buf)
    assert verify_dex_integrity(bytes(buf)), "post-patch integrity failed"

    # 21-char host lands exactly, no pad.
    exact = build_replacement("na.quillons.zwgaws.io", PROD_LEN)
    assert exact == b"https://na.quillons.zwgaws.io/graphql", exact
    # stage length
    st = build_replacement("na.quillons.zwgaws.io", STAGE_LEN)
    assert len(st) == STAGE_LEN, st
    # too-long host rejected
    try:
        build_replacement("a" * 40, PROD_LEN)
        raise AssertionError("should have rejected over-long host")
    except ValueError:
        pass
    # exact-length validator
    try:
        validate_exact(b"https://short/graphql", PROD_LEN)
        raise AssertionError("should have rejected wrong-length --url")
    except ValueError:
        pass

    print(f"  patched @0x{url_off:x}: {url.decode()} -> {repl.decode()}")
    print(f"  new checksum=0x{chk} sha1={sig[:16]}...")
    print("self-test: ALL PASSED")
    return 0


# ---------------------------------------------------------------------------
def main(argv=None):
    p = argparse.ArgumentParser(
        description="Patch the ZWILLING app's hardcoded GraphQL endpoint to a "
        "self-hosted host, in place and same-byte-length. PERSONAL USE ONLY.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("input", nargs="?",
                   help="a .apk, a single .dex, or a directory of classes*.dex")
    grp = p.add_mutually_exclusive_group()
    grp.add_argument("--host",
                     help="your backend host, e.g. mybackend.example.io. "
                          "The script builds https://<host>/graphql and pads "
                          "to the exact slot length if needed.")
    grp.add_argument("--url",
                     help="full replacement URL, must be EXACTLY 37 bytes "
                          "(prod slot). Overrides --host for prod slots.")
    p.add_argument("--include-stage", action="store_true",
                   help="also patch the *-stage 43-byte slots (needs --host).")
    p.add_argument("--output", "-o",
                   help="output file (apk / single dex) or directory (dex dir). "
                        "Default: <input>.patched / <name>.patched.apk")
    p.add_argument("--dry-run", action="store_true",
                   help="print matches and planned edits, write nothing.")
    p.add_argument("--verify", metavar="DEX",
                   help="verify DEX integrity (checksum+sha1) of a file and exit.")
    p.add_argument("--self-test", action="store_true",
                   help="run built-in tests (no APK/java needed) and exit.")
    args = p.parse_args(argv)

    if args.self_test:
        return self_test()

    if args.verify:
        with open(args.verify, "rb") as f:
            ok = verify_dex_integrity(f.read())
        print(f"{args.verify}: integrity {'OK' if ok else 'BAD'}")
        return 0 if ok else 1

    if not args.input:
        p.error("input is required (a .apk, .dex, or dir) unless --self-test/--verify")
    if not args.url and not args.host:
        p.error("provide --host YOURHOST (or --url for a full 37-byte URL)")
    if args.include_stage and not args.host:
        p.error("--include-stage requires --host (stage slots are 43 bytes)")

    try:
        targets = build_targets(args)
    except ValueError as e:
        p.error(str(e))

    print("Replacement plan (same-byte-length, in place):")
    seen = set()
    for old, new in targets:
        key = (len(old), new)
        if key in seen:
            continue
        seen.add(key)
        print(f"  {len(old):>2}B  ...{old.decode():<44} -> {new.decode()}")

    if args.input.lower().endswith(".apk"):
        return run_apk_mode(args, targets)
    run_dex_mode(args, targets)
    return 0


if __name__ == "__main__":
    sys.exit(main())
