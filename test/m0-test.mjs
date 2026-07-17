// M0 gate test: boots the worker test page in headless chromium and runs a set
// of commands through the worker protocol, printing output + exit code + timing.
//
// Each command gets a FRESH page/worker so a guest hang can't cascade into the
// commands after it (the wasm interpreter blocks the whole worker while stuck).
//
// Usage:  bun test/m0-test.mjs   (or node)
// Expects the static server to be running:  cd ./test && python3 -m http.server 8765

import { chromium } from "playwright";

const COMMANDS = [
  ["echo", "hello from blink"],
  ["ls", "/bin"],
  ["probe", "err"],
  ["probe", "exit3"],
  ["probe", "out"],
  ["probe", "raw"],
  ["probe", "args", "x"],
  ["probe", "hash"],
  ["xtool"],
  ["xtool", "ping"],
];

const browser = await chromium.launch();

for (const argv of COMMANDS) {
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [console.${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto("http://localhost:8765/index.html?ts=" + Date.now());
  await page.waitForFunction(
    () => document.getElementById("statusEl").textContent === "ready",
    { timeout: 15000 },
  );

  const t0 = Date.now();
  const result = await page.evaluate((argv) => {
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        if (ev.data.type === "result" && ev.data.id === id) {
          worker.removeEventListener("message", handler);
          resolve({ output: ev.data.output, error: ev.data.error, exitCode: ev.data.exitCode });
        }
        if (ev.data.type === "dbg") console.log("[worker dbg]", ev.data.text);
      };
      worker.addEventListener("message", handler);
      worker.postMessage({ type: "exec", id, argv });
      setTimeout(() => resolve({ output: null, error: "TEST TIMEOUT (8s)", exitCode: null }), 8000);
    });
  }, argv);
  const ms = Date.now() - t0;

  console.log(`$ ${argv.join(" ")}   (${ms} ms, exit=${result.exitCode})`);
  if (result.error) console.log(`  [error] ${result.error}`);
  const out = (result.output ?? "").trimEnd();
  console.log(out ? out.split("\n").map((l) => "  " + l).join("\n") : "  (no output)");
  console.log();
  await page.close();
}

await browser.close();
