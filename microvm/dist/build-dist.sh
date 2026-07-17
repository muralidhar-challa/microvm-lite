#!/usr/bin/env bash
# Assemble the microvm-lite CDN payload into microvm/dist/ and emit a hashed,
# BUNDLE-based manifest.json. Run after blink/build.sh (needs blink-wasm/) and
# after the generic-OSS closure (sqlite/poppler) is staged in test/rootfs/.
#
#   bash microvm/dist/build-dist.sh
#
# This project is PRODUCT-AGNOSTIC: the reference build ships only the generic
# runtime — blink + busybox + generic OSS (sqlite/poppler). Product tools and
# skills are NOT built in; an integrator supplies them at runtime as their own
# manifest bundles or via vm.loadBundle()/vm.writeFile({mode}).
#
# Layout produced:
#   dist/blink.js  dist/blink.wasm          — emulator
#   dist/vm-worker.js  dist/vm-host.js       — contract layer
#   dist/bin/busybox                         — hush shell (GPL, eager)
#   dist/bin/toybox                          — 0BSD coreutils (eager)
#   dist/rootfs/bin/*  dist/rootfs/lib/*      — generic OSS closure (lazy)
#   dist/manifest.json                        — { buildId, home, applets,
#                                                 bundles: { base:eager, oss:lazy } }
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # microvm/
WASM="$DIR/blink-wasm"
ROOTFS="$DIR/test/rootfs"
SRC="$DIR/src"
OUT="$DIR/dist"

[ -f "$WASM/blink.wasm" ] || { echo "blink-wasm/ not built — run blink/build.sh first" >&2; exit 1; }
[ -f "$ROOTFS/manifest.json" ] || { echo "test/rootfs/ not staged (OSS closure)" >&2; exit 1; }

echo "[1/4] Clean dist/"
rm -rf "$OUT/blink.js" "$OUT/blink.wasm" "$OUT/vm-worker.js" "$OUT/vm-host.js" \
       "$OUT/bin" "$OUT/rootfs" "$OUT/manifest.json"
mkdir -p "$OUT/bin" "$OUT/rootfs/bin" "$OUT/rootfs/lib"

echo "[2/4] Copy assets (deref symlinks)"
cp -L "$WASM/blink.js"  "$OUT/blink.js"
cp -L "$WASM/blink.wasm" "$OUT/blink.wasm"
cp -L "$SRC/vm-worker.js" "$OUT/vm-worker.js"
cp -L "$SRC/vm-host.js"   "$OUT/vm-host.js"
cp -L "$WASM/busybox" "$OUT/bin/busybox"     # GPL shell only (hush)
cp -L "$WASM/toybox"  "$OUT/bin/toybox"      # 0BSD coreutils
# Generic OSS closure (sqlite/poppler) — the lazy tier.
python3 - "$ROOTFS" "$OUT" <<'PY'
import json, shutil, sys, os
rootfs, out = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(rootfs, "manifest.json")))
for f in man["bin"]: shutil.copy(os.path.join(rootfs, "bin", f), os.path.join(out, "rootfs/bin", f))
for f in man["lib"]: shutil.copy(os.path.join(rootfs, "lib", f), os.path.join(out, "rootfs/lib", f))
print(f"  staged busybox + toybox + {len(man['bin'])} OSS bins + {len(man['lib'])} libs")
PY

echo "[3/4] Hash + emit manifest.json"
# BusyBox applets that share the single busybox binary (symlinked in the guest).
# BusyBox applets that share the single busybox binary (symlinked in the guest).
# GPL shell only (hush) — coreutils come from toybox (0BSD).
BUSYBOX_APPLETS='["sh","hush","bash"]'
TOYBOX_APPLETS='["ls","cat","sed","awk","grep","find","head","tail","cp","mv","rm","mkdir","rmdir","touch","echo","printf","wc","sort","uniq","cut","tr","xargs","env","pwd","id","wget","chmod","stat","du","df","diff","md5sum","tar","gzip","gunzip","base64","sleep","seq","yes","date","sync","kill","true","false"]'
ALL_APPLETS="$BUSYBOX_APPLETS $TOYBOX_APPLETS"
HOME_DIR="/workspace"

python3 - "$OUT" "$ROOTFS" "$BUSYBOX_APPLETS" "$TOYBOX_APPLETS" "$HOME_DIR" <<'PY'
import json, hashlib, os, sys
out, rootfs, busybox_json, toybox_json, home = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
busybox_applets = json.loads(busybox_json)
toybox_applets = json.loads(toybox_json)
all_applets = busybox_applets + toybox_applets
def meta(path):
    b = open(path, "rb").read()
    return hashlib.sha256(b).hexdigest(), len(b)
def bundle_file(url, dest, mode="0755", applets=None):
    sha, size = meta(os.path.join(out, url))
    e = {"url": url, "dest": dest, "mode": mode, "sha256": sha, "size": size}
    if applets is not None: e["applets"] = applets
    return e
# base bundle (eager): busybox (GPL shell) + toybox (0BSD coreutils).
base_files = [
    bundle_file("bin/busybox", "/bin/busybox", applets=busybox_applets),
    bundle_file("bin/toybox", "/bin/toybox", applets=toybox_applets),
]

# oss bundle (lazy): sqlite + poppler closure, staged on first pdf*/sqlite3.
rman = json.load(open(os.path.join(rootfs, "manifest.json")))
oss_files  = [bundle_file("rootfs/bin/" + f, "/bin/" + f) for f in rman["bin"]]
oss_files += [bundle_file("rootfs/lib/" + f, "/lib/" + f) for f in rman["lib"]]
triggers = sorted(rman["bin"])   # pdf*/sqlite3 — derived, not hardcoded

# buildId = hash of the runtime asset digests (blink + contract layer + base
# bundle). Snapshots key on it so a rebuilt runtime busts a stale IDB workspace
# snapshot; the lazy OSS bundle is excluded (it never changes workspace state).
runtime = {}
for rel in ["blink.js", "blink.wasm", "vm-worker.js", "vm-host.js"]:
    runtime[rel] = meta(os.path.join(out, rel))[0]
for f in base_files:
    runtime[f["dest"]] = f["sha256"]
h = hashlib.sha256()
for k in sorted(runtime): h.update(k.encode()); h.update(runtime[k].encode())
build_id = h.hexdigest()[:16]

manifest = {
    "buildId": build_id,
    "home": home,
    "applets": all_applets,
    "bundles": {
        "base": {"tier": "eager", "files": base_files},
        "oss":  {"tier": "lazy", "triggers": triggers, "files": oss_files},
    },
}
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
eager = sum(f["size"] for f in base_files)
lazy  = sum(f["size"] for f in oss_files)
print(f"  buildId={build_id}  home={home}  base={eager/1e6:.1f}MB (eager)  oss={lazy/1e6:.1f}MB (lazy)")
PY

echo "[4/4] Done → $OUT"
ls -la "$OUT" | grep -vE '^total|\.sh$'
