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

// Virtual HTTP routes: IP → hostname. Built from init.vmRoutes at init time —
// the runtime is PRODUCT-AGNOSTIC and hardcodes no endpoints. Seeds the guest
// /etc/hosts and maps guest connect() destinations back to a hostname for the
// fetch bridge (see emHttpFetch). Fake IPs assigned 10.0.2.10, .11, … in order.
var VM_ROUTES = {};

// Applet fallback list for the no-manifest path. manifest.applets overrides.
var APPLETS = [
  "sh", "hush", "ls", "cat", "sed", "awk", "grep", "find", "head", "tail",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "echo", "printf",
  "wc", "sort", "uniq", "cut", "tr", "xargs", "env", "pwd", "id", "wget",
  "chmod", "stat", "du", "df", "diff", "md5sum", "tar", "gzip", "gunzip", "base64",
  "sleep", "seq", "yes", "date", "sync", "kill", "true", "false",
];

// The asset manifest, fetched in `init` before blink loads. Product-agnostic:
// named BUNDLES of files (ELF binaries, shared libs, skills, seed assets), each
//   { tier: "eager" | "lazy", triggers?: [tokens], files: [ {url,dest,mode,applets} ] }
// eager bundles stage at boot (block ready); lazy bundles stage on the first
// command whose text matches one of the bundle's trigger tokens (or an explicit
// vm.loadBundle(name)). The reference build ships dash + toybox.
// null → minimal fallback (fetched from BASE/busybox).
var MANIFEST = null;
var _bundlePromises = {};   // bundle name → resolved-once staging promise (idempotent)

