// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // CLI mode: the canonical HOME launcher supplies a private marker; known
    // app-binary subcommands/flags remain backwards-compatible.
    // This avoids starting the GUI, running cleanup_stale_sidecars (which kills
    // running sidecars), and triggering the single-instance window focus.
    if app_lib::is_cli_mode(&args) {
        std::process::exit(app_lib::run_cli(&args));
    }

    // GUI mode: normal Tauri app
    app_lib::run();
}
