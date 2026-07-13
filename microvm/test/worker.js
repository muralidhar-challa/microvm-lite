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

var BINARIES = ["busybox", "xtool", "probe"];
var APPLETS = [
  "sh", "hush", "ls", "cat", "sed", "awk", "grep", "find", "head", "tail",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "echo", "printf",
  "wc", "sort", "uniq", "cut", "tr", "xargs", "env", "pwd", "id",
  "chmod", "stat", "du", "df", "diff", "md5sum", "tar", "gzip", "gunzip",
];

self.Module = {
  preRun: [
    function () {
      FS.mkdir("/root");
      FS.mkdir("/bin");
      ENV["HOME"] = "/root";
      ENV["PATH"] = "/bin:/root";
      ENV["TERM"] = "xterm";

      BINARIES.forEach(function (name) {
        addRunDependency("fetch-" + name);
      });
      BINARIES.forEach(function (name) {
        fetch(name)
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            FS.writeFile("/bin/" + name, new Uint8Array(buf), { mode: 0o755 });
            if (name === "busybox") {
              APPLETS.forEach(function (a) {
                try { FS.writeFile("/bin/" + a, new Uint8Array(buf), { mode: 0o755 }); } catch (e) {}
              });
            }
            removeRunDependency("fetch-" + name);
          })
          .catch(function (e) {
            self.postMessage({ type: "dbg", text: "fetch " + name + " failed: " + e });
            removeRunDependency("fetch-" + name);
          });
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
  try {
    exitCode = await callMainAsync(["blink"].concat(argv));
  } catch (e) {
    error = e && e.message ? e.message : String(e);
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
  return { output: output, error: error, exitCode: exitCode };
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
    self.postMessage({ type: "result", id: msg.id, output: r.output, error: r.error, exitCode: r.exitCode });
  }
};

moduleReadyPromise.then(function () {
  self.postMessage({ type: "ready" });
});
