// Phase 2 gate (SCHEDULER-DESIGN.md): two Machines sharing one System via
// NewMachine(system, parent), memory shared across a real Emscripten Fiber
// swap. Calls em_sched_phase2_test() (blink/mvl_sched_phase2_test.c)
// directly in a live browser against the actual dist/blink.js — the native
// lldb harness (test/native-phase2-selftest.sh) covers the same logic
// against ucontext; this covers it against the real wasm backend, since
// Phase 1 found bugs that only showed up there.
//
//   bun test/phase2-selftest.spec.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8774;

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
await waitServer(`http://localhost:${PORT}/test/phase2-selftest.html`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/test/phase2-selftest.html`);
  await page.evaluate(() => window.__phase2SelftestReady);

  const rc = await page.evaluate(() => window.__runPhase2Selftest());
  console.log("  em_sched_phase2_test() ->", rc);
  check("em_sched_phase2_test() returns 0 (pass)", rc === 0, `rc=${rc}`);

  // Run it again — same module instance, fresh System/Machines each call —
  // proves no leftover page-table/fiber state corrupts a later run.
  const rc2 = await page.evaluate(() => window.__runPhase2Selftest());
  check("second run also returns 0", rc2 === 0, `rc=${rc2}`);
} finally {
  await browser.close();
  cleanup();
}

if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log("\nALL PHASE 2 SELFTEST CHECKS PASSED");
  process.exit(0);
}
