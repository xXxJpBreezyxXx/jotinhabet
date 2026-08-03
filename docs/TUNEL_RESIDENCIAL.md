# Túnel residencial (Tailscale) — dois exit nodes com fallback

Algumas fontes só respondem quando o egress sai por um **IP residencial**:

| Fonte | Por que precisa |
|---|---|
| **Pinnacle** (bússola de odd justa: devig, Radar Cashout, value bets) | bloqueio por **ASN de datacenter** → HTTP 403 no IP da VPS |
| **Stake** | Cloudflare **comportamental** → 403 depois de acessos repetidos |
| **Betsul** (recon, não integrada) | *managed challenge* do Cloudflare não cede nem headed pelo IP da VPS |

O egress vai por sidecars `tailscale` em userspace, cada um preso a um **exit node**
diferente. O celular cai da tailnet com frequência (Android matando a VPN) — em
**03/08/2026 ficou 21h fora e a Pinnacle passou o dia em 0 odds**. Daí o 2º exit node.

## Topologia

```
backend  ──┬─→ http://jotinhabet_tsproxy:1055   ─→ exit node  S21 FE de joao   (100.97.159.64,  Android)
           └─→ http://jotinhabet_tsproxy2:1055  ─→ exit node  DESKTOP-SH8BVOR  (100.115.26.17,  Windows)
```

Cada sidecar é um serviço Swarm próprio, com **node e volume de state próprios**
(`jotinhabet_tsproxy_state`, `jotinhabet_tsproxy2_state`). Os dois ficam **sempre de pé**:
não há troca de configuração no failover, só escolha de rota pelo backend. Custo medido:
~50 MB RAM e ~0,2% de CPU por sidecar.

## Escolha do túnel (`backend/src/utils/tunelResidencial.ts`)

Ordem de preferência vem de `TSPROXY_URLS` (lista separada por vírgula;
`TSPROXY_URL`/`PINNACLE_PROXY` seguem valendo como legado de 1 túnel).

**⚠️ "respondeu" NÃO é sinal de saúde.** Quando o exit node não está anunciado/aprovado, o
tailscaled **ignora o pref e manda o tráfego direto** — o proxy responde 200 mas com o IP
da VPS, justamente o que a casa bloqueia. Medido em 03/08: o tsproxy2 respondia em 268 ms
com `212.85.11.105`. Por isso o probe mede o IP de saída (`api.ipify.org`) e **só aceita o
túnel se o IP for diferente do IP de saída direto da VPS**.

Regras:

- **aderência**: pega no túnel escolhido enquanto ele estiver bom (não fica pulando de
  exit node a cada varredura), e re-confirma a cada **5 min**;
- **castigo**: túnel que falhou fica **3 min** fora da fila; se *todos* estiverem de
  castigo, tenta de novo (fonte viva > castigo);
- **1 probe por rodada**: resoluções concorrentes dos vários scrapers compartilham o mesmo
  probe em andamento;
- **gate de revalidação** (`resolverTunel(false)`): responde só com cache — um probe de 8 s
  ali entraria direto na latência do alerta;
- **falha no meio da varredura**: a Pinnacle castiga o túnel, resolve outro e **refaz o
  esporte** uma vez (`trocarTunel`).

Estado visível em **`GET /api/health` → `services.tuneis`** (visão em cache; quem re-testa é
a varredura) e no log:

```
🔀 [Túnel] usando http://jotinhabet_tsproxy2:1055 (IP de saída 179.94.138.228) — FALLBACK, o anterior falhou.
⚠️ [Túnel] http://jotinhabet_tsproxy2:1055 respondeu mas SAIU PELO DATACENTER (212.85.11.105) — exit node não aprovado/anunciado; descartado.
⚠️ [Túnel] NENHUM túnel residencial disponível (...) — fontes que dependem de IP residencial vão falhar.
```

## Pré-requisito em CADA exit node (só o dono da máquina faz)

1. **anunciar** como exit node:
   - Windows: bandeja do Tailscale → *Exit node* → **Run as exit node** (ou
     `tailscale set --advertise-exit-node`);
   - Android: app → *Use as exit node*;
2. **aprovar** em <https://login.tailscale.com/admin/machines> → máquina → *Edit route
   settings* → **Use as exit node**.

Conferir de dentro do sidecar (a coluna tem de dizer `offers exit node`):

```bash
docker exec $(docker ps -q -f name=jotinhabet_tsproxy2) tailscale exit-node list
```

## Subir/refazer o sidecar do desktop

```bash
docker service create \
  --name jotinhabet_tsproxy2 \
  --network RedeEurek --replicas 1 --restart-condition any --restart-delay 15s \
  --mount type=volume,source=jotinhabet_tsproxy2_state,target=/var/lib/tailscale \
  -e TS_AUTHKEY=<auth key reusable da tailnet> \
  -e TS_HOSTNAME=jotinhabet-proxy2 \
  -e TS_STATE_DIR=/var/lib/tailscale \
  -e TS_USERSPACE=true \
  -e TS_ACCEPT_DNS=false \
  -e TS_OUTBOUND_HTTP_PROXY_LISTEN=:1055 \
  -e TS_EXTRA_ARGS=--exit-node=100.115.26.17 \
  tailscale/tailscale:latest
```

Os sidecars ficam **fora do `docker-compose.yml`** de propósito: o `TS_AUTHKEY` é segredo e
o compose está no git. O compose só carrega a lista `TSPROXY_URLS` (sem segredo).

## Diagnóstico rápido

```bash
# quem está na tailnet e quem oferece exit node
docker exec $(docker ps -q -f name=jotinhabet_tsproxy) tailscale status

# IP de saída real de cada caminho (de dentro do backend, que é quem resolve os nomes)
docker exec $(docker ps -q -f name=jotinhabet_backend) node -e "
const {ProxyAgent,fetch}=require('undici');
(async()=>{for(const [n,u] of [['celular','http://jotinhabet_tsproxy:1055'],['desktop','http://jotinhabet_tsproxy2:1055'],['direto','']]){
 try{const i={signal:AbortSignal.timeout(12000)};if(u)i.dispatcher=new ProxyAgent(u);
 console.log(n,(await (await fetch('https://api.ipify.org',i)).text()).trim());}catch(e){console.log(n,'FALHOU',e.message);}}})();"
```

Leitura dos resultados:

| Sintoma | Causa |
|---|---|
| `FALHOU` / timeout | exit node offline (máquina desligada, VPN morta) — o pref pinado faz o tráfego morrer em vez de vazar |
| IP igual ao `direto` | exit node **não anunciado ou não aprovado** → o tailscaled ignorou o pref |
| IP residencial | túnel OK |

## Trocar de máquina / IP

O IP da tailnet é estável por nó, mas se a máquina for reinstalada o IP muda: basta
`docker service update --env-add TS_EXTRA_ARGS=--exit-node=<novo IP> jotinhabet_tsproxy2`.
Para adicionar um 3º exit node, suba `jotinhabet_tsproxy3` e acrescente a URL em
`TSPROXY_URLS` — o seletor não tem limite de 2.
