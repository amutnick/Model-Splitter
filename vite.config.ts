import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// One Vite configuration serves both the browser build and Tauri's WebView.
export default defineConfig(() => {
  const tauriDevHost = process.env.TAURI_DEV_HOST;

  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "src"),
      },
    },
    server: {
      host: tauriDevHost || false,
      port: 5173,
      strictPort: true,
      hmr: tauriDevHost
        ? { protocol: "ws", host: tauriDevHost, port: 1421 }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      // Three.js no longer transpiles cleanly to Safari 14.0 with current
      // esbuild. Safari 14.1 maps to the app's macOS 11.3 deployment floor.
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14.1",
      minify: process.env.TAURI_ENV_DEBUG ? false : ("esbuild" as const),
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
      // Three.js and the mesh algorithms intentionally ship together.
      chunkSizeWarningLimit: 1000,
    },
  };
});
