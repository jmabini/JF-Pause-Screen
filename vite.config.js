import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.js'),
      name: 'CustomPauseScreen',
      fileName: () => 'js-pause-screen.js',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        extend: true,
        // Ensure it's a single file
        manualChunks: undefined,
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    sourcemap: false,
  },
});
