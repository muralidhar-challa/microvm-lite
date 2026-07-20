// Real-fork diagnosis: one pipeline, full console/error capture.
import { chromium } from "playwright";
import { spawn } from "child_process";
const PORT = 8811;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.on("console", (m) => log(`  [console:${m.type()}] ${m.text().slice(0, 300)}`));
p.on("pageerror", (e) => log("  [pageerror] " + e.message.slice(0, 300)));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "rf-diag", cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted");

const run = async (x, ms = 20000) => { try { return JSON.stringify(String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms]))); } catch (e) { return "<<ERR: " + e.message.slice(0, 120) + ">>"; } };

log("\n1) plain command (no pipe):");
log("   echo alive -> " + (await run("echo alive")));
log("\n2) THE pipeline:");
log("   seq 1 5 | head -2 -> " + (await run("seq 1 5 | head -2")));
log("\n3) is the VM still alive?");
log("   echo alive -> " + (await run("echo alive")));
log("\n4) fork log:");
try {
  const flog = String(await p.evaluate(() => window.vm.readFile("/tmp/.mvlfork.log")));
  log(flog.split("\n").slice(-25).join("\n"));
} catch (e) { log("   unreadable: " + e.message.slice(0, 120)); }
await b.close(); server.kill(); process.exit(0);
