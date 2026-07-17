#!/usr/bin/env bash
# Generate test/text30.pdf — a 30-page, text-layer PDF used as the
# pdftotext extraction workload in bench.mjs. The bundled sample PDFs
# (permit.pdf, item8.pdf) are SCANNED/image PDFs, so pdftotext returns near-empty
# on them and can't measure extraction speed; this one has a real text layer.
#
# Requires: python3, ps2pdf (ghostscript).  Usage: bash test/gen-text-pdf.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

python3 - > /tmp/text30.ps << 'PY'
import random
random.seed(1)
words = ("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
         "tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam "
         "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo").split()
out = ["%!PS-Adobe-3.0", "/Times-Roman findfont 11 scalefont setfont"]
for _ in range(30):
    y = 760
    for _ in range(50):
        line = " ".join(random.choice(words) for _ in range(12))
        out.append(f"50 {y} moveto ({line}) show")
        y -= 14
    out.append("showpage")
print("\n".join(out))
PY

ps2pdf /tmp/text30.ps "$HERE/text30.pdf"
echo "wrote $HERE/text30.pdf ($(wc -c < "$HERE/text30.pdf") bytes, 30 pages)"
