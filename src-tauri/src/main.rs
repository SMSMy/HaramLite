// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // CLI mode: any arguments (other than GUI file-open leftovers) → headless.
    // Tauri dev/build may inject its own flags; those never reach here in GUI
    // double-click launches, so this heuristic is safe for our usage.
    if !args.is_empty() {
        std::process::exit(haramlite_rs_lib::cli_entry(&args));
    }

    haramlite_rs_lib::run()
}
