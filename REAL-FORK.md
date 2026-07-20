# Real fork(): giving each fork child its own address space

Successor to SCHEDULER-DESIGN.md's Phase 4. That phase deliberately shipped
"share, don't isolate" — fork children share the parent's `struct System`,
so memory AND fds are shared, with no copy-on-write. That was a
point-in-time decision to get concurrency working, **not** a permanent
architectural choice. This document is the plan to finish the job.

## Why now: the symptoms are all one root cause

Every remaining pipeline bug traces back to the missing isolation:

| symptom | mechanism |
|---|---|
| `cmd \| wc` fails on a cold VM with dash's `Out of space` | child's allocations corrupt dash's shared heap |
| `echo hello \| jq -R -s .` returns 6 bytes of *stale memory* for a 6-byte input | writer's buffer clobbered before `writev()` |
| `seq 1 5 \| head -2` poisons the VM on the 3rd command; everything after returns `""` silently | early reader exit leaves the pipe unresolvable (below) |
| host fds leak; child fd lists never torn down | no owner ever frees them |

They are not four bugs. They are one missing guarantee.

## The premise that made this look blocked, and why it's wrong

`Fork()` currently reasons:

> fds live on `struct System`, not `struct Machine`, so there is no way to
> share memory but NOT fds without splitting that struct

That is true, but it only constrains you if the goal is **shared memory +
private fds**. Real `fork()` wants **private memory + private fds** — which
is precisely what one fresh `System` per child gives you. The struct layout
that read as a blocker is actually aligned with fork semantics; it only
obstructed the hybrid Phase 4 was attempting.

Thread-style `clone(CLONE_VM)` (real `pthread_create`, and musl's
`posix_spawn` trampoline, which passes an explicit stack) still wants a
shared `System`. So `Fork()` branches on that, and both cases become
honest instead of one case pretending to be the other.

## What real fork() must do, vs. what we do today

| # | Real POSIX | Today | After |
|---|---|---|---|
| 1 | address space COW-copied, child's writes private | fully shared, only the stack duplicated | private copy |
| 2 | fd table copied; guest numbers preserved, open-file-descriptions shared | dup'd, numbers preserved via `realfd` (fixed in 7ee24de) | unchanged, but owned by the child's System |
| 3 | **child exit closes the child's fds** | never happens | `FreeSystem` does it |
| 4 | pipe: blocking read, EOF when last write end closes, `EPIPE` when last read end closes | temp file; `read()==0` ambiguous; no `EPIPE` | EOF becomes real (3); `EPIPE` still absent |
| 5 | child is a zombie until `wait()`, then reaped | fiber unlinked; Machine, 256 KB host stack, fd list all leaked | reaped |

Row 3 is why `seq 1 5 | head -2` wedges. `head` exits early; nothing closes
its fds; the write-end `Fd` stranded in the dead child's list keeps
`MvlPipeRef.refcount > 0` forever; `SysRead`'s retry loop (added in 7ee24de)
then waits for a writer that already exited, and that fiber never finishes.
Measured: a healthy 150-pipeline session frees 300 child stacks; a poisoned
one frees 4.

## What this deletes (final tally — the plan below over-estimated)

