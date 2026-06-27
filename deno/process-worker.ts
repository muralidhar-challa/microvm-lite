// One busybox "process" per Worker instance.
// Implements the workerFork/workerSpawn/workerWaitpid/workerUnfork globals that
// busybox.js's compiled-in em-shell.js library checks for at runtime
// (see: `if (typeof workerFork !== 'undefined') return workerFork();`).
//
// Real fork = spawn a new Worker running this same script.
// Real exec = postMessage the applet+args to that worker (fire-and-forget).
// Real wait = Atomics.wait on a SharedArrayBuffer until the worker reports an exit code.

const EVAL_MARKER = Math.random().toString(36).slice(2);

const debugBC = new BroadcastChannel("busybox-debug");

function dbg(...args: unknown[]) {
  const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.error(text);
  const full = `[marker ${EVAL_MARKER}] ${text}`;
  try { (self as any).postMessage({ type: "dbg", text: full }); } catch (_e) { /* ignore */ }
  try { debugBC.postMessage(full); } catch (_e) { /* ignore */ }
}

(self as any).onerror = (e: ErrorEvent) => {
  dbg("UNCAUGHT ERROR:", e.message, e.filename, e.lineno);
};
(self as any).onunhandledrejection = (e: PromiseRejectionEvent) => {
  dbg("UNHANDLED REJECTION:", String(e.reason));
};

dbg("module evaluated, marker:", EVAL_MARKER);

let mod: any;
let memory: WebAssembly.Memory;
let myPid = 0;

let pidCounter = 1000;
const children = new Map<number, { worker: Worker; ctrl: Int32Array }>();
let lastForkedPid: number | null = null;

function ensureDir(fs: any, path: string) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts.slice(0, -1)) {
    cur += "/" + p;
    try { fs.mkdir(cur); } catch (_e) { /* exists */ }
  }
}

// Emscripten --js-library functions get raw WASM pointers, not decoded JS values.
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

// ── Pipe ring buffers (SharedArrayBuffer-backed, real cross-worker streaming) ──
//
// ctrl layout (Int32Array, shared): [0]=writeIdx [1]=readIdx [2]=count [3]=writersOpen [4]=readersOpen

const PIPE_CAP = 65536;
let pipeIdCounter = 20000;
type PipeHandle = { ctrl: Int32Array; data: Uint8Array; role: "r" | "w" };
const pipes = new Map<number, PipeHandle>();
let pendingRedirects = { stdin: -1, stdout: -1, stderr: -1 };

function pipeWriteBytes(p: PipeHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) {
    let count = Atomics.load(p.ctrl, 2);
    while (count >= PIPE_CAP) {
      Atomics.wait(p.ctrl, 2, count);
      count = Atomics.load(p.ctrl, 2);
    }
    const avail = PIPE_CAP - count;
    const n = Math.min(avail, bytes.length - offset);
    const widx = Atomics.load(p.ctrl, 0);
    for (let i = 0; i < n; i++) p.data[(widx + i) % PIPE_CAP] = bytes[offset + i];
    Atomics.store(p.ctrl, 0, (widx + n) % PIPE_CAP);
    Atomics.add(p.ctrl, 2, n);
    Atomics.notify(p.ctrl, 2);
    offset += n;
  }
}

function pipeReadByte(p: PipeHandle): number | null {
  let count = Atomics.load(p.ctrl, 2);
  while (count === 0) {
    if (Atomics.load(p.ctrl, 3) <= 0) return null; // no writers left — EOF
    Atomics.wait(p.ctrl, 2, 0);
    count = Atomics.load(p.ctrl, 2);
  }
  const ridx = Atomics.load(p.ctrl, 1);
  const byte = p.data[ridx];
  Atomics.store(p.ctrl, 1, (ridx + 1) % PIPE_CAP);
  Atomics.sub(p.ctrl, 2, 1);
  Atomics.notify(p.ctrl, 2);
  return byte;
}

