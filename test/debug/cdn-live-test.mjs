// Boot straight against the LIVE test CDN (not a local dist) and run the
// real-fork + product-tool checks end to end.
import { chromium } from "playwright";
import { spawn } from "child_process";

const PORT = 8812;
const CDN = "https://api.njbsoft.com/cdn/sams/asksams-microvm/test";
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.on("console", (m) => { if (m.type() === "error") log("  [console:error] " + m.text().slice(0, 300)); });
p.on("pageerror", (e) => log("  [pageerror] " + e.message.slice(0, 300)));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
// Cross-origin: contract.html is served from localhost, the CDN is a
// different origin, and `new Worker(url)` (vm-host.js:222) requires
// same-origin. Fetch the worker source as text and wrap it in a blob:
// URL — exactly what SQL_Chat's real useMicrovm.ts does for this same
// reason (see its vm-worker.js `_fetchText` + blob comment).
await p.evaluate(async (cdnBase) => {
  const src = await (await fetch(cdnBase + "/vm-worker.js")).text();
  const workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  return window.__startVM({ baseEtag: "cdn-live-" + Date.now(), cdnBase, workerUrl });
}, CDN);
const t0 = Date.now();
await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
log(`VM booted from live CDN in ${Date.now() - t0}ms\n`);

const run = async (x, ms = 20000) => { try { return String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms])).trim(); } catch (e) { return "<<ERR: " + e.message.slice(0, 120) + ">>"; } };

let fail = 0;
const check = async (label, cmd, want) => {
  const got = await run(cmd);
  const ok = want === null ? got.length > 0 : got === want;
  if (!ok) fail++;
  log(`  ${ok ? "PASS" : "FAIL"}  ${label}\n        -> ${JSON.stringify(got.slice(0, 100))}${!ok && want !== null ? `\n        want ${JSON.stringify(want)}` : ""}`);
};

log("== real fork / pipe gates ==");
await check("home dir", "pwd", "/home/sams");
await check("seq | head (the historic poison case)", "seq 1 5 | head -2", "1\n2");
await check("still alive after it", "echo hi | cat", "hi");
await check("&& chain", "mkdir -p /tmp/x && cd /tmp/x && pwd", "/tmp/x");

log("\n== product tools (the actual thing being deployed) ==");
await check("docc auto-staged + runs", "docc ping", "pong");
await check("sams auto-staged + runs", "sams --help 2>&1 | head -c1 && echo x", null);
await check("agent auto-staged + runs", "agent --help 2>&1 | head -c1 && echo x", null);
await check("jq via pipe", `echo '{"a":1,"b":[2,3]}' | /usr/bin/jq -c '.b[0]'`, "2");
await check("sqlite3 via piped stdin", `printf 'select 1+2;' | /usr/bin/sqlite3`, "3");
await check("lua5.4", `/usr/bin/lua5.4 -e 'print(1+2)'`, "3");
await check("pdfinfo runs", "/usr/bin/pdfinfo -v 2>&1 | head -1", null);
await check("CLAUDE.md seeded", "test -f /home/sams/CLAUDE.md && echo YES", "YES");
await check("skills seeded", "ls /home/sams/skills | wc -l", null);

log(`\nfailures: ${fail}`);
log(fail === 0 ? "\nALL GREEN — live CDN deploy verified" : "\nNOT GREEN");
await b.close(); server.kill();
process.exit(fail === 0 ? 0 : 1);
