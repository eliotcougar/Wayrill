import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  // The pinned package exports JS but omits its WASM subpath.
  resolve: {
    alias: [
      {
        find: /^libavoid-wasm(\?.*)?$/,
        replacement:
          fileURLToPath(new URL('./node_modules/libavoid-js/dist/libavoid.wasm', import.meta.url)) +
          '$1',
      },
    ],
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Native builds must not reload the frontend or watch the toolchain tree.
    watch: { ignored: ['**/.tools/**', '**/service/**', '**/src-tauri/**'] },
  },
  build: { target: 'chrome105' },
});
