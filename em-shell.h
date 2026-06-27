#ifndef __ASSEMBLER__

#include <unistd.h>
#include <setjmp.h>

extern jmp_buf vfork_jump_buffer;
int em_vfork(int is_parent);
void em_exit(int status);
int em_execvp(const char *file, char *const argv[]);
pid_t js_waitpid(pid_t pid, int *status, int options);
int em_pipe(int fds[2]);
int em_dup2(int oldfd, int newfd);
int em_close(int fd);

#define vfork() (em_vfork(setjmp(vfork_jump_buffer)))
#define _exit(status) (em_exit(status))
#define _Exit(status) (em_exit(status))
#define execvp(file, argv) (em_execvp((file), (argv)))
#define waitpid(pid, status, options) js_waitpid(pid, status, options)
#define pipe(fds) em_pipe(fds)
#define dup2(oldfd, newfd) em_dup2(oldfd, newfd)
#define close(fd) em_close(fd)

#endif /* __ASSEMBLER__ */
