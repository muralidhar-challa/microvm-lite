// M4 gate: drive the real vm-host.js/vm-worker.js pair through the exact
// SQL_Chat useV86.ts `window.vm` + registerVmEndpoint contract and assert the
// shapes/strings the app depends on (wasm-bridge.ts). Serves microvm/ root on
// its own port so both /src and /test are same-origin.
//
//   bun microvm/test/contract.spec.mjs
//
// Exit code 0 = all assertions passed.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8771;

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

// Poll until the static server is actually serving before Playwright navigates.
async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("static server never came up at " + url);
}
await waitServer(`http://localhost:${PORT}/test/contract.html`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.text().startsWith("[vm-dbg]") === false && m.type() === "error") console.log("[console.error]", m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/test/contract.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });

  // Boot the SOURCE worker (workerUrl=/src) against the packaged bundle
  // manifest + assets in /dist, and register a generic mock endpoint BEFORE
  // ready so the HTTP-bridge test below can use it.
  await page.evaluate(() => {
    window.__startVM({ baseEtag: "test-v1", cdnBase: "/dist", workerUrl: "/src/vm-worker.js",
      vmRoutes: { "api.vm": "mock" } });
    // registerVmEndpoint isn't defined until _doStartVM sets window.vm; poll.
    const install = () => {
      if (typeof window.registerVmEndpoint !== "function") return setTimeout(install, 20);
      window.registerVmEndpoint("/echo", (_m, data) => ({ ok: true, got: (data && data.msg) || null }));
    };
    install();
  });

  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });
  check("window.vm installed + isReady", await page.evaluate(() => window.vm && window.vm.isReady === true));
  check("window.vm.ready() resolves", await page.evaluate(async () => { await window.vm.ready(); return true; }));

  // ── execute() → string ──────────────────────────────────────────────────
  const execOut = await page.evaluate(() => window.vm.execute("echo hello && echo world"));
  check("execute() returns a string", typeof execOut === "string", `got ${typeof execOut}`);
  check("execute() output correct", execOut === "hello\nworld", JSON.stringify(execOut));

  // ── run() → {done, output_file, pid, output} ──────────────────────────────
  const runRes = await page.evaluate(() => window.vm.run("echo bg-output"));
  check("run() done:true (run-to-completion)", runRes.done === true, JSON.stringify(runRes));
  check("run() output_file /tmp/out-<hex>.txt", /^\/tmp\/out-[0-9a-f]{8}\.txt$/.test(runRes.output_file || ""), runRes.output_file);
  check("run() pid is a number", typeof runRes.pid === "number" && runRes.pid > 0, String(runRes.pid));
  check("run() output correct", runRes.output === "bg-output", JSON.stringify(runRes.output));
  const persisted = await page.evaluate((f) => window.vm.readFile(f), runRes.output_file);
  check("run() output_file readable + matches", persisted.trim() === "bg-output", JSON.stringify(persisted));

  // ── writeFile / readFile / readFileRaw ────────────────────────────────────
  await page.evaluate(() => window.vm.writeFile("/workspace/wf.txt", "written-content"));
  const rf = await page.evaluate(() => window.vm.readFile("/workspace/wf.txt"));
  check("writeFile → readFile round-trip", rf === "written-content", JSON.stringify(rf));
  const rawLen = await page.evaluate(async () => (await window.vm.readFileRaw("/workspace/wf.txt")).byteLength);
  check("readFileRaw returns ArrayBuffer bytes", rawLen === 15, String(rawLen));
  await page.evaluate(() => window.vm.writeFile("/workspace/bin.dat", new Uint8Array([1, 2, 3, 0, 255])));
  const binLen = await page.evaluate(async () => (await window.vm.readFileRaw("/workspace/bin.dat")).byteLength);
  check("writeFile accepts Uint8Array binary", binLen === 5, String(binLen));

  // ── HTTP bridge through the registerVmEndpoint registry (guest wget) ───────
  const echoOut = await page.evaluate(() => window.vm.execute("wget -O - http://api.vm/echo"));
  check("HTTP bridge → registered endpoint", echoOut.includes('"ok":true'), echoOut);

  // ── writeFile({mode}): install an executable at runtime, then run it ───────
  // (how an integrator loads a binary/skill it built later — here a +x script.)
  await page.evaluate(() => window.vm.writeFile("/bin/hello", "#!/bin/sh\necho hi-from-installed\n", { mode: "0755" }));
  const helloOut = await page.evaluate(() => window.vm.execute("hello"));
  check("writeFile({mode}) installs a runnable executable", helloOut.includes("hi-from-installed"), helloOut);

  // ── Snapshot persistence: save_state → gzip+IDB, restore across reboot ─────
  await page.evaluate(() => window.vm.writeFile("/workspace/persist.txt", "survives-reboot"));
  // Force a save (fs_dirty debounce would also do it, but drive it directly).
  await page.evaluate(async () => {
    // trigger a save by calling the internal path via a fresh write + wait for debounce
    await window.vm.writeFile("/workspace/persist2.txt", "x");
    await new Promise((r) => setTimeout(r, 6000)); // > 5s fs_dirty debounce
  });
  const idbHadSnapshot = await page.evaluate(async () => {
    const req = indexedDB.open("microvm-lite-data", 1);
    return await new Promise((resolve) => {
      req.onsuccess = () => {
        const tx = req.result.transaction("snapshot", "readonly");
        const g = tx.objectStore("snapshot").get("snapshot");
        g.onsuccess = () => resolve(!!g.result && g.result.byteLength > 12);
        g.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    });
  });
  check("save_state → snapshot written to IDB", idbHadSnapshot);

  // Reboot via a full page reload (fresh module + worker), same etag — the IDB
  // snapshot (kept, since resetToFresh isn't called yet) must restore the files.
  await page.reload();
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate(() => window.__startVM({ baseEtag: "test-v1", cdnBase: "/test", workerUrl: "/src/vm-worker.js", vmRoutes: {} }));
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });
  const afterReboot = await page.evaluate(() => window.vm.readFile("/workspace/persist.txt").catch(() => "<missing>"));
  check("snapshot restores files across reboot", afterReboot === "survives-reboot", JSON.stringify(afterReboot));

  // ── resetToFresh clears the snapshot ──────────────────────────────────────
  await page.evaluate(() => window.vm.resetToFresh());
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });
  const afterReset = await page.evaluate(() => window.vm.readFile("/workspace/persist.txt").catch(() => "<missing>"));
  check("resetToFresh wipes persisted files", afterReset === "<missing>", JSON.stringify(afterReset));

} catch (e) {
  failures++;
  console.log("FATAL:", e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}

console.log(failures === 0 ? "\nALL CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
