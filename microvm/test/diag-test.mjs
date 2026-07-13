// Batch diagnostic on a SINGLE page/worker instance, in order:
//   1. echo A            — baseline
//   2. echo B            — repeated callMain on same module instance
//   3. ls /nonexistent   — does fd2 (stderr) capture work? nonzero exit code?
//   4. probe out         — Rust binary
//   5. echo C            — did the Rust run poison the module?
//   6. -s -s probe out   — strace'd Rust run (exec_raw with blink flags)
//   7. cat /blink.log    — dump strace output
//   8. ls /              — where did blink.log actually land?

import { chromium } from "playwright";

const STEPS = [
  { type: "exec", argv: ["echo", "A"] },
  { type: "exec", argv: ["echo", "B"] },
  { type: "exec", argv: ["ls", "/nonexistent"] },
  { type: "exec", argv: ["probe", "out"] },
  { type: "exec", argv: ["echo", "C"] },
  { type: "exec_raw", argv: ["-s", "-s", "/bin/probe", "out"] },
  { type: "exec", argv: ["cat", "/blink.log"] },
  { type: "exec", argv: ["ls", "-la", "/"] },
];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
await page.waitForFunction(
  () => document.getElementById("statusEl").textContent === "ready",
  { timeout: 15000 },
);

for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i];
  const r = await page.evaluate((step) => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        if (ev.data.type === "result" && ev.data.id === id) {
          worker.removeEventListener("message", handler);
          resolve(ev.data);
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: step.type, id, argv: step.argv });
      setTimeout(() => resolve({ error: "TIMEOUT" }), 8000);
    });
  }, step);
  console.log(`── [${i + 1}] ${step.type} ${step.argv.join(" ")}   exit=${r.exitCode}${r.error ? "  error=" + r.error : ""}`);
  const out = (r.output ?? "").trimEnd();
  if (out) console.log(out.split("\n").map((l) => "   " + l).join("\n"));
  if (r.error === "TIMEOUT") break;
}

await browser.close();
