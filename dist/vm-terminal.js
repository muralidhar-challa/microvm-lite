// microvm-lite terminal — a composable, CDN-deliverable xterm.js front end for
// window.vm. Ports blink/shell.html's interactive REPL feel (line editing,
// backspace, paste, Ctrl-C, pipes) onto the M4 window.vm contract instead of
// shell.html's direct callMain/FS wiring, so it works against the real worker
// (vfork/execve, HTTP bridge, snapshots) rather than a single in-page Module.
//
// Zero-config by default: import this module from the same CDN directory as
// vm-host.js/vm-worker.js/manifest.json, call attachTerminal(container), and
// it locates its own xterm.js/xterm-addon-fit/xterm.css siblings (via
// import.meta.url) and injects them if not already on the page. No caller-side
// asset wiring, no bundler config — just <script type="module"> + one call.
//
//   import { attachTerminal } from "https://cdn.example.com/vm-terminal.js";
//   const term = await attachTerminal(document.getElementById("term"));
//   // term.dispose() to tear down.
//
// Optional opts: { vm, cdnBase, cwd, prompt, theme, onExit }
//   vm       — an already-started window.vm-shaped object (default: window.vm,
//              awaiting vm.ready() if it's not up yet).
//   cdnBase  — override where xterm.min.js/xterm-addon-fit.min.js/xterm.css are
//              fetched from (default: this module's own directory).
//   cwd      — starting working directory (default: whatever `pwd` reports).
//   prompt   — (cwd) => string, default green "<cwd> $ ".
//   theme    — xterm.js Terminal `theme` option override.

const DEFAULT_ASSET_BASE = new URL(".", import.meta.url).href.replace(/\/+$/, "");

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    for (const s of document.getElementsByTagName("script")) {
      if (s.src === src) { s.dataset.loaded === "1" ? resolve() : s.addEventListener("load", () => resolve()); return; }
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

function loadStyleOnce(href) {
  if ([...document.styleSheets].some((ss) => ss.href === href)) return;
  for (const l of document.getElementsByTagName("link")) if (l.href === href) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

async function ensureXterm(assetBase) {
  if (window.Terminal && window.FitAddon) return;
  loadStyleOnce(assetBase + "/xterm.css");
  await loadScriptOnce(assetBase + "/xterm.min.js");
  await loadScriptOnce(assetBase + "/xterm-addon-fit.min.js");
}

async function waitForVm(vm) {
  if (vm.isReady) return;
  await vm.ready();
}

const SMART_QUOTES = { "‘": "'", "’": "'", "“": '"', "”": '"' };
// Printable-only marker — a raw control byte (e.g. \x01) in the guest command
// crashes blink (Aborted()), confirmed by testing. Newline-anchored so it can't
// collide with ordinary command output on the same line.
const PWD_MARK = "\n__MVL_PWD__:";

export async function attachTerminal(container, opts = {}) {
  if (!container) throw new Error("attachTerminal: container element required");

  const assetBase = (opts.cdnBase || DEFAULT_ASSET_BASE).replace(/\/+$/, "");
  await ensureXterm(assetBase);

  const vm = opts.vm || window.vm;
  if (!vm) throw new Error("attachTerminal: no window.vm — start the VM (startVM()) before attaching a terminal");
  await waitForVm(vm);

  const promptFn = opts.prompt || ((cwd) => "\x1b[32m" + cwd + "\x1b[0m $ ");

  const terminal = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", monospace',
    theme: opts.theme || { background: "#0d0d0d", foreground: "#e0e0e0", cursor: "#00ff88" },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();
  const onResize = () => fitAddon.fit();
  window.addEventListener("resize", onResize);
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container);

  let cwd = opts.cwd || null;
  let lineBuffer = "";
  let running = false;
  let disposed = false;

  function showPrompt() { if (!disposed) terminal.write("\r\n" + promptFn(cwd || "~")); }

  // Every line is wrapped so cwd persists across separate vm.execute() calls —
  // each call is otherwise stateless (a fresh `sh -c` per command) — and so a
  // `cd` the user typed sticks for the next line, same as a real shell.
  async function runLine(line) {
    line = line.trim();
    if (!line) { showPrompt(); return; }
    if (line === "clear") { terminal.write("\x1b[2J\x1b[H"); showPrompt(); return; }

    const cdPrefix = cwd ? 'cd "' + cwd.replace(/"/g, '\\"') + '" 2>/dev/null; ' : "";
    const wrapped = cdPrefix + line + '; printf "' + PWD_MARK + '%s\\n" "$(pwd)"';

    try {
      const out = await vm.execute(wrapped, opts.timeout || 30000);
      const idx = out.lastIndexOf(PWD_MARK);
      let shown = out, newCwd = null;
      if (idx !== -1) {
        shown = out.slice(0, idx).replace(/\n$/, "");
        newCwd = out.slice(idx + PWD_MARK.length).trim() || null;
      }
      if (newCwd) cwd = newCwd;
      if (shown) terminal.write(shown.replace(/\n/g, "\r\n"));
    } catch (e) {
      terminal.write("\r\n\x1b[31m[error: " + (e && e.message || e) + "]\x1b[0m");
    }
    showPrompt();
  }

  const dataHandler = terminal.onData((data) => {
    if (running || disposed) return;
    const isPaste = data.length > 1 && ![...data].every((c) => c.charCodeAt(0) < 32);
    if (isPaste) {
      const pasted = data.replace(/\r/g, "");
      terminal.write(pasted);
      lineBuffer += pasted;
      return;
    }
    for (let i = 0; i < data.length; i++) {
      const ch = SMART_QUOTES[data[i]] || data[i];
      const c = ch.charCodeAt(0);
      if (c === 13) { // Enter
        running = true;
        terminal.write("\r\n");
        const line = lineBuffer;
        lineBuffer = "";
        runLine(line).finally(() => { running = false; });
      } else if (c === 127) { // Backspace
        if (lineBuffer.length > 0) { lineBuffer = lineBuffer.slice(0, -1); terminal.write("\b \b"); }
      } else if (c === 3) { // Ctrl-C — blink has no preemption point (run-to-completion),
        lineBuffer = "";      // so this only clears the pending line, not a running command.
        terminal.write("^C");
        showPrompt();
      } else if (c >= 32) {
        lineBuffer += ch;
        terminal.write(ch);
      }
    }
  });

  terminal.write("\x1b[32mmicrovm-lite\x1b[0m ready.\r\n");
  if (!cwd) {
    try { cwd = (await vm.execute("pwd", 10000)).trim() || null; } catch { /* leave null, prompt shows ~ */ }
  }
  showPrompt();
  terminal.focus();

  return {
    terminal,
    fitAddon,
    get cwd() { return cwd; },
    dispose() {
      if (disposed) return;
      disposed = true;
      dataHandler.dispose();
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
      terminal.dispose();
      opts.onExit && opts.onExit();
    },
  };
}