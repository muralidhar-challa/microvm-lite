// Static file server with COOP/COEP headers so SharedArrayBuffer is available.
const root = new URL(".", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".ts": "application/javascript", // served as-is; browsers won't execute but useful for fetch
};

Deno.serve({ port: 8769 }, async (req) => {
  const url = new URL(req.url);
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/browser-test.html";
  const filePath = root + path.slice(1);
  try {
    const data = await Deno.readFile(filePath);
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(data, {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    });
  } catch (_e) {
    return new Response("Not found", { status: 404 });
  }
});
