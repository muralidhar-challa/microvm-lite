import { chromium } from "playwright";
import { spawn } from "child_process";
import { readFileSync } from "fs";
const PORT = 8820;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "hostoverlap-" + Date.now(), cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted\n");

const bin = readFileSync("dist/pidcollide");
await p.evaluate(async (bytes) => { await window.vm.writeFile("/tmp/pidcollide", new Uint8Array(bytes), { mode: 0o755 }); }, [...bin]);
log("staged pidcollide\n");

// The realistic overlap: TWO vm.execute() calls fired WITHOUT awaiting the
// first — no guest-side `&` at all, each a plain foreground posix_spawn.
// Repeated N times to catch the race, not just prove it CAN work once.
let collisions = 0, hangs = 0, ran = 0;
const N = 25;
for (let i = 0; i < N; i++) {
  const [a, b2] = await Promise.all([
    p.evaluate(([q, t]) => window.vm.execute(q, t).catch(e => "<<ERR:" + e.message.slice(0,80) + ">>"), ["/tmp/pidcollide", 10000]),
    p.evaluate(([q, t]) => window.vm.execute(q, t).catch(e => "<<ERR:" + e.message.slice(0,80) + ">>"), ["/tmp/pidcollide", 10000]),
  ]);
  ran++;
  const pa = (String(a).match(/spawned pid=(\d+)/) || [])[1];
  const pb = (String(b2).match(/spawned pid=(\d+)/) || [])[1];
  if (String(a).includes("ERR") || String(b2).includes("ERR")) { hangs++; if (hangs <= 3) log(`  [${i}] TIMEOUT/ERR: a=${JSON.stringify(a)} b=${JSON.stringify(b2)}`); continue; }
  if (pa && pb && pa === pb) { collisions++; log(`  [${i}] COLLISION: both pid=${pa}`); }
}
log(`\nran=${ran} collisions=${collisions} hangs/errors=${hangs}`);
log(collisions === 0 && hangs === 0 ? "\nALL GREEN — realistic host-overlap pattern is safe" : "\nISSUE FOUND");
await b.close(); server.kill(); process.exit(collisions === 0 && hangs === 0 ? 0 : 1);
