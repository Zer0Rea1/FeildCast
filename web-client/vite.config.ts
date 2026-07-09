import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// import fs from 'fs';
// import path from 'path';

// Read local SSL certs only when they exist (dev only).
// In production Docker build the certs dir is not present — that's fine,
// `vite build` never starts an HTTPS server so the config is ignored.
// function readCerts() {
//   try {
//     return {
//       key:  fs.readFileSync(path.resolve(__dirname, 'certs/dev.pem')),
//       cert: fs.readFileSync(path.resolve(__dirname, 'certs/cert.pem')),
//     };
//   } catch {
//     return undefined;
//   }
// }

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts:["unpainted-decency-aside.ngrok-free.dev"],
    port: 3001,
    host: '0.0.0.0',
    // https: readCerts(),
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/hls': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/stream': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      // Proxy LiveKit WebSocket so mobile (HTTPS) avoids mixed-content errors
      '/rtc': {
        target: 'ws://localhost:7880',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
