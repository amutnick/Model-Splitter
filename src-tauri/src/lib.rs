//! Tauri v2 backend for the Model Splitter desktop app.
//!
//! The heavy lifting (STL/OBJ/3MF parsing, CSG splitting, BSP planning, ZIP
//! packaging) all happens in the WebView side because the algorithms already
//! exist there in TypeScript and are fully deterministic. Rust's job on
//! desktop is narrow but important:
//!
//!   1. Serve as a native host with operating-system integration.
//!   2. Provide native open / save dialogs (via the `dialog` plugin).
//!   3. Perform guarded filesystem I/O off the UI thread before transferring
//!      model data to the WebView.
//!
//! All exposed commands are async so long-running I/O never blocks the UI
//! thread, and every filesystem error is converted into a plain `String` so
//! the frontend can display it verbatim in a toast.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Metadata returned alongside binary file contents so the frontend can
/// display filename + size without a second round-trip.
#[derive(Serialize)]
pub struct FilePayload {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub bytes: Vec<u8>,
}

/// Hard ceiling that prevents an unexpectedly large file from exhausting the
/// renderer's heap during the IPC transfer.
const MAX_READ_BYTES: u64 = 300 * 1024 * 1024;

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn filename_of(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("model")
        .to_string()
}

/// Read the full contents of a model file identified by absolute path.
///
/// The frontend obtains this path from the OS file picker. Validate the file
/// type and size again at the command boundary before reading any data.
#[tauri::command]
async fn read_model_file(path: String) -> Result<FilePayload, String> {
    let p = PathBuf::from(&path);
    let supported = p
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("stl")
                || extension.eq_ignore_ascii_case("obj")
                || extension.eq_ignore_ascii_case("mtl")
                || extension.eq_ignore_ascii_case("3mf")
        });
    if !supported {
        return Err("Only STL, OBJ, MTL, and 3MF files are supported.".to_string());
    }

    // Tauri re-exports its own async runtime so we don't need a direct tokio
    // dependency — `spawn_blocking` runs the blocking I/O off the UI thread.
    let p_meta = p.clone();
    let meta = tauri::async_runtime::spawn_blocking(move || std::fs::metadata(&p_meta))
        .await
        .map_err(to_err)?
        .map_err(to_err)?;

    if !meta.is_file() {
        return Err(format!("Not a regular file: {path}"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File is {} MB — over the {} MB read limit.",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }

    let p_read = p.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&p_read))
        .await
        .map_err(to_err)?
        .map_err(to_err)?;

    Ok(FilePayload {
        name: filename_of(&p),
        path: p.to_string_lossy().into_owned(),
        size: meta.len(),
        bytes,
    })
}

/// Persist a byte payload (typically the generated `_segmented.zip`) to disk.
/// Any parent directory that doesn't yet exist is created recursively so the
/// user can point the Save dialog at a fresh folder.
#[tauri::command]
async fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    let written = bytes.len() as u64;
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(parent) = p.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(&p, &bytes)
    })
    .await
    .map_err(to_err)?
    .map_err(to_err)?;
    Ok(written)
}

/// Debug-only ping used by the bridge on startup so the frontend can display
/// a "Native mode" badge with confidence rather than trusting `window`
/// sniffing alone.
#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": env!("CARGO_PKG_VERSION"),
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_model_file,
            write_binary_file,
            app_info
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                // Auto-open devtools in dev builds so viewing WebGL logs is
                // one shortcut away.
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