The plan assumed EVERY fork-style child would go private, but musl's
posix_spawn trampoline (Rust's `std::process::Command`, i.e. the sams CLI)
calls `clone(CLONE_VM|CLONE_VFORK, stack)` — genuinely shared memory with a
guest-supplied stack — and that path stays. So the shared-System machinery
splits into deleted vs. still-load-bearing:

**Deleted (done):**

- `EmSaveMem`/`EmRestoreMem`/`EmSaveFds`/`EmRestoreFds` + all their structs
  (`EmMemSnap`, `EmMemPage`, `EmFdSave`) and helpers (`EmSnapAdd`,
  `EmSnapFind`, `EmFreeMemSnap`) — the run-to-completion snapshot/restore
  era; uncalled since Phase 4 replaced that model
- the live-stack copy + red-zone arm of the shared path (`stack==0` with
  `CLONE_VM`) — unreachable: every no-stack fork now goes private, and
  posix_spawn always supplies a stack; a loud `eagain()` guards the arm in
  case a new caller ever trips it
- `em_forkstack` (field, reclaim in `EmForkChildEntry`, zeroing in
  `EmForkPrivate`) — only the deleted arm ever set it

**Kept, still load-bearing (for posix_spawn, not dash/toybox):**

- `EmDupFdsForChild` + `independent_fds`/`fds_list` swapping in
  `mvl_dispatch.c` — a CLONE_VM fork-style child shares memory but needs
  its own fd table; only the swap machinery can give it one
- `em_vfork_child` + `SysExecve`'s vfork-child branch + `SysExitGroup`'s
  gate — the execve-on-a-throwaway-Machine trick is exactly right for a
  child that shares the parent's memory
- `MvlPipeRef` refcount + `SysRead` retry loop — became *correct* rather
  than a workaround: `EmCloseAllFds` at child exit is what finally drives
  the refcount to 0 and turns "file at EOF" into "writer is genuinely gone"

## Implementation

Machinery that already exists and is proven:

- `EmWalkLeaves(system, cb, arg)` — walks every present leaf PTE in
  ascending virt order (`syscall.c`)
- `EmSaveMemCb` — already encodes the right COW insight: read-only pages
  (`.text`, file-backed `PROT_READ|PROT_EXEC`) can never diverge without an
  `mprotect` neither dash nor toybox issues, so only writable pages need
  copying. It also documents that writing *into* a read-only host page is a
  real SIGSEGV — confirmed under lldb.
- `NewSystem()` / `FreeSystem()`; `SysExecve` already builds a separate
  System mid-flight, so this is not novel
- `ReserveVirtual(s, virt, size, flags, fd, offset, shared, fixedmap)`
- spare PTE bits for a COW marker: `0x8`–`0x100` are unused
  (`PAGE_V/RW/U`=1/2/4, `PAGE_RSRV`=0x200, `PAGE_HOST`=0x400, …)

Constraint to respect: `NewMachine(system, parent)` asserts
`!parent || system == parent->system`, so the real-fork path must pass
`parent = 0` and replicate the register copy itself (the `parent` branch is
`memcpy(m, parent, sizeof(*m))` plus resetting `path`, `freelist`,
`pagelocks`, instruction cache, `insyscall`, `nofault`, `sysdepth`,
`sigdepth`, `signals`).

### Step 1 — eager copy (do this first)

Plain `fork()` (no `CLONE_VM`, no explicit stack):

1. `s2 = NewSystem(m->system->mode)`
2. `EmWalkLeaves` the parent; per present leaf, recreate it in `s2` with the
   same protection flags, copying content for materialized pages and
   recreating reservations as reservations (`PAGE_RSRV`) so first-touch
   still zeroes
3. copy the fd table into `s2->fds`, preserving guest `fildes` and `dup`ing
   the host fd (dup shares the open-file-description, which is what fork
   requires — same file offset)
4. copy System-level state: `rlim`, `exec`, `automap`, `brk`, `mode`
5. `m2 = NewMachine(s2, 0)`, replicate the parent's registers,
   `Put64(m2->ax, 0)`
6. no stack copy at all — the child's address space already contains the
   parent's stack at identical addresses
7. on child exit: `FreeSystem(s2)` (closes fds → real pipe EOF), then free
   the Machine and fiber stack

Eager copy is chosen first because it is obviously correct and reuses proven
code. Cost is proportional to mapped writable memory; dash's footprint is
small, and the current per-command cost is ~0.5 s, so a few ms of copying is
not the bottleneck. **Measure it** rather than assuming.

### Step 2 — COW, only if Step 1's copy cost shows up

`PAGE_RW` is genuinely enforced on the write path (`memory.c`: a write to a
non-RW page sets `SEGV_ACCERR` and faults), so COW is reachable:

1. add `PAGE_COW` using a spare bit
2. at fork, clear `PAGE_RW` and set `PAGE_COW` on writable pages in **both**
   parent and child; share the host page with a refcount
3. on a write fault to a `PAGE_COW` page, duplicate it, restore `PAGE_RW`,
   drop the old refcount, resume

Requires host-page refcounting, which the current allocator does not have —
which is exactly why Step 1 comes first.

## How it landed (post-mortem of the bookmark)

The bookmark's diagnosis ("dies writing into read-only .text") turned out to
be WRONG — a reasonable inference from where the log stopped, but not the
mechanism. Three real bugs, found in order once the read-only pages were
shared instead of copied:

1. **`NewSystem()` does not create the page-table root.** Only `LoadProgram`
   (loader.c) ever allocates `cr3`. `EmForkPrivate`'s fresh System had
   `cr3 = 0`, and under wasm walking page tables from root 0 is not a trap —
   `GetPageAddress` returns a near-NULL host pointer and every
   `StorePte`/`ReserveVirtual` silently corrupts the bottom of wasm linear
   memory until something unrelated falls over. This, not the read-only-page
   write, is what killed the first attempt on "page #1". Fix: mirror
   LoadProgram — `s2->cr3 = AllocatePageTable(s2)` (plus cr0) right after
   `NewSystem`.

2. **`FreeMachine()` already frees an orphan's System.** It dll_removes the
   machine and, when the list empties — always, for a real-fork child —
   calls `FreeSystem` itself. The child-exit teardown (and both fork failure
   paths) called `FreeSystem` again: double `DestroyFds`, double `free(s)`.
   Eight child exits of that corrupted the C heap enough to kill dash
   itself; the test signature was "first two pipelines pass, then the VM
   dies for good". Fix: `EmCloseAllFds(s)` (real fds must close — that is
   the pipe-EOF mechanism) then `FreeMachine(m)` ALONE.

