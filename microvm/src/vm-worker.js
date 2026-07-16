// microvm-lite production worker (M4 contract layer).
//
// Speaks the EXACT SQL_Chat useV86.ts worker message protocol so the app can
// swap the v86 backend for blink with no code changes:
//   main → worker:  init | run | execute | write_file | read_file |
//                   save_state | proxy_response | serial_send
//   worker → main:  ready | result | error | proxy_request | fs_dirty |
//                   serial_output
//
// The backend is blink (x86-64 → wasm, Asyncify, no SAB) with the M2 process
// model and M3 HTTP bridge. One architectural difference from v86 the contract
// must absorb: v86 runs the guest CONTINUOUSLY while JS watches the serial
// console, so a slow command can be Ctrl+C-backgrounded (done:false + a live
// pid). blink runs each command to completion inside a single Asyncify call —
// there is no preemption point — so `execute` (vm.run) always returns
// done:true. We still populate output_file and the real guest pid so the
// {done, output_file, pid, output} shape is faithful and kill-by-pid degrades
// gracefully (nothing is ever left running).

self.onerror = function (e) {
  self.postMessage({ type: "dbg", text: "UNCAUGHT: " + e.message + " @ " + e.filename + ":" + e.lineno });
};
self.onunhandledrejection = function (e) {
  self.postMessage({ type: "dbg", text: "UNHANDLED REJECTION: " + (e.reason && (e.reason.stack || e.reason)) });
};

// ── Config ───────────────────────────────────────────────────────────────────
// `base` is where blink.js/blink.wasm and the guest binaries live; the main
// thread passes it in `init.cdnBase` (mirrors useV86's cdnBase). Defaults to
// the worker's own directory so a plain static server just works.
var BASE = ".";
var VM_ROUTES = { "10.0.2.10": "llm.vm", "10.0.2.11": "api.vm", "10.0.2.12": "done.vm" };

// Fallback lists used only when no dist manifest.json is present (e.g. a bare
// test dir). In the packaged dist/, the manifest drives everything.
var BINARIES = ["busybox", "xtool", "probe", "app", "runner"];
var ROOTFS_MANIFEST = "rootfs/manifest.json";
var APPLETS = [
  "sh", "hush", "ls", "cat", "sed", "awk", "grep", "find", "head", "tail",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "echo", "printf",
  "wc", "sort", "uniq", "cut", "tr", "xargs", "env", "pwd", "id", "wget",
  "chmod", "stat", "du", "df", "diff", "md5sum", "tar", "gzip", "gunzip", "base64",
];

// M5: the dist manifest (fetched in `init` before blink loads). When present it
// lists the eager `core` bin/, the `applets`, the `lazy.poppler` closure, and
// the `triggers` (command tokens that force a lazy fetch). null → fall back to
// the hardcoded lists above and eager-load everything.
var MANIFEST = null;
// Lazy poppler/sqlite closure: fetched at most once, on first triggering cmd.
var _rootfsPromise = null;

var HOME = "/workspace";

var _moduleReadyResolve;
var moduleReadyPromise = new Promise(function (r) { _moduleReadyResolve = r; });
var _runSeq = 0;

// Snapshot passed in init (restore the guest FS before we signal ready).
var _initSnapshot = null;

// ── FS dirty tracking (debounced fs_dirty like useV86) ───────────────────────
var _fsDirty = false;
setInterval(function () {
  if (_fsDirty && !_execBusy) {
    _fsDirty = false;
    self.postMessage({ type: "fs_dirty" });
  }
}, 5000);
var _execBusy = false;

// ── HTTP bridge (M3) ─────────────────────────────────────────────────────────
var _proxySeq = 0;
var _proxyWaiters = {};

function parseHttpRequest(bytes) {
  var headerEnd = -1;
  for (var i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) { headerEnd = i; break; }
  }
  if (headerEnd === -1) return null;
  var head = new TextDecoder("latin1").decode(bytes.subarray(0, headerEnd)).split("\r\n");
  var reqLine = head[0].split(" ");
  var headers = {};
  for (var j = 1; j < head.length; j++) {
    var k = head[j].indexOf(":");
    if (k > 0) headers[head[j].slice(0, k).trim().toLowerCase()] = head[j].slice(k + 1).trim();
  }
  return { method: reqLine[0], path: reqLine[1] || "/", headers: headers, body: bytes.subarray(headerEnd + 4) };
}

