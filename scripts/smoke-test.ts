import { createBusyboxRunner } from "./busybox_runner.ts";

const runner = await createBusyboxRunner();

console.log("=== echo ===");
console.log(await runner.run({ args: ["busybox", "echo", "hello from busybox.wasm"] }));

console.log("=== ls / ===");
console.log(await runner.run({ args: ["busybox", "ls", "-la", "/"] }));

console.log("=== write + cat ===");
console.log(
  await runner.run({
    args: ["busybox", "cat", "/tmp/x.txt"],
    files: [{ path: "/tmp/x.txt", content: "hello vfs\n" }],
  }),
);

console.log("=== sh -c pipe ===");
console.log(
  await runner.run({
    args: ["busybox", "sh", "-c", "echo abc | grep a | wc -l"],
  }),
);

console.log("=== grep ===");
console.log(
  await runner.run({
    args: ["busybox", "grep", "foo", "/tmp/y.txt"],
    files: [{ path: "/tmp/y.txt", content: "foo\nbar\nfoobar\n" }],
  }),
);

console.log("=== sed ===");
console.log(
  await runner.run({
    args: ["busybox", "sed", "s/foo/baz/", "/tmp/z.txt"],
    files: [{ path: "/tmp/z.txt", content: "foo bar\n" }],
  }),
);

console.log("=== awk ===");
console.log(
  await runner.run({
    args: ["busybox", "awk", "{print $2}", "/tmp/w.txt"],
    files: [{ path: "/tmp/w.txt", content: "a b c\n" }],
  }),
);
