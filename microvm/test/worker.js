// M0 spike worker: hosts blink.wasm (classic, non-module Emscripten build) and
// exposes a minimal exec-one-command-at-a-time protocol over postMessage.
//
// No process model yet (that's M2) — each `exec` message runs Module.callMain()
// to completion via the JS-REPL pattern from blink/shell.html (stdout/stderr
// captured by swapping FS.streams[1]/[2] to a temp file for the duration of the
// call, then reading it back), matching this repo's future worker.ts contract
// at the message-shape level: {type:"exec", argv} -> {type:"result", ...}.

self.onerror = function (e) {
  self.postMessage({ type: "dbg", text: "UNCAUGHT: " + e.message + " @ " + e.filename + ":" + e.lineno });
};
self.onunhandledrejection = function (e) {
  self.postMessage({ type: "dbg", text: "UNHANDLED REJECTION: " + (e.reason && e.reason.stack || e.reason) });
};

var _moduleReadyResolve;
var moduleReadyPromise = new Promise(function (r) { _moduleReadyResolve = r; });

// Monotonic id for per-run capture files.
var _runSeq = 0;

// Static binaries fetched into /bin (our Rust tools + busybox).
var BINARIES = ["busybox", "xtool", "probe", "app", "runner"];
// Dynamic poppler-utils + sqlite3 come from Alpine packages (rootfs/): binaries
// into /bin, their shared-library closure + musl loader into /lib. blink runs
// the ELF interpreter out of MEMFS just like a real rootfs.
var ROOTFS_MANIFEST = "rootfs/manifest.json";
// Seed files fetched into /workspace (test assets for the bench).
// permit.pdf/item8.pdf are scanned (image) PDFs; text30.pdf is a 30-page
// text-layer PDF for a fair pdftotext extraction benchmark.
var SEED_FILES = ["permit.pdf", "item8.pdf", "text30.pdf"];
var APPLETS = [
  "sh", "hush", "ls", "cat", "sed", "awk", "grep", "find", "head", "tail",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "echo", "printf",
  "wc", "sort", "uniq", "cut", "tr", "xargs", "env", "pwd", "id", "wget",
  "chmod", "stat", "du", "df", "diff", "md5sum", "tar", "gzip", "gunzip",
];

// M3 HTTP bridge: virtual IP → hostname (mirrors useV86.ts's vmRoutes). The
// same table seeds the guest's /etc/hosts, so guest connect() destinations
// always map back to one of these names.
var VM_ROUTES = {
  "10.0.2.10": "llm.vm",
  "10.0.2.11": "api.vm",
  "10.0.2.12": "done.vm",
};

// Pending proxy_request round-trips to the main thread, keyed by id.
var _proxySeq = 0;
var _proxyWaiters = {};

// Parse the raw HTTP/1.x request bytes the guest wrote to its socket.
function parseHttpRequest(bytes) {
  var headerEnd = -1;
  for (var i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) return null;
  var head = new TextDecoder("latin1").decode(bytes.subarray(0, headerEnd)).split("\r\n");
  var reqLine = head[0].split(" ");
  var headers = {};
  for (var j = 1; j < head.length; j++) {
    var k = head[j].indexOf(":");
    if (k > 0) headers[head[j].slice(0, k).trim().toLowerCase()] = head[j].slice(k + 1).trim();
  }
  return {
    method: reqLine[0],
    path: reqLine[1] || "/",
    headers: headers,
    body: bytes.subarray(headerEnd + 4),
  };
}

// Serialize a response as raw HTTP/1.1 bytes for the guest's socket recv
// buffer. Always Connection: close — clients must not pool/reuse the socket
// (a pooled socket crossing a vfork would fight the M2 fd save/restore).
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
  return buildHttpResponse(status, statusText, { "Content-Type": "text/plain" },
                           new TextEncoder().encode(text));
}