function buildHttpResponse(status, statusText, headers, bodyBytes) {
  var head = "HTTP/1.1 " + status + " " + (statusText || "OK") + "\r\n";
  var seen = {};
  Object.keys(headers || {}).forEach(function (k) {
    var kl = k.toLowerCase();
    if (kl === "content-length" || kl === "connection" || kl === "transfer-encoding") return;
    seen[kl] = true;
    head += k + ": " + headers[k] + "\r\n";
  });
  if (!seen["content-type"]) head += "Content-Type: application/json\r\n";
  head += "Content-Length: " + bodyBytes.length + "\r\nConnection: close\r\n\r\n";
  var headBytes = new TextEncoder().encode(head);
  var out = new Uint8Array(headBytes.length + bodyBytes.length);
  out.set(headBytes, 0);
  out.set(bodyBytes, headBytes.length);
  return out;
}

function textResponse(status, statusText, text) {
  return buildHttpResponse(status, statusText, { "Content-Type": "text/plain" }, new TextEncoder().encode(text));
}

// ── Emscripten Module ────────────────────────────────────────────────────────
self.Module = {
  // blink.js resolves blink.wasm relative to the WORKER's own directory, which
  // may differ from where the assets live (cdnBase). Redirect every asset load
  // (blink.wasm) to BASE.
  locateFile: function (path) { return BASE + "/" + path; },

  // Called by blink's virtual-socket layer with the guest's HTTP request.
  // Routes known vm hosts to the main thread via proxy_request/proxy_response
  // in the SAME shape as useV86.ts (id/url/pathname/method/body), so the app's
  // registerVmEndpoint registry and its auth-injecting proxyFetch both work
  // unchanged. Unknown hosts get a synthesized 403 — never a real network hop.
  emHttpFetch: async function (ip, port, reqBytes) {
    var hostname = VM_ROUTES[ip];
    if (!hostname || port !== 80) return textResponse(403, "Forbidden", "blocked: " + ip + ":" + port + "\n");
    var req = parseHttpRequest(reqBytes);
    if (!req) return textResponse(400, "Bad Request", "unparseable HTTP request\n");
    var id = ++_proxySeq;
    var respPromise = new Promise(function (resolve) {
      _proxyWaiters[id] = resolve;
      setTimeout(function () {
        if (_proxyWaiters[id]) { delete _proxyWaiters[id]; resolve({ status: 504, statusText: "Gateway Timeout", body: "endpoint timeout\n" }); }
      }, 30000);
    });
    // Split the query off for the registry key (useV86 routes on pathname
    // only); keep the full target in `url` so handlers can read query params.
    var q = req.path.indexOf("?");
    var pathname = q === -1 ? req.path : req.path.slice(0, q);
    self.postMessage({
      type: "proxy_request", id: id,
      url: "http://" + hostname + req.path,
      pathname: pathname,
      hostname: hostname,
      method: req.method,
      body: new TextDecoder().decode(req.body),
    });
    var r = await respPromise;
    var body = typeof r.body === "string" ? new TextEncoder().encode(r.body)
             : (r.body instanceof Uint8Array ? r.body : new Uint8Array(0));
    return buildHttpResponse(r.status || 200, r.statusText, r.headers || {}, body);
  },
  emHttpLog: function (text) { self.postMessage({ type: "dbg", text: text }); },

  preRun: [function () {
    function mkdirp(p) { try { FS.mkdir(p); } catch (e) { /* EEXIST */ } }
    mkdirp("/root"); mkdirp("/bin"); mkdirp("/lib");
    mkdirp("/home"); mkdirp(HOME); mkdirp("/etc"); mkdirp("/tmp");
    ENV["HOME"] = HOME; ENV["PATH"] = "/bin:/root"; ENV["TERM"] = "xterm";
    ENV["WORKDIR"] = HOME;

    // M3 DNS seed.
    var hosts = "127.0.0.1 localhost\n";
    Object.keys(VM_ROUTES).forEach(function (ip) { hosts += ip + " " + VM_ROUTES[ip] + "\n"; });
    FS.writeFile("/etc/hosts", hosts);
    FS.writeFile("/etc/resolv.conf", "nameserver 127.0.0.1\n");

    function fetchInto(url, destPath, mode, applets) {
      addRunDependency("fetch-" + destPath);
      fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          FS.writeFile(destPath, new Uint8Array(buf), { mode: mode });
          if (applets) applets.forEach(function (a) { try { FS.writeFile("/bin/" + a, new Uint8Array(buf), { mode: 0o755 }); } catch (e) {} });
          removeRunDependency("fetch-" + destPath);
        })
        .catch(function (e) { self.postMessage({ type: "dbg", text: "fetch " + destPath + " skipped: " + e.message }); removeRunDependency("fetch-" + destPath); });
    }

    if (MANIFEST) {
      // Packaged path: eager-load ONLY the core tier (busybox+applets, xtool,
      // app, runner). Poppler/sqlite stay unfetched until a triggering command
      // (see ensureRootfs) — this is what keeps cold boot off the ~16MB closure.
      var applets = MANIFEST.applets || APPLETS;
      Object.keys(MANIFEST.core).forEach(function (rel) {
        if (rel.indexOf("bin/") !== 0) return;  // blink.js/.wasm load via Emscripten
        var name = rel.slice(4);
        fetchInto(BASE + "/" + rel, "/bin/" + name, 0o755, name === "busybox" ? applets : null);
      });
    } else {
      // Fallback path (no manifest): eager-load everything, including poppler.
      BINARIES.forEach(function (name) { fetchInto(BASE + "/" + name, "/bin/" + name, 0o755, name === "busybox" ? APPLETS : null); });
      addRunDependency("fetch-rootfs");
      fetch(BASE + "/" + ROOTFS_MANIFEST)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (man) {
          man.bin.forEach(function (f) { fetchInto(BASE + "/rootfs/bin/" + f, "/bin/" + f, 0o755); });
          man.lib.forEach(function (f) { fetchInto(BASE + "/rootfs/lib/" + f, "/lib/" + f, 0o755); });
          removeRunDependency("fetch-rootfs");
        })
        .catch(function (e) { self.postMessage({ type: "dbg", text: "rootfs manifest skipped: " + e.message }); removeRunDependency("fetch-rootfs"); });
    }

    // Keep /dev/stdout,/dev/stderr registered but discard — real capture is
    // via MEMFS-file redirection per run (see runExec).
    var ops = { get_char: function () { return null; }, put_char: function () {}, flush: function () {}, fsync: function () {}, poll: function () { return 0; } };
    TTY.register(FS.makedev(5, 0), ops);
    TTY.register(FS.makedev(6, 0), ops);
  }],
  postRun: [function () {
    // Restore a prior FS snapshot (if init supplied one) before signalling ready.
    if (_initSnapshot) { try { restoreSnapshot(_initSnapshot); } catch (e) { self.postMessage({ type: "dbg", text: "snapshot restore failed: " + e }); } }
    _moduleReadyResolve();
  }],
  onExit: function (code) { _lastExitCode = code; },
};

