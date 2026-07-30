// Regression coverage for sqlite3 spawn/pipe patterns under the scheduler.
//
// ATTEMPTED repro for the "--table hang" (bug #2) — and it does NOT reproduce
// it. Measured, not assumed: this file passes identically against a pre-fix
// blink build and a post-fix one, so it exercises none of the deadlock and
// proves nothing about the Poll() cooperative-yield change. Kept because the
// coverage is still worth having, and because the next person chasing bug #2
// should not waste time re-deriving that this shape is a dead end.
//
// Why it misses: the original trigger came from `sams`, a Rust binary whose
// Command::new() goes through musl's posix_spawn/vfork path. dash's fork —
// all this file can drive — is a different path into the scheduler. And
// g_mvl_sched_active only turns on once a fiber is actually spawned, so a
// shape that never spawns one exercises neither the bug nor the fix. A real
// repro needs the product build (sams + sqlite3), not the reference build.
//
// The reference build ships only dash + toybox, so sqlite3 (a dynamic musl ELF
// that polls its pipes) and its library closure are staged at runtime from the
// product CDN payload — same binary the product build uses.
//
//   node test/debug/poll-sqlite-hang.mjs
//
// Exit 0 = every sqlite3 spawn returned correct output. Exit 1 = hang/wrong.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 8779;
// Staged out-of-tree (these are ~4 MB of CDN binaries, not repo content).
const SQ = process.env.SQ_DIR || "/tmp/mvl-sq";

const NEED = [
  ["lib/ld-musl-x86_64.so.1", "/lib/ld-musl-x86_64.so.1"],
  ["lib/libc.musl-x86_64.so.1", "/lib/libc.musl-x86_64.so.1"],
  ["usr/lib/libreadline.so.8", "/usr/lib/libreadline.so.8"],
  ["usr/lib/libncursesw.so.6", "/usr/lib/libncursesw.so.6"],
  ["usr/lib/libz.so.1", "/usr/lib/libz.so.1"],
  ["usr/bin/sqlite3", "/usr/bin/sqlite3"],
];

for (const [rel] of NEED) {
  if (!existsSync(resolve(SQ, rel))) {
    console.error(`missing ${resolve(SQ, rel)}
Stage the guest userland first, e.g.:
  B=https://api.njbsoft.com/cdn/sams/asksams-microvm/test/rootfs
  for p in ${NEED.map(([r]) => r).join(" ")}; do
    mkdir -p "${SQ}/$(dirname $p)"; curl -s -o "${SQ}/$p" "$B/$p"; done`);
    process.exit(2);
  }
}

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
const cleanup = () => { try { server.kill(); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
};

async function waitServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server never came up: " + url);
}
await waitServer(`http://localhost:${PORT}/test/contract.html`);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/test/contract.html`);
  await page.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
  await page.evaluate(() => window.__startVM({
    baseEtag: "poll-repro-v1", cdnBase: "/dist", workerUrl: "/src/vm-worker.js", vmRoutes: {},
  }));
  await page.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 45000 });

  console.log("\n== staging sqlite3 + closure ==");
  for (const [rel, dest] of NEED) {
    const bytes = Array.from(readFileSync(resolve(SQ, rel)));
    await page.evaluate(async ({ dest, bytes }) => {
      await window.vm.writeFile(dest, new Uint8Array(bytes), { mode: "0755" });
    }, { dest, bytes });
  }
  const ver = await page.evaluate(() => window.vm.execute("/usr/bin/sqlite3 -version 2>&1", 20000));
  check("sqlite3 runs at all", /^\d+\.\d+/.test(String(ver).trim()), JSON.stringify(String(ver).slice(0, 120)));

  // ── the actual bug shape ──────────────────────────────────────────────────
  // Bare sqlite3 first (the case that always worked), then the same call
  // PRECEDED by forked commands — the documented trigger.
  console.log("\n== bare sqlite3 (control) ==");
  for (let i = 0; i < 3; i++) {
    const out = await page.evaluate((i) =>
      window.vm.execute(`/usr/bin/sqlite3 :memory: "SELECT ${i}+${i};" 2>&1`, 20000), i);
    check(`bare spawn ${i} → ${i * 2}`, String(out).trim() === String(i * 2), JSON.stringify(String(out).slice(0, 120)));
  }

  console.log("\n== sqlite3 preceded by forks (the reported trigger) ==");
  for (let i = 0; i < 6; i++) {
    const cmd = `echo warm | cat > /dev/null; ls / | head -2 > /dev/null; ` +
                `printf 'b\\na\\n' | sort > /dev/null; ` +
                `/usr/bin/sqlite3 :memory: "SELECT ${i}+${i};" 2>&1`;
    const out = await page.evaluate((c) => window.vm.execute(c, 20000)
      .catch((e) => "ERR:" + e.message), cmd);
    check(`fork-then-spawn ${i} → ${i * 2}`, String(out).trim() === String(i * 2),
      JSON.stringify(String(out).slice(0, 160)));
  }

  console.log("\n== sqlite3 in a pipeline (poll on both ends) ==");
  for (let i = 0; i < 3; i++) {
    const out = await page.evaluate((i) =>
      window.vm.execute(`/usr/bin/sqlite3 :memory: "SELECT ${i}+100;" | cat 2>&1`, 20000)
        .catch((e) => "ERR:" + e.message), i);
    check(`piped spawn ${i} → ${i + 100}`, String(out).trim() === String(i + 100),
      JSON.stringify(String(out).slice(0, 160)));
  }

  const alive = await page.evaluate(() => window.vm.execute("echo still-alive").catch((e) => "ERR:" + e.message));
  check("VM healthy at end", String(alive).trim() === "still-alive", JSON.stringify(alive));

} catch (e) {
  failures++;
  console.log("FATAL:", e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}

console.log(failures === 0 ? "\nALL GREEN — no hang" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
