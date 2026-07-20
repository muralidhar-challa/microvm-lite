# Child-pid collision → spurious ECHILD ("No child process") — FIXED

**Status: fixed and verified.** Was blocking any `microvm-v*` production
tag; that block is lifted now that the fix is in and tested. Live on the
test CDN via SQL_Chat's real-fork swap; not yet promoted to production —
that's a separate, normal release decision, not a bug-block anymore.

## Symptom

Reported from SQL_Chat's subagent feature: a shelled-out subprocess (Rust's
`std::process::Command::new("sh")...output()`, in `tools-rs/src/bin/agent.rs`
line ~86) intermittently fails with:

```
Error: No child process (os error 10)
```

`os error 10` is `ECHILD` — the exact errno `wait4()` returns when the
kernel has no record of the pid you're waiting for.

## Root cause

Two facts combined into a real bug:

1. **`g_em_children[EM_MAX_CHILDREN]` (`syscall.c` ~574) is a single GLOBAL,
   process-wide table, keyed purely by pid** (`EmStashChildStatus`/
   `EmReapChildStatus`) — not scoped to a `System` at all. Any `Machine`
   anywhere in the process can stash or reap any entry.
2. **Child pids were allocated from `struct System::next_tid`
   (`machine.h:286`), which every freshly-created `System` starts at 0**
   (`NewSystem`'s `memset`). Both allocation sites — `NewMachine`'s
   shared-System branch (`memorymalloc.c:408`, real threads and
   `clone(CLONE_VM|CLONE_VFORK, stack)` — musl's posix_spawn, i.e. Rust's
   `std::process::Command`) and `EmForkPrivate` (`syscall.c:887`, real
   fork()'s own child pid) — computed
   `(system->next_tid++ & (kMaxThreadIds - 1)) + kMinThreadId`, so **the
   first child spawned by any fresh System always got the same pid,
   `kMinThreadId` (262144)**.

Real fork() gives every forked command its own brand-new `System` — not
just at exec boundaries, at every fork — so `next_tid` resets to 0 far
more often than before that work landed. Two independently-forked
lineages each spawning a `Command::new(...)` child with overlapping
lifetimes could both land pid 262144 in the same global table;
`EmStashChildStatus` doesn't check for an existing entry with the same
pid before writing a new one, so the table could hold two live entries
both claiming 262144, and whichever caller's `wait4()` ran first would
consume the wrong one — `ECHILD` for whoever lost the race.

## Fix (implemented)

Replaced the per-`System` `next_tid` counter, for pid allocation
specifically, with a single process-wide monotonic counter
(`g_em_next_child_pid`, declared `extern` in `machine.h`, defined in
`syscall.c` next to `g_em_children[]`) — shared across every `System`,
real-fork or shared-memory alike, so no two live children can ever get
the same pid regardless of how many independent `System`s exist.

- `EmForkPrivate` (`syscall.c:887`) now reads `g_em_next_child_pid`
  directly.
- `NewMachine`'s shared-System branch (`memorymalloc.c:408`) is gated
  `#ifdef __EMSCRIPTEN__`: wasm builds read `g_em_next_child_pid`; native
  blink keeps `system->next_tid` unchanged (correct there — each System
  is a real OS process, and native blink uses real host `wait4()`, not
  `g_em_children[]`, so per-process tid scoping was never wrong for it).
- Deliberately **not** reset by `em_reset_children()` (which clears
  `g_em_children[]` between top-level commands): the collision that
  mattered is two lineages live *within* one top-level command (e.g.
  subagent-style concurrent dispatch), and resetting the pid counter the
  same way would reopen that exact window every command.

## Verification

- Direct repro (`pidcollide-repro.c`, `posix_spawn` + print the spawned
  pid, deliberately unreaped): two sequential foreground calls now get
  distinct pids (262147, 262148 — previously both would have been
  262144). One backgrounded call also clean (262150).
- **Realistic host-overlap pattern** (`isolate-hostoverlap.mjs`): two
  concurrent `vm.execute()` calls fired without awaiting the first — no
  guest-side `&` at all, matching how overlap would actually occur if
  `agent_busy` (a *prompt-level*, not code-enforced, guard in
  `system.md`) were ever violated — 25/25 clean, zero collisions, zero
  hangs.
- Full regression: `realfork-test.mjs` (0/60 fail), `contract.spec.mjs`
  (17/17), `guest-userland.mjs` (10/10) all green after the fix.

## A second, separate finding — not fixed, likely not on the real path

While isolating the above, found that **two jobs backgrounded with `&`
under ONE dash process, then waited on with a single `wait` builtin,
hangs completely** (`isolate-hang.mjs`/`isolate-hang2.mjs` — deterministic,
first try, not a race). This is a different bug from the pid collision
above (it reproduces even with plain `sleep &` and no `posix_spawn` at
all in some variants tested) — most likely a scheduler/job-control
interaction specific to one shell backgrounding multiple children and
`wait`ing on all of them at once.

**Deliberately not chased further**: `system.md`'s `Delegate()` procedure
explicitly documents "foreground, never background (&)", and the
realistic overlap path (separate `vm.execute()` calls, verified above) is
what subagent actually risks, not guest-side `&`. Revisit only if a real
usage pattern is found that needs guest-side backgrounding — not blocking
anything today.

## Status

- **Fixed and verified**, per above.
- No longer blocks a `microvm-v*` tag on its own; production promotion is
  a separate, ordinary release decision now.
- Related: [[REAL-FORK.md]] — this bug was a side effect of real fork()'s
  private-System-per-fork model, not a flaw in the private-address-space
  design itself.