// ── Asyncify-safe main() invocation (unchanged from the M0-M3 harness) ───────
var _prevArgvAllocs = [];
var _lastExitCode = null;

async function callMainAsync(args) {
  Module._em_reset_getopt();
  _prevArgvAllocs.forEach(function (p) { Module._free(p); });
  var ptrs = args.map(function (a) { return Module.stringToNewUTF8(a); });
  var argvBuf = Module._malloc((ptrs.length + 1) * 4);
  for (var i = 0; i < ptrs.length; i++) Module.HEAPU32[(argvBuf >> 2) + i] = ptrs[i];
  Module.HEAPU32[(argvBuf >> 2) + ptrs.length] = 0;
  _prevArgvAllocs = ptrs.concat([argvBuf]);
  _lastExitCode = null;
  try {
    await Module.ccall("em_main", "number", ["number", "number"], [args.length, argvBuf], { async: true });
    return _lastExitCode !== null ? _lastExitCode : Module.ccall("em_last_exit", "number", [], []);
  } catch (e) {
    if (e && e.name === "ExitStatus") return e.status;
    if (_lastExitCode !== null) return _lastExitCode;
    throw e;
  }
}

// runExec: run argv under blink, capturing stdout+stderr via MEMFS files.
async function runExec(argv) {
  var id = ++_runSeq;
  var outPath = "/tmp/.stdout." + id, errPath = "/tmp/.stderr." + id;
  var outStream = FS.open(outPath, "w+"), errStream = FS.open(errPath, "w+");
  FS.streams[1] = outStream; FS.streams[2] = errStream;
  var error = null, exitCode = null;
  _execBusy = true;
  try { exitCode = await callMainAsync(["blink"].concat(argv)); }
  catch (e) { error = (e && e.name ? e.name + ": " : "") + (e && (e.stack || e.message) || String(e)); }
  finally { _execBusy = false; }
  var output = "";
  try { output += new TextDecoder().decode(FS.readFile(outPath)); } catch (e) {}
  try { output += new TextDecoder().decode(FS.readFile(errPath)); } catch (e) {}
  try { FS.unlink(outPath); } catch (e) {}
  try { FS.unlink(errPath); } catch (e) {}
  return { output: output, error: error, exitCode: exitCode };
}

