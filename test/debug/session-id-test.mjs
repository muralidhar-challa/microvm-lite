// Verifies the system.md Init() fix: same session_id across multiple turns
// within one boot, but a fresh one after a reboot (page reload) — using the
// SAME baseEtag so IDB snapshot restore actually kicks in (persists HOME,
// not /tmp), matching the real persistence boundary the fix relies on.
import { chromium } from "playwright";
import { spawn } from "child_process";
const PORT = 8821;
const ETAG = "session-id-fixed-v1"; // fixed, not Date.now() — must persist across "reboots"
const log = (s) => process.stdout.write(s + "\n");
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
async function w(u, t = 60) { for (let i = 0; i < t; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); } throw new Error("no server"); }
await w(`http://localhost:${PORT}/test/contract.html`);

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`http://localhost:${PORT}/test/contract.html`);
await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });

const INIT_CMD = "[ -f /tmp/.mvl_boot ] || { uuidgen > /home/sams/.session_id; : > /tmp/.mvl_boot; }";

async function bootAndInit() {
  await p.evaluate((etag) => window.__startVM({ baseEtag: etag, cdnBase: "/product-dist", workerUrl: "/src/vm-worker.js" }), ETAG);
  await p.waitForFunction(() => window.vm && window.vm.isReady === true, { timeout: 60000 });
  const run = async (x) => String(await p.evaluate(q => window.vm.execute(q, 10000), x)).trim();
  await run(INIT_CMD);
  return (await run("cat /home/sams/.session_id")).trim();
}

async function reboot() {
  // resetToFresh tears down the worker and reboots — but ALSO wipes the IDB
  // snapshot (real "start over"), which isn't what we want (that would wipe
  // .session_id too, masking the bug either way). Instead: terminate the
  // worker directly and re-run __startVM with the SAME etag, so it restores
  // from the snapshot __startVM itself will have saved (fs_dirty→_saveSnapshot)
  // — simulating a genuine page reload, not a hard reset.
  await p.evaluate(async () => {
    await new Promise((resolve) => {
      window.vm.execute("true", 2000).then(() => {
        // force a save by simulating page hide, matching the real trigger
        document.dispatchEvent(new Event("visibilitychange"));
        setTimeout(resolve, 500);
      });
    });
  });
  await p.reload();
  await p.waitForFunction(() => window.__startVM !== undefined, { timeout: 15000 });
}

log("== turn 1 (fresh boot) ==");
const id1 = await bootAndInit();
log("session_id: " + id1);

log("\n== turn 2, SAME boot (no reload) — must be identical ==");
const run2 = async (x) => String(await p.evaluate(q => window.vm.execute(q, 10000), x)).trim();
await run2(INIT_CMD);
const id2 = (await run2("cat /home/sams/.session_id")).trim();
log("session_id: " + id2 + (id2 === id1 ? "  [MATCH, correct]" : "  [MISMATCH, BUG]"));

log("\n== simulated reboot (page reload, same IDB snapshot lineage) ==");
await reboot();
const id3 = await bootAndInit();
log("session_id: " + id3 + (id3 !== id1 ? "  [DIFFERENT, correct — fresh session after reboot]" : "  [SAME, BUG — staleness not fixed]"));

const ok = id1 === id2 && id3 !== id1;
log("\n" + (ok ? "ALL GREEN — same-boot stable, cross-boot fresh" : "FAIL"));
await b.close(); server.kill(); process.exit(ok ? 0 : 1);
