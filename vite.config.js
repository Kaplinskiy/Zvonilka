// vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',            // index.html в корне
  publicDir: 'public',  // статика монтируется в /
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/signal': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
        secure: false
      }
    }
  },
  preview: {
    host: true,
    port: 5173
  }
});