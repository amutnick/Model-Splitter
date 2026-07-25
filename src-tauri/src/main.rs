// Prevents an additional console window from popping up on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    stl_segmenter_lib::run()
}
