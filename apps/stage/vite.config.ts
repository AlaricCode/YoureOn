// Stage view (TASKS K-06 E3; ARCHITECTURE §8.2): the laptop on the projector. Static Vite build;
// it talks to the server only over HTTPS + the /v1/ws WebSocket (API-CONTRACT §1.3 stage auth).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