(globalThis as any).workerPipe = function (fdsPtr: number): void {
  const ctrl = new Int32Array(new SharedArrayBuffer(5 * 4));
  const data = new Uint8Array(new SharedArrayBuffer(PIPE_CAP));
  Atomics.store(ctrl, 3, 1); // writersOpen = 1 (creator)
  Atomics.store(ctrl, 4, 1); // readersOpen = 1 (creator)

  const readVfd = pipeIdCounter++;
  const writeVfd = pipeIdCounter++;
  pipes.set(readVfd, { ctrl, data, role: "r" });
  pipes.set(writeVfd, { ctrl, data, role: "w" });

  const view = new DataView(memory.buffer);
  view.setInt32(fdsPtr, readVfd, true);
  view.setInt32(fdsPtr + 4, writeVfd, true);
  dbg("[DEBUG] workerPipe ->", readVfd, writeVfd, "marker:", EVAL_MARKER, "pipes.size now:", pipes.size);
};

(globalThis as any).workerSetRedirects = function (stdinVfd: number, stdoutVfd: number, stderrVfd: number): void {
  dbg("[DEBUG] workerSetRedirects", stdinVfd, stdoutVfd, stderrVfd, "pipes.size:", pipes.size);
  pendingRedirects = { stdin: stdinVfd, stdout: stdoutVfd, stderr: stderrVfd };
  dbg("[DEBUG] workerSetRedirects done, pipes.size:", pipes.size);
};

(globalThis as any).workerPipeClose = function (vfd: number): void {
  const p = pipes.get(vfd);
  if (!p) return;
  if (p.role === "w") {
    const left = Atomics.sub(p.ctrl, 3, 1) - 1;
    if (left <= 0) Atomics.notify(p.ctrl, 2);
  } else {
    Atomics.sub(p.ctrl, 4, 1);
  }
  pipes.delete(vfd);
};

// ── Worker pool ────────────────────────────────────────────────────────────
//
// Chromium will not start a freshly-constructed Worker's module script if the
// creating thread synchronously blocks (Atomics.wait) before yielding back to
// its own event loop even once. busybox's vfork()->execvp()->waitpid() is one
// synchronous C call chain with no JS-visible yield point (no Asyncify), so a
// worker constructed *at fork time* and then immediately waited on deadlocks.
//
// Fix: pre-spawn idle workers ahead of time (while nothing is blocking), and
// have workerFork() *claim* an already-running one instead of constructing
// fresh. Claiming + postMessage to an already-alive worker doesn't need the
// claiming thread's event loop to do anything further, so the subsequent
// zero-yield Atomics.wait is safe.

const POOL_TARGET = 2;
type PoolEntry = { pid: number; worker: Worker; ready: boolean };
const pool: PoolEntry[] = [];

function spawnPoolWorker() {
  const pid = pidCounter++;
  const worker = new Worker(import.meta.url, { type: "module" });
  const entry: PoolEntry = { pid, worker, ready: false };
  worker.onmessage = (ev) => {
    if (ev.data.type === "ready") entry.ready = true;
    else if (ev.data.type === "stdout" || ev.data.type === "stderr" || ev.data.type === "dbg") {
      (self as any).postMessage(ev.data);
    }
  };
  worker.onerror = (e: ErrorEvent) => dbg("[POOL] worker error:", e.message, e.filename, String(e.lineno));
  worker.postMessage({ type: "init", pid, wasmBytes: cachedWasmBytes, files: {} });
  pool.push(entry);
}

function refillPool() {
  while (pool.length < POOL_TARGET) spawnPoolWorker();
}

function claimPoolWorker(): PoolEntry | null {
  const idx = pool.findIndex((e) => e.ready);
  const entry = idx >= 0 ? pool.splice(idx, 1)[0] : pool.length > 0 ? pool.shift()! : null;
  if (entry) refillPool(); // background refill, fire-and-forget
  return entry;
}

// ── em-shell.js extension points (must be real globals — busybox.js checks `typeof X !== 'undefined'`) ──

