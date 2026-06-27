// Real end-to-end test: real "init" -> real "sh -c" exec, driven entirely
// through WASM's vfork/exec/waitpid (no test hooks, no bypasses).
// Validates the worker-pool fix against the actual production code path.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (msg) => console.log("[console]", msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err));

await page.goto("http://localhost:8769/blank.html");

const result = await page.evaluate(async () => {
  const wasmBytes = await fetch("/busybox.wasm").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
  const logs = [];
  const bc = new BroadcastChannel("busybox-debug");
  bc.onmessage = (ev) => logs.push("[bc] " + ev.data);

  const root = new Worker("/scripts/process-worker.bundle.js", { type: "module" });
  root.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "stdout") logs.push("[stdout] " + JSON.stringify(m.text));
    else if (m.type === "stderr") logs.push("[stderr] " + JSON.stringify(m.text));
    else if (m.type === "exited") logs.push(`[exited code=${m.exitCode}]`);
    else if (m.type === "ready") logs.push("[ready]");
  };
  root.onerror = (e) => logs.push("[root error] " + e.message);

  root.postMessage({ type: "init", pid: 1, wasmBytes, files: { "/tmp/test.txt": new TextEncoder().encode("foo\nbar\nbaz\n") } });
  await new Promise((r) => setTimeout(r, 1000)); // let pool warm up

  logs.push("=== sh -c 'echo hi' (real vfork/exec/waitpid, no pipe) ===");
  root.postMessage({ type: "exec", argv: ["sh", "-c", "echo hi"] });
  await new Promise((r) => setTimeout(r, 2000));

  logs.push("=== sh -c 'cat /tmp/test.txt' (real vfork/exec/waitpid, no pipe) ===");
  root.postMessage({ type: "exec", argv: ["sh", "-c", "cat /tmp/test.txt"] });
  await new Promise((r) => setTimeout(r, 2000));

  logs.push("=== sh -c 'cat /tmp/test.txt | grep bar' (real pipe) ===");
  root.postMessage({ type: "exec", argv: ["sh", "-c", "cat /tmp/test.txt | grep bar"] });
  await new Promise((r) => setTimeout(r, 2500));

  logs.push("=== sh -c 'cat /tmp/test.txt | grep bar' AGAIN (regression check: optind reentrancy after a real vfork pipe) ===");
  root.postMessage({ type: "exec", argv: ["sh", "-c", "cat /tmp/test.txt | grep bar"] });
  await new Promise((r) => setTimeout(r, 2500));

  logs.push("=== done ===");
  return logs;
});

console.log(result.join("\n"));
await browser.close();
