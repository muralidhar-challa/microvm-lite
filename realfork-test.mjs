// Real fork() gate. The decisive case is `seq 1 5 | head -2` on a COLD VM:
// an early-exiting reader used to poison everything after it, silently.
import { chromium } from "playwright";
import { spawn } from "child_process";
const PORT = 8810;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.on("pageerror", (e) => log("  [pageerror] " + e.message));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "realfork-v1", cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted\n");
const run = async (x) => { try { return String(await p.evaluate(q => window.vm.execute(q, 25000), x)).trim(); } catch (e) { return "<<TIMEOUT/ERR: " + e.message.slice(0, 60) + ">>"; } };

let fail = 0;
const check = async (cmd, want) => {
  const got = await run(cmd);
  const ok = want === null ? got.length > 0 : got === want;
  if (!ok) fail++;
  log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(cmd)}\n        -> ${JSON.stringify(got.slice(0, 90))}${want !== null && !ok ? `\n        want ${JSON.stringify(want)}` : ""}`);
};

log("== THE decisive case: early-exiting reader on a cold VM ==");
await check(`seq 1 5 | head -2`, "1\n2");
await check(`echo hi | cat`, "hi");          // must survive the above
await check(`seq 1 5 | head -2`, "1\n2");
await check(`echo hi | cat`, "hi");

log("\n== previously-poisoning cases ==");
await check(`echo hi | wc -l`, "1");
await check(`ls / | wc -l`, null);
await check(`printf 'b\\na\\n' | sort`, "a\nb");
await check(`echo hi | cat`, "hi");

log("\n== basics ==");
await check(`echo a | cat | cat | cat`, "a");
await check(`ls / | head -3`, null);
await check(`echo foo | grep foo`, "foo");
await check(`seq 1 5 | cat`, "1\n2\n3\n4\n5");
await check(`echo alive`, "alive");

log("\n== does it survive repetition? 60 mixed pipelines ==");
const t0 = Date.now();
let bad = 0;
for (let i = 0; i < 60; i++) {
  const a = await run(`seq 1 5 | head -2`);
  const c = await run(`echo hi | cat`);
  if (a !== "1\n2" || c !== "hi") { bad++; if (bad === 1) log(`  first bad at ${i}: head=${JSON.stringify(a)} cat=${JSON.stringify(c)}`); }
  if ((i + 1) % 20 === 0) log(`  [${i + 1}/60] ${((Date.now() - t0) / 1000).toFixed(0)}s, bad=${bad}`);
}
log(`\nmixed-loop failures: ${bad}/60   |   check failures: ${fail}`);
try {
  const flog = String(await p.evaluate(() => window.vm.readFile("/tmp/.mvlfork.log")));
  const lines = flog.split("\n");
  const done = lines.filter(l => l.startsWith("COPYDONE"));
  const fails = lines.filter(l => l.includes("FAIL"));
  log(`fork log: ${done.length} COPYDONE, ${fails.length} FAIL lines`);
  log("  last: " + (done[done.length - 1] || "<none>"));
  if (fails.length) log("  first fail: " + fails[0]);
} catch (e) { log("fork log unreadable: " + e.message.slice(0, 60)); }
log(bad === 0 && fail === 0 ? "\nALL GREEN" : "\nNOT GREEN");
await b.close(); server.kill(); process.exit(0);
