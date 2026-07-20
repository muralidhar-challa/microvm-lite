// CHILD-PID-COLLISION-BUG.md verification: two independent fork lineages,
// each spawning a posix_spawn (clone(CLONE_VM)) child within the SAME
// top-level command (so g_em_children[] isn't reset between them — the
// actual failure mode: subagent-style concurrent spawning). Repeated many
// times to catch the race; asserts the two spawned pids are never equal
// AND that nothing ever surfaces ECHILD-style wait failures.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { readFileSync } from "fs";

const PORT = 8814;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.on("pageerror", (e) => log("  [pageerror] " + e.message.slice(0, 200)));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "pidcollide-" + Date.now(), cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted\n");

const run = async (x, ms = 15000) => { try { return String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms])).trim(); } catch (e) { return "<<ERR: " + e.message.slice(0, 150) + ">>"; } };

// Stage the repro binary (already musl-static-linked, dist/pidcollide) into
// the guest, then run it under two BACKGROUNDED, independently-forked shells
// within one top-level command — same as one guest command backgrounding
// two subagent-style spawns concurrently.
const bin = readFileSync("dist/pidcollide");
await p.evaluate(async (bytes) => {
  await window.vm.writeFile("/tmp/pidcollide", new Uint8Array(bytes), { mode: 0o755 });
}, [...bin]);
const staged = await run("test -x /tmp/pidcollide && echo YES || echo NO");
log("staged: " + staged);

let collisions = 0, echild = 0, ran = 0;
const N = 40;
for (let i = 0; i < N; i++) {
  const out = await run("/tmp/pidcollide & /tmp/pidcollide & wait");
  const pids = [...out.matchAll(/spawned pid=(\d+)/g)].map((m) => m[1]);
  ran++;
  if (out.includes("No child process") || out.includes("ECHILD")) echild++;
  if (pids.length === 2 && pids[0] === pids[1]) {
    collisions++;
    if (collisions <= 3) log(`  [${i}] COLLISION: both spawned pid=${pids[0]}\n       raw: ${JSON.stringify(out)}`);
  } else if (pids.length !== 2) {
    log(`  [${i}] unexpected output (want 2 pids): ${JSON.stringify(out.slice(0, 200))}`);
  }
}

log(`\nran=${ran} collisions=${collisions} echild=${echild}`);
log(collisions === 0 && echild === 0 ? "\nALL GREEN — no pid collisions, no ECHILD" : "\nFAIL — bug still present");
await b.close(); server.kill();
process.exit(collisions === 0 && echild === 0 ? 0 : 1);
