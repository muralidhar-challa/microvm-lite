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
  "wc", "sort", "uniq", "cut", "tr", "xargs", "env", "pwd", "id",
  "chmod", "stat", "du", "df", "diff", "md5sum", "tar", "gzip", "gunzip",
];

self.Module = {
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

      // No terminal in a Worker — stdout/stderr default to a discard TTY;
      // exec() below redirects fd 1/2 to a real file for the duration of each call.
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
  var outPath = "/tmp/out-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  var outFd = FS.open(outPath, "w");
  var saved = { 1: FS.streams[1], 2: FS.streams[2] };
  FS.streams[1] = outFd;
  FS.streams[2] = outFd;
  var error = null;
  var exitCode = null;
  var blinkLog = null;
  try {
    exitCode = await callMainAsync(["blink"].concat(argv));
  } catch (e) {
    error = (e && e.name ? e.name + ": " : "") + (e && e.stack ? e.stack : (e && e.message ? e.message : String(e)));
    // On abort (fatal wasm trap), the module dies — no further calls can
    // read this. MEMFS is JS-side, so it may still be readable right here.
    try { blinkLog = new TextDecoder().decode(FS.readFile("/blink.log")); } catch (e2) {}
  } finally {
    FS.streams[1] = saved[1];
    FS.streams[2] = saved[2];
    FS.close(outFd);
  }
  var output = "";
  try {
    output = new TextDecoder().decode(FS.readFile(outPath));
  } catch (e) {}
  try { FS.unlink(outPath); } catch (e) {}
  if (blinkLog === null) {
    try { blinkLog = new TextDecoder().decode(FS.readFile("/blink.log")); } catch (e) {}
  }
  return { output: output, error: error, exitCode: exitCode, blinkLog: blinkLog };
}

self.onmessage = async function (ev) {
  var msg = ev.data;
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
