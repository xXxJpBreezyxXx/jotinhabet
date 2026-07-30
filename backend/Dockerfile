# Imagem oficial do Playwright — já traz Chromium + todas as libs de sistema.
# IMPORTANTE: manter a tag em sincronia com a versão do "playwright" no package.json (1.61.1).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

ENV TZ=America/Sao_Paulo \
    PORT=4000

WORKDIR /app

# 1) Dependências — INCLUI devDependencies (typescript p/ o "tsc").
#    NODE_ENV=production só entra DEPOIS do build; se entrasse antes, o npm omitiria
#    as devDeps e o "tsc" sumiria (erro: sh: tsc: not found).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# 2) Código + build do TypeScript
COPY . .
RUN npm run build

# 3) Runtime
ENV NODE_ENV=production
EXPOSE 4000

# Healthcheck via Node (a imagem não garante curl/wget). Aponta para
# /api/health/live — LIVENESS puro, sem tocar no banco.
#
# Por que não o /api/health: ele faz um select no Supabase, então uma lentidão ou blip do
# banco reprovava o probe e, com 3 falhas seguidas, o Swarm matava a task (exit 137
# "unhealthy container"). Probe de liveness não pode depender de serviço externo.
#
# Tolerâncias folgadas de propósito: a VPS tem 1 CORE e o mesmo core roda Chromium dos
# scrapers e o `docker build` de todo deploy. Com timeout=5s/retries=3 uma janela de ~90s
# de CPU saturada bastava para matar um backend saudável.
#   start-period=90s : boot faz DB + scheduler + Telegram + monitor de GREEN
#   timeout=10s      : p99 medido é ~1,9s em repouso; 10s cobre CPU saturada
#   retries=5        : só desiste após ~2,5min de falha contínua (era ~1,5min)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/api/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# X virtual (Xvfb) para os scrapers poderem subir o Chromium em modo HEADED: casas atrás
# de Cloudflare (Rivalo, Brazino777, Betsul) barram o fingerprint headless mesmo com
# stealth — headed sob Xvfb renderiza (mesma técnica que fez o bet365 responder 200; ver
# memória bet365-recon). Os scrapers headless existentes não mudam: só ganham um DISPLAY
# disponível, sem obrigação de usar.
#
# NÃO usar `xvfb-run` aqui: como PID 1 ele TRAVA antes de executar o comando (o script
# espera um SIGUSR1 do Xvfb com `trap`/`wait`, e o PID 1 não tem a semântica de sinais
# que esse handshake assume). Sintoma observado em 29/07/2026: container subia, ZERO
# linha de log, healthcheck falhava 3x e o Swarm matava com exit 137 — reproduzido até
# com `xvfb-run -a ... node -e 'console.log(1)'` como PID 1.
#
# Subir o Xvfb em background e dar `exec` no node resolve e é melhor: o node fica sendo
# o PID 1 de verdade, então recebe SIGTERM do Swarm e encerra limpo.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x900x24 -nolisten tcp >/dev/null 2>&1 & export DISPLAY=:99; exec node dist/index.js"]
