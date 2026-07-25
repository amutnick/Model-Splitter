# Model Splitter

A local-first STL and OBJ feature slicer for multi-colour 3D printing. Model Splitter analyzes mesh geometry, proposes cut planes, previews the resulting parts in 3D, and exports watertight STL files in a ZIP archive.

The same React application runs in a browser or inside the included Tauri desktop host. Model geometry stays on the local machine.

New users can follow the illustrated [Get, Install, and Run guide](INSTALL_GUIDE.md) or download the [print-ready PDF edition](Model-Splitter-Installation-Guide.pdf).

## Supported input

- Binary and ASCII STL
- Wavefront OBJ
- Optional MTL files supplied alongside an OBJ

## Web quick start

### Requirements

- Node.js 20.19+ or 22.12+
- npm 10 or newer

### Install and run

```bash
npm ci
npm run dev
```

Vite serves the application at <http://localhost:5173>.

### Production build

```bash
npm run build
npm run preview
```

The generated static site is written to `dist/`.

## Desktop app

The native host uses Tauri 2. macOS setup and packaging instructions are in [TAURI_SETUP.md](TAURI_SETUP.md).

After the platform prerequisites are installed:

```bash
npm ci
npm run tauri:dev
```

Create a release bundle with:

```bash
npm run tauri:build
```

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the browser development server |
| `npm run typecheck` | Run strict TypeScript validation |
| `npm run build` | Type-check and create the web production bundle |
| `npm run build:web` | Explicit alias for the web production build |
| `npm run preview` | Preview the generated web bundle |
| `npm run tauri:dev` | Start the native application in development mode |
| `npm run tauri:build` | Build and package the native application |

## Project layout

```text
src/                    React UI, mesh processing, import/export, and Three.js rendering
src-tauri/              Tauri configuration and Rust native host
src-tauri/capabilities/ Desktop permission declarations
src-tauri/icons/        Source and generated application icons
```

Generated dependency and build directories (`node_modules/`, `dist/`, and `src-tauri/target/`) are intentionally not tracked.
