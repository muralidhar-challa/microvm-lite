#!/usr/bin/env bash
# M5: assemble the microvm-lite CDN payload into microvm/dist/ and emit a
# hashed manifest.json. Run after blink/build.sh (needs blink-wasm/ populated)
# and after the poppler/sqlite rootfs is staged in test/rootfs/.
#
#   bash microvm/dist/build-dist.sh
#
# Layout produced:
#   dist/blink.js  dist/blink.wasm          — emulator (eager)
#   dist/vm-worker.js  dist/vm-host.js       — contract layer (eager)
#   dist/bin/{busybox,xtool,app,runner}       — core guest tools (eager)
#   dist/rootfs/bin/*  dist/rootfs/lib/*      — poppler+sqlite closure (LAZY)
#   dist/manifest.json                        — sha256+size of every asset,
#                                               buildId (hash of core), and the
#                                               applet + lazy-trigger lists
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # microvm/
WASM="$DIR/blink-wasm"
ROOTFS="$DIR/test/rootfs"
SRC="$DIR/src"
OUT="$DIR/dist"

[ -f "$WASM/blink.wasm" ] || { echo "blink-wasm/ not built — run blink/build.sh first" >&2; exit 1; }
[ -f "$ROOTFS/manifest.json" ] || { echo "test/rootfs/ not staged (poppler closure)" >&2; exit 1; }

echo "[1/4] Clean dist/"
rm -rf "$OUT/blink.js" "$OUT/blink.wasm" "$OUT/vm-worker.js" "$OUT/vm-host.js" \
       "$OUT/bin" "$OUT/rootfs" "$OUT/manifest.json"
mkdir -p "$OUT/bin" "$OUT/rootfs/bin" "$OUT/rootfs/lib"

echo "[2/4] Copy assets (deref symlinks)"
cp -L "$WASM/blink.js"  "$OUT/blink.js"
cp -L "$WASM/blink.wasm" "$OUT/blink.wasm"
cp -L "$SRC/vm-worker.js" "$OUT/vm-worker.js"
cp -L "$SRC/vm-host.js"   "$OUT/vm-host.js"
for b in busybox xtool app runner; do cp -L "$WASM/$b" "$OUT/bin/$b"; done
# Poppler/sqlite closure (lazy tier)
python3 - "$ROOTFS" "$OUT" <<'PY'
import json, shutil, sys, os
rootfs, out = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(rootfs, "manifest.json")))
for f in man["bin"]: shutil.copy(os.path.join(rootfs, "bin", f), os.path.join(out, "rootfs/bin", f))
for f in man["lib"]: shutil.copy(os.path.join(rootfs, "lib", f), os.path.join(out, "rootfs/lib", f))
print(f"  staged {len(man['bin'])} rootfs bins + {len(man['lib'])} libs")
PY

echo "[3/4] Hash + emit manifest.json"
# BusyBox applets that share the single busybox binary (symlink targets in the
# guest FS). Kept here so the worker installs them without a second fetch.
APPLETS='["sh","hush","ls","cat","sed","awk","grep","find","head","tail","cp","mv","rm","mkdir","rmdir","touch","echo","printf","wc","sort","uniq","cut","tr","xargs","env","pwd","id","wget","chmod","stat","du","df","diff","md5sum","tar","gzip","gunzip","base64","sleep","seq","yes","date","sync","kill","true","false"]'

python3 - "$OUT" "$ROOTFS" "$APPLETS" <<'PY'
import json, hashlib, os, sys
out, rootfs, applets = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])

def entry(path):
    b = open(path, "rb").read()
    return {"sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}

core = {}
for rel in ["blink.js", "blink.wasm", "vm-worker.js", "vm-host.js"]:
    core[rel] = entry(os.path.join(out, rel))
for b in ["busybox", "xtool", "app", "runner"]:
    core["bin/" + b] = entry(os.path.join(out, "bin", b))

rman = json.load(open(os.path.join(rootfs, "manifest.json")))
lazy = {}
for f in rman["bin"]: lazy["rootfs/bin/" + f] = entry(os.path.join(out, "rootfs/bin", f))
for f in rman["lib"]: lazy["rootfs/lib/" + f] = entry(os.path.join(out, "rootfs/lib", f))

# buildId = hash of the CORE asset digests (order-stable). Snapshots key on this
# so a rebuilt binary invalidates a stale IDB filesystem snapshot; lazy poppler
# is excluded because it never changes the guest's persisted /workspace state.
h = hashlib.sha256()
for k in sorted(core): h.update(k.encode()); h.update(core[k]["sha256"].encode())
build_id = h.hexdigest()[:16]

# Lazy triggers: any of these tokens in a command => fetch the poppler closure
# first. Derived from the rootfs bin list (pdf*/sqlite3), not hardcoded.
triggers = sorted(rman["bin"])

manifest = {
    "buildId": build_id,
    "applets": applets,
    "triggers": triggers,
    "core": core,
    "lazy": {"poppler": lazy},
}
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
core_bytes = sum(v["size"] for v in core.values())
lazy_bytes = sum(v["size"] for v in lazy.values())
print(f"  buildId={build_id}  core={core_bytes/1e6:.1f}MB (eager)  lazy={lazy_bytes/1e6:.1f}MB (poppler)")
PY

echo "[4/4] Done → $OUT"
ls -la "$OUT" | grep -vE '^total|\.sh$'
