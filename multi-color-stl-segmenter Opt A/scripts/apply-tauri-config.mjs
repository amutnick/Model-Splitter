#!/usr/bin/env node
/**
 * apply-tauri-config.mjs
 *
 * One-shot patcher that flips this project from "pure web" into a fully wired
 * Tauri v2 desktop app. It ONLY touches two files that shouldn't be rewritten
 * from scratch — everything else (Rust crate, capabilities, bridge, icons,
 * README) is already scaffolded by the setup task.
 *
 * What it does:
 *
 *   1. Adds the `tauri`, `tauri:dev`, `tauri:build` and `build:web` scripts
 *      to `package.json` without disturbing existing scripts, deps or
 *      formatting order.
 *
 *   2. Rewrites `vite.config.ts` so it:
 *        - removes `vite-plugin-singlefile` (Tauri needs multi-file output),
 *        - keeps `clearScreen: false` so Rust compile output stays visible,
 *        - fixes the dev server port + HMR to values Tauri expects,
 *        - excludes `src-tauri/` from Vite's watcher.
 *
 * Idempotent — safe to run repeatedly. Run it once, then commit.
 *
 *     node scripts/apply-tauri-config.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const say = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

/* -------------------------------------------------- package.json */
{
  const path = resolve(root, 'package.json');
  if (!existsSync(path)) throw new Error('package.json not found');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.scripts ??= {};

  const additions = {
    // `build` is what Tauri invokes as `beforeBuildCommand`. We alias the
    // pure-web build to `build:web` so Netlify/Pages CI can keep calling it.
    'build:web': pkg.scripts['build:web'] ?? pkg.scripts.build ?? 'vite build',
    tauri: 'tauri',
    'tauri:dev': 'tauri dev',
    'tauri:build': 'tauri build',
  };

  let changed = false;
  for (const [k, v] of Object.entries(additions)) {
    if (pkg.scripts[k] !== v) { pkg.scripts[k] = v; changed = true; }
  }
  if (changed) {
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    say('package.json scripts updated');
  } else {
    say('package.json scripts already up to date');
  }
}

/* -------------------------------------------------- vite.config.ts */
{
  const path = resolve(root, 'vite.config.ts');
  if (!existsSync(path)) {
    warn('vite.config.ts not found — skipping (create one manually).');
  } else {
    const CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Configured for Tauri v2:
//  - devUrl in tauri.conf.json points at localhost:5173,
//  - clearScreen kept so Rust compile output stays visible,
//  - HMR pinned so the Tauri WebView can subscribe reliably,
//  - src-tauri/ excluded from the file watcher (Cargo artefacts are noisy).
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST
      ? { protocol: 'ws', host: process.env.TAURI_DEV_HOST, port: 1421 }
      : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Match Tauri's minimum supported Chromium / Safari targets.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
`;
    writeFileSync(path, CONFIG);
    say('vite.config.ts rewritten (singlefile plugin removed)');
  }
}

/* -------------------------------------------------- .gitignore */
{
  const path = resolve(root, '.gitignore');
  const line = 'src-tauri/target/';
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!cur.split('\n').includes(line)) {
    writeFileSync(path, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + line + '\n');
    say('.gitignore: added src-tauri/target/');
  }
}

console.log('\nDone. Next:');
console.log('  npm install               # installs the JS side of Tauri v2');
console.log('  npx tauri icon path/logo.png   # optional — generate app icons');
console.log('  npm run tauri:dev         # boots Vite + spawns the Rust host');
console.log('  npm run tauri:build       # produces .app + .dmg under src-tauri/target/release/bundle/\n');
