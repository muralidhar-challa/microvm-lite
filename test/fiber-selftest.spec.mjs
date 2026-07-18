// Phase 1 gate (SCHEDULER-DESIGN.md): does emscripten_fiber_init/
// emscripten_fiber_swap actually work under this project's exact emcc
// flags/worker environment? Calls em_fiber_selftest() (blink/mvl_sched.c)
// directly in a live browser and asserts the returned interleave log.
//
//   bun test/fiber-selftest.spec.mjs
import { chromium } from "playwright";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8773;

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
await waitServer(`http://localhost:${PORT}/test/fiber-selftest.html`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/test/fiber-selftest.html`);
  await page.evaluate(() => window.__fiberSelftestReady);

  const result = await page.evaluate(() => window.__runFiberSelftest());
  console.log("  em_fiber_selftest() ->", JSON.stringify(result));

  check("em_fiber_selftest() returns 0 (pass)", result.rc === 0, `rc=${result.rc}`);
  check("log is 20 chars", result.log.length === 20, `log=${JSON.stringify(result.log)}`);
  const expected = "ABABABABABABABABABAB".slice(0, 20);
  check("log alternates A/B starting with A", result.log === expected, `got=${JSON.stringify(result.log)} want=${JSON.stringify(expected)}`);

  // Run it a second time in the SAME module instance — proves the fiber
  // machinery doesn't leave stale state that corrupts a later run (relevant
  // once the real scheduler reuses this on every worker-lifetime command).
  const result2 = await page.evaluate(() => window.__runFiberSelftest());
  check("second run also returns 0", result2.rc === 0, `rc=${result2.rc}`);
  check("second run log matches first", result2.log === result.log, `got=${JSON.stringify(result2.log)}`);
} finally {
  await browser.close();
  cleanup();
}

if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log("\nALL FIBER SELFTEST CHECKS PASSED");
  process.exit(0);
}
