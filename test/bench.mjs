// M1 performance gate: benchmark the blink guest against the v86 timing budget.
//
// v86 reference budget (tools-rs/skills/env.md):
//   simple_shell        : 150-400 ms
//   pdftotext_per_10_pages : 25-35 s
//   pdftotext_100_pages    : 60-90 s
//   excel_get/set       : 300 ms - 10 s
//
// Usage:  bun test/bench.mjs
// Expects: static server on :8765 serving microvm/test, all binaries built.

import { chromium } from "playwright";

const BENCHES = [
  // name, argv, accept-ms (informational), expect-substring (correctness)
  ["boot-to-ready", null, 10000, null],
  ["echo (simple shell)", ["echo", "hi"], 500, "hi"],
  ["xtool ping", ["xtool", "ping"], 2000, "pong"],
  ["xtool excel_create", ["xtool", "excel_create", "/workspace/bench.xlsx", "--sheets=[\"S1\"]"], 10000, null],
  ["xtool excel_set_batch 50 cells", ["xtool", "excel_set_batch", "/workspace/bench.xlsx::S1",
      "--ops=" + JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ col: (i % 5) + 1, row: ((i / 5) | 0) + 1, value: "v" + i }))),
    ], 10000, null],
  ["xtool excel_get col", ["xtool", "excel_get", "/workspace/bench.xlsx::S1/col/1"], 10000, "v0"],
  ["sqlite3 create+1k rows+query", ["sqlite3", "/workspace/bench.db",
      "CREATE TABLE t(a INTEGER, b TEXT); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<1000) INSERT INTO t SELECT x, 'row'||x FROM c; SELECT count(*), sum(a) FROM t;",
    ], 15000, "1000|500500"],
  ["pdfinfo text30.pdf (1st dyn exec, warms loader)", ["pdfinfo", "/workspace/text30.pdf"], 15000, "Pages:"],
  ["pdftotext 10 text pages", ["pdftotext", "-f", "1", "-l", "10", "/workspace/text30.pdf", "/workspace/t10.txt"], 105000, null],
  ["wc -c extracted 10p", ["wc", "-c", "/workspace/t10.txt"], 5000, null],
  ["pdftotext full 30 text pages", ["pdftotext", "/workspace/text30.pdf", "/workspace/t30.txt"], 200000, null],
  ["wc -c extracted 30p", ["wc", "-c", "/workspace/t30.txt"], 5000, null],
  ["pdftoppm 1 scanned page → png (raster)", ["pdftoppm", "-png", "-f", "1", "-l", "1", "-r", "72", "/workspace/permit.pdf", "/workspace/page"], 120000, null],
  ["ls -la /workspace", ["ls", "-la", "/workspace"], 5000, "t10.txt"],
];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const rows = [];

const tBoot = Date.now();
await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
await page.waitForFunction(
  () => document.getElementById("statusEl").textContent === "ready",
  { timeout: 30000 },
);
rows.push({ name: "boot-to-ready", ms: Date.now() - tBoot, ok: true, note: "incl. binary fetches" });

for (const [name, argv, acceptMs, expect] of BENCHES) {
  if (!argv) continue;
  const t0 = Date.now();
  const r = await page.evaluate(({ argv, timeoutMs }) => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        if (ev.data.type === "result" && ev.data.id === id) {
          worker.removeEventListener("message", handler);
          resolve(ev.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "exec", id, argv });
      setTimeout(() => resolve({ error: "TIMEOUT" }), timeoutMs);
    });
  }, { argv, timeoutMs: acceptMs + 30000 });
  const ms = Date.now() - t0;

  let ok = !r.error;
  let note = r.error || "";
  if (ok && expect && !(r.output || "").includes(expect)) {
    ok = false;
    note = "unexpected output: " + JSON.stringify((r.output || "").slice(0, 120));
  }
  rows.push({ name, ms, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(32)} ${String(ms).padStart(7)} ms  ${note}`);
  if (r.error === "TIMEOUT") break; // module is likely wedged
}

console.log("\n| bench | ms | ok | note |");
console.log("|---|---:|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.ms} | ${r.ok ? "✓" : "✗"} | ${r.note} |`);

await browser.close();
