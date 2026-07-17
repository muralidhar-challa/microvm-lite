// M5 gate: boot the PACKAGED dist/ payload and verify the packaging goals —
//  1. cold boot is fast because poppler (~16MB) is NOT fetched at boot,
//  2. a PDF command lazily fetches the poppler closure on first use and works,
//  3. the snapshot etag is the manifest buildId (rebuild busts stale snapshots),
//  4. a save_state → reload round-trip restores the guest FS.
// Serves microvm/ root so /dist (payload) and /test (the sample PDF) coexist.
//
//   bun microvm/test/dist-smoke.spec.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8772;
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}
async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server never came up: " + url);
}
await waitServer(`http://localhost:${PORT}/dist/dist.html`);

// The manifest buildId the packaging emitted — the host should adopt it as etag.
const manifest = await fetch(`http://localhost:${PORT}/dist/manifest.json`).then((r) => r.json());
const pdfBytes = Array.from(readFileSync(resolve(ROOT, "test/text30.pdf")));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
// Capture the worker's lazy-load dbg lines so we can prove WHEN poppler loads.
const dbg = [];
page.on("console", (m) => { const t = m.text(); if (t.includes("[vm-dbg]")) dbg.push(t); });

try {
  await page.goto(`http://localhost:${PORT}/dist/dist.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });

  // ── 1. Cold boot timing (no explicit etag → host adopts manifest buildId) ──
  const t0 = Date.now();
  await page.evaluate(() => window.__startVM({ cdnBase: "/dist", workerUrl: "/dist/vm-worker.js", vmRoutes: {} }));
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });
  const bootMs = Date.now() - t0;
  console.log(`  · cold boot to ready: ${bootMs} ms`);
  // v86 boot is ~25-35s (bench-results.md); require a large margin under that.
  check("cold boot well under v86 (< 15s)", bootMs < 15000, `${bootMs}ms`);
  check("poppler NOT fetched at boot", !dbg.some((l) => l.includes("staging bundle 'oss'")), dbg.join(" | "));

  // ── 2. Lazy poppler on first PDF command ──────────────────────────────────
  await page.evaluate((bytes) => window.vm.writeFile("/workspace/doc.pdf", new Uint8Array(bytes)), pdfBytes);
  const beforeLazy = dbg.length;
  const pdfOut = await page.evaluate(() => window.vm.execute("pdftotext doc.pdf - | head -c 60"));
  check("lazy fetch triggered by pdftotext", dbg.slice(beforeLazy).some((l) => l.includes("staging bundle 'oss'")), dbg.join(" | "));
  check("poppler closure reported ready", dbg.some((l) => l.includes("bundle 'oss' ready")));
  check("pdftotext produced text", typeof pdfOut === "string" && pdfOut.trim().length > 0, JSON.stringify(pdfOut));

  // Second PDF call must NOT re-fetch (closure cached).
  const beforeSecond = dbg.length;
  await page.evaluate(() => window.vm.execute("pdfinfo doc.pdf"));
  check("second PDF call does not re-fetch", !dbg.slice(beforeSecond).some((l) => l.includes("staging bundle 'oss'")));

  // ── 3. buildId is the snapshot etag ───────────────────────────────────────
  await page.evaluate(() => window.vm.writeFile("/workspace/keep.txt", "packaged-persist"));
  await page.evaluate(() => new Promise((r) => setTimeout(r, 6000))); // fs_dirty debounce → save
  const snapEtag = await page.evaluate(async () => {
    const req = indexedDB.open("microvm-lite-data", 1);
    return await new Promise((res) => {
      req.onsuccess = () => {
        const g = req.result.transaction("snapshot", "readonly").objectStore("snapshot").get("snapshot");
        g.onsuccess = () => {
          const buf = g.result;
          if (!buf) return res(null);
          const v = new DataView(buf), len = v.getUint32(0, true);
          res(new TextDecoder().decode(new Uint8Array(buf, 12, len)));
        };
        g.onerror = () => res(null);
      };
      req.onerror = () => res(null);
    });
  });
  check("snapshot etag == manifest buildId", snapEtag === manifest.buildId, `snap=${snapEtag} build=${manifest.buildId}`);

  // ── 4. Reload → snapshot restores the FS ──────────────────────────────────
  await page.reload();
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate(() => window.__startVM({ cdnBase: "/dist", workerUrl: "/dist/vm-worker.js", vmRoutes: {} }));
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });
  const restored = await page.evaluate(() => window.vm.readFile("/workspace/keep.txt").catch(() => "<missing>"));
  check("snapshot restores across reload", restored === "packaged-persist", JSON.stringify(restored));

} catch (e) {
  failures++;
  console.log("FATAL:", e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}

console.log(failures === 0 ? "\nALL DIST SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
