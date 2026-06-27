// Distinguish: is corruption specific to vfork happening first, or does ANY
// repeated callMain() on the same instance break pipe parsing?
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
(globalThis as any).workerFork = function () { const pid = fakePidCounter++; console.log("[workerFork] ->", pid); return pid; };
(globalThis as any).workerSpawn = function (filePtr: number, argvPtr: number) {
  console.log("[workerSpawn] file:", JSON.stringify(readCStr(filePtr)), "argv:", JSON.stringify(readArgv(argvPtr)));
  return 38;
};
(globalThis as any).workerWaitpid = function (pid: number) { console.log("[workerWaitpid]", pid); return -1; };
(globalThis as any).workerUnfork = function (status: number) { console.log("[workerUnfork]", status); };

async function freshMod() {
  const factoryMod = await import("../busybox.js");
  const factory = factoryMod.default;
  return await factory({
    noInitialRun: true,
    noExitRuntime: true,
    thisProgram: "busybox",
    print: (t: string) => console.log("[stdout]", t),
    printErr: (t: string) => console.log("[stderr]", t),
    async instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
      const wasmBytes = await Deno.readFile(new URL("../busybox.wasm", import.meta.url));
      const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
      memory = (Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) as WebAssembly.Memory)
        ?? (imports.env?.memory as WebAssembly.Memory);
      cb(instance);
      return instance.exports;
    },
  });
}

console.log("\n### TEST C: piped command run twice in a row, WITH em_reset_getopt() before each callMain ###");
{
  const mod = await freshMod();
  mod.FS.writeFile("/tmp/test.txt", new TextEncoder().encode("foo\nbar\nbaz\n"));
  console.log("--- run 1: piped command (with reset) ---");
  mod._em_reset_getopt();
  try { mod.callMain(["sh", "-c", "cat /tmp/test.txt | grep bar"]); } catch (e) { console.log("threw:", String(e)); }
  console.log("--- run 2: piped command again (with reset) ---");
  mod._em_reset_getopt();
  try { mod.callMain(["sh", "-c", "cat /tmp/test.txt | grep bar"]); } catch (e) { console.log("threw:", String(e)); }
}
