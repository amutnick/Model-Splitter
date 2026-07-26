/**
 * tauriBridge.ts — Thin, isomorphic wrapper around Tauri v2's dialog and
 * command APIs.
 *
 * Design constraints:
 *
 *   1. The same source tree must ship as a plain web build (Vite dev server,
 *      Netlify static hosting, GitHub Pages) AND as a native macOS Tauri app.
 *      So every helper here degrades to the browser equivalent (a hidden
 *      <input type="file">, a Blob download) when `window.__TAURI_INTERNALS__`
 *      is absent.
 *
 *   2. Tauri's JS modules are only imported LAZILY inside async helpers, so
 *      the web bundle never pulls the plugin runtime unless a call is
 *      actually made in native mode. This keeps the pure-web build small and
 *      avoids top-level import failures on hosts where the Tauri plugins
 *      aren't installed (e.g. legacy CI).
 *
 *   3. All commands and dialog helpers return plain, serialisable objects
 *      that mirror the frontend's existing `File`-based flow, so callers can
 *      swap `openFileDialog()` in place of a file input without touching the
 *      parsing / segmentation code downstream.
 */

/* ------------------------------------------------------------------ */
/* Environment detection                                              */
/* ------------------------------------------------------------------ */

/**
 * True when the code is running inside a Tauri v2 WebView. The v2 runtime
 * exposes `__TAURI_INTERNALS__` (v1 used `__TAURI__`); we probe both so a
 * legacy runtime doesn't get quietly ignored.
 */
export const isTauri = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
};

/* ------------------------------------------------------------------ */
/* Payload types                                                       */
/* ------------------------------------------------------------------ */

export interface LoadedFile {
  /** Basename with extension, e.g. `dragon.stl`. */
  name: string;
  /** Absolute filesystem path when native, empty string in the browser. */
  path: string;
  /** Byte length of `bytes` — pre-computed so callers can render size stats. */
  size: number;
  /** Raw contents. Callers wrap this in `new Uint8Array()` / `TextDecoder()`. */
  bytes: ArrayBuffer;
  /** True when the payload came from a Tauri native picker + Rust read. */
  fromNative: boolean;
}

export interface OpenDialogOptions {
  title?: string;
  multiple?: boolean;
  /** e.g. `[{ name: '3D Models', extensions: ['stl', 'obj', 'mtl', '3mf'] }]` */
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/* ------------------------------------------------------------------ */
/* File open                                                           */
/* ------------------------------------------------------------------ */

/**
 * Opens the OS-native file picker (Tauri) or the DOM file input (browser)
 * and returns the selected files' contents as `LoadedFile`s. Multi-select
 * yields at most `opts.multiple` items; single-select is a 0-or-1 array.
 *
 * On the native side we call the Rust `read_model_file` command rather than
 * the JS-side `readBinaryFile()` so that the byte transfer happens off the
 * WebView's main thread and gets a native size guard.
 */
export async function openFileDialog(opts: OpenDialogOptions = {}): Promise<LoadedFile[]> {
  const filters = opts.filters ?? [
    { name: '3D Models', extensions: ['stl', 'obj', 'mtl', '3mf'] },
    { name: 'STL', extensions: ['stl'] },
    { name: 'OBJ (+ MTL)', extensions: ['obj', 'mtl'] },
    { name: '3MF', extensions: ['3mf'] },
  ];

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');

    const picked = await open({
      title: opts.title ?? 'Open 3D Model',
      multiple: opts.multiple ?? false,
      directory: false,
      filters,
    });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];

    // Read every file in parallel — the Rust side spawns them off the main
    // thread, so this doesn't stall the UI even for a batch of 100 MB files.
    return Promise.all(paths.map(async (path) => {
      const payload = await invoke<{
        name: string; path: string; size: number; bytes: number[];
      }>('read_model_file', { path });
      return {
        name: payload.name,
        path: payload.path,
        size: payload.size,
        // Tauri serialises `Vec<u8>` as a JS number array — cheap to widen.
        bytes: new Uint8Array(payload.bytes).buffer,
        fromNative: true,
      } satisfies LoadedFile;
    }));
  }

  return openFileDialogViaDom(opts, filters);
}

