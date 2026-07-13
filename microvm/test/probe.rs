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
        _ => println!("probe-default"),
    }
}
