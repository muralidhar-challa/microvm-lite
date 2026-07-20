import { chromium } from "playwright";
import { spawn } from "child_process";
import { readFileSync } from "fs";
const PORT = 8819;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "isohang2-" + Date.now(), cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted\n");
const run = async (x, ms = 8000) => { try { return String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms])).trim(); } catch (e) { return "<<TIMEOUT/ERR: " + e.message.slice(0, 100) + ">>"; } };

const bin = readFileSync("dist/pidcollide");
await p.evaluate(async (bytes) => { await window.vm.writeFile("/tmp/pidcollide", new Uint8Array(bytes), { mode: 0o755 }); }, [...bin]);
log("staged pidcollide\n");

const step = async (label, cmd) => { log(`-- ${label}\n   cmd: ${cmd}`); log("   -> " + (await run(cmd)) + "\n"); };

await step("two plain sleeps backgrounded + wait (no posix_spawn, no real-fork-of-ELF)", "sleep 0.2 & sleep 0.3 & wait; echo DONE");
await step("two externals (dash applets) backgrounded + wait", "echo a & echo b & wait; echo DONE");
await step("two REAL FORK'd ELF binaries (dash itself, no posix_spawn) backgrounded + wait", "/bin/dash -c 'sleep 0.1' & /bin/dash -c 'sleep 0.1' & wait; echo DONE");
await step("two posix_spawn again, for comparison", "/tmp/pidcollide & /tmp/pidcollide & wait; echo DONE");
await step("still alive after the hang?", "echo alive");

await b.close(); server.kill(); process.exit(0);
