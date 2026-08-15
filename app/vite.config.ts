import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientPort = Number.parseInt(process.env.COFFEE_DASHBOARD_CLIENT_PORT ?? '5173', 10);
const serverPort = Number.parseInt(process.env.COFFEE_DASHBOARD_PORT ?? '4173', 10);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: clientPort,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
    },
  },
});
