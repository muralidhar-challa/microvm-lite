#!/usr/bin/env bash
# Assemble the microvm-lite CDN payload into dist/ and emit a hashed,
# BUNDLE-based manifest.json. Run after blink/build.sh (needs blink-wasm/).
#
#   bash dist/build-dist.sh
#
# Reference build: blink + dash (BSD-3-Clause /bin/sh) + toybox (0BSD coreutils).
# No GPL. No OSS closure. Integrators add their own tools via manifest bundles
# or vm.loadBundle()/vm.writeFile().
#
# Layout produced:
#   dist/blink.js  dist/blink.wasm          — emulator
#   dist/vm-worker.js  dist/vm-host.js       — contract layer
#   dist/bin/dash                            — BSD-3-Clause /bin/sh (eager)
#   dist/bin/toybox                          — 0BSD coreutils (eager)
#   dist/manifest.json                        — { buildId, home, applets, bundles }
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # microvm/
WASM="$DIR/blink-wasm"
SRC="$DIR/src"
OUT="$DIR/dist"

[ -f "$WASM/blink.wasm" ] || { echo "blink-wasm/ not built — run blink/build.sh first" >&2; exit 1; }

echo "[1/3] Clean dist/"
rm -rf "$OUT/blink.js" "$OUT/blink.wasm" "$OUT/vm-worker.js" "$OUT/vm-host.js" \
       "$OUT/bin" "$OUT/rootfs" "$OUT/manifest.json"
mkdir -p "$OUT/bin"

echo "[2/3] Copy assets (deref symlinks)"
cp -L "$WASM/blink.js"  "$OUT/blink.js"
cp -L "$WASM/blink.wasm" "$OUT/blink.wasm"
cp -L "$SRC/vm-worker.js" "$OUT/vm-worker.js"
cp -L "$SRC/vm-host.js"   "$OUT/vm-host.js"
cp -L "$WASM/dash"   "$OUT/bin/dash"         # BSD-3-Clause /bin/sh
cp -L "$WASM/toybox"  "$OUT/bin/toybox"       # 0BSD coreutils

echo "[3/3] Hash + emit manifest.json"
DASH_APPLETS='["sh","bash"]'
TOYBOX_APPLETS='["ls","cat","sed","awk","grep","find","head","tail","cp","mv","rm","mkdir","rmdir","touch","echo","printf","wc","sort","uniq","cut","tr","xargs","env","pwd","id","wget","chmod","stat","du","df","diff","md5sum","tar","gzip","gunzip","base64","sleep","seq","yes","date","sync","kill","true","false"]'
HOME_DIR="/workspace"

python3 - "$OUT" "$DASH_APPLETS" "$TOYBOX_APPLETS" "$HOME_DIR" <<'PY'
import json, hashlib, os, sys
out, dash_json, toybox_json, home = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
dash_applets = json.loads(dash_json)
toybox_applets = json.loads(toybox_json)
all_applets = dash_applets + toybox_applets

def meta(path):
    b = open(path, "rb").read()
    return hashlib.sha256(b).hexdigest(), len(b)

def bundle_file(url, dest, mode="0755", applets=None):
    sha, size = meta(os.path.join(out, url))
    e = {"url": url, "dest": dest, "mode": mode, "sha256": sha, "size": size}
    if applets is not None: e["applets"] = applets
    return e

base_files = [
    bundle_file("bin/dash",   "/bin/dash",   applets=dash_applets),
    bundle_file("bin/toybox", "/bin/toybox", applets=toybox_applets),
]

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
    },
}
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
eager = sum(f["size"] for f in base_files)
print(f"  buildId={build_id}  home={home}  base={eager/1e6:.1f}MB (eager)  no lazy bundles")
PY

echo ""
echo "Done → $OUT"
ls -la "$OUT" | grep -vE '^total|\.sh$'
