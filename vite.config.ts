import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    sourcemap: true,
  },
  server: {
    port: 3000,
    host: true,
  },
});
