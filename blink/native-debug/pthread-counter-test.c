// Phase 3 gate (SCHEDULER-DESIGN.md): a real GUEST binary, cross-compiled
// with musl, that calls pthread_create() twice. Two workers each increment
// a SHARED counter kIters times under a mutex, main() joins both and
// checks the final total — proving genuine concurrent execution (not just
// host C code poking guest memory directly, like Phase 2) survives a real
// clone(CLONE_THREAD)/futex/pthread_join round trip.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define ITERS 20000

static long g_counter = 0;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

static void *Worker(void *arg) {
  long i;
  (void)arg;
  for (i = 0; i < ITERS; i++) {
    pthread_mutex_lock(&g_lock);
    g_counter++;
    pthread_mutex_unlock(&g_lock);
  }
  return 0;
}

int main(void) {
  pthread_t t1, t2;
  if (pthread_create(&t1, 0, Worker, 0)) {
    fprintf(stderr, "pthread_create t1 failed\n");
    return 1;
  }
  if (pthread_create(&t2, 0, Worker, 0)) {
    fprintf(stderr, "pthread_create t2 failed\n");
    return 1;
  }
  pthread_join(t1, 0);
  pthread_join(t2, 0);
  if (g_counter != 2 * ITERS) {
    fprintf(stderr, "FAIL: counter=%ld want=%d (torn write or lost update)\n",
            g_counter, 2 * ITERS);
    return 1;
  }
  printf("PASS: counter=%ld\n", g_counter);
  return 0;
}
