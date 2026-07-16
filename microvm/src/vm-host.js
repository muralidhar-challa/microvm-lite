// microvm-lite main-thread host (M4 contract layer).
//
// Transcribes the main-thread half of SQL_Chat's useV86.ts against the blink
// worker (vm-worker.js): installs the identical `window.vm` API and
// `window.registerVmEndpoint`, the gzip+IndexedDB snapshot cache with
// etag/TTL, `resetToFresh`, and the proxy_request → registerVmEndpoint routing.
// A drop-in backend swap: SQL_Chat's wasm-bridge.ts talks to `window.vm` and
// never learns which emulator is underneath.
//
// Differences from useV86.ts, all deliberate:
//  - No libv86/zstd/boot-command machinery — blink has no BIOS/kernel and no
//    serial console; the worker seeds its own FS from binaries.
//  - "state" is the guest filesystem snapshot (see vm-worker.makeSnapshot),
//    not a full machine image. The gzip/IDB/etag/TTL wrapper is unchanged
//    because it is agnostic to what the ArrayBuffer contains.
//  - etag is a caller-supplied build id (there is no base state URL to HEAD).

// ── IndexedDB (identical to useV86.ts) ───────────────────────────────────────
const IDB_NAME = "microvm-lite-data";
const IDB_STORE = "snapshot";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Stored: 4-byte etagLen + 8-byte savedAt + etag bytes + gzip state bytes.
function encodeSnapshot(etag, state) {
  const etagBytes = new TextEncoder().encode(etag);
  const buf = new ArrayBuffer(4 + 8 + etagBytes.byteLength + state.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, etagBytes.byteLength, true);
  view.setFloat64(4, Date.now(), true);
  new Uint8Array(buf, 12, etagBytes.byteLength).set(etagBytes);
  new Uint8Array(buf, 12 + etagBytes.byteLength).set(new Uint8Array(state));
  return buf;
}
function decodeSnapshot(buf) {
  if (buf.byteLength < 12) return null;
  const view = new DataView(buf);
  const etagLen = view.getUint32(0, true);
  const savedAt = view.getFloat64(4, true);
  if (buf.byteLength < 12 + etagLen) return null;
  const etag = new TextDecoder().decode(new Uint8Array(buf, 12, etagLen));
  return { etag, state: buf.slice(12 + etagLen), savedAt };
}

async function readStream(reader) {
  const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}
async function compressGzip(data) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter(); w.write(data); w.close();
  return readStream(cs.readable.getReader());
}
async function decompressGzip(data) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter(); w.write(data); w.close();
  return readStream(ds.readable.getReader());
}

// ── Virtual endpoint registry (proxy_request → registered handlers) ──────────
const _endpoints = new Map();

async function callHandler(fn) {
  try { return { status: 200, body: JSON.stringify(await fn()) }; }
  catch (e) { return { status: 500, body: JSON.stringify({ __error__: String(e) }) }; }
}
async function handleVirtualRequest(pathname, method, bodyText, url) {
  let data = {};
  try { if (bodyText) data = JSON.parse(bodyText); } catch { /* keep {} */ }
  const handler = _endpoints.get(pathname);
  if (handler) return callHandler(() => handler(method, data, url));
  return { status: 404, body: JSON.stringify({ __error__: "no handler for: " + pathname }) };
}

// ── Singleton state (mirrors useV86.ts) ──────────────────────────────────────
let _worker = null;
let _ready = false;
let _startPromise = null;
const _readyResolvers = [];
let _nextId = 1;
const _pending = new Map();
let _saving = false;
let _baseEtag = "v1";
let _cdnBase = ".";
let _vmRoutes = {};
let _workerUrl = "./vm-worker.js";

const DEFAULT_CALL_TIMEOUT_MS = 120000;

function _call(msg, transfer, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (_pending.delete(id)) reject(new Error(`VM call timed out after ${timeoutMs}ms (type: ${String(msg.type)})`));
    }, timeoutMs) : undefined;
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    if (transfer && transfer.length) _worker.postMessage({ ...msg, id }, transfer);
    else _worker.postMessage({ ...msg, id });
  });
}

async function _saveSnapshot() {
  if (!_worker || !_ready || _saving) return;
  _saving = true;
  try {
    const state = await _call({ type: "save_state" });
    await idbPut("snapshot", encodeSnapshot(_baseEtag, await compressGzip(state)));
  } catch { /* non-fatal */ } finally { _saving = false; }
}

