// CHILD-PID-COLLISION-BUG.md repro. Spawns one child via posix_spawn (musl's
// implementation calls clone(CLONE_VM|CLONE_VFORK,...) — the exact path
// NewMachine's shared-System tid allocation covers) and prints its pid,
// unreaped. Run twice under two independent fork lineages (e.g. `a & b &
// wait` at the guest shell) — before the fix both print the same pid
// (kMinThreadId, 262144, since each lineage's fresh System's next_tid/
// g_em_next_child_pid started at 0); after the fix they never collide.
#include <spawn.h>
#include <stdio.h>
#include <unistd.h>
extern char **environ;
int main(void) {
  pid_t pid;
  char *argv[] = {"/bin/dash", "-c", "sleep 1", NULL};
  int rc = posix_spawn(&pid, "/bin/dash", NULL, NULL, argv, environ);
  if (rc != 0) { printf("posix_spawn failed: %d\n", rc); return 1; }
  printf("spawned pid=%d\n", pid);
  return 0;
}
