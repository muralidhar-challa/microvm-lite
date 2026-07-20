// Verify the api.vm/done.vm DNS fix against the LIVE CDN: register a vm
// endpoint, seed vmRoutes with the same keys the host integration hook now uses, and
// confirm a guest-side request to http://api.vm/<path> actually reaches it —
// the exact round trip `guestcli queries` needs (DNS -> connect -> proxy_request).
import { chromium } from "playwright";
import { spawn } from "child_process";

const PORT = 8813;
const CDN = "https://cdn.example.com/microvm/test";
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.on("pageerror", (e) => log("  [pageerror] " + e.message.slice(0, 300)));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });

// window.registerVmEndpoint only exists after __startVM's promise resolves
// (vm-host.js sets it partway through _doStartVM, past several awaits) — it
// must be called AFTER, not before. Registration itself just has to land
// before the guest issues its request, which happens later via vm.execute.
await p.evaluate(async (cdnBase) => {
  const src = await (await fetch(cdnBase + "/vm-worker.js")).text();
  const workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  await window.__startVM({
    baseEtag: "vmroutes-live-" + Date.now(),
    cdnBase, workerUrl,
    vmRoutes: { "api.vm": "unused", "done.vm": "unused" },
  });
  window.registerVmEndpoint("/ListQueries", async () => ({ success: true, data: ["query-A", "query-B"] }));
}, CDN);
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log("VM booted with api.vm/done.vm seeded in vmRoutes\n");

const run = async (x, ms = 20000) => { try { return String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms])).trim(); } catch (e) { return "<<ERR: " + e.message.slice(0, 150) + ">>"; } };

log("== the exact user-reported command ==");
const out = await run(`guestcli queries --per-page 200 2>&1`);
log("  -> " + out.slice(0, 300));
const ok = out.includes("query-A") && out.includes("query-B") && !out.includes("Dns Failed");
log(ok ? "\nPASS — api.vm resolves and routes to the registered handler" : "\nFAIL — still broken");

await b.close(); server.kill();
process.exit(ok ? 0 : 1);