(globalThis as any).workerFork = function (): number {
  dbg("[DEBUG] workerFork called, pool.length:", pool.length);
  try {
    let pid: number;
    let worker: Worker;
    const claimed = claimPoolWorker();
    if (claimed) {
      pid = claimed.pid;
      worker = claimed.worker;
      dbg("[DEBUG] workerFork: claimed pooled worker pid", pid);
    } else {
      // Cold-start fallback (pool not warmed up yet) — may race the startup
      // deadlock if immediately followed by a blocking wait, but only hit
      // before the pool has had a chance to fill.
      pid = pidCounter++;
      worker = new Worker(import.meta.url, { type: "module" });
      worker.postMessage({ type: "init", pid, wasmBytes: cachedWasmBytes, files: {} });
      dbg("[DEBUG] workerFork: pool empty, cold-spawned pid", pid);
    }

    const sab = new SharedArrayBuffer(8); // [0]=state(0=running,1=done) [1]=exit status (Linux-encoded)
    const ctrl = new Int32Array(sab);

    worker.onmessage = (ev) => {
      if (ev.data.type === "stdout" || ev.data.type === "stderr" || ev.data.type === "dbg") {
        (self as any).postMessage(ev.data);
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      dbg("[DEBUG] CHILD WORKER ERROR:", e.message, e.filename, e.lineno);
    };

    // Pooled workers were pre-warmed with an empty FS snapshot — sync the
    // parent's current files now (cheap postMessage, no new worker startup).
    worker.postMessage({ type: "sync-files", files: snapshotFiles() });

    children.set(pid, { worker, ctrl });
    lastForkedPid = pid;
    dbg("[DEBUG] workerFork returning, pid:", pid);
    return pid;
  } catch (e) {
    dbg("[DEBUG] workerFork THREW:", String(e));
    return -1;
  }
};

(globalThis as any).workerSpawn = function (filePtr: number, argvPtr: number): number {
  dbg("[DEBUG] workerSpawn ENTRY, pipes.size:", pipes.size);
  try {
    const file = readCStr(filePtr);
    const argv = readArgv(argvPtr);
    dbg("[DEBUG] workerSpawn", file, argv);
    if (lastForkedPid == null) { dbg("[DEBUG] no lastForkedPid"); return 38; }
    const entry = children.get(lastForkedPid)!;
    const sab = entry.ctrl.buffer as SharedArrayBuffer;

    dbg("[DEBUG] pendingRedirects at spawn time:", JSON.stringify(pendingRedirects), "marker:", EVAL_MARKER, "pipes keys:", [...pipes.keys()]);
    const redirects: Record<string, { ctrlBuf: SharedArrayBuffer; dataBuf: SharedArrayBuffer; role: "r" | "w" }> = {};
    for (const [slot, vfd] of Object.entries(pendingRedirects)) {
      if (vfd < 0) continue;
      const p = pipes.get(vfd);
      if (!p) { dbg("[DEBUG] no pipe found for vfd", vfd); continue; }
      // hand off: the spawned child becomes a new holder of this pipe end
      Atomics.add(p.ctrl, p.role === "w" ? 3 : 4, 1);
      redirects[slot] = { ctrlBuf: p.ctrl.buffer as SharedArrayBuffer, dataBuf: p.data.buffer as SharedArrayBuffer, role: p.role };
    }
    dbg("[DEBUG] redirects built:", Object.keys(redirects));
    pendingRedirects = { stdin: -1, stdout: -1, stderr: -1 };

    entry.worker.postMessage({ type: "exec", argv, sab, redirects });
    lastForkedPid = null;
    return 0;
  } catch (e) {
    dbg("[DEBUG] workerSpawn threw", e);
    return 38;
  }
};

(globalThis as any).workerWaitpid = function (pid: number, statusPtr: number, _options: number): number {
  dbg("[DEBUG] workerWaitpid", pid);
  // pid <= 0 means "wait for any child" (POSIX) — we only ever track one outstanding child here.
  let targetPid = pid;
  if (pid <= 0) {
    const keys = [...children.keys()];
    if (keys.length === 0) return -1;
    targetPid = keys[0];
  }
  const entry = children.get(targetPid);
  if (!entry) return -1;
  const { ctrl } = entry;
  while (Atomics.load(ctrl, 0) === 0) {
    Atomics.wait(ctrl, 0, 0);
  }
  const exitCode = Atomics.load(ctrl, 1);
  children.delete(targetPid);
  pid = targetPid;
  if (statusPtr) {
    const status = (exitCode & 0xff) << 8; // Linux WEXITSTATUS encoding
    new DataView(memory.buffer).setInt32(statusPtr, status, true);
  }
  return pid;
};

(globalThis as any).workerUnfork = function (status: number): void {
  // exec failed before the forked worker ever ran anything — report status directly, no-op worker.
  if (lastForkedPid == null) return;
  const entry = children.get(lastForkedPid);
  if (entry) {
    Atomics.store(entry.ctrl, 1, status);
    Atomics.store(entry.ctrl, 0, 1);
    Atomics.notify(entry.ctrl, 0);
    entry.worker.terminate();
    children.delete(lastForkedPid);
  }
  lastForkedPid = null;
};

// ── Module bootstrap ──────────────────────────────────────────────────────────

let cachedWasmBytes: Uint8Array;

function snapshotFiles(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  function walk(dir: string) {
    let entries: string[];
    try { entries = mod.FS.readdir(dir); } catch (_e) { return; }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const p = dir === "/" ? "/" + name : dir + "/" + name;
      let st;
      try { st = mod.FS.stat(p); } catch (_e) { continue; }
      if (mod.FS.isDir(st.mode)) walk(p);
      else {
        try { out[p] = mod.FS.readFile(p); } catch (_e) { /* skip */ }
      }
    }
  }
  if (mod) { walk("/tmp"); walk("/home"); walk("/root"); }
  return out;
}