/** Browser fallback that mimics the Tauri behaviour with a hidden input. */
function openFileDialogViaDom(
  opts: OpenDialogOptions,
  filters: { name: string; extensions: string[] }[],
): Promise<LoadedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? false;
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.style.display = 'none';
    input.oncancel = () => { document.body.removeChild(input); resolve([]); };
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      document.body.removeChild(input);
      const out = await Promise.all(files.map(async (f) => ({
        name: f.name,
        path: '',
        size: f.size,
        bytes: await f.arrayBuffer(),
        fromNative: false,
      } satisfies LoadedFile)));
      resolve(out);
    };
    document.body.appendChild(input);
    input.click();
  });
}

/* ------------------------------------------------------------------ */
/* File save                                                           */
/* ------------------------------------------------------------------ */

/** Result of a save operation. `path` is empty in browser mode. */
export interface SaveResult {
  saved: boolean;
  path: string;
  bytesWritten: number;
  fromNative: boolean;
}

/**
 * Persist a binary blob (typically the segmenter's ZIP) to disk. In the
 * browser this is `saveAs()`; on the desktop it's a native Save dialog +
 * a Rust write off the UI thread.
 */
export async function saveBinaryFile(
  data: Uint8Array | ArrayBuffer | Blob,
  opts: SaveDialogOptions & { fallbackFilename: string },
): Promise<SaveResult> {
  const bytes: Uint8Array = data instanceof Blob
    ? new Uint8Array(await data.arrayBuffer())
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');

    const path = await save({
      title: opts.title ?? 'Save',
      defaultPath: opts.defaultPath ?? opts.fallbackFilename,
      filters: opts.filters,
    });
    if (!path) return { saved: false, path: '', bytesWritten: 0, fromNative: true };

    // The Tauri IPC channel expects a plain array of numbers for Vec<u8>.
    const bytesWritten = await invoke<number>('write_binary_file', {
      path,
      bytes: Array.from(bytes),
    });
    return { saved: true, path, bytesWritten, fromNative: true };
  }

  // Browser: kick off a Blob download and pretend the user picked the name.
  // `.slice()` copies into a fresh ArrayBuffer (never SharedArrayBuffer) so
  // Blob's TS types accept it under strict lib settings.
  const blob = data instanceof Blob ? data : new Blob([bytes.slice().buffer]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.fallbackFilename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next microtask so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, path: opts.fallbackFilename, bytesWritten: bytes.byteLength, fromNative: false };
}

/* ------------------------------------------------------------------ */
/* Miscellaneous native helpers                                        */
/* ------------------------------------------------------------------ */

export interface NativeAppInfo {
  name: string;
  version: string;
  arch: string;
  os: string;
}

/** Returns null in the browser; a fresh object in Tauri (also confirms IPC). */
export async function getNativeInfo(): Promise<NativeAppInfo | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<NativeAppInfo>('app_info');
  } catch (e) {
    console.warn('getNativeInfo failed', e);
    return null;
  }
}

/** Show a native message box, falling back to `window.alert()` in the browser. */
export async function nativeAlert(message: string, title = 'Model Splitter'): Promise<void> {
  if (isTauri()) {
    const { message: show } = await import('@tauri-apps/plugin-dialog');
    await show(message, { title, kind: 'info' });
    return;
  }
  window.alert(`${title}\n\n${message}`);
}

/** Ask the user for confirmation. Resolves to `true` if they confirm. */
export async function nativeConfirm(message: string, title = 'Model Splitter'): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }
  return window.confirm(`${title}\n\n${message}`);
}
