import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Dev proxy so the SPA can call the Rust backend without CORS friction.
      '/admin/api': process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8787',
    },
  },
  build: { outDir: 'dist' },
});
