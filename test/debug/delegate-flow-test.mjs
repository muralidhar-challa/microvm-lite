// Runs the EXACT sequence system.md's Init() + Delegate() specify, against
// the LIVE product CDN — the real binaries, the real procedure, verbatim.
// Answers: does orchestrator -> subagent delegation actually work now?
import { chromium } from "playwright";
import { spawn } from "child_process";

const PORT = 8822;
const CDN = "https://api.njbsoft.com/cdn/sams/asksams-microvm/test";
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
p.setDefaultTimeout(90000);
p.on("pageerror", (e) => log("  [pageerror] " + e.message.slice(0, 200)));
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined);
await p.evaluate(async (cdnBase) => {
  const src = await (await fetch(cdnBase + "/vm-worker.js")).text();
  const workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  return window.__startVM({ baseEtag: "delegate-flow-" + Date.now(), cdnBase, workerUrl });
}, CDN);
await p.waitForFunction(() => window.vm && window.vm.isReady === true);
log("VM booted\n");

const run = async (x, ms = 20000) => { try { return String(await p.evaluate(([q, t]) => window.vm.execute(q, t), [x, ms])).trim(); } catch (e) { return "<<TIMEOUT/ERR: " + e.message.slice(0, 150) + ">>"; } };

log("== Init() verbatim ==");
log("  " + await run("[ -f /tmp/.mvl_boot ] || { uuidgen > /home/sams/.session_id; : > /tmp/.mvl_boot; }"));
const sessionId = await run("cat /home/sams/.session_id");
log("  session_id: " + sessionId);
const workdir = `/tmp/sams_${sessionId}`;
log("  " + await run(`mkdir -p ${workdir}`));
log("  workdir: " + workdir);

log("\n== Delegate() verbatim (task 1) ==");
const task = "Run: echo hello-from-subagent";
await run(`cat > ${workdir}/task_1.txt << 'EOF'\n${task}\nEOF`);
log("  task file written");

log("  running: agent --thread " + sessionId + " < task_1.txt (foreground, 60s cap)");
const t0 = Date.now();
const out = await run(
  `agent --thread ${sessionId} < ${workdir}/task_1.txt > ${workdir}/agent_out_1.log 2> ${workdir}/agent_err_1.log; echo EXIT:$?`,
  60000
);
log(`  finished in ${Date.now() - t0}ms: ${out}`);
log("  stdout: " + (await run(`cat ${workdir}/agent_out_1.log`)).slice(0, 400));
log("  stderr: " + (await run(`cat ${workdir}/agent_err_1.log`)).slice(0, 400));

log("\n== is the VM still healthy after? ==");
log("  " + await run("echo alive"));

await b.close(); server.kill(); process.exit(0);
