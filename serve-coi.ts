// Static file server with COOP/COEP headers so SharedArrayBuffer is available.
const root = new URL(".", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
};

Bun.serve({
  port: 8769,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/browser-test.html";
    const filePath = root + path.slice(1);
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    });
  },
});
