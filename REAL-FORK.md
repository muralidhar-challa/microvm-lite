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

## What this deletes

Real fork is mostly **removal**. These exist only to survive shared memory:

- `em_forkstack` reclaim — child's stack lives in its own address space
- live-stack copy + red-zone slack — no stack aliasing exists to fix
- `EmDupFdsForChild`, and `independent_fds`/`fds_list`/`g_mvl_canonical_fds`
  swapping in `mvl_dispatch.c` — each System owns its fds, nothing to swap
- `MvlPipeRef` refcount + `SysRead` retry loop — becomes *correct* rather
  than a workaround, because `FreeSystem` closing child fds is what finally
  makes the refcount reach 0. (Keep it: it is the mechanism that turns
  "file at EOF" into "writer is genuinely gone".)
- `em_vfork_child` + `SysExecve`'s vfork-child branch (the nested
  `RunMachineUntilExit(m2)` on a throwaway System) — a child with private
  memory can just `execve` in place
- `EmSaveMem`/`EmRestoreMem` snapshot/restore — the trick that existed only
  to undo a shared-memory child's damage

`Fork()`'s eagain-on-no-stack-room guard (76fa8d0) stays: failing loudly
beats corrupting, regardless of model.

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

## Where the first attempt stopped (bookmark)

Branch `wip/real-fork`. Compiles; `Fork()` branches correctly
(`FORK flags=0 stack=0 -> PRIVATE`); `EmForkPrivate` is entered
(`FORKENTER tid=42`). It then dies on the **first page it tries to copy**:

    copying page #1 virt=400000 entry=60000000004c05

`virt=0x400000` is dash's ELF load address and the entry decodes to
PAGE_V | PAGE_U | PAGE_HOST | PAGE_MAP | PAGE_MUG | PAGE_FILE with
**PAGE_RW clear** — i.e. the read-only, file-backed, host-mmapped `.text`
segment. `EmCopyAsCb` reserves it writable and `CopyToUser`s into it, which
is precisely what EmSaveMemCb documents as fatal:

> restoring INTO a genuinely read-only host page (e.g. after a real host
> mmap(PROT_READ|PROT_EXEC) for the executable's file-backed .text) is an
> actual SIGSEGV/SIGBUS — confirmed via lldb

So the approach is wrong for that page class, and it is the first page every
fork touches.

**Next step:** don't copy read-only pages at all — SHARE them, which is what
real COW fork does and what EmSaveMemCb already concluded (they cannot
diverge without an mprotect neither dash nor toybox issues). Branch
`EmCopyAsCb` on `entry & PAGE_RW`: copy writable pages as it does now,
install the parent's PTE directly for read-only ones. The one hazard to
resolve is teardown — `FreeSystem` on the child must not free a host page
the parent still owns, so shared pages need a refcount or an exclusion from
the child's FreeHostPages.

Two workaround conflicts were found and are already fixed in this WIP; both
were silent and both are worth keeping regardless of how the copy is done:

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
