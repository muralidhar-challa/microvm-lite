import { chromium } from "playwright";
import { spawn } from "child_process";
const PORT = 8816;
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
await p.evaluate(() => window.__startVM({ baseEtag: "uuid-" + Date.now(), cdnBase: "/dist", workerUrl: "/src/vm-worker.js" }));
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
const run = async (x) => String(await p.evaluate(q => window.vm.execute(q, 10000), x)).trim();
log("uuidgen (1): " + await run("uuidgen"));
log("uuidgen (2): " + await run("uuidgen"));
log("cat /dev/urandom | head -c8 | od -An -tx1: " + await run("cat /dev/urandom 2>&1 | head -c8 | od -An -tx1 2>&1"));
await b.close(); server.kill(); process.exit(0);
