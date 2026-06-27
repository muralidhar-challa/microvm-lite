import factory from "../busybox.js";

const wasmBytes = await Deno.readFile(new URL("../busybox.wasm", import.meta.url));

const mod = await factory({
  noInitialRun: true,
  noExitRuntime: true,
  thisProgram: "busybox",
  locateFile: (p: string) => p,
  async instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    cb(instance);
    return instance.exports;
  },
});

const stdout: string[] = [];
mod.print = (t: string) => stdout.push(t);
mod.printErr = (t: string) => stdout.push("ERR:" + t);
mod.quit = (status: number) => { throw new Error("ExitStatus:" + status); };

function run(args: string[]) {
  stdout.length = 0;
  try {
    mod.callMain(args);
  } catch (e) {
    // expected exit
  }
  console.log(JSON.stringify(args), "->", stdout.join("\n"));
}

run(["echo", "hello"]);
run(["ls", "-la", "/"]);
run(["busybox", "echo", "hello2"]);

function writeFile(path: string, content: string) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts.slice(0, -1)) {
    cur += "/" + p;
    try { mod.FS.mkdir(cur); } catch (_e) {}
  }
  mod.FS.writeFile(path, content);
}

writeFile("/tmp/x.txt", "hello vfs\n");
run(["cat", "/tmp/x.txt"]);

writeFile("/tmp/y.txt", "foo\nbar\nfoobar\n");
run(["grep", "foo", "/tmp/y.txt"]);

writeFile("/tmp/z.txt", "foo bar\n");
run(["sed", "s/foo/baz/", "/tmp/z.txt"]);

writeFile("/tmp/w.txt", "a b c\n");
run(["awk", "{print $2}", "/tmp/w.txt"]);

run(["sh", "-c", "echo abc | grep a | wc -l"]);

run(["sh", "-c", "echo single"]);
run(["sh", "-c", "cat /tmp/x.txt"]);
run(["sh", "-c", "echo a; echo b"]);
