# Bookmark: child-pid collision → spurious ECHILD ("No child process")

**Status: open, not yet fixed. Do not tag a `microvm-v*` release (production
deploy trigger) until this is resolved.** Currently only live on the test
CDN, via SQL_Chat's merged real-fork swap.

## Symptom

Reported from SQL_Chat's subagent feature: a shelled-out subprocess (Rust's
`std::process::Command::new("sh")...output()`, in `tools-rs/src/bin/agent.rs`
line ~86) intermittently fails with:

```
Error: No child process (os error 10)
```

`os error 10` is `ECHILD` — the exact errno `wait4()` returns when the
kernel has no record of the pid you're waiting for. The report also
mentioned "the loop isn't exiting", consistent with whatever retry logic
sits above this `Command::output()` call spinning on a wait that can never
succeed once the status has been lost.

## Root cause

Two facts combine into a real bug:

1. **`g_em_children[EM_MAX_CHILDREN]` (`syscall.c` ~574) is a single GLOBAL,
   process-wide table, keyed purely by pid** (`EmStashChildStatus`/
   `EmReapChildStatus`, ~598-625) — not scoped to a `System` at all. Any
   `Machine` anywhere in the process can stash or reap any entry.
2. **Child pids are allocated from `struct System::next_tid`
   (`machine.h:286`), which every freshly-created `System` starts at 0**
   (`NewSystem`'s `memset(s, 0, sizeof(*s))`). Both allocation sites:
   - `NewMachine`'s shared-System branch (`memorymalloc.c:408`) — real
     threads and `clone(CLONE_VM|CLONE_VFORK, stack)` (musl's posix_spawn,
     i.e. Rust's `std::process::Command` — exactly what `agent.rs` uses).
   - `EmForkPrivate` (`syscall.c:887`) — real fork()'s own child pid.

   Both compute `(system->next_tid++ & (kMaxThreadIds - 1)) + kMinThreadId`
   — with `next_tid` starting at 0, **the first child spawned by any fresh
   System always gets the same pid, `kMinThreadId` (262144)**.

Before today's real-fork work, a shell session's `System` was long-lived —
`next_tid` kept incrementing across many sequential commands, and only
reset at an actual `execve()` boundary (`SysExecve`'s vfork branch already
built a fresh `System`). Pid collisions were rare: mostly sequential, with
old statuses already reaped before a new 262144 was issued.

**Real fork() (this session) gives every single forked command its own
brand-new `System`** — not just at exec boundaries, at every fork. `next_tid`
now resets to 0 far more often. If two independently-forked lineages each
spawn a `Command::new(...)` child with overlapping lifetimes (very plausible
under the cooperative scheduler, since `SysWait4` yields — `MvlSchedYieldOnce`
— rather than blocking, letting unrelated fibers run pid-262144-allocating
code while a wait is outstanding), **both land pid 262144 in the same
global table.** `EmStashChildStatus` doesn't check for an existing entry
with the same pid before writing a new one — it just claims the first free
slot — so the table can hold two live entries both claiming pid 262144.
`EmReapChildStatus`'s linear scan then returns whichever one it finds
first, for whichever caller asks first. The rightful caller can end up
with nothing left to reap: `ECHILD`, exactly matching the report.

This is a **latent bug that predates today**, but today's change to
"private System per fork" (not just per exec) sharply increased how often
`next_tid` resets to 0, making the collision window far more likely to be
hit in practice — hence surfacing now, specifically via subagent's
`Command::new("sh")` pattern (the shared-System/`CLONE_VM` path, not real
fork itself — real fork's own children aren't the ones colliding here,
they're what's resetting the counters that then collide for the *other*
path).

## Fix direction (not yet implemented)

Replace the per-`System` `next_tid` counter with a single **process-wide**
monotonic counter for pid allocation — shared across every `System`,
real-fork or shared-memory alike — so no two live, unreaped children can
ever get the same pid regardless of how many independent `System`s exist
concurrently. Both allocation sites (`memorymalloc.c:408`,
`syscall.c:887`) need to read from the same global. `EM_MAX_CHILDREN = 64`
should also be reconsidered once pids stop colliding — 64 concurrent
unreaped children is a separate, real ceiling worth checking against
actual subagent fan-out.

## Reproduction (not yet built)

No isolated repro exists yet. Plan: two overlapping `sh -c 'sleep-then-
Command::new-sh'`-style guest invocations (or a tight loop of
`agent`-style shell-outs) run concurrently via the scheduler, asserting no
`ECHILD` and that every spawned child's real exit status is what gets
reaped (not another lineage's). `test/` already has the scheduler-phase
selftests (`phase2`, `phase3-pthread`) as a starting pattern.

## Status

- **Not fixed.** Diagnosed only — root cause and mechanism above are high
  confidence (traced through the actual allocation and reaping code), but
  unverified by a live repro or a fix attempt.
- **Blocks:** any `microvm-v*` tag (production deploy). Test CDN already
  carries the bug; do not promote further until this is fixed and
  verified.
- Related: [[REAL-FORK.md]] — this bug is a side effect of real fork()'s
  private-System-per-fork model, not a flaw in the private-address-space
  design itself.
