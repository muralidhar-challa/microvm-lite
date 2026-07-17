// Quick smoke of newly staged binaries/seeds (no poppler needed).
// Usage: bun microvm/test/quick-test.mjs '["ls","/workspace"]' ...

import { chromium } from "playwright";

const commands = process.argv.slice(2).map((s) => JSON.parse(s));
if (!commands.length) {
  commands.push(["ls", "-la", "/workspace"], ["probe", "out"]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
await page.waitForFunction(
  () => document.getElementById("statusEl").textContent === "ready",
  { timeout: 30000 },
);

for (const argv of commands) {
  const t0 = Date.now();
  const r = await page.evaluate((argv) => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        if (ev.data.type === "result" && ev.data.id === id) {
          worker.removeEventListener("message", handler);
          resolve(ev.data);
        }
        if (ev.data.type === "dbg") console.log("[dbg]", ev.data.text);
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "exec", id, argv });
      setTimeout(() => resolve({ error: "TIMEOUT" }), 20000);
    });
  }, argv);
  console.log(`$ ${argv.join(" ")}   (${Date.now() - t0} ms, exit=${r.exitCode})${r.error ? "  error=" + r.error : ""}`);
  console.log((r.output ?? "").trimEnd().split("\n").map((l) => "  " + l).join("\n"));
}
await browser.close();