let readyResolve: () => void;
const readyPromise = new Promise<void>((r) => { readyResolve = r; });

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;

  if (msg.type === "test-pool-fork-exec") {
    dbg("test-pool-fork-exec: pre-warming worker, waiting for it to be alive");
    try {
      cachedWasmBytes = msg.wasmBytes;
      const pid = pidCounter++;
      const worker = new Worker(import.meta.url, { type: "module" });
      const sab = new SharedArrayBuffer(8);
      const ctrl = new Int32Array(sab);
      let aliveResolve: () => void;
      const alive = new Promise<void>((r) => { aliveResolve = r; });
      worker.onmessage = (ev) => {
        if (ev.data.type === "dbg" || ev.data.type === "stdout" || ev.data.type === "stderr") (self as any).postMessage(ev.data);
        if (ev.data.type === "ready") aliveResolve();
      };
      worker.postMessage({ type: "init", pid, wasmBytes: cachedWasmBytes, files: {} });
      dbg("test-pool-fork-exec: waiting for child ready message (real await, event loop free)");
      await alive;
      children.set(pid, { worker, ctrl });
      lastForkedPid = pid;
      dbg("test-pool-fork-exec: child is alive and ready, NOW doing exec+wait with zero yield");
      worker.postMessage({ type: "exec", argv: ["echo", "hi-from-pool"], sab: ctrl.buffer });
      const status = (globalThis as any).workerWaitpid(pid, 0, 0);
      dbg("test-pool-fork-exec: workerWaitpid returned", status);
    } catch (e) {
      dbg("test-pool-fork-exec: threw:", String(e));
    }
    return;
  }

  if (msg.type === "test-full-fork-exec") {
    dbg("test-full-fork-exec: calling real workerFork()");
    try {
      cachedWasmBytes = msg.wasmBytes;
      const pid = (globalThis as any).workerFork();
      dbg("test-full-fork-exec: workerFork returned pid", pid);
      const entry = children.get(pid);
      if (!entry) { dbg("test-full-fork-exec: no entry for pid!"); return; }
      entry.worker.postMessage({ type: "exec", argv: ["echo", "hi-from-fork-exec"], sab: entry.ctrl.buffer });
      dbg("test-full-fork-exec: sent exec message, yielding before wait");
      await new Promise((r) => setTimeout(r, 50));
      dbg("test-full-fork-exec: now waiting via Atomics.wait");
      const status = (globalThis as any).workerWaitpid(pid, 0, 0);
      dbg("test-full-fork-exec: workerWaitpid returned", status);
    } catch (e) {
      dbg("test-full-fork-exec: threw:", String(e));
    }
    return;
  }

  if (msg.type === "test-nested-spawn") {
    dbg("test-nested-spawn: about to construct Worker(import.meta.url)");
    try {
      const w = new Worker(import.meta.url, { type: "module" });
      dbg("test-nested-spawn: constructed OK");
      w.onmessage = (e) => dbg("test-nested-spawn: child said:", JSON.stringify(e.data));
      w.onerror = (e) => dbg("test-nested-spawn: child error:", e.message, e.filename, String(e.lineno));
      w.addEventListener("messageerror", () => dbg("test-nested-spawn: messageerror"));
    } catch (e) {
      dbg("test-nested-spawn: threw:", String(e));
    }
    return;
  }

  if (msg.type === "init") {
    myPid = msg.pid;
    cachedWasmBytes = msg.wasmBytes;
    const factoryMod = await import("../busybox.js");
    const factory = factoryMod.default;
    mod = await factory({
      noInitialRun: true,
      noExitRuntime: true,
      thisProgram: "busybox",
      async instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
        const { instance } = await WebAssembly.instantiate(msg.wasmBytes, imports);
        memory = (Object.values(instance.exports).find((v) => v instanceof WebAssembly.Memory) as WebAssembly.Memory)
          ?? (imports.env?.memory as WebAssembly.Memory);
        cb(instance);
        return instance.exports;
      },
    });
    for (const [path, bytes] of Object.entries(msg.files ?? {})) {
      ensureDir(mod.FS, path);
      mod.FS.writeFile(path, bytes as Uint8Array);
    }
    readyResolve();
    (self as any).postMessage({ type: "ready", pid: myPid });
    // Deliberately NOT refilling this worker's own pool here: idle pool
    // spares that are never claimed must stay leaf nodes, or every spare
    // recursively grows its own spares forever (exponential worker blow-up).
    // Pool refill only happens once a worker actually runs a command (below).
    return;
  }

  if (msg.type === "sync-files") {
    await readyPromise;
    for (const [path, bytes] of Object.entries(msg.files ?? {})) {
      ensureDir(mod.FS, path);
      mod.FS.writeFile(path, bytes as Uint8Array);
    }
    return;
  }

  if (msg.type === "exec") {
    await readyPromise;
    refillPool(); // this process is actually running now — make sure it has spares ready in case it forks

    const redirects = msg.redirects ?? {};
    dbg("[DEBUG] exec", msg.argv, "redirects:", JSON.stringify({ stdin: !!redirects.stdin, stdout: !!redirects.stdout }));
    let stdoutPipe: PipeHandle | null = null;
    let stdinPipe: PipeHandle | null = null;

    if (redirects.stdout) {
      stdoutPipe = {
        ctrl: new Int32Array(redirects.stdout.ctrlBuf),
        data: new Uint8Array(redirects.stdout.dataBuf),
        role: "w",
      };
      mod.print = (t: string) => { dbg("[DEBUG] print->pipe", JSON.stringify(t)); pipeWriteBytes(stdoutPipe!, new TextEncoder().encode(t + "\n")); };
    } else {
      mod.print = (t: string) => { dbg("[DEBUG] print->relay", JSON.stringify(t)); (self as any).postMessage({ type: "stdout", text: t + "\n" }); };
    }
    mod.printErr = (t: string) => (self as any).postMessage({ type: "stderr", text: t + "\n" });

    if (redirects.stdin) {
      stdinPipe = {
        ctrl: new Int32Array(redirects.stdin.ctrlBuf),
        data: new Uint8Array(redirects.stdin.dataBuf),
        role: "r",
      };
      mod.stdin = () => { const b = pipeReadByte(stdinPipe!); dbg("[DEBUG] stdin<-pipe", b); return b; };
    }

    let exitCode = 0;
    mod.quit = (status: number) => { exitCode = status; throw new Error("ExitStatus"); };
    try {
      // hush_main()'s "-c" parsing relies on libc's process-global optind,
      // which stays wherever the previous top-level callMain() left it
      // since this worker can run several commands across one WASM
      // instance. Reset before every invocation or hush silently fails to
      // recognize "-c" and treats the command string as a script filename.
      mod._em_reset_getopt();
      mod.callMain(msg.argv);
    } catch (_e) {
      // normal exit via quit()
    }

    // This process implicitly closes whatever pipe ends it was holding.
    if (stdoutPipe) {
      const left = Atomics.sub(stdoutPipe.ctrl, 3, 1) - 1;
      if (left <= 0) Atomics.notify(stdoutPipe.ctrl, 2);
    }
    if (stdinPipe) {
      Atomics.sub(stdinPipe.ctrl, 4, 1);
    }

    if (msg.sab) {
      const ctrl = new Int32Array(msg.sab);
      Atomics.store(ctrl, 1, exitCode);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
    }
    (self as any).postMessage({ type: "exited", pid: myPid, exitCode });
  }
};
