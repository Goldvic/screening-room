import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001', '/auth': 'http://127.0.0.1:3001', '/login': 'http://127.0.0.1:3001', '/tv': 'http://127.0.0.1:3001' } },
  build: {
    // two pages: the app, and the small page a TV opens (/tv)
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), tv: resolve(__dirname, 'tv.html') } },
  },
});
