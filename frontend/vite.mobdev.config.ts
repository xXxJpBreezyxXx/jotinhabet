// ARQUIVO TEMPORÁRIO (não commitar) — servidor local só para iterar/validar o layout mobile.
// Proxy de /api pro backend de produção via Traefik (127.0.0.1:443 + Host header),
// porque o serviço do Swarm não publica a porta 4000 no host.
// `dev` = fonte crua; `preview` = dist minificado (é o que valida a ordem das media queries).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const proxy = {
  '/api': {
    target: 'https://127.0.0.1:443',
    changeOrigin: false,
    secure: false,
    headers: { Host: 'jotinhabet.eurekmind.com' },
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  cacheDir: '/tmp/claude-0/-root-jotinhabet/c13397eb-abd4-45f6-9d26-7daae8883ad9/scratchpad/.vite',
  server: { host: '127.0.0.1', port: 5199, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 5198, strictPort: true, proxy },
});
