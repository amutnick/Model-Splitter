# Application icons

`app-icon.png` is the source artwork. The desktop files referenced by `tauri.conf.json` are checked in so a clean clone can be packaged without an icon-generation step.

To regenerate them after replacing the source artwork, run from the repository root:

```bash
npm ci
npx tauri icon src-tauri/icons/app-icon.png --output src-tauri/icons
```

Tauri also emits mobile and Windows Store assets. This desktop project only retains the source image and the files referenced by the bundle configuration:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns`
- `icon.ico`
