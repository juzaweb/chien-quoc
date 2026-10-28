import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/colyseus': {
        target: 'http://localhost:2567',
        ws: true,
        changeOrigin: true
      }
    }
  }
});

