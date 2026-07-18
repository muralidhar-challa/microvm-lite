// Phase 3 gate (SCHEDULER-DESIGN.md): a real guest binary (cross-compiled
// with musl, blink/native-debug/pthread-counter-test.c) that calls
// pthread_create() twice, exercised through the REAL production contract —
// window.vm.writeFile + window.vm.execute, the same path SQL_Chat's agent
// uses — against the actual dist/blink.js build. The native lldb harness
// (test/native-phase3-*.sh, run manually — see SCHEDULER-DESIGN.md) proved
// genuine interleaving via g_mvl_current alternation; this proves the same
// scheduler survives the full vm-worker/vm-host round trip in a live
// browser, real Emscripten Fibers included.
//
//   bun test/phase3-pthread-selftest.spec.mjs
import { chromium } from "playwright";
import { spawn, spawnSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8775;
const GUEST_SRC = resolve(ROOT, "blink/native-debug/pthread-counter-test.c");
const GUEST_OUT_DIR = "/tmp/mvl-phase3-guest";
const GUEST_BIN = `${GUEST_OUT_DIR}/pthread-counter-test`;

mkdirSync(GUEST_OUT_DIR, { recursive: true });
const cc = spawnSync("x86_64-linux-musl-gcc", [
  "-O2", "-static", "-Wl,-z,common-page-size=65536,-z,max-page-size=65536",
  "-o", GUEST_BIN, GUEST_SRC, "-lpthread",
], { stdio: "inherit" });
if (cc.status !== 0) throw new Error("failed to cross-compile the guest pthread test binary");

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("static server never came up at " + url);
}
await waitServer(`http://localhost:${PORT}/test/contract.html`);

const guestBytes = Array.from(readFileSync(GUEST_BIN));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/test/contract.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate(() => {
    window.__startVM({ baseEtag: "test-v1", cdnBase: "/dist", workerUrl: "/src/vm-worker.js" });
  });
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });

  await page.evaluate((bytes) => {
    return window.vm.writeFile("/workspace/pthread-counter-test", new Uint8Array(bytes), { mode: "0755" });
  }, guestBytes);

  const out = await page.evaluate(() => window.vm.execute("/workspace/pthread-counter-test"));
  console.log("  guest output:", JSON.stringify(out));
  check("real guest pthread_create() test passes through the real VM", out.trim() === "PASS: counter=40000", `got=${JSON.stringify(out)}`);

  // Run it again — same worker instance — proves the scheduler's
  // per-command reset (MvlSchedReset, wired into em_reset_children) leaves
  // no state that corrupts a later command in this long-lived worker.
  const out2 = await page.evaluate(() => window.vm.execute("/workspace/pthread-counter-test"));
  check("second run in the same worker also passes", out2.trim() === "PASS: counter=40000", `got=${JSON.stringify(out2)}`);

  // A normal (non-threaded) command afterward — proves the scheduler
  // hook's near-zero-cost path doesn't disturb ordinary execution once
  // g_mvl_sched_active has been true earlier in this worker's lifetime.
  const out3 = await page.evaluate(() => window.vm.execute("echo AFTER"));
  check("ordinary command still works after threaded runs", out3.trim() === "AFTER", `got=${JSON.stringify(out3)}`);
} finally {
  await browser.close();
  cleanup();
}

if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log("\nALL PHASE 3 PTHREAD SELFTEST CHECKS PASSED");
  process.exit(0);
}
