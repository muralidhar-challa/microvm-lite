// Isolate pipe parsing: stub workerFork/workerSpawn/workerWaitpid to just log
// what hush tries to exec, without any real worker/forking involved.
let memory: WebAssembly.Memory;

function readCStr(ptr: number): string {
  if (!ptr) return "";
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}
function readArgv(ptr: number): string[] {
  const args: string[] = [];
  const view = new DataView(memory.buffer);
  let i = 0;
  while (true) {
    const argPtr = view.getUint32(ptr + i * 4, true);
    if (argPtr === 0) break;
    args.push(readCStr(argPtr));
    i++;
  }
  return args;
}

let fakePidCounter = 1000;
(globalThis as any).workerFork = function () {
  const pid = fakePidCounter++;
  console.log("[workerFork] ->", pid);
  return pid;
};
(globalThis as any).workerSpawn = function (filePtr: number, argvPtr: number) {
  console.log("[workerSpawn] file:", JSON.stringify(readCStr(filePtr)), "argv:", JSON.stringify(readArgv(argvPtr)));
  return 38; // ENOSYS — pretend exec always fails, we just want to see what it tried
};
(globalThis as any).workerWaitpid = function (pid: number) {
  console.log("[workerWaitpid]", pid);
  return -1;
};
(globalThis as any).workerUnfork = function (status: number) {
  console.log("[workerUnfork]", status);
};

const factoryMod = await import("../busybox.js");
const factory = factoryMod.default;
const mod = await factory({
  noInitialRun: true,
  noExitRuntime: true,
  thisProgram: "busybox",
  print: (t: string) => console.log("[stdout]", t),
  printErr: (t: string) => console.log("[stderr]", t),
  async instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
    const wasmBytes = new Uint8Array(await Bun.file(new URL("../busybox.wasm", import.meta.url)).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    memory = (Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) as WebAssembly.Memory)
      ?? (imports.env?.memory as WebAssembly.Memory);
    cb(instance);
    return instance.exports;
  },
});

mod.FS.writeFile("/tmp/test.txt", new TextEncoder().encode("foo\nbar\nbaz\n"));

console.log("=== sh -c 'cat /tmp/test.txt' (no pipe, first) ===");
try { mod.callMain(["sh", "-c", "cat /tmp/test.txt"]); } catch (e) { console.log("callMain threw:", String(e)); }

console.log("=== sh -c 'cat /tmp/test.txt | grep bar' (pipe, second, same mod instance) ===");
try { mod.callMain(["sh", "-c", "cat /tmp/test.txt | grep bar"]); } catch (e) { console.log("callMain threw:", String(e)); }
