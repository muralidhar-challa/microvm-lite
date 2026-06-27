// Real end-to-end timing test. Records performance.now() when each exited
// message arrives rather than blocking the evaluate loop on Promises.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.error("[pageerror]", err));

await page.goto("http://localhost:8769/blank.html");

const result = await page.evaluate(async () => {
  const wasmBytes = await fetch("/busybox.wasm").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
  const logs = [];

  const root = new Worker("/scripts/process-worker.bundle.js", { type: "module" });

  const commands = [];
  let cmdIdx = 0;

  root.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "stdout") logs.push("[stdout] " + m.text.trimEnd());
    else if (m.type === "exited") {
      const cmd = commands[cmdIdx];
      if (cmd) {
        const ms = (performance.now() - cmd.t0).toFixed(1);
        logs.push(`[exited code=${m.exitCode}] [${ms} ms]  ← ${cmd.label}`);
      }
      cmdIdx++;
    }
  };
  root.onerror = (e) => logs.push("[root error] " + e.message);

  function send(label, argv) {
    commands.push({ label, t0: performance.now() });
    root.postMessage({ type: "exec", argv });
  }

  root.postMessage({ type: "init", pid: 1, wasmBytes, files: { "/tmp/test.txt": new TextEncoder().encode("foo\nbar\nbaz\n") } });
  await new Promise((r) => setTimeout(r, 300));

  // Warmup: trigger pool-worker spawning, then wait for WASM init (~1s)
  send("warmup echo", ["echo", "warmup"]);
  await new Promise((r) => setTimeout(r, 1500));

  // Timed commands — each given plenty of headroom
  send("echo hi (builtin, no fork)", ["echo", "hi"]);
  await new Promise((r) => setTimeout(r, 500));

  send("sh -c 'echo hi' (shell, no fork)", ["sh", "-c", "echo hi"]);
  await new Promise((r) => setTimeout(r, 500));

  send("sh -c 'cat /tmp/test.txt' (fork+exec)", ["sh", "-c", "cat /tmp/test.txt"]);
  await new Promise((r) => setTimeout(r, 2000));

  send("sh -c 'cat | grep bar' (pipe, 1st)", ["sh", "-c", "cat /tmp/test.txt | grep bar"]);
  await new Promise((r) => setTimeout(r, 2500));

  send("sh -c 'cat | grep bar' (pipe, 2nd)", ["sh", "-c", "cat /tmp/test.txt | grep bar"]);
  await new Promise((r) => setTimeout(r, 2500));

  logs.push("\n=== done ===");
  return logs;
});

console.log(result.join("\n"));
await browser.close();