async function _loadSnapshotFromIdb() {
  const saved = await idbGet("snapshot").catch(() => null);
  if (!saved) return null;
  const decoded = decodeSnapshot(saved);
  const expired = decoded ? (Date.now() - decoded.savedAt) > SNAPSHOT_TTL_MS : true;
  if (decoded && decoded.etag === _baseEtag && !expired) {
    const state = await decompressGzip(decoded.state).catch(() => null);
    if (state) return state;
  }
  await idbDelete("snapshot").catch(() => null);
  return null;
}

async function _doStartVM() {
  const stateBuffer = await _loadSnapshotFromIdb();

  _worker = new Worker(_workerUrl);
  _worker.onerror = (e) => {
    console.error("[vm-worker]", e.message, e);
    _pending.forEach(({ reject }) => reject(new Error("worker crashed: " + e.message)));
    _pending.clear();
  };
  _worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "ready") {
      _ready = true;
      _readyResolvers.forEach((r) => r()); _readyResolvers.length = 0;
      return;
    }
    if (msg.type === "proxy_request") {
      const w = _worker;
      handleVirtualRequest(msg.pathname, msg.method, msg.body, msg.url)
        .then(({ status, body }) => w && w.postMessage({ type: "proxy_response", id: msg.id, status, body }))
        .catch((err) => w && w.postMessage({ type: "proxy_response", id: msg.id, status: 500, body: JSON.stringify({ __error__: String(err) }) }));
      return;
    }
    if (msg.type === "fs_dirty") { _saveSnapshot(); return; }
    if (msg.type === "dbg") { if (window.__vmDebug) console.log("[vm-dbg]", msg.text); return; }
    if (msg.type === "result") { const p = _pending.get(msg.id); if (p) { _pending.delete(msg.id); p.resolve(msg.value); } return; }
    if (msg.type === "error") { const p = _pending.get(msg.id); if (p) { _pending.delete(msg.id); p.reject(new Error(msg.message)); } return; }
  };

  const transfer = stateBuffer ? [stateBuffer] : [];
  _worker.postMessage({ type: "init", cdnBase: _cdnBase, stateBuffer, vmRoutes: _vmRoutes }, transfer);

  window.vm = {
    get isReady() { return _ready; },
    ready: () => _ready ? Promise.resolve() : new Promise((r) => _readyResolvers.push(r)),
    execute: (cmd, timeout = 30000) => _call({ type: "run", cmd, timeout }, undefined, timeout + 15000),
    run: async (cmd, timeout = 120000) => {
      const r = await _call({ type: "execute", cmd, timeout }, undefined, timeout + 15000);
      if (!r.done && r.output_file && r.pid == null) {
        try {
          const hex = r.output_file.replace("/tmp/out-", "").replace(".txt", "");
          const pidBuf = await _call({ type: "read_file", path: `/tmp/pid-${hex}.txt` });
          r.pid = parseInt(new TextDecoder().decode(pidBuf).trim()) || null;
        } catch { /* pid file missing */ }
      }
      return r;
    },
    writeFile: async (path, data) => {
      let buf;
      if (typeof data === "string") buf = new TextEncoder().encode(data).buffer;
      else if (data instanceof Uint8Array) buf = data.buffer;
      else buf = data;
      await _call({ type: "write_file", path, buf }, [buf]);
    },
    readFile: async (path) => {
      const buf = await _call({ type: "read_file", path });
      return new TextDecoder().decode(buf).replace(/\0+$/, "");
    },
    readFileRaw: async (path) => _call({ type: "read_file", path }),
    resetToFresh: async () => {
      await idbDelete("snapshot").catch(() => {});
      if (_worker) _worker.terminate();
      _worker = null; _startPromise = null; _ready = false;
      _readyResolvers.length = 0; _nextId = 1;
      _pending.forEach(({ reject }) => reject(new Error("VM reset"))); _pending.clear();
      await startVM({ baseEtag: _baseEtag, cdnBase: _cdnBase, vmRoutes: _vmRoutes, workerUrl: _workerUrl });
    },
  };

  window.registerVmEndpoint = (path, handler) => { _endpoints.set(path, handler); };
}

// ── Public API ───────────────────────────────────────────────────────────────
export function startVM(opts = {}) {
  if (_startPromise) return _startPromise;
  if (opts.baseEtag) _baseEtag = opts.baseEtag;
  if (opts.cdnBase) _cdnBase = opts.cdnBase;
  if (opts.vmRoutes) _vmRoutes = opts.vmRoutes;
  if (opts.workerUrl) _workerUrl = opts.workerUrl;
  _startPromise = _doStartVM();
  return _startPromise;
}
export function preloadVM(opts) { startVM(opts).catch(() => {}); }

// Attach for non-module callers / test harnesses.
if (typeof window !== "undefined") { window.startVM = startVM; window.preloadVM = preloadVM; }
