# Shell licensing: findings and options

Status: **investigated, not implemented.** This documents the outcome of
evaluating permissive (non-GPL) replacements for `/bin/sh` in `microvm/`, so
the work isn't lost and the decision can be revisited with full context.

## Goal

`microvm/` currently uses BusyBox (GPL-2.0) for its shell (`hush`) and
coreutils. The runtime's own code is MIT and ships no bundled binaries (see
`CREDITS.md`), but the *reference build* fetches BusyBox at runtime, so
integrators who use the default build inherit BusyBox's GPL obligations if
they redistribute it. Goal: find a permissive (MIT/ISC/BSD/public-domain)
`/bin/sh` so the reference build can be GPL-free end to end.

## What was ruled out

- **sbase** (suckless, MIT): ~90 coreutils, **no shell at all**. Not a
  candidate for `/bin/sh`; still a fine permissive coreutils replacement.
- **9base** (Plan 9 port): its only shell is `rc`, which is **not POSIX** —
  different control-flow syntax entirely (`if(~ $1 hello)`, C-like `switch`,
  `>[1=2]` redirection). Can't parse the `$()`/`&&`/`[ ]` syntax the agent and
  its tools emit. Not viable as `/bin/sh`.
- **oksh** (portable OpenBSD ksh, public-domain/BSD/ISC): builds cleanly as a
  static x86-64-musl binary and passes every basic POSIX check. **Fails
  under blink's WASM fork model** — see below. Not currently viable.
- **loksh**: same pdksh/OpenBSD-ksh lineage as oksh, expected to hit the
  identical failure (not separately tested, but the root cause is
  architectural, not oksh-specific).

## Root cause: shared memory across blink's `Fork()`

blink's M2 process model (`microvm/blink/patches/blink-wasm.patch`) emulates
`fork()`/`vfork()` by running the "child" **on the same guest memory as the
parent**, to completion, then restoring the parent's saved registers — a
deliberate simplification, since WASM has no real `fork()` to lean on. This
matches real `fork()` semantics *from the return-value perspective* (child
sees 0, parent sees the child pid), but not from the *memory-isolation*
perspective: real `fork()` gives the child a copy-on-write copy of the whole
address space, so anything the child mutates is invisible to the parent
afterward. Our model doesn't — parent and child share one address space.

BusyBox's `hush` never surfaces this because its control flow after a fork
returns normally up the C call stack — no shared global state gets mutated
in a way that outlives the child.

oksh (and the whole pdksh family) does: shell state (loops, traps, "this
forked child is done" signaling) is managed via a global `genv` linked list
and `setjmp`/`longjmp` (`unwind()` in `main.c`). On real Unix, the forked
child's `longjmp` only unwinds *its own* copy of `genv` (courtesy of COW) and
exits *that* process. Under blink's shared-memory model, the child's
`longjmp` unwinds the **one shared `genv`**, and doesn't stop at "this child
is done" — it propagates all the way to the shell's top-level parse loop,
silently abandoning the rest of the script.

**Verified, not theoretical:** built oksh static-musl, ran it under the real
WASM worker. `busybox echo one; echo AFTER_ONE; busybox echo two; echo
AFTER_TWO` printed `one` and stopped — everything after the first external
fork+exec was lost. Confirmed via strace-equivalent isolation that a *single*
external fork+exec already triggers `oksh: internal error: exchild:
execute() returned`, and confirmed via a **native (real-fork) build of the
same source on this machine** that the bug does not reproduce there —
isolating it to blink's WASM fork emulation specifically, not oksh's code or
build configuration.

This generalizes: any shell using `setjmp`/`longjmp`-based control flow
across a forked child (loksh, and plausibly ash/dash-family shells, which use
a similar `error()`/`exitshell()` pattern) is expected to hit the same class
of bug.

## Options considered

| # | Option | Generalizes to any shell? | Effort | Verdict |
|---|---|---|---|---|
| 1 | Patch oksh's specific `unwind(LLEAVE)` call site in `jobs.c` to `_exit()` directly | No — fixes one call site in one shell; other `unwind()`-reachable paths (traps, command substitution) may hit the same bug differently | Small, uncertain coverage | Not pursued |
| 2 | Keep BusyBox `hush` as `/bin/sh`; use permissive coreutils (sbase/toybox) for everything else | No — works because `hush` happens not to trigger the bug, not because the bug is fixed | Small | **Pragmatic near-term default** |
| 3 | Fix blink's `Fork()` to give the child a true copy-on-write copy of guest memory (not just registers) | **Yes** — fixes the actual root cause for any guest program, not just shells | Large, new subsystem | **Correct long-term fix; not started** |

## Option 3, sized honestly

Feasibility was checked against blink's actual internals, not assumed:

- Blink's guest memory **is** a real 4-level x86-64 page table (PML4 → PDPT →
  PD → PT, `blink/pml4t.h`) backed by host pages (`struct HostPage`,
  `memorymalloc.c`) — a walkable structure, so this is buildable in principle.
- **This capability does not exist anywhere in blink today.** Native blink's
  `SysFork` just calls the real host `fork()` and lets the OS kernel's own
  COW machinery do the work for free — blink itself has never needed to
  implement guest-memory duplication.
- Building it means: at `Fork()` time, walk the parent's page tables,
  allocate fresh host pages, copy each mapped page's bytes, and construct an
  equivalent page-table hierarchy in a new `System` — then run the "child" on
  that isolated copy instead of the shared one. This is the same job a real
  OS kernel's `fork()` does.

This is new low-level VM-memory-management code — qualitatively different
from every patch built so far (M2/M3/M5 all plumbed *existing* blink
mechanisms together; this is a new subsystem). Comparable in scope to M2
itself. Open question, not yet answered: per-fork cost scales with the
guest's resident memory at fork time — unmeasured, and matters for
fork-heavy scripts (loops spawning many externals).

## Recommendation

- **Short term:** stay on BusyBox `hush` for `/bin/sh`; adopt permissive
  coreutils (sbase or toybox) for the rest of the tool surface as a
  standalone, low-risk change. This shrinks the GPL footprint to "just the
  shell" without touching blink internals.
- **Long term, if pursued:** treat option 3 as its own milestone (design doc
  + benchmarked prototype, the same way M2 was planned) before writing code.
  Not started.

## Artifacts from this investigation

- oksh build recipe (cross-compiling with `x86_64-linux-musl-gcc`, using a
  native `blink-native` build as the `CONFTEST_RUNNER` to work around
  `configure`'s "must execute a test binary" check when cross-compiling):
  kept only in this document, not committed as build scripts (the resulting
  binary isn't usable as `/bin/sh` yet).
- Reproduction commands, for whoever picks this up next:
  ```sh
  # after building oksh static-musl and staging it as /bin/oksh in the guest:
  oksh -c 'busybox echo one; echo AFTER_ONE; busybox echo two; echo AFTER_TWO'
  # expected (real fork): one / AFTER_ONE / two / AFTER_TWO
  # actual (blink WASM):  one
  #                       oksh: internal error: exchild: execute() returned
  ```
