// Top-level driver: spawns the root busybox worker, runs a command, prints output.
const wasmBytes = new Uint8Array(await Bun.file(new URL("../busybox.wasm", import.meta.url)).arrayBuffer());

const root = new Worker(new URL("./process-worker.ts", import.meta.url).href, { type: "module" });

root.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "stdout") process.stdout.write(msg.text);
  if (msg.type === "stderr") process.stderr.write(msg.text);
  if (msg.type === "exited") {
    console.log(`\n[root exited with code ${msg.exitCode}]`);
  }
};

root.postMessage({ type: "init", pid: 1, wasmBytes, files: {} });

await new Promise((r) => setTimeout(r, 300)); // let init settle

console.log("=== sh -c 'ls /' ===");
root.postMessage({ type: "exec", argv: ["sh", "-c", "ls /"] });
await new Promise((r) => setTimeout(r, 1500));

console.log("\n=== sh -c 'echo hello world | grep world' (fresh worker) ===");
const root2 = new Worker(new URL("./process-worker.ts", import.meta.url).href, { type: "module" });
root2.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "stdout") process.stdout.write(msg.text);
  if (msg.type === "stderr") process.stderr.write(msg.text);
  if (msg.type === "exited") console.log(`\n[root2 exited with code ${msg.exitCode}]`);
};
root2.postMessage({ type: "init", pid: 2, wasmBytes, files: {} });
await new Promise((r) => setTimeout(r, 300));
root2.postMessage({ type: "exec", argv: ["sh", "-c", "echo hello world | grep world"] });
await new Promise((r) => setTimeout(r, 1500));

console.log("\n=== sh -c 'printf foo\\\\nbar\\\\n | grep bar' (fresh worker, distinguishing test) ===");
const root3 = new Worker(new URL("./process-worker.ts", import.meta.url).href, { type: "module" });
root3.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "stdout") process.stdout.write(msg.text);
  if (msg.type === "stderr") process.stderr.write(msg.text);
  if (msg.type === "exited") console.log(`\n[root3 exited with code ${msg.exitCode}]`);
};
root3.postMessage({
  type: "init",
  pid: 3,
  wasmBytes,
  files: { "/tmp/test.txt": new TextEncoder().encode("foo\nbar\nbaz\n") },
});
await new Promise((r) => setTimeout(r, 300));
root3.postMessage({ type: "exec", argv: ["sh", "-c", "cat /tmp/test.txt | grep bar"] });
await new Promise((r) => setTimeout(r, 1500));

console.log("\n=== done, exiting ===");
process.exit(0);