// Working directory. From manifest.home / init.home; default /workspace.
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
      headers: req.headers,
      body: new TextDecoder().decode(req.body),
    });
    var r = await respPromise;
    var body = typeof r.body === "string" ? new TextEncoder().encode(r.body)
             : (r.body instanceof Uint8Array ? r.body : new Uint8Array(0));
    return buildHttpResponse(r.status || 200, r.statusText, r.headers || {}, body);
  },
  emHttpLog: function (text) { self.postMessage({ type: "dbg", text: text }); },
  onAbort: function (what) { self.postMessage({ type: "dbg", text: "ABORT: " + what + "\n" + (new Error().stack) }); },

  preRun: [function () {
    function mkdirp(p) { try { FS.mkdir(p); } catch (e) { /* EEXIST */ } }
    mkdirp("/root"); mkdirp("/bin"); mkdirp("/lib"); mkdirp("/etc"); mkdirp("/tmp");
    mkdirpDeep(HOME);
    // /usr/bin: where the guest-userland closure (sqlite3, jq, lua5.4,
    // poppler-utils — build-guest-userland.sh) installs, matching real
    // FHS layout. Without it those tools only run via absolute path.
    ENV["HOME"] = HOME; ENV["PATH"] = "/bin:/usr/bin:/root"; ENV["TERM"] = "xterm";
    // No boot-level WORKDIR: the per-session wrapper in runShellCapture exports
    // the real one (/tmp/sams_<session>). A HOME-valued fallback here would
    // silently swallow a missing session and land files in the persistent HOME.

    // DNS seed from the configured routes (product-agnostic — VM_ROUTES is built
    // from init.vmRoutes). getaddrinfo reads /etc/hosts first.
    var hosts = "127.0.0.1 localhost\n";
    Object.keys(VM_ROUTES).forEach(function (ip) { hosts += ip + " " + VM_ROUTES[ip] + "\n"; });
    FS.writeFile("/etc/hosts", hosts);
    FS.writeFile("/etc/resolv.conf", "nameserver 127.0.0.1\n");

    // Stage EAGER bundles (block ready). Lazy bundles wait for a trigger token
    // or an explicit vm.loadBundle(). No manifest → minimal fallback.
    if (MANIFEST && MANIFEST.bundles) {
      Object.keys(MANIFEST.bundles).forEach(function (name) {
        var b = MANIFEST.bundles[name];
        if ((b.tier || "eager") !== "eager") return;
        (b.files || []).forEach(function (f) {
          addRunDependency("stage-" + f.dest);
          stageFile(f).then(function () { removeRunDependency("stage-" + f.dest); })
            .catch(function (e) { self.postMessage({ type: "dbg", text: "stage " + f.dest + " skipped: " + e.message }); removeRunDependency("stage-" + f.dest); });
        });
      });
    } else {
      addRunDependency("stage-fallback");
      stageFile({ url: "busybox", dest: "/bin/busybox", mode: "0755", applets: true })
        .then(function () { removeRunDependency("stage-fallback"); })
        .catch(function (e) { self.postMessage({ type: "dbg", text: "busybox skipped: " + e.message }); removeRunDependency("stage-fallback"); });
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
  Module._em_reset_children();
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
//
// fd 0 is explicitly opened here (/dev/null — no interactive stdin in this
// model) for the same reason fd 1/2 always get a fresh stream: a real Unix
// process ALWAYS has fds 0/1/2 pre-opened before it runs, and some guest
// programs rely on that guarantee. Confirmed root cause of a real bug: dash's
// own evalpipe() (src/eval.c) only dup2()s a pipe's write end to fd 1 when
// `pip[1] > 1` — on a real OS pipe() can never return fd 0 (0/1/2 are always
// already taken), so dash's authors never needed to handle pip[1]==0, but if
// fd 0 is left CLOSED here, pipe() may allocate its write end AT fd 0, and
// dash's `> 1` check then wrongly skips the redirect — the pipeline's writer
// silently keeps writing to whatever fd 1 already was instead of the pipe,
// which only shows up as wrong output on the pipeline that happens to hit
// this, not as a crash. Keeping fd 0 always-open sidesteps it for dash and
// any other guest binary carrying the same (extremely standard) assumption.
async function runExec(argv) {
  var id = ++_runSeq;
  var outPath = "/tmp/.stdout." + id, errPath = "/tmp/.stderr." + id;
  var inStream = FS.open("/dev/null", "r");
  var outStream = FS.open(outPath, "w+"), errStream = FS.open(errPath, "w+");
  FS.streams[0] = inStream; FS.streams[1] = outStream; FS.streams[2] = errStream;
  var error = null, exitCode = null;
  _execBusy = true;
  try { exitCode = await callMainAsync(["blink"].concat(argv)); }
  catch (e) { error = (e && e.name ? e.name + ": " : "") + (e && (e.stack || e.message) || String(e)); }
  finally { _execBusy = false; }
  var output = "";
  try { output += new TextDecoder().decode(FS.readFile(outPath)); } catch (e) {}
  try { output += new TextDecoder().decode(FS.readFile(errPath)); } catch (e) {}
  // Close the streams explicitly — leaving them open leaks Emscripten fd
  // numbers across every run in this worker (FS.streams[N] just get
  // overwritten next run, never freed), so fd numbers climb unbounded over a
  // long-lived session. blink's own C code partitions fds into a "guest range"
  // vs "blink-internal range" by a fixed numeric cutoff (kMinBlinkFd) — once
  // real host fd numbers climb past that cutoff, blink misclassifies a guest
  // fd as its own internal fd and later commands' output/redirection breaks.
  try { FS.close(inStream); } catch (e) {}
  try { FS.close(outStream); } catch (e) {}
  try { FS.close(errStream); } catch (e) {}
  try { FS.unlink(outPath); } catch (e) {}
  try { FS.unlink(errPath); } catch (e) {}
  return { output: output, error: error, exitCode: exitCode };
}

// Serialize ALL guest executions: two concurrent em_main calls on one
// Asyncify module corrupt its unwind state and wedge the worker permanently
// (real incident: a sams call stuck retrying against a slow backend + the
// user typing `pwd` in the terminal → every later call timed out forever).
// A queued call just waits its turn; the host-side per-call timeout may still
// fire for the waiting caller, but the worker stays healthy and drains.
var _execChain = Promise.resolve();
function runExecQueued(argv) {
  var run = function () { return runExec(argv); };
  var p = _execChain.then(run, run);
  _execChain = p.then(function () {}, function () {});
  return p;
}

function randHex() { return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0"); }

// ── Bundle staging (generic, product-agnostic asset loading) ─────────────────
function octalMode(m) { return typeof m === "string" ? parseInt(m, 8) : (typeof m === "number" ? m : 0o755); }

function mkdirpDeep(dir) {
  dir.split("/").reduce(function (acc, seg) {
    if (!seg) return acc;
    var d = acc + "/" + seg;
    try { FS.mkdir(d); } catch (e) {}
    return d;
  }, "");
}

function applyApplets(binBytes, appletList) {
  if (!appletList || !appletList.length) return;
  appletList.forEach(function (a) { try { FS.writeFile("/bin/" + a, binBytes, { mode: 0o755 }); } catch (e) {} });
}

// Stage one bundle file into MEMFS: fetch BASE/url → write to dest (mkdir -p its
// dir), applying applet symlinks if flagged.
//   f.applets: true → use the global manifest.applets list (backward compat)
//   f.applets: ["sh","hush"] → create only those applets from this binary
function stageFile(f) {
  return fetch(BASE + "/" + f.url).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + f.url);
    return r.arrayBuffer();
  }).then(function (buf) {
    var slash = f.dest.lastIndexOf("/");
    if (slash > 0) mkdirpDeep(f.dest.slice(0, slash));
    var bytes = new Uint8Array(buf);
    FS.writeFile(f.dest, bytes, { mode: octalMode(f.mode) });
    if (f.applets === true) {
      applyApplets(bytes, (MANIFEST && MANIFEST.applets) || APPLETS);
    } else if (Array.isArray(f.applets)) {
      applyApplets(bytes, f.applets);
    }
  });
}

// Stage a lazy bundle by name, at most once (idempotent). Both vm.loadBundle()
// and the trigger path funnel here — so product binaries/skills you add later
// load exactly like the built-in generic OSS bundle.
function ensureBundle(name) {
  if (!MANIFEST || !MANIFEST.bundles || !MANIFEST.bundles[name]) return Promise.resolve();
  if (_bundlePromises[name]) return _bundlePromises[name];
  var b = MANIFEST.bundles[name];
  self.postMessage({ type: "dbg", text: "staging bundle '" + name + "' (" + (b.files || []).length + " files)" });
  _bundlePromises[name] = Promise.all((b.files || []).map(stageFile))
    .then(function () { self.postMessage({ type: "dbg", text: "bundle '" + name + "' ready" }); })
    .catch(function (e) { _bundlePromises[name] = null; self.postMessage({ type: "dbg", text: "bundle '" + name + "' failed: " + e.message }); throw e; });
  return _bundlePromises[name];
}

// Lazy bundles a command triggers (by token match on the bundle's `triggers`).
function bundlesForCommand(cmd) {
  var names = [];
  if (!MANIFEST || !MANIFEST.bundles) return names;
  Object.keys(MANIFEST.bundles).forEach(function (name) {
    var b = MANIFEST.bundles[name];
    if ((b.tier || "eager") !== "lazy" || !b.triggers) return;
    for (var i = 0; i < b.triggers.length; i++) {
      var t = b.triggers[i];
      // word-ish boundary so "pdftotext" matches but not "mypdftotextfile".
      var re = new RegExp("(^|[^A-Za-z0-9_])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9_]|$)");
      if (re.test(cmd)) { names.push(name); break; }
    }
  });
  return names;
}

async function ensureBundlesFor(cmd) {
  var names = bundlesForCommand(cmd);
  for (var i = 0; i < names.length; i++) { try { await ensureBundle(names[i]); } catch (e) {} }
}

// Run `cmd` under sh with stdout+stderr captured via a GUEST-LEVEL redirect to
// `capFile` — the shell itself opens the file and redirects the whole command
// group into it. This is the ONLY reliable capture in the vfork model: aliasing
// FS.streams[1] to a MEMFS stream (see runExec) is corrupted by the fd
// save/restore the instant any fork+exec command runs, so every command AFTER
// the first fork in a sequence (`rm -f db; sqlite3 db …`, `cp a b; grep …`,
// `tool1; tool2`) loses its stdout. A guest-opened redirect fd is an ordinary
// blink Fd that survives the save/restore, so the full `A; B; C` sequence — post
// -fork commands included — is captured intact. cmd goes on its own line inside
// the group so a trailing `;`/operator in cmd can't break the `)` terminator.
// With a `session`, the command additionally runs inside an emulated shell
// session: WORKDIR=/tmp/sams_<sid> and SESSION_ID are exported for real (and
// the workdir created), the previous call's exported env vars and cwd are
// restored from /tmp/.sess_<sid>.{env,cwd}, and the trailer re-saves both
// after the command — so `export FOO=1` or `cd somewhere` in one call is
// still in effect in the next, per session, like a persistent shell. The
// trailer runs regardless of cmd's exit status and the real status is
// preserved via __rc. cwd restore uses the `read` builtin (not `$(cat …)`)
// to avoid a subshell+fork per call under the vfork model. /tmp is MEMFS, so
// session state resets on VM restart — the [ -f ] guards make that graceful.
async function runShellCapture(cmd, capFile, pidFile, session) {
  var script = (pidFile ? "echo $$ > " + pidFile + "; " : "")
    + "exec > " + capFile + " 2>&1; ";
  if (session) {
    var sid = String(session).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
    var wd = "/tmp/sams_" + sid, sess = "/tmp/.sess_" + sid;
    script += "export WORKDIR=" + wd + " SESSION_ID=" + sid + "; "
      + "mkdir -p " + wd + "; "
      + "[ -f " + sess + ".env ] && . " + sess + ".env; "
      + "__c=; [ -f " + sess + ".cwd ] && read -r __c < " + sess + ".cwd; "
      // `cd ""` is a silent no-op in dash (stays in the inherited, possibly
      // cross-session cwd) — default an empty __c to the workdir explicitly.
      + "[ -n \"$__c\" ] || __c=" + wd + "; "
      + "cd \"$__c\" 2>/dev/null || cd " + wd + "; "
      + cmd + "\n"
      + "__rc=$?; export -p > " + sess + ".env; pwd > " + sess + ".cwd; exit $__rc";
  } else {
    script += "cd " + HOME + " 2>/dev/null; " + cmd;
  }
  return runExecQueued(["/bin/sh", "-c", script]);
}

// ── vm.execute (worker msg "run"): simple string capture ─────────────────────
async function doRun(cmd) {
  await ensureBundlesFor(cmd);
  var cap = "/tmp/.run-" + randHex();
  await runShellCapture(cmd, cap);
  var out = "";
  try { out = new TextDecoder().decode(FS.readFile(cap)); } catch (e) {}
  try { FS.unlink(cap); } catch (e) {}
  return out.replace(/\s+$/, "");
}

// ── vm.run (worker msg "execute"): file-capture + pid, {done,output_file,pid} ─
// Mirrors useV86.executeCmd's on-disk contract (/tmp/out-<hex>.txt,
// /tmp/pid-<hex>.txt) so the app's window.vm.run pid-readback path is byte-for-
// byte compatible. Run-to-completion → always done:true (see file header).
async function doExecute(cmd, session) {
  await ensureBundlesFor(cmd);
  var hex = randHex();
  var outFile = "/tmp/out-" + hex + ".txt", pidFile = "/tmp/pid-" + hex + ".txt";
  var r = await runShellCapture(cmd, outFile, pidFile, session);
  _fsDirty = true;
  var output = "(no output)", pid = null;
  try {
    var bytes = FS.readFile(outFile);
    if (bytes && bytes.length) {
      var MAX = 32 * 1024;
      if (bytes.length > MAX) output = new TextDecoder().decode(bytes.subarray(0, MAX)) + "\n...(output large — use grep/awk on " + outFile + " to filter)";
      else output = new TextDecoder().decode(bytes).replace(/\s+$/, "") || "(no output)";
    }
  } catch (e) {
    // Capture file unreadable — surface it instead of masquerading as empty
    // output (a "(no output)" streak on commands like `echo hello` is exactly
    // this case, and used to be silently swallowed here).
    output = "[vm error: could not read command output: " + String(e && e.message || e) + "]";
  }
  if (r && r.error) output = "[vm error: " + r.error + "]" + (output === "(no output)" ? "" : "\n" + output);
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
    if (msg.stateBuffer) _initSnapshot = msg.stateBuffer;
    // Assign a fake IP to each configured hostname (product-agnostic: the routes
    // come entirely from the integrator's init.vmRoutes). These seed /etc/hosts
    // and let the fetch bridge map guest connect() dests back to a hostname.
    if (msg.vmRoutes) {
      var ipN = 10;
      Object.keys(msg.vmRoutes).forEach(function (host) { VM_ROUTES["10.0.2." + (ipN++)] = host; });
    }
    // Fetch the manifest BEFORE blink loads: preRun reads MANIFEST.bundles to
    // decide eager vs lazy staging. Absent → minimal busybox fallback.
    try {
      var mr = await fetch(BASE + "/manifest.json");
      if (mr.ok) MANIFEST = await mr.json();
    } catch (e) { MANIFEST = null; }
    if (MANIFEST && MANIFEST.home) HOME = MANIFEST.home;
    if (msg.home) HOME = msg.home;
    importScripts(BASE + "/blink.js");
    moduleReadyPromise.then(function () { self.postMessage({ type: "ready", buildId: MANIFEST && MANIFEST.buildId }); });
    return;
  }

  if (msg.type === "load_bundle") {
    await moduleReadyPromise;
    try { await ensureBundle(msg.name); self.postMessage({ type: "result", id: msg.id, value: { ok: true, name: msg.name } }); }
    catch (err) { self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) }); }
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
    await ensureBundlesFor(argv.join(" "));
    var r = await runExecQueued(argv);
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
    try { self.postMessage({ type: "result", id: msg.id, value: await doExecute(msg.cmd, msg.session) }); }
    catch (err) { self.postMessage({ type: "result", id: msg.id, value: { done: false, output_file: null, pid: null, output: "error: " + String(err && err.message || err) } }); }
    return;
  }

  if (msg.type === "write_file") {
    await moduleReadyPromise;
    try {
      var bytes = new Uint8Array(msg.buf);
      var p = msg.path, slash = p.lastIndexOf("/");
      if (slash > 0) mkdirpDeep(p.slice(0, slash));
      // Optional mode lets integrators push an executable (ELF binary, 0o755)
      // or a plain asset/skill (default). Enables "load binaries/skills later".
      var opts = (msg.mode != null) ? { mode: octalMode(msg.mode) } : undefined;
      FS.writeFile(p, bytes, opts);
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
