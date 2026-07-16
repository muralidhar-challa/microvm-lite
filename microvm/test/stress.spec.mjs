// Sustained-load soak for the microvm-lite blink backend.
//
// Simulates constant real usage in ONE long-lived worker: varying file sizes
// in/out, varying HTTP request/response ("packet") sizes in/out through the M3
// bridge, and CPU processing (sqlite, pdftotext), all interleaved. The point is
// to surface what unit gates miss — memory growth, /tmp residue, latency drift
// over time, and any correctness loss under churn.
//
//   bun microvm/test/stress.spec.mjs           # default ~140 iterations
//   ITERS=400 bun microvm/test/stress.spec.mjs # longer soak
//
// Health thresholds (exit 1 on breach): zero integrity failures, zero errors on
// the supported surface, bounded latency drift, and a heap that plateaus.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8773;
const ITERS = parseInt(process.env.ITERS || "140", 10);

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);
async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server never came up: " + url);
}
await waitServer(`http://localhost:${PORT}/dist/dist.html`);
const pdfBytes = Array.from(readFileSync(resolve(ROOT, "test/text30.pdf")));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); } };

try {
  await page.goto(`http://localhost:${PORT}/dist/dist.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate((bytes) => {
    window.__startVM({ cdnBase: "/dist", workerUrl: "/dist/vm-worker.js", vmRoutes: {} });
    const install = () => {
      if (typeof window.registerVmEndpoint !== "function") return setTimeout(install, 20);
      // /echo: size=N query → N-byte response body ending in "END" (packet-out);
      // JSON POST body {pad:"..."} → echo its length (packet-in).
      window.registerVmEndpoint("/echo", (_m, data, url) => {
        const out = parseInt(new URL(url).searchParams.get("size") || "0", 10);
        if (out > 0) return { size: out, pad: "x".repeat(Math.max(0, out - 3)) + "END" };
        return { ok: true, echoedLen: data && typeof data.pad === "string" ? data.pad.length : 0 };
      });
      window.__pdf = bytes;
    };
    install();
  }, pdfBytes);
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });

  const boot = await page.evaluate(() => window.vm._stat());
  console.log(`  · boot heap=${(boot.heapBytes / 1e6).toFixed(1)}MB  tmpFiles=${boot.tmpFiles}`);

  // Seed the PDF once (used by the pdf op).
  await page.evaluate(() => window.vm.writeFile("/workspace/doc.pdf", new Uint8Array(window.__pdf)));

  console.log(`\nrunning soak: ${ITERS} iterations, mixed workload…`);
  const report = await page.evaluate(async (ITERS) => {
    const vm = window.vm;
    // Deterministic PRNG so a failing run is reproducible.
    let seed = 0x2545f491;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 0xffffffff); };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const randBytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (rnd() * 256) | 0; return a; };
    // FNV-1a over bytes — cheap integrity check without shipping the payload out.
    const fnv = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h * 0x01000193) >>> 0; } return h; };

    const FILE_SIZES = [1 << 10, 16 << 10, 128 << 10, 1 << 20, 4 << 20];
    const HTTP_SIZES = [256, 4 << 10, 64 << 10, 512 << 10];
    const SQL_ROWS = [100, 1000, 5000];

    const lat = {};       // op -> [ms]
    const record = (op, ms) => { (lat[op] = lat[op] || []).push(ms); };
    const errors = [];
    let integrityFails = 0;
    const failDetail = [];  // {op, reason}
    const heapSamples = [];

    const OPS = [
      ["file", 34], ["out", 16], ["http_out", 18], ["http_in", 14], ["sqlite", 14], ["pdf", 4],
    ];
    const bag = [];
    OPS.forEach(([n, w]) => { for (let i = 0; i < w; i++) bag.push(n); });

    let fileCounter = 0;
    for (let it = 0; it < ITERS; it++) {
      const op = pick(bag);
      const t0 = performance.now();
      try {
        const fail = (op, reason) => { integrityFails++; if (failDetail.length < 40) failDetail.push({ op, reason }); };
        if (op === "file") {
          const size = pick(FILE_SIZES);
          const data = randBytes(size);
          const h = fnv(data);
          const path = `/workspace/stress_${(fileCounter++) % 8}.bin`; // reuse 8 slots (overwrite churn)
          await vm.writeFile(path, data);
          const back = new Uint8Array(await vm.readFileRaw(path));
          if (back.length !== size || fnv(back) !== h) fail("file:" + size, `len ${back.length}/${size} hash ${fnv(back)}/${h}`);
          record("file:" + size, performance.now() - t0);
        } else if (op === "out") {
          // Large stdout capture: write a marker file, cat it, verify captured intact.
          const size = pick(FILE_SIZES);
          const marker = "S".repeat(size - 3) + "END";
          await vm.writeFile("/workspace/cat.txt", marker);
          const outp = await vm.execute("cat cat.txt");
          if (!outp.endsWith("END") || outp.length !== size) fail("out:" + size, `len ${outp.length}/${size} tail=${JSON.stringify(outp.slice(-6))}`);
          record("out:" + size, performance.now() - t0);
        } else if (op === "http_out") {
          const size = pick(HTTP_SIZES);
          const outp = await vm.execute(`wget -qO- 'http://api.vm/echo?size=${size}'`);
          if (!outp.includes("END")) fail("http_out:" + size, `len ${outp.length} no END`);   // full body survived the bridge
          record("http_out:" + size, performance.now() - t0);
        } else if (op === "http_in") {
          const size = pick(HTTP_SIZES);
          const pad = "p".repeat(size);
          await vm.writeFile("/workspace/post.json", JSON.stringify({ pad }));
          const outp = await vm.execute("wget -qO- --post-file=post.json http://api.vm/echo");
          let echoed = -1; try { echoed = JSON.parse(outp).echoedLen; } catch {}
          if (echoed !== size) fail("http_in:" + size, `echoed ${echoed}/${size} raw=${JSON.stringify(outp.slice(0, 40))}`);
          record("http_in:" + size, performance.now() - t0);
        } else if (op === "sqlite") {
          const rows = pick(SQL_ROWS);
          const sql = `CREATE TABLE t(x); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${rows}) INSERT INTO t SELECT i FROM c; SELECT count(*), sum(x) FROM t;`;
          // Fresh db name per call — a single fork+exec command. (A "rm -f db;
          // sqlite3 db" sequence would lose sqlite's stdout: see the M2
          // external-then-command limitation the soak surfaced.)
          const outp = await vm.execute(`sqlite3 /tmp/s_${it}.db "${sql}"`);
          const want = `${rows}|${(rows * (rows + 1)) / 2}`;
          if (!outp.includes(want)) fail("sqlite:" + rows, `want ${want} got ${JSON.stringify(outp.slice(0, 40))}`);
          record("sqlite:" + rows, performance.now() - t0);
        } else if (op === "pdf") {
          const outp = await vm.execute("pdftotext doc.pdf - | wc -c");
          if (parseInt(outp.trim(), 10) < 1000) fail("pdf", `wc=${JSON.stringify(outp.trim())}`);
          record("pdf", performance.now() - t0);
        }
      } catch (e) {
        errors.push(`${op}: ${String(e && e.message || e)}`);
      }
      if (it % 20 === 0) { const s = await vm._stat(); heapSamples.push({ it, heap: s.heapBytes, tmp: s.tmpFiles }); }
    }
    const end = await vm._stat();
    return { lat, errors, integrityFails, failDetail, heapSamples, end };
  }, ITERS);

  // ── Report ────────────────────────────────────────────────────────────────
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
  const med = (arr) => pct(arr, 0.5);
  console.log("\n  per-op latency (count · p50 · p95 · max, ms):");
  const opNames = Object.keys(report.lat).sort();
  let totalOps = 0;
  for (const k of opNames) {
    const a = report.lat[k]; totalOps += a.length;
    console.log(`    ${k.padEnd(16)} n=${String(a.length).padStart(3)}  p50=${med(a).toFixed(0).padStart(6)}  p95=${pct(a, 0.95).toFixed(0).padStart(6)}  max=${Math.max(...a).toFixed(0).padStart(6)}`);
  }

  // Latency drift: compare first-half vs second-half p50 WITHIN each exact
  // op:size bucket (same work), so the number reflects slowdown over time and
  // isn't confounded by which sizes happened to be drawn early vs late. Only
  // buckets with enough samples (n>=6) are eligible.
  console.log("\n  latency drift (first-half p50 → second-half p50, same-size buckets, n≥6):");
  let worstDrift = 1, worstKey = "";
  for (const k of opNames) {
    const a = report.lat[k];
    if (a.length < 6) continue;
    const half = Math.floor(a.length / 2);
    const first = med(a.slice(0, half)), last = med(a.slice(half));
    const drift = last / Math.max(first, 0.5);
    if (drift > worstDrift) { worstDrift = drift; worstKey = k; }
    console.log(`    ${k.padEnd(16)} ${first.toFixed(0)}ms → ${last.toFixed(0)}ms  (${drift.toFixed(2)}×)`);
  }
  console.log(`    worst: ${worstKey || "n/a"} ${worstDrift.toFixed(2)}×`);

  const heaps = report.heapSamples;
  const heap0 = heaps[0]?.heap || 0, heapPeak = Math.max(...heaps.map((h) => h.heap));
  console.log(`\n  heap: boot=${(heap0 / 1e6).toFixed(1)}MB  peak=${(heapPeak / 1e6).toFixed(1)}MB  end=${(report.end.heapBytes / 1e6).toFixed(1)}MB`);
  console.log(`  /tmp residue: boot→end ${heaps[0]?.tmp ?? "?"} → ${report.end.tmpFiles}  (run() output files are retained by contract)`);
  console.log(`  total ops=${totalOps}  errors=${report.errors.length}  integrity-fails=${report.integrityFails}`);
  if (report.errors.length) console.log("  first errors: " + report.errors.slice(0, 5).join(" | "));
  if (report.failDetail && report.failDetail.length) {
    console.log("  integrity-fail detail:");
    report.failDetail.slice(0, 12).forEach((f) => console.log(`    ${f.op}: ${f.reason}`));
  }

  console.log("\n  health:");
  check("zero integrity failures", report.integrityFails === 0, `${report.integrityFails} corrupt round-trips`);
  check("zero errors on supported surface", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
  check("latency drift < 2.5× (no runaway slowdown)", worstDrift < 2.5, `worst ${worstDrift.toFixed(2)}×`);
  check("heap plateaus (peak < 3× boot, < 900MB)", heapPeak < Math.max(heap0 * 3, 200e6) && heapPeak < 900e6, `peak ${(heapPeak / 1e6).toFixed(0)}MB vs boot ${(heap0 / 1e6).toFixed(0)}MB`);

} catch (e) {
  failures++;
  console.log("FATAL:", e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}

console.log(failures === 0 ? "\nSOAK PASSED" : `\n${failures} HEALTH CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