function randHex() { return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0"); }

// ── Lazy poppler/sqlite closure (M5) ─────────────────────────────────────────
// Fetched at most once, the first time a command references a trigger token
// (pdftotext/pdfinfo/pdftoppm/…/sqlite3). Staged into MEMFS /bin and /lib just
// like the eager tier; subsequent calls reuse the resolved promise.
function ensureRootfs() {
  if (!MANIFEST || !MANIFEST.lazy || !MANIFEST.lazy.poppler) return Promise.resolve();
  if (_rootfsPromise) return _rootfsPromise;
  var lazy = MANIFEST.lazy.poppler;
  self.postMessage({ type: "dbg", text: "lazy-loading poppler closure (" + Object.keys(lazy).length + " files)" });
  _rootfsPromise = Promise.all(Object.keys(lazy).map(function (rel) {
    // rel is "rootfs/bin/<f>" or "rootfs/lib/<f>" → /bin/<f> or /lib/<f>
    var dest = rel.indexOf("rootfs/bin/") === 0 ? "/bin/" + rel.slice(11)
             : rel.indexOf("rootfs/lib/") === 0 ? "/lib/" + rel.slice(11)
             : null;
    if (!dest) return Promise.resolve();
    return fetch(BASE + "/" + rel).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + rel);
      return r.arrayBuffer();
    }).then(function (buf) { FS.writeFile(dest, new Uint8Array(buf), { mode: 0o755 }); });
  })).then(function () {
    self.postMessage({ type: "dbg", text: "poppler closure ready" });
  }).catch(function (e) {
    _rootfsPromise = null;  // allow a retry on the next triggering command
    self.postMessage({ type: "dbg", text: "poppler lazy-load failed: " + e.message });
    throw e;
  });
  return _rootfsPromise;
}

// Whether a command line references any lazy-tier binary → needs ensureRootfs.
function needsRootfs(cmd) {
  if (!MANIFEST || !MANIFEST.triggers || !MANIFEST.triggers.length) return false;
  for (var i = 0; i < MANIFEST.triggers.length; i++) {
    var t = MANIFEST.triggers[i];
    // word-ish boundary so "pdftotext" matches but a substring in a path/arg
    // that merely contains it (e.g. "mypdftotextfile") does not.
    var re = new RegExp("(^|[^A-Za-z0-9_])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9_]|$)");
    if (re.test(cmd)) return true;
  }
  return false;
}