self.Module = {
  // Called by blink's virtual-socket layer (EM_ASYNC_JS em_http_fetch) with
  // the guest's destination IP/port and the raw request bytes; must resolve
  // to raw HTTP response bytes. Routing mirrors useV86.ts: every known
  // endpoint round-trips to the main thread as proxy_request/proxy_response
  // (the test page mocks them; the real host registers endpoint handlers).
  // Unknown destinations get a synthesized 403 — never a real network hop.
  emHttpFetch: async function (ip, port, reqBytes) {
    var hostname = VM_ROUTES[ip];
    if (!hostname || port !== 80) {
      return textResponse(403, "Forbidden", "blocked: " + ip + ":" + port + " is not a vm route\n");
    }
    var req = parseHttpRequest(reqBytes);
    if (!req) return textResponse(400, "Bad Request", "unparseable HTTP request\n");
    var id = ++_proxySeq;
    var respPromise = new Promise(function (resolve) {
      _proxyWaiters[id] = resolve;
      setTimeout(function () {
        if (_proxyWaiters[id]) {
          delete _proxyWaiters[id];
          resolve({ status: 504, statusText: "Gateway Timeout", headers: {}, body: "endpoint timeout\n" });
        }
      }, 30000);
    });
    self.postMessage({
      type: "proxy_request",
      id: id,
      hostname: hostname,
      port: port,
      method: req.method,
      path: req.path,
      headers: req.headers,
      body: new TextDecoder().decode(req.body),
    });
    var r = await respPromise;
    var body = typeof r.body === "string" ? new TextEncoder().encode(r.body)
             : (r.body instanceof Uint8Array ? r.body : new Uint8Array(0));
    return buildHttpResponse(r.status || 200, r.statusText, r.headers || {}, body);
  },
  emHttpLog: function (text) { self.postMessage({ type: "dbg", text: text }); },

  preRun: [
    function () {
      function mkdirp(p) {
        try { FS.mkdir(p); } catch (e) { /* EEXIST */ }
      }
      mkdirp("/root");
      mkdirp("/bin");
      ENV["HOME"] = "/root";
      ENV["PATH"] = "/bin:/root";
      ENV["TERM"] = "xterm";

      mkdirp("/home");
      mkdirp("/workspace");
      mkdirp("/lib");
      mkdirp("/etc");

      // M3 HTTP bridge, DNS half: musl/busybox getaddrinfo consult /etc/hosts
      // before DNS, so seeding fake IPs for the virtual endpoints means no
      // DNS-syscall interception is needed. connect() to one of these IPs hits
      // the virtual-socket path in blink (EmSysConnect), which hands the HTTP
      // request to Module.emHttpFetch below.
      var hosts = "";
      Object.keys(VM_ROUTES).forEach(function (ip) { hosts += ip + " " + VM_ROUTES[ip] + "\n"; });
      FS.writeFile("/etc/hosts", "127.0.0.1 localhost\n" + hosts);
      FS.writeFile("/etc/resolv.conf", "nameserver 127.0.0.1\n");

      function fetchInto(url, destPath, mode, applets) {
        addRunDependency("fetch-" + destPath);
        fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) {
            FS.writeFile(destPath, new Uint8Array(buf), { mode: mode });
            if (applets) {
              applets.forEach(function (a) {
                try { FS.writeFile("/bin/" + a, new Uint8Array(buf), { mode: 0o755 }); } catch (e) {}
              });
            }
            removeRunDependency("fetch-" + destPath);
          })
          .catch(function (e) {
            self.postMessage({ type: "dbg", text: "fetch " + destPath + " skipped: " + e.message });
            removeRunDependency("fetch-" + destPath);
          });
      }

      BINARIES.forEach(function (name) {
        fetchInto(name, "/bin/" + name, 0o755, name === "busybox" ? APPLETS : null);
      });
      SEED_FILES.forEach(function (name) { fetchInto(name, "/workspace/" + name, 0o644); });

      // Dynamic poppler/sqlite rootfs (blocks ready until the closure is in MEMFS).
      addRunDependency("fetch-rootfs");
      fetch(ROOTFS_MANIFEST)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (man) {
          man.bin.forEach(function (f) { fetchInto("rootfs/bin/" + f, "/bin/" + f, 0o755); });
          man.lib.forEach(function (f) { fetchInto("rootfs/lib/" + f, "/lib/" + f, 0o755); });
          removeRunDependency("fetch-rootfs");
        })
        .catch(function (e) {
          self.postMessage({ type: "dbg", text: "rootfs manifest skipped: " + e.message });
          removeRunDependency("fetch-rootfs");
        });

      // Keep the stdout/stderr TTY devices registered (so /dev/stdout,
      // /dev/stderr exist) but discard — real capture happens by redirecting
      // the guest's fd 1/2 to MEMFS files per run (see exec()). We do NOT
      // capture via put_char: a forking command's dup2(pipe,1) runs on blink's
      // single shared Emscripten fd table and destroys the TTY device binding,
      // which can't be revived, so put_char capture breaks after the first fork.
      // File streams have no such device-callback fragility, and bytes persist
      // in the MEMFS node regardless of later fd surgery.
      var ops = {
        get_char: function () { return null; },
        put_char: function () {},
        flush: function () {},
        fsync: function () {},
        poll: function () { return 0; },
      };
      TTY.register(FS.makedev(5, 0), ops);
      TTY.register(FS.makedev(6, 0), ops);
    },
  ],
  postRun: [function () { _moduleReadyResolve(); }],
  // Fires on every guest exit() — the reliable exit-code channel even when the
  // ExitStatus throw is swallowed by an Asyncify-resumed frame.
  onExit: function (code) { _lastExitCode = code; },
};

