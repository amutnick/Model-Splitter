# Turning the STL Segmenter into a native macOS app (Tauri v2)

Everything the CLI's `npx tauri init` would have created is already committed
to this repo. Because two files (`package.json`, `vite.config.ts`) can't be
rewritten from inside the codegen sandbox, a small patcher fills them in on
your machine.

## First-time setup (once per clone)

```bash
# 1. Toolchains
xcode-select --install                      # macOS command-line tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# 2. JS dependencies (already installed if you ran `npm install`)
npm install

# 3. Patch package.json + vite.config.ts for Tauri
node scripts/apply-tauri-config.mjs

# 4. (optional) generate the platform icons from a single 1024×1024 PNG
npx tauri icon path/to/logo-1024.png
```

## Everyday commands

| Command                | What it does                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`          | Plain browser mode — Vite on `http://localhost:5173`.                         |
| `npm run build:web`    | Pure web bundle (`dist/`) — unchanged, still deploys to Netlify/Pages.        |
| `npm run tauri:dev`    | Boots Vite, compiles the Rust host, and opens the native macOS window.        |
| `npm run tauri:build`  | Compiles the release binary + packages `.app` and `.dmg` under `src-tauri/target/release/bundle/`. |

The first `tauri:dev` run compiles `~350` Rust crates and takes 3–5 minutes;
subsequent runs are incremental (< 5 s).

## What's already in place

```
src-tauri/
├── Cargo.toml                # Rust deps (tauri v2, plugin-dialog, plugin-fs)
├── build.rs                  # tauri-build shim
├── tauri.conf.json           # window, bundle, file associations, macOS settings
├── capabilities/default.json # dialog + fs permissions with scoped $HOME/etc.
├── icons/README.md           # how to generate the icon set
└── src/
    ├── main.rs               # binary entry point
    └── lib.rs                # #[tauri::command]s + plugin registration

src/utils/tauriBridge.ts      # isTauri(), openFileDialog(), saveBinaryFile(),
                              # nativeAlert(), nativeConfirm(), getNativeInfo()

scripts/apply-tauri-config.mjs  # patches package.json + vite.config.ts
```

## Exposed native commands

All are async and off the UI thread (Rust `spawn_blocking`).

| Command             | Signature                                                       | Purpose                                   |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `read_model_file`   | `path: String -> FilePayload`                                   | Native open-file dialogue payload.        |
| `write_binary_file` | `path: String, bytes: Vec<u8> -> u64`                           | Native save (returns bytes written).      |
| `app_info`          | `() -> { name, version, arch, os }`                             | Detects that IPC is alive; drives badge.  |

The frontend never touches these directly — `src/utils/tauriBridge.ts` wraps
them behind isomorphic helpers so the same code works in the browser build
using `<input type="file">` + `saveAs`.

## Capability permissions

`src-tauri/capabilities/default.json` grants exactly what the app needs:

- `dialog:allow-open`, `dialog:allow-save`, `dialog:allow-message`, `dialog:allow-ask`
- `fs:allow-read-file`, `fs:allow-write-file`, `fs:allow-exists`, `fs:allow-mkdir`
- `fs:scope` = `$HOME/**`, `$DOCUMENT/**`, `$DOWNLOAD/**`, `$DESKTOP/**`, `$TEMP/**`
- `deny` for `$HOME/.ssh/**` and `$HOME/.aws/**`

Tighten these if the app is ever shipped to end users through the App Store.

## Verifying the setup

1. `node scripts/apply-tauri-config.mjs`
2. `npm run build:web` — should succeed with the singlefile plugin gone.
3. `npm run tauri:dev` — a native window titled *STL Segmenter* opens; the
   header shows a green **● NATIVE** badge; clicking **📂 Open…** launches the
   macOS file picker; slicing a model and pressing **Download .ZIP** launches
   the native Save dialog with the correct default filename.
