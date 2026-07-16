import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
//
// O bloco `server` é ciente do ambiente por variáveis de ambiente, para o mesmo
// arquivo servir tanto o dev local quanto o Vite dev server rodando em container
// atrás do Traefik/HTTPS na VPS (hot-reload). Sem as envs (dev local), o
// comportamento é o de antes: porta 3000, HMR padrão e proxy /api → localhost:4000.
//
//  - VITE_PORT         porta que o Vite escuta (na VPS: 80, atrás do Traefik).
//  - VITE_ALLOWED_HOST host público liberado (ex.: jotinhabet.eurekmind.com).
//  - VITE_HMR_HOST     host que o cliente HMR usa; quando setado, força wss:443
//                      (o Traefik termina o TLS e encaminha o WebSocket).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 0.0.0.0 — alcançável de fora do container (inócuo no dev local)
    port: Number(process.env.VITE_PORT) || 3000,
    allowedHosts: process.env.VITE_ALLOWED_HOST ? [process.env.VITE_ALLOWED_HOST] : undefined,
    // Usado só no dev local; na VPS o Traefik roteia /api direto pro backend.
    proxy: {
      '/api': 'http://localhost:4000',
    },
    // Atrás do Traefik/HTTPS o cliente precisa conectar em wss://<host>:443.
    hmr: process.env.VITE_HMR_HOST
      ? { host: process.env.VITE_HMR_HOST, clientPort: 443, protocol: 'wss' }
      : undefined,
  },
});
