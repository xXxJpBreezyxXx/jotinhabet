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

# Healthcheck simples via Node (a imagem não garante curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
