// Minimal Rust std probe for the blink guest — no dependencies.
// Each argv[1] mode exercises one std facility so failures can be isolated.
use std::io::Write;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "out" => println!("stdout-line"),
        "err" => eprintln!("stderr-line"),
        "both" => {
            println!("O");
            eprintln!("E");
        }
        "raw" => std::io::stdout().write_all(b"raw-bytes\n").unwrap(),
        "exit3" => std::process::exit(3),
        "args" => {
            for a in std::env::args() {
                println!("arg={a}");
            }
        }
        "hash" => {
            // forces RandomState init → getrandom syscall path
            let mut m = std::collections::HashMap::new();
            m.insert("k", 1);
            println!("hash-ok {}", m["k"]);
        }
        "exec" => {
            // Replace this process image with `probe out` via execve (no fork).
            // Proves blink's in-process Exec() works when driven by a guest
            // execve syscall, not just the initial program load.
            use std::os::unix::process::CommandExt;
            let err = std::process::Command::new("/bin/probe").arg("out").exec();
            eprintln!("exec failed: {err}");
            std::process::exit(1);
        }
        "spawn" => {
            // fork+exec+wait via the standard library (the runner's `sh -c` path).
            let out = std::process::Command::new("/bin/probe").arg("out").output();
            match out {
                Ok(o) => {
                    print!("{}", String::from_utf8_lossy(&o.stdout));
                    println!("spawn-exit={:?}", o.status.code());
                }
                Err(e) => {
                    eprintln!("spawn failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        "spawnsh" => {
            // The runner's EXACT run_shell path: Command::new("sh").arg("-c")
            // with a PIPELINE, captured via .output() (3 host pipes). Isolates
            // the "Rust Command → sh -c → internal pipe fork" nesting.
            let out = std::process::Command::new("sh")
                .arg("-c").arg("echo hello-from-tool | tr a-z A-Z")
                .output();
            match out {
                Ok(o) => {
                    print!("{}", String::from_utf8_lossy(&o.stdout));
                    println!("spawnsh-exit={:?}", o.status.code());
                }
                Err(e) => { eprintln!("spawnsh failed: {e}"); std::process::exit(1); }
            }
        }
        _ => println!("probe-default"),
    }
}
