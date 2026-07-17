// Run one command under `blink -L /blink.log [-s...]` and then dump the log,
// SEQUENTIALLY (concurrent execs wedge Asyncify). Usage:
//   bun test/diag-log.mjs [-s] <cmd> [args...]
import { chromium } from "playwright";

let args = process.argv.slice(2);
const straceFlags = [];
while (args[0] === "-s") { straceFlags.push(args.shift()); }
if (!args.length) { console.error("usage: diag-log.mjs [-s] <cmd> [args...]"); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
await page.waitForFunction(() => document.getElementById("statusEl").textContent === "ready", { timeout: 30000 });

async function exec(argv, raw) {
  return await page.evaluate(({ argv, raw }) => new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (ev) => {
      if (ev.data.type === "result" && ev.data.id === id) {
        worker.removeEventListener("message", handler);
        resolve(ev.data);
      }
      if (ev.data.type === "dbg") console.log("[dbg]", ev.data.text);
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: raw ? "exec_raw" : "exec", id, argv });
    setTimeout(() => resolve({ error: "TIMEOUT" }), 60000);
  }), { argv, raw });
}

const r1 = await exec([...straceFlags, "-L", "/blink.log", "/bin/" + args[0], ...args.slice(1)], true);
console.log(`── ${args.join(" ")}  exit=${r1.exitCode}${r1.error ? " error=" + r1.error : ""}`);
console.log(r1.output ?? "");
const r2 = await exec(["cat", "/blink.log"]);
console.log("── /blink.log ──");
console.log(r2.output ?? "(empty)");
await browser.close();
