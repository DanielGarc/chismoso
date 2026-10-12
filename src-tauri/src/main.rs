// No console window behind the app on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

//! Desktop entry point: command-line mode when given arguments, otherwise the
//! window. Mobile builds start in `lib.rs` (`run`) and never use this file.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() && !args[0].starts_with("-psn") {
        attach_console();
        std::process::exit(frigate_desktop_lib::cli::run(args));
    }
    frigate_desktop_lib::run();
}

/// Release builds on Windows have no console; reattach to the terminal that
/// launched us so command-line mode can print.
#[cfg(target_os = "windows")]
fn attach_console() {
    unsafe extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    unsafe {
        AttachConsole(u32::MAX);
    }
}

#[cfg(not(target_os = "windows"))]
fn attach_console() {}
