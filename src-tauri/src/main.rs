// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Native Messaging host (Sprint E): browsers do NOT pass --native-host.
    // Chrome invokes:  <exe> chrome-extension://<id>/ [--parent-window=<hwnd>]
    // Firefox invokes: <exe> <extension-id>          (e.g. name@org.app)
    // Anything that looks like one of those is a host call, not a CLI call.
    let is_native = args.iter().any(|a| {
        a == "--native-host"
            || a.starts_with("chrome-extension://")
            || a.starts_with("moz-extension://")
            || (a.contains('@') && !a.contains('/') && !a.contains('\\') && a.ends_with(".app"))
    });
    if is_native {
        std::process::exit(haramlite_rs_lib::native_host_entry());
    }

    // GUI launch requested by the browser bridge while no instance is open:
    // start hidden (the in-page mini panel is the UI), but it is NOT a CLI run.
    let hidden_start = args.iter().any(|a| a == "--hidden-start");
    let cli_args: Vec<&String> = args
        .iter()
        .filter(|a| *a != "--hidden-start")
        .collect();

    // CLI mode: any arguments (other than GUI file-open leftovers) → headless.
    // Tauri dev/build may inject its own flags; those never reach here in GUI
    // double-click launches, so this heuristic is safe for our usage.
    if !cli_args.is_empty() {
        std::process::exit(haramlite_rs_lib::cli_entry(&args));
    }

    if hidden_start {
        std::env::set_var("HARAMLITE_HIDDEN", "1");
    }

    haramlite_rs_lib::run()
}