importScripts("blink.js");

// Asyncify-safe main() invocation. Module.callMain is NOT safe here: if the
// wasm suspends (any emscripten_sleep, e.g. blink's em_poll — Rust std polls
// fds 0-2 at startup), the export returns mid-execution and callMain reports a
// bogus exit while the program keeps running detached. ccall with async:true
// returns a promise that resolves only when main truly completes.
//
// The previous call's argv stays allocated until the next call: blink's
// vendored getopt keeps a static pointer into argv, and _em_reset_getopt only
// resets the globals — the stale pointer must still reference valid memory
// (it always sits on a '\0' after a completed parse).
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
    // em_main stores main()'s return in a global — Asyncify drops the direct
    // return value of any invocation that suspended, so read it back instead.
    await Module.ccall("em_main", "number", ["number", "number"],
                       [args.length, argvBuf], { async: true });
    return _lastExitCode !== null ? _lastExitCode : Module.ccall("em_last_exit", "number", [], []);
  } catch (e) {
    if (e && e.name === "ExitStatus") return e.status;
    if (_lastExitCode !== null) return _lastExitCode;
    throw e;
  }
}

async function exec(argv) {
  // Capture stdout+stderr by pointing the guest's fd 1/2 at fresh MEMFS files.
  // guest fd 1 → host fd 1 (blink's AddStdFd) → these file streams; the bytes
  // persist in the MEMFS node during the run, so any fd surgery blink does for
  // vfork isolation can't lose them, and a fresh file per run means nothing
  // leaks across commands. fd 1 and fd 2 get SEPARATE stream objects (never the
  // same object aliased to both — that double-closed and wedged the module).
  var id = ++_runSeq;
  var outPath = "/tmp/.stdout." + id;
  var errPath = "/tmp/.stderr." + id;
  var outStream = FS.open(outPath, "w+");
  var errStream = FS.open(errPath, "w+");
  FS.streams[1] = outStream;
  FS.streams[2] = errStream;

  var error = null;
  var exitCode = null;
  var blinkLog = null;
  try {
    exitCode = await callMainAsync(["blink"].concat(argv));
  } catch (e) {
    error = (e && e.name ? e.name + ": " : "") + (e && e.stack ? e.stack : (e && e.message ? e.message : String(e)));
  }

  var output = "";
  try { output += new TextDecoder().decode(FS.readFile(outPath)); } catch (e) {}
  try { output += new TextDecoder().decode(FS.readFile(errPath)); } catch (e) {}
  try { FS.unlink(outPath); } catch (e) {}
  try { FS.unlink(errPath); } catch (e) {}
  try { blinkLog = new TextDecoder().decode(FS.readFile("/blink.log")); } catch (e) {}
  return { output: output, error: error, exitCode: exitCode, blinkLog: blinkLog };
}

self.onmessage = async function (ev) {
  var msg = ev.data;
  if (msg.type === "proxy_response") {
    var waiter = _proxyWaiters[msg.id];
    if (waiter) {
      delete _proxyWaiters[msg.id];
      waiter(msg);
    }
    return;
  }
  if (msg.type === "exec" || msg.type === "exec_raw") {
    await moduleReadyPromise;
    // exec: argv[0] resolved under /bin. exec_raw: argv passed verbatim to
    // blink's main (lets callers use blink flags like -s for strace).
    var argv = msg.type === "exec"
      ? ["/bin/" + msg.argv[0]].concat(msg.argv.slice(1))
      : msg.argv;
    var r = await exec(argv);
    self.postMessage({ type: "result", id: msg.id, output: r.output, error: r.error, exitCode: r.exitCode, blinkLog: r.blinkLog });
  }
};

moduleReadyPromise.then(function () {
  self.postMessage({ type: "ready" });
});