// ── vm.execute (worker msg "run"): simple string capture ─────────────────────
async function doRun(cmd) {
  if (needsRootfs(cmd)) await ensureRootfs();
  var r = await runExec(["/bin/sh", "-c", "cd " + HOME + " 2>/dev/null; " + cmd]);
  var s = (r.output || "").replace(/\s+$/, "");
  return s;
}

// ── vm.run (worker msg "execute"): file-capture + pid, {done,output_file,pid} ─
// Mirrors useV86.executeCmd's on-disk contract (/tmp/out-<hex>.txt,
// /tmp/pid-<hex>.txt) so the app's window.vm.run pid-readback path is byte-for-
// byte compatible. Run-to-completion → always done:true (see file header).
async function doExecute(cmd) {
  if (needsRootfs(cmd)) await ensureRootfs();
  var hex = randHex();
  var outFile = "/tmp/out-" + hex + ".txt", pidFile = "/tmp/pid-" + hex + ".txt";
  var script = "echo $$ > " + pidFile + "\n( cd " + HOME + " 2>/dev/null; " + cmd + " ) > " + outFile + " 2>&1\n";
  await runExec(["/bin/sh", "-c", script]);
  _fsDirty = true;
  var output = "(no output)", pid = null;
  try {
    var bytes = FS.readFile(outFile);
    if (bytes && bytes.length) {
      var MAX = 32 * 1024;
      if (bytes.length > MAX) output = new TextDecoder().decode(bytes.subarray(0, MAX)) + "\n...(output large — use grep/awk on " + outFile + " to filter)";
      else output = new TextDecoder().decode(bytes).replace(/\s+$/, "") || "(no output)";
    }
  } catch (e) {}
  try { pid = parseInt(new TextDecoder().decode(FS.readFile(pidFile)).trim()) || null; } catch (e) {}
  return { done: true, output_file: outFile, pid: pid, output: output };
}

// ── FS snapshot: a JSON manifest of every file under HOME, base64-encoded ─────
// blink has no long-lived machine to serialize (each exec is a fresh Machine),
// so "state" is the working filesystem, not CPU/RAM. This is smaller and more
// portable than a v86 machine image; the main-thread gzip+IDB+etag+TTL layer
// (vm-host.js) is backend-agnostic and stores whatever ArrayBuffer we hand it.
function walk(dir, out) {
  var entries;
  try { entries = FS.readdir(dir); } catch (e) { return; }
  entries.forEach(function (name) {
    if (name === "." || name === "..") return;
    var path = dir === "/" ? "/" + name : dir + "/" + name;
    var st;
    try { st = FS.stat(path); } catch (e) { return; }
    if (FS.isDir(st.mode)) walk(path, out);
    else if (FS.isFile(st.mode)) { try { out[path] = FS.readFile(path); } catch (e) {} }
  });
}

