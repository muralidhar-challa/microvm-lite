// Diagnostic: run one command under blink strace (-s) and dump blink.log.
// Usage: bun test/strace-test.mjs probe out

import { chromium } from "playwright";

const target = process.argv.slice(2);
if (!target.length) {
  console.error("usage: strace-test.mjs <cmd> [args...]");
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
await page.waitForFunction(
  () => document.getElementById("statusEl").textContent === "ready",
  { timeout: 15000 },
);

// Run the target with strace enabled. worker.js prefixes "/bin/" to argv[0],
// so pass blink flags via a raw-argv escape: exec_raw runs argv verbatim.
const result = await page.evaluate((target) => {
  return new Promise((resolve) => {
    const id = 1;
    const results = [];
    const handler = (ev) => {
      if (ev.data.type === "result") {
        results.push(ev.data);
        if (results.length === 2) {
          worker.removeEventListener("message", handler);
          resolve(results);
        }
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "exec_raw", id: 1, argv: ["-s", "-s", "-s", "/bin/" + target[0], ...target.slice(1)] });
    worker.postMessage({ type: "exec", id: 2, argv: ["cat", "/blink.log"] });
    setTimeout(() => resolve(results.concat([{ output: null, error: "TIMEOUT" }])), 15000);
  });
}, target);

for (const r of result) {
  console.log("── result id", r.id, "exit:", r.exitCode, r.error ? "error: " + r.error : "");
  console.log(r.output ?? "(null)");
}
await browser.close();
