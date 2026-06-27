#include "em-shell.h"
#include <emscripten.h>
#include <errno.h>

#undef _exit
#undef dup2
#undef close
#undef pipe

jmp_buf vfork_jump_buffer;
static int vfork_child_active = 0;
static int vfork_child_pid = 0;

// JS function declarations - implemented in em-shell.js
extern int js_fork(void);
extern void js_unfork(int status);
extern int js_spawn(const char *file, char *const argv[]);
extern void js_pipe(int fds[2]);
extern void js_pipe_close(int vfd);
extern void js_set_redirects(int stdin_vfd, int stdout_vfd, int stderr_vfd);

int em_vfork(int is_parent) {
    if (is_parent) {
        vfork_child_active = 0;
        errno = 0;
        return vfork_child_pid;
    }
    else {
        vfork_child_active = 1;
        vfork_child_pid = js_fork();
        return 0;
    }
}

void em_exit(int status) {
    if (vfork_child_active) {
        js_unfork(status);
        longjmp(vfork_jump_buffer, 1);
    } else
        _exit(status);
}

#define VIRTUAL_FD_BASE 10000

static int pending_redirect[3] = {-1, -1, -1};

int em_execvp(const char *file, char *const argv[]) {
    js_set_redirects(pending_redirect[0], pending_redirect[1], pending_redirect[2]);
    pending_redirect[0] = pending_redirect[1] = pending_redirect[2] = -1;
    errno = js_spawn(file, argv);
    if (errno)
        return -1;
    else if (vfork_child_active)
        longjmp(vfork_jump_buffer, 1);
    else
        _exit(0);
}

int em_pipe(int fds[2]) {
    js_pipe(fds);
    return 0;
}

int em_dup2(int oldfd, int newfd) {
    if (oldfd >= VIRTUAL_FD_BASE && newfd >= 0 && newfd <= 2) {
        pending_redirect[newfd] = oldfd;
        return newfd;
    }
    return dup2(oldfd, newfd);
}

int em_close(int fd) {
    if (fd >= VIRTUAL_FD_BASE) {
        // Virtual pipe FDs are owned by JS. Cleanup happens in workerSpawn()
        // via pipes.delete() after handing off the buffer to the child worker.
        // Calling js_pipe_close() here is premature — the sibling child's
        // workerSpawn() hasn't had a chance to look up the other pipe end yet.
        return 0;
    }
    return close(fd);
}

// hush_main() (and other applets) leave libc's process-global `optind`
// however getopt() last set it. On real OSes that's harmless since each
// invocation is a fresh process; here, multiple top-level callMain() calls
// reuse one WASM instance, so stale optind silently breaks "-c" parsing on
// the next call unless something happens to reset it first (e.g. a nofork
// applet running run_nofork_applet's defensive GETOPT_RESET()). Must be
// called before every top-level callMain() invocation.
EMSCRIPTEN_KEEPALIVE
void em_reset_getopt(void) {
    optind = 0;
}
