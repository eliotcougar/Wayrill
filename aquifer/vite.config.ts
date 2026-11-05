import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^libavoid-wasm(\?.*)?$/,
        replacement: resolve(dirname(require.resolve('libavoid-js')), 'libavoid.wasm') + '$1',
      },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 1461,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/*-private*', '**/.tools/**'] },
  },
  clearScreen: false,
  build: { target: 'chrome105' },
});
