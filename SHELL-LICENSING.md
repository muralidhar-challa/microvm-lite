# Shell licensing: resolution

Status: **resolved.** The reference build is GPL-free: **dash** (BSD-3-Clause)
for `/bin/sh` + **toybox** (0BSD) for coreutils.

## What worked

- **dash 0.5.12** — BSD-3-Clause, built page-aligned for blink
  (`-Wl,-z,common-page-size=65536,-z,max-page-size=65536`). Works as both
  primary shell and forked child. No `setjmp`/`longjmp` issue — the earlier
  prediction that ash/dash-family shells would hit the oksh-class fork bug
  was incorrect.
- **toybox 0.8.14** — 0BSD, multi-call binary providing 46 coreutils.

## Actual blockers (not the fork model)

The fork-model `setjmp`/`longjmp` bug documented below is real for oksh/loksh,
but dash was blocked by two unrelated issues:

1. **blink `Exec()` host-fd injection** — blink's first-time program load
   adds host fds 0-9 into the guest fd table (`SetupCod`/`AddStdFd` in
   `blink/blink.c`). This confuses musl libc's own stdio initialization for
   non-busybox binaries. Fix: `#ifndef __EMSCRIPTEN__` around that block.
2. **Page alignment** — dash's default page alignment (4K) doesn't match
   blink's linear-memory expectations. Fix: build with 64K alignment.

## Remaining GPL components

| Component | License | Bundle | Notes |
|---|---|---|---|
| Poppler (`pdftotext`, etc.) | GPL-2.0 | lazy (oss) | Only fetched on first pdf*/sqlite3 trigger |
| ~~BusyBox~~ | ~~GPL-2.0~~ | ~~eager (base)~~ | Replaced by dash + toybox |

## Why oksh/loksh still don't work (Option 3)

The `setjmp`/`longjmp` fork-model bug documented below is still real.
oksh's `genv`/`unwind()` pattern corrupts shared parent state under blink's
run-to-completion vfork. Fixing this requires Option 3 (COW page-table
cloning in `Fork()`), which is not started. Not needed for dash.

---

*The rest of this document is the original investigation, preserved for context.*

## Original investigation