function b64(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  var bin = atob(str), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function makeSnapshot() {
  var files = {};
  walk(HOME, files);
  var manifest = { version: 1, home: HOME, files: {} };
  Object.keys(files).forEach(function (p) { manifest.files[p] = b64(files[p]); });
  return new TextEncoder().encode(JSON.stringify(manifest)).buffer;
}

function restoreSnapshot(buf) {
  var manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
  if (!manifest || !manifest.files) return;
  Object.keys(manifest.files).forEach(function (p) {
    var dir = p.slice(0, p.lastIndexOf("/")) || "/";
    dir.split("/").reduce(function (acc, seg) { if (!seg) return acc; var d = acc + "/" + seg; try { FS.mkdir(d); } catch (e) {} return d; }, "");
    try { FS.writeFile(p, unb64(manifest.files[p])); } catch (e) {}
  });
}

// ── Message protocol ─────────────────────────────────────────────────────────
self.onmessage = async function (ev) {
  var msg = ev.data;

  if (msg.type === "init") {
    BASE = msg.cdnBase || ".";
    if (msg.vmRoutes) { /* host may override, but IPs are ours; keep VM_ROUTES */ }
    if (msg.stateBuffer) _initSnapshot = msg.stateBuffer;
    // Fetch the dist manifest BEFORE blink loads: preRun reads MANIFEST to
    // decide eager vs lazy tiers. Absent (bare test dir) → hardcoded fallback.
    try {
      var mr = await fetch(BASE + "/manifest.json");
      if (mr.ok) MANIFEST = await mr.json();
    } catch (e) { MANIFEST = null; }
    importScripts(BASE + "/blink.js");
    moduleReadyPromise.then(function () { self.postMessage({ type: "ready", buildId: MANIFEST && MANIFEST.buildId }); });
    return;
  }

  if (msg.type === "proxy_response") {
    var w = _proxyWaiters[msg.id];
    if (w) { delete _proxyWaiters[msg.id]; w(msg); }
    return;
  }

  // exec/exec_raw: debug escape hatch used by the M0-M3 test harnesses.
  if (msg.type === "exec" || msg.type === "exec_raw") {
    await moduleReadyPromise;
    var argv = msg.type === "exec" ? ["/bin/" + msg.argv[0]].concat(msg.argv.slice(1)) : msg.argv;
    if (needsRootfs(argv.join(" "))) await ensureRootfs();
    var r = await runExec(argv);
    self.postMessage({ type: "result", id: msg.id, output: r.output, error: r.error, exitCode: r.exitCode });
    return;
  }

  if (msg.type === "run") {
    await moduleReadyPromise;
    try { self.postMessage({ type: "result", id: msg.id, value: await doRun(msg.cmd) }); }
    catch (err) { self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) }); }
    return;
  }

  if (msg.type === "execute") {
    await moduleReadyPromise;
    try { self.postMessage({ type: "result", id: msg.id, value: await doExecute(msg.cmd) }); }
    catch (err) { self.postMessage({ type: "result", id: msg.id, value: { done: false, output_file: null, pid: null, output: "error: " + String(err && err.message || err) } }); }
    return;
  }

  if (msg.type === "write_file") {
    await moduleReadyPromise;
    try {
      var bytes = new Uint8Array(msg.buf);
      var p = msg.path, dir = p.slice(0, p.lastIndexOf("/")) || "/";
      dir.split("/").reduce(function (acc, seg) { if (!seg) return acc; var d = acc + "/" + seg; try { FS.mkdir(d); } catch (e) {} return d; }, "");
      FS.writeFile(p, bytes);
      _fsDirty = true;
      self.postMessage({ type: "result", id: msg.id, value: null });
    } catch (err) { self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) }); }
    return;
  }

  if (msg.type === "read_file") {
    await moduleReadyPromise;
    try {
      var b = FS.readFile(msg.path);
      var copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      self.postMessage({ type: "result", id: msg.id, value: copy }, [copy]);
    } catch (err) { self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) }); }
    return;
  }

  if (msg.type === "save_state") {
    await moduleReadyPromise;
    try { var s = makeSnapshot(); self.postMessage({ type: "result", id: msg.id, value: s }, [s]); }
    catch (err) { self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) }); }
    return;
  }

  if (msg.type === "serial_send") { /* no interactive serial console in blink */ return; }

  // Diagnostic (used by the stress soak and viable for prod ops monitoring):
  // report the wasm heap size and /tmp residue so a long-lived session can be
  // watched for growth/leaks.
  if (msg.type === "stat") {
    await moduleReadyPromise;
    var tmpFiles = 0;
    try { FS.readdir("/tmp").forEach(function (n) { if (n !== "." && n !== "..") tmpFiles++; }); } catch (e) {}
    // HEAPU8 isn't in EXPORTED_RUNTIME_METHODS; HEAPU32 is. Total wasm memory =
    // HEAPU32.length * 4. Fall back to wasmMemory if present.
    var heapBytes = (Module.HEAPU32 && Module.HEAPU32.length * 4) ||
                    (Module.wasmMemory && Module.wasmMemory.buffer.byteLength) || 0;
    self.postMessage({ type: "result", id: msg.id, value: {
      heapBytes: heapBytes,
      tmpFiles: tmpFiles,
      runSeq: _runSeq,
    } });
    return;
  }
};
