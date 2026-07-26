# Tauri desktop setup

Model Splitter includes a Tauri 2 host for macOS. The JavaScript and Rust configuration is checked in; no post-install patching step is required.

## Prerequisites

1. Install the Xcode command-line tools:

   ```bash
   xcode-select --install
   ```

2. Install the Rust toolchain with [rustup](https://rustup.rs/):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```

3. Install JavaScript dependencies from the repository root:

   ```bash
   npm ci
   ```

The app's deployment floor is macOS 11.3. Building a distributable `.app` or `.dmg` must be done on macOS.

## Development

```bash
npm run tauri:dev
```

Tauri starts Vite on port 5173, compiles the Rust host, and opens the native window. The first Rust build downloads and compiles the Tauri dependency graph, so it takes longer than subsequent runs.

For browser-only development, use `npm run dev` instead.

## Release build

```bash
npm run tauri:build
```

Artifacts are written beneath:

```text
src-tauri/target/release/bundle/
```

The configured bundle targets are `.app` and `.dmg`. Local builds do not automatically provide a Developer ID signature or notarization; configure Apple signing credentials before distributing the app outside your machine.

## Universal macOS build (optional)

Install both Apple targets:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Then build a universal binary:

```bash
npm run tauri:build -- --target universal-apple-darwin
```

## Native integration

The frontend uses `src/utils/tauriBridge.ts` to select browser or native behavior at runtime. The native host exposes three commands from `src-tauri/src/lib.rs`:

| Command | Purpose |
| --- | --- |
| `read_model_file` | Read a picker-selected STL, OBJ, MTL, or 3MF file with type and size checks |
| `write_binary_file` | Save an exported binary payload off the UI thread |
| `app_info` | Confirm the native IPC connection and return build information |

Open/save/message dialogs are provided by `tauri-plugin-dialog` and declared in `src-tauri/capabilities/default.json`.

## Verification

Run these checks before packaging:

```bash
npm run build
npx tauri info
npm run tauri:build
```

If `tauri info` reports missing tools, install the platform prerequisites listed in its Environment section before retrying.