3. **Read-only pages are shared, not copied** — `EmCopyAsCb` branches on
   `entry & PAGE_RW`: writable pages are copied via
   ReserveVirtual+CopyToUser as before; read-only ones get the parent's
   leaf PTE installed verbatim (`EmInstallSharedLeaf`) with a new
   **`PAGE_NOOWN`** flag (spare PTE bit 0x10, `__EMSCRIPTEN__` only).
   `FreePage()` sees NOOWN and drops only its accounting — never
   Munmaps/recycles backing it doesn't own — while still reporting
   exec-page invalidation so an in-place execve at the same load address
   can't execute stale decoded instructions. NOOWN is only applied when
   the entry has real backing to alias (`PAGE_HOST`); bare anonymous
   reservations stay untagged, since `HandlePageFault` preserves flags on
   materialize and a tagged child-owned page would leak at teardown.

Per-fork cost measured: **2098 pages walked, 44 shared, 8 pages
byte-copied (32 KB)** — the rest are dash's stack-region reservations,
recreated as reservations. ~4 ms/fork in practice: the 60-iteration
gate loop (120 pipelines, 266 forks) completes in ~1 s total, versus
~0.5 s per command before — the old latency was the pipe retry loops
that real EOF removed.

Gate results (2026-07-20): realfork-test.mjs ALL GREEN — the cold-VM
`seq 1 5 | head -2` case, all previously-poisoning cases, 0/60 loop
failures, 266/266 clean forks. contract 17/17, dist-smoke 5/5,
guest-userland 10/10 (incl. sqlite3-via-piped-stdin and jq-via-pipe as
hard assertions). stress: zero errors, drift ≤1.09×, heap 73→87.6 MB
plateau (the vfork-era model peaked at 540 MB on this profile); its 68
"integrity failures" are the reference dist lacking sqlite3/full wget —
pre-existing, unrelated, and themselves evidence of forks working (dash
fork+execs and reports `sqlite3: not found` cleanly).

Two workaround conflicts found earlier in the WIP remain fixed and load-bearing:

- `SysExitGroup` gated only on `em_vfork_child`, so a real-fork child fell
  through to KillOtherThreads/exit() and never stashed a status for
  SysWait4 — every pipeline returned "".
- `memcpy(m2, m, sizeof(*m2))` inherited the parent's `em_forkstack`, so the
  child would have freed the PARENT's stack while the parent was still on it.

## Verification

- `seq 1 5 | head -2` on a **cold** VM, followed by `echo hi | cat`: the
  early-exiting reader must not poison anything
- `cmd | wc`, `echo hello | jq -R -s .` (byte-exact, not just non-empty),
  `printf '{...}' | jq -c .b[0]` with the real 17-byte payload
- 150+ mixed pipelines with no degradation, and child stacks/Systems freed
  1:1 with forks (instrument and count; do not infer)
- full suite: `contract`, `dist-smoke`, `guest-userland`, `product-dist`,
  `stress`
- measure per-fork copy cost and total heap before/after

Two process notes learned the hard way, both of which silently produced
false results:

- `blink/build.sh` does `git checkout` + `git apply` from
  `blink/patches/blink-wasm.patch`, so **direct edits to `blink-src/` are
  discarded unless `blink/regen-patch.sh` runs first**. A probe build once
  measured a binary containing none of its probes.
- `LOGF` compiles to `(void)0` in production (`log.h`: `LOG_ENABLED 0` under
  `NDEBUG`, and we build `-DNDEBUG`), and blink's C `stderr` reaches neither
  the browser console nor the guest's captured output. The only channel that
  works is writing to a file in MEMFS and reading it back via
  `window.vm.readFile`.
