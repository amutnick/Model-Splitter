# App icons

Tauri's bundler expects the icon files referenced by `tauri.conf.json → bundle.icon`
to live here. Generate all sizes + platform variants from a single 1024×1024 PNG:

```bash
npx tauri icon path/to/logo-1024.png
```

That command will emit:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Once these exist here, `npm run tauri:build` will produce a signed `.app` and a `.dmg`
under `src-tauri/target/release/bundle/`.
