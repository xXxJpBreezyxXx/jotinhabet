# Agente de IA (aba "IA & Automação")

Lote de 30/07/2026. O chat de turno único virou um **agente com ferramentas**: ele
consulta odds ao vivo nas casas, o radar, a banca, as regras e as calculadoras antes de
responder — e mostra no frontend **quais skills usou** em cada resposta.

## Arquitetura

```
POST /api/ai/chat            (painel)          POST /api/whatsapp/webhook   (grupo "Sure Agent")
  └─ IA/agent/agentLoop.ts        loop ReAct (system prompt + tools → executa skill → repete)
       ├─ IA/agent/chatModels.ts  motores com tool-calling: Groq/OpenAI (REST OpenAI-compat) e Gemini (functionDeclarations)
       ├─ IA/agent/registry.ts    registro das skills (+ projeção enxuta para o modelo)
       ├─ IA/agent/skills/*.ts    as ferramentas
       ├─ IA/agent/catalogoCasas.ts  o que cada casa sabe fazer (derivado do código)
       ├─ IA/agent/comparadorOdds.ts tabela comparada entre casas (mesmo matching do motor)
       ├─ IA/agent/varredura.ts   agrupa feed por JOGO e cruza casas (varredura sem nome de evento)
       ├─ IA/agent/whatsappBridge.ts  triagem do webhook + sessão por chat + resposta no grupo
       ├─ notify/markdownWhatsapp.ts  markdown → dialeto do WhatsApp (negrito/tabela/lista)
       └─ IA/conhecimento/*       doutrina de promoções + conversa original com o Gemini

GET /api/ai/skills            → catálogo de skills, casas, provedores e cadeia ativa (o painel lê isto)
GET /api/whatsapp/webhook     → estado do canal do WhatsApp (sessões, contadores)   [requer API_TOKEN]
GET /api/whatsapp/webhook/debug → últimos payloads CRUS recebidos da Evolution      [requer API_TOKEN]
```

O frontend renderiza a resposta em **markdown** (`frontend/src/Markdown.tsx`, react-markdown +
remark-gfm em chunk `lazy`): negrito, listas, código e principalmente TABELA — que é o que o
agente mais produz (comparador de odds, cobertura de promoção). A bolha virou classe
(`.chat-bubble` / `.md` no `index.css`) porque markdown precisa de estilo descendente.

`modo: 'simples'` no corpo do POST (ou `AGENT_DESATIVADO=1`) cai no chat antigo de turno
único — válvula de escape se um provedor quebrar function calling.

## Skills (23)

| grupo | skill | o que faz |
|---|---|---|
| odds | `listar_casas` | catálogo das casas integradas e capacidades |
| odds | `consultar_odds_casa` ⏳ | odds ao vivo de UM evento numa casa |
| odds | `comparar_odds_casas` ⏳ | mesmo evento em N casas: melhor odd por lado, ROI ou quanto falta |
| odds | `varrer_jogos_casa` ⏳ | LISTA os jogos de um esporte numa casa (ao vivo / pré / todos) — sem nome de evento |
| odds | `varrer_surebets_casas` ⏳ | varre o feed de 2-4 casas e cruza tudo: surebet ao vivo ou pré, sem nome de evento |
| radar | `surebets_no_radar` | surebets ativas com filtros (ROI, esporte, casa, evento) |
| radar | `revalidar_surebet` ⏳ | reconsulta as duas pernas ao vivo (por id) |
| radar | `value_bets_e_middles` | +EV vs Pinnacle e middles ativos |
| radar | `radar_cashout` | dropping odds recentes |
| banca | `banca_e_saldos` | banca ativa + saldo por casa |
| banca | `historico_entradas` | operações lançadas, com período/esporte/casa e agregados |
| banca | `historico_promocoes` | promoções registradas nos 6 tipos + lucro, ROI e retenção média das freebets |
| regras | `checar_regras_do_par` | Diretrizes: mercado proibido, grupos de W.O., regra da KTO |
| regras | `regras_de_anulacao_da_casa` | política de void por casa/esporte |
| cálculo | `calcular_surebet` | distribuição de stake, lucro e ROI garantido |
| cálculo | `calcular_cobertura_promocao` | cobertura nos **6 tipos** de promoção (ver abaixo): aporte, os 2 cenários, garantido, ROI, retenção, odd efetiva e piso do boost |
| cálculo | `otimizar_odd_freebet` | curva de retenção e odd ótima √(1+1/m) — na SRR o ótimo é a MENOR odd (sem pico) |
| cálculo | `calcular_multipla_qualificadora` | regulamento + cobertura sequencial de uma múltipla JÁ escolhida |
| cálculo | `montar_multipla_promocao` ⏳ | MONTA a múltipla: escolhe pernas com odd real, acha a cobertura em outra casa e calcula a sequencial |
| conhecimento | `buscar_conhecimento` | doutrina + conversa do Gemini (blank.pdf) |
| ação | `criar_oportunidade_no_radar` ✍️ | registra surebet (via SignalPipeline: gates + dedup + revalidação) |
| ação | `registrar_promocao` ✍️ | grava no histórico de promoções (os 6 tipos, incl. SRR / super odd / lucro extra) |
| ação | `avisar_no_whatsapp` ✍️ | uma mensagem no grupo de alertas (desligada por padrão) |

⏳ = consulta lenta (rede/scraper). ✍️ = escrita; só roda se a mensagem do usuário pedir
explicitamente (gate no `agentLoop`, além da instrução no prompt).

### Os 6 tipos de promoção (o que `calcular_cobertura_promocao` e `registrar_promocao` cobrem)

A matemática dos seis vive em `core/promocoes.ts` (fonte única). Cada tipo é uma definição
diferente de **retorno bruto (R)** e de **custo real**; o resto da conta é comum.
`S` = stake **elegível** (`min(valor, teto_stake)`), `v` = quanto vale R$ 1 de bônus/ficha
devolvida (default 70%), `b` = percentual do boost.

| tipo (core) | `promo_type` (banco) | como o usuário fala | R (retorno bruto) | custo real |
|---|---|---|---|---|
| `FREEBET_SNR` | `FREEBET_SNR` | "aposta grátis", "aposta extra", "prêmio", "bônus de R$ X" | `S×(odd−1)` | R$ 0 |
| `FREEBET_SRR` | `FREEBET_SRR` | "devolve a ficha", "com retorno do stake" | `S×(odd−1+v)` | R$ 0 |
| `QUALIFICATIVA` | **`QUALIFYING`** | "aposta qualificadora", "com meu dinheiro" | `S×odd` | `S` |
| `PROTECAO` | `PROTECAO` | "50% da aposta perdida de volta", "seguro", "cashback se perder" | `S×odd` + devolução **no red** | `S` |
| `SUPERODD` | `SUPERODD` | "super odd", "odd turbinada/aumentada" | `S×odd` (em caixa a odd JÁ contém o excedente) ou `S×odd_padrao + v×S×(odd−odd_padrao)` (em bônus) | `S` |
| `LUCRO_EXTRA` | `LUCRO_EXTRA` | "lucro extra", "+30% de lucro", "ganhos turbinados" | `S×odd + v×min(b×S×(odd−1), teto_extra)` | `S` |

Três coisas que valem para quem mexer nisso:

- **`QUALIFICATIVA` ↔ `QUALIFYING`** é a única divergência entre core e banco (herança). Use
  `tipoDoPromoType()` / `promoTypeDoTipo()` do core — os tradutores espalhados já fizeram
  filtro de histórico devolver zero em silêncio.
- **Escada de tipo exaustiva.** O `else` de qualquer escada de tipo significa hoje "freebet";
  tipo novo esquecido num `else` não dá erro, ele se **disfarça de freebet** na tela e nos
  números. `calcularPromocao` usa whitelist e avisa quando o tipo é desconhecido.
- **Bônus cai em ramos opostos:** na proteção, no cenário de **red**; na SRR com ficha em
  bônus e no boost pago em bônus, no cenário de **green**. Por isso o core devolve
  `lucroEmCaixaSePromoGanha` e `lucroEmCaixaSeCoberturaGanha` separados — "lucro travado" e
  "caixa de hoje" são números diferentes e os dois precisam aparecer na resposta.

Detalhe matemático e armadilhas de cada tipo: `Promocoes.md` (seções 1–8) e a doutrina
(`buscar_conhecimento` com `tipos-de-promocao`, `freebet-srr`, `superodd-lucro-extra`,
`protecao-aposta-perdida`, `odd-ideal-freebet`).

## Varredura de jogos (lote de 31/07/2026)

O agente pedia o nome do jogo porque as skills de odds só sabiam buscar POR NOME
(`oddsDoEvento`). Quem pergunta "quais jogos ao vivo tem na KTO?" não tem esse nome. Duas
coisas mudaram:

1. **Skills de varredura** — `varrer_jogos_casa` (feed de UMA casa, agrupado por jogo) e
   `varrer_surebets_casas` (feed de 2-4 casas, cruzado pelo MESMO comparador da skill de um
   evento só). O system prompt proíbe explicitamente pedir o nome do jogo quando o pedido é
   de varredura.
2. **Coleta AO VIVO nos scrapers** — até aqui NENHUM scraper devolvia partida em andamento
   (todos descartavam `start <= now`, porque o pipeline de surebet é pré-match). A opção
   `incluirAoVivo` foi levada a 15 casas, sempre por endpoint/parâmetro oficial da
   plataforma (probes reais em 31/07):

| plataforma | casas | como o ao vivo entra | semântica da flag |
|---|---|---|---|
| Kambi | KTO, BetWarrior | `listView` já traz `STARTED` | live **+** pré |
| Pinnacle | Pinnacle | matchup FILHO (`parentId`, `isLive`) | live **+** pré |
| Superbet | Superbet | `offerState=prematch,live` + janela começando no passado | live **+** pré |
| Altenar | Aposta1, BetPix365, EstrelaBet, MC Games, 4Play, Luvabet | `widget/GetLiveEvents?sportId=` | **só live** (endpoints disjuntos) |
| Swarm | SeuBet, Vbet | `where.game.is_live @in [0,1]` | live **+** pré |
| sptpub | BetBoom | rota `/api/v4/live/...` somada à `/prematch` | live **+** pré |
| NSoft | Brazino777, ApostaGanha | `games/2` além de `games/1` | live **+** pré |

A diferença de semântica é tratada em `feedNaSituacao` (`skills/odds.ts`): nas Altenar,
`situacao="todos"` faz DUAS coletas e une; nas outras, uma só.

**Duas capacidades distintas**, por isso dois conjuntos em `revalidationService.ts`:
`CASAS_AO_VIVO` (a busca por evento aceita partida em andamento) e `CASAS_FEED_AO_VIVO` (o
FEED devolve partida em andamento). A Betano está só na primeira: a flag dela vale na busca
dirigida, mas o caminho de lista navega páginas de pré-jogo. Quando a casa não coleta ao
vivo, a skill DIZ isso — nunca responde "não tem jogo ao vivo".

**Bug de assertividade corrigido no caminho (Pinnacle).** A flag `incluirAoVivo` existia
desde o Radar Cashout, mas nunca entregou odd ao vivo: na Pinnacle a partida em andamento é
um matchup **filho** (`parentId != null`, `isLive: true`) e a guarda de `parentId` — que
existe para barrar derivados/especiais — rodava ANTES da flag. Resultado: os 44 jogos ao
vivo do futebol eram 100% descartados e o que sobrava era o matchup **pai**, com preço
congelado no apito inicial (medido em 31/07, Krasnodar × Rostov: moneyline do pai −404
contra −496 no filho). A bússola "ao vivo" do Radar Cashout estava lendo esse preço velho.
Agora o filho ao vivo entra e o pai de jogo já começado é descartado (`filtroMatchup`).

**Casas que seguem SEM varredura ao vivo** (e por quê): EsportesDaSorte (o `left-menu`/
`league-card` é a árvore pré-jogo; o feed live é outro e precisa de recon), Betnacional,
Blaze, 1xBet, Stake, Rivalo (browser — mudança de rota + parser novo; 1xBet e Stake ainda
exigem recon do marketId ao vivo) e o FEED da Betano. Nessas, `situacao="ao_vivo"` responde
que a casa só entrega pré-jogo.

## Casas do lote de 31/07/2026 (recon + integração)

Seis casas pedidas, uma por agente de recon, com request real (não dedução pelo nome):

| casa | domínio REAL | plataforma | veredito |
|---|---|---|---|
| **Onabet** | `ona.bet.br` (⚠️ `onabet.bet.br` é NXDOMAIN) | Altenar `onabet` | **INTEGRADA** |
| **BrBET** | `brbet.bet.br` (site com 403 de WAF; o feed é o host da Altenar) | Altenar `brbet` | **INTEGRADA** |
| **BetEsporte** | `betesporte.bet.br` | própria "SA Esportes"/SA Online (ASP.NET) + feed Sportradar | **INTEGRADA** |
| **MarjoSports** | `www.marjosports.com.br` (⚠️ não é .bet.br — licença **LOTERJ**, não federal) | NGX/"BetPlus" (`sb-loterias.ngbras.com`), multi-tenant | **INTEGRADA** |
| Sportybet | `sporty.bet.br` (⚠️ não `sportybet.bet.br`) | própria (SportyTech, API `factsCenter`) | pendente do túnel: BR responde **451 por ASN** |
| ~~EsporteNetBet~~ | nenhum `.bet.br` existe | banca/cambista própria (2 variantes) | **VETADA** (ver abaixo) |

Onabet e BrBET entraram como subclasses de `AltenarWidgetScraper` (o padrão da Luvabet) +
registro nos pontos de sempre: `scanner_v2` (import, instância, allowlist `SCRAPERS_API`),
`SCRAPER_FACTORY`/`CASAS_AO_VIVO`/`CASAS_FEED_LIVE_EXCLUSIVO` em `revalidationService`,
`casasAliases` e o META de `catalogoCasas`. Medido no probe: Onabet 1.297 odds/324 jogos em
2,8s (69 odds ao vivo) e BrBET 2.659 odds/721 jogos em 13,9s (117 ao vivo). Tênis fica
BLOQUEADO nas duas até a auditoria de W.O. (grupo não classificado = fail-safe de
`arbitrage/regras.ts`).

Achado de manutenção: `recon/casas_alvo.ts` tinha `onabet.bet.br`, que não existe — por isso
o recon automático nunca via essa casa.

**BetEsporte** (`casa_betesporte.ts`) e **MarjoSports** (`casa_ngx.ts`, classe-base
multi-tenant da plataforma NGX) exigiram parser próprio. Medido na coleta real de 31/07:

| casa | pré-jogo | ao vivo | mercados canônicos |
|---|---|---|---|
| BetEsporte | 3.002 odds / 1.168 refs em 33,8s | 255 odds / 40 eventos (todos em andamento) | 21 |
| MarjoSports | 1.058 odds / 296 eventos em 9,5s | +26 partidas em andamento | 10 (zero `DESCONHECIDO`) |

Armadilhas que a coleta real revelou (as duas estão comentadas no código):

- **BetEsporte**: o campo `line` só é preenchido no futebol (types 16/18); nos outros esportes
  a linha existe apenas no rótulo (`"Casa (+5.5)"`), e quando os dois existem e divergem o
  parser DESCARTA. O e-sports vem de OUTRO provedor (`od:player:...`) com numeração de
  `externalId` conflitante, e a ordem do array `options` VARIA entre eventos — a perna sai por
  `externalId`, nunca por posição. O type **1601 ("1x2 Pagamento antecipado")** aparece como
  mercado principal em 123 dos 709 jogos de futebol e é promoção, não 1x2: mapear por `type`
  numérico foi o que evitou publicar isso como Resultado Final. Custo: 1 request por esporte
  (Resultado Final de tudo vem de graça) + 20 detalhes por esporte, SEQUENCIAIS com pacer de
  260 ms — concorrência 4 já devolve 429; o 429 lê `retry-after`, pausa a casa no ciclo e
  devolve o que já coletou.
- **MarjoSports**: `/event?type=X` devolve **só `NOT_STARTED`** — as partidas em andamento
  exigem `&status=LIVE` (a flag SOMA esse feed). Existe um `&search=<termo>` não documentado
  que derruba o custo da busca dirigida de 4,8 MB para ~15 KB, mas ele é sensível a acento, então
  o catálogo inteiro fica como fallback obrigatório (senão "Japao" nunca acha "Japão" e um
  alerta bom seria abortado por falso negativo). No basquete o mercado principal está no grupo
  `full_match`, não `full_time` (que é a versão com/sem prorrogação).

Nas duas o **tênis está bloqueado** até a auditoria de W.O. (grupo não classificado).

### Casa VETADA na operação (`arbitrage/regras.ts`)

`casaBloqueada()` veta uma casa em QUALQUER fonte (SureRadar, sinal do Telegram, motor
próprio, value bet) e QUALQUER mercado, porque roda no topo de `regraPermiteOportunidade` —
o gate único usado por `scanner_v2:364`, `signalPipeline:292`, `valor.ts:348` e pelo
comparador do agente. Vale também em promoção (`checar_regras_do_par` com
`finalidade="promocao"` NÃO contorna): bloqueio por casa é decisão de operação, não regra de
mercado.

Vetada em 31/07/2026 por decisão do usuário: **EsporteNetBet** (e EsporteNet VIP). Motivo
medido no recon: não é operadora regulada (nenhum domínio `.bet.br`; é rede de banca/cambista
em `.bet`/`.net`, com Bilhete/Cambista/Bicho no menu), margem mediana de ~17% (casa de
verdade opera 2-5%), teto de R$ 500 por aposta e odds derivadas do bet365 — com essa margem
ela quase nunca tem a melhor perna e, quando tem, é erro de cotação em casa que pode
cancelar. A lista aceita override por `CASAS_BLOQUEADAS` no .env (vírgula) para vetar outra
casa sem deploy. Cuidado ao editar: a comparação é por igualdade/prefixo declarado, nunca
"contém" — `esportenet*` é a vetada, `esportesdasorte` é casa integrada e legítima (há teste
para isso em `tests/unit/regras.test.ts`).

## Escopo das Diretrizes: surebet × promoção (lote de 31/07/2026)

As Diretrizes (mercado proibido, grupos de W.O. do tênis) existem para SUREBET: num
mercado 3-vias ou num cruzamento A×B, o lucro garantido vira prejuízo garantido. Em
operação de PROMOÇÃO — freebet SNR/SRR, aposta qualificativa, proteção/cashback, "aposte e
ganhe", múltipla qualificadora — não há lucro garantido a proteger e o mercado é o que o
regulamento da casa exige (1X2 no futebol é o caso comum). Aplicá-las ali só impedia
operação legítima.

Ressalva de doutrina para os tipos com **boost** (super odd e lucro extra): ali existe lucro
travado de verdade (`1/odd_efetiva + 1/odd_cob < 1`), então o `risco_residual` que a skill
devolve como aviso — void divergente, grupo de W.O. no tênis — pesa como numa surebet. O
gate continua permitindo (bloqueio por mercado é regra de surebet), mas a resposta deve dizer
que a perna coberta pode ser anulada e deixar a outra exposta.

O que mudou:

- `checar_regras_do_par` aceita `finalidade: 'surebet' | 'promocao'`. Em `promocao` devolve
  `permitido: true`, `regras_de_surebet_aplicadas: false`, o bloqueio que existiria como
  **aviso** e o `risco_residual` (no tênis com grupos diferentes, abandono pode anular a
  perna e deixar a cobertura exposta — a exposição é o aporte, não red garantido).
- `DOUTRINA_MERCADOS` ganhou a seção **ESCOPO** dizendo isso; ela é injetada no prompt do
  agente e no RiskAnalyzer.
- O system prompt proíbe o agente de dizer que a promoção "não pode" por mercado proibido
  ou grupo de W.O.
- Os gates DETERMINÍSTICOS do motor (`arbitrage/regras.ts`, `scanner_v2`) seguem inalterados
  — quem alerta surebet continua bloqueando o que sempre bloqueou.

### `montar_multipla_promocao`

Monta a múltipla com odds REAIS, em vez de pedir ao usuário as pernas prontas:

1. coleta o feed da casa da promoção + até 3 casas de cobertura (uma passada, 2 em paralelo);
2. agrupa por jogo e **escolhe a perna dentro dos clusters comparados** — só entra mercado de
   jogo completo e 2 vias (`DNB_FT`, `TOTAIS_*_FT`, `HANDICAP_*_FT`, `AMBAS_MARCAM_FT`,
   `RESULTADO_FINAL_FT`) que JÁ tenha o lado oposto em outra casa. No primeiro probe, escolher
   do feed cru deixou 3 de 5 pernas sem cobertura e trouxe mercado exótico ("Primeiro gol");
3. por jogo, fica a perna de hedge mais barato (menor `1/odd + 1/oddCobertura`);
4. entre jogos, mira a **odd equilibrada** (`odd_total_minima^(1/n)`, piso na odd mínima do
   regulamento) e, se faltar total, troca a menor perna pela MENOR candidata que faz bater —
   pegar a maior fechava com odd total 20.28 para exigência 5.00 e hedge de R$ 500 num bilhete
   de R$ 50 (medido);
5. ordena por horário (a cobertura é sequencial) e entrega tudo por `calcularMultiplaQualificadora`
   — aporte por perna, gasto acumulado, caixa de pico e o aviso do caminho all-green.

Medido em 31/07 (KTO, cobertura Superbet+EstrelaBet, R$ 50, exigência 5.00 com 5 pernas):
odd total 5.15, todas as pernas com cobertura, caixa de pico R$ 472, all-green −R$ 216 com
cobertura total (com `perda_aceita` o hedge fica mais barato).

## Canal do WhatsApp (grupo "Sure Agent")

`POST /api/whatsapp/webhook` recebe os eventos da Evolution e roda o MESMO agente da aba.

**Como ligar na Evolution** (campo "Webhook" da instância, ou
`POST /instance/connect {webhookUrl, subscribe:["MESSAGE"]}` com `apikey: <token da instância>`):

```
https://jotinhabet.eurekmind.com/api/whatsapp/webhook?token=<AGENT_WHATSAPP_WEBHOOK_TOKEN>
```

O formato do payload do **evolution-go é whatsmeow serializado** (`event: "Message"`,
`data.Info.Chat`, `data.Info.ID`, `data.Info.IsFromMe`, `data.Info.Timestamp` em RFC3339,
texto em `data.Message.conversation` ou `data.Message.extendedTextMessage.text`) — NÃO é o
`messages.upsert`/`key.remoteJid` do Evolution v2 em Node. `extrairMensagemWhatsApp` cobre os
dois formatos e ainda faz varredura em profundidade se o envelope mudar; `/webhook/debug`
mostra os payloads crus recebidos.

| guarda | por quê |
|---|---|
| responde 200 SEMPRE | a Evolution re-tenta 3x em não-2xx, e cada re-tentativa duplicaria a execução do agente |
| execução em background | uma pergunta com scraper passa de 1 min; a triagem é síncrona, a resposta vai depois |
| 1 pergunta por vez | VPS de 1 core; a 2ª pergunta recebe aviso em vez de derrubar o backend |
| `IsFromMe` e evento `Send*` ignorados | a própria resposta volta pelo webhook — sem isso o agente conversaria consigo mesmo |
| mensagem > 10 min ignorada | history-sync da Evolution re-entrega conversa antiga e queimaria a cota de IA |
| chat em allowlist | só os JIDs de `AGENT_WHATSAPP_CHAT` |
| token na URL | `/api` é público via Traefik e a Evolution não assina o payload |

| env | default | o que faz |
|---|---|---|
| `AGENT_WHATSAPP_ATIVO` | 1 | liga/desliga o canal |
| `AGENT_WHATSAPP_CHAT` | grupo Sure Agent | JIDs autorizados (vírgula) |
| `AGENT_WHATSAPP_WEBHOOK_TOKEN` | — | segredo do `?token=` (vazio = aceita todos) |
| `AGENT_WHATSAPP_TRACE` | 1 | rodapé com as skills usadas |
| `AGENT_WHATSAPP_MAX_HISTORICO` | 12 | mensagens de contexto por chat |
| `AGENT_WHATSAPP_SESSAO_MIN` | 180 | TTL da sessão |
| `AGENT_WHATSAPP_MAX_POR_HORA` | 30 | teto de perguntas por chat |
| `AGENT_WHATSAPP_IDADE_MAX_MIN` | 10 | idade máxima da mensagem aceita |

Comandos locais (não gastam IA): `/novo` limpa o contexto, `/ajuda` lista o que o agente faz,
`/status` mostra motor/sessão. Mídia sem legenda recebe aviso de que o canal só lê texto.

A resposta sai por `markdownParaWhatsApp`: título vira `*negrito*`, tabela GFM vira bloco
monoespaçado alinhado, lista vira `•`, link fica cru (o WhatsApp linkifica). Resposta longa é
fatiada em ~3.500 caracteres com numeração. O `rodarAgente` recebe `{ canal: 'whatsapp' }` e
o prompt pede resposta curta (celular).

## Guardas do loop

| guarda | env | default | por quê |
|---|---|---|---|
| rodadas de ferramenta | `AGENT_MAX_PASSOS` | 6 | evita loop infinito; ao estourar, pede fechamento em texto |
| skills lentas por pergunta | `AGENT_MAX_SKILLS_CUSTOSAS` | 4 | VPS de 1 core; um "compara tudo" sem limite a derruba |
| payload de uma skill | `AGENT_MAX_CHARS_SKILL` | 3800 | o resultado fica no histórico e é reenviado a cada rodada |
| skill de WhatsApp | `AGENT_WHATSAPP_SKILL` | off | o destino é o grupo de alertas |

## Leitura de IMAGEM (lote de 31/07/2026)

O agente lê print nos DOIS canais: botão de anexar na aba (`ImageIcon` ao lado do input,
`POST /api/ai/chat` com `imagemBase64`+`mimeType`) e imagem enviada no grupo do WhatsApp
(baixada da Evolution por `POST /message/downloadmedia`, que exige o objeto `Message` cru
de volta — por isso `EntradaWhatsApp.imagem` guarda a mensagem inteira).

O caminho é o mesmo nos dois: `IA/extractors/imagemChat.ts` transforma a imagem em TEXTO
estruturado (tipo do print, casa, evento, mercado/linha, odds, valores, regulamento) e esse
texto entra na conversa como se o usuário tivesse digitado — daí o agente segue com as 23
skills (cobertura de promoção, montar múltipla, comparar odds…). Não há caminho paralelo
só para imagem, e a mensagem injetada avisa que o conteúdo veio de OCR e pode ter erro.

**Provedor: OpenRouter** (`IA/Provedores/OpenRouter`), 1º da cadeia de visão
(`AI_PROVIDER_CHAIN_VISION=openrouter,openai,gemini`). Motivo: em 31/07 a OpenAI respondia
"no credits remaining", o Gemini "prepayment credits are depleted" e a conta da Groq não tem
nenhum modelo multimodal (15 modelos, todos texto/áudio). A API da OpenRouter é compatível
com a da OpenAI — mesmo SDK, só troca de `baseURL`.

Modelos free multimodais medidos com print REAL de sinal (31/07):

| modelo | tempo | resultado |
|---|---|---|
| `google/gemma-4-26b-a4b-it:free` | 6-21s | **default**: leu odds/mercado/evento certos; único com `response_format`/`structured_outputs` |
| `nvidia/nemotron-nano-12b-v2-vl:free` | 4,7s (e 504 em outra tentativa) | leu certo quando respondeu; feito para "document intelligence" |
| `google/gemma-4-31b-it:free` | 429 | upstream do Google congestionado no free tier |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 6,4s | leu certo, schema próprio |

Como o 429/504 vem do provedor UPSTREAM (não da OpenRouter) e cada modelo free tem upstream
próprio, existe uma **escada de modelos** (`OPENROUTER_MODEL_FALLBACKS`) igual à da Groq.

**Teto de qualidade do free tier, documentado porque custa dinheiro:** o gemma-4-26b leu
`casaA="Chance"` num print em que a casa era **Stake** — "Chance" é o cabeçalho da faixa do
template. Duas defesas: (1) `validarSinal` (telegramSignalExtractor) REJEITA o sinal quando a
casa extraída é um rótulo conhecido do template — casa errada faria a revalidação procurar a
perna onde ela não está; (2) o prompt de `imagemChat` avisa explicitamente que essas faixas
são cabeçalho. Ainda assim o modelo às vezes hesita; no chat isso aparece como "casa não
integrada" e o agente pede confirmação. Com crédito na OpenAI/Gemini (ou na própria
OpenRouter, que aí libera modelo pago barato de visão) a cadeia volta a começar por um modelo
melhor sem mudar código.

## Provedores e a cota da Groq

Cadeia de texto: `AI_PROVIDER_CHAIN` (default `openai,gemini,groq`; **o .env de produção
usa `groq,openai,gemini`** porque OpenAI e Gemini estavam com crédito esgotado em 29/07).
Cadeia do agente: `AGENT_PROVIDER_CHAIN` (default `groq,openai,gemini`).

Provedor que responde "créditos esgotados" entra em **cooldown** (`AI_QUOTA_COOLDOWN_MIN`,
30min) e é pulado — antes, cada chamada pagava o timeout dos provedores mortos.

A Groq no free tier limita **tokens por minuto por modelo** (medido em 30/07/2026):

| modelo | TPM | req/dia | nota |
|---|---|---|---|
| `llama-3.3-70b-versatile` | 12.000 | 1.000 | default do agente |
| `openai/gpt-oss-120b` | 8.000 | 1.000 | 1º degrau da escada |
| `openai/gpt-oss-20b`, `qwen/qwen3.6-27b` | 8.000 | 1.000 | degraus seguintes |
| `llama-3.1-8b-instant` | 6.000 | 14.400 | último degrau |
| `groq/compound-mini` | 70.000 | 250 | ⚠️ **sem tool calling** — inútil para o agente (verificado por chamada real) |

Como o loop reenvia system + tools em CADA rodada, isso é o gargalo real. Três decisões
saíram daí:

1. **Escada de modelos** (`GROQ_MODEL_FALLBACKS`): cada modelo tem SEU balde de TPM, então
   descer a escada soma ~42k tokens/min de folga. 413 (não cabe) troca de modelo na hora;
   429 espera se o reset informado for curto, senão desce a escada; no último degrau tolera
   até 30s de espera. E 400 `tool_use_failed` (o modelo escreveu `"limite": "3"` com aspas e
   a Groq valida o schema) re-tenta com reforço de formatação antes de trocar de modelo.
2. **Prompt enxuto**: `resumo` de 1 linha por skill (a `descricao` longa fica só para a UI),
   catálogo de casas compactado (`Nome[chave:flags]`) e contexto do app reduzido
   (`montarContextoAgente()` em vez do `montarContextoApp()` completo). Foi de ~10k para
   ~4k tokens por chamada.
3. **Sem visão na Groq**: a conta não expõe modelo multimodal, então
   `AI_PROVIDER_CHAIN_VISION=openai,gemini,groq` e `generateFromImage` lança erro explícito
   em vez de devolver texto inventado.

### Teto do payload de ferramentas: 14.000 caracteres

O array de tools (`ferramentasParaModelo()`) é reenviado **em toda rodada** do loop, junto
com o system prompt — e o gargalo da Groq é TPM, não requisição. Daí o gate em
`tests/unit/agente.test.ts` (a suíte falha se estourar):

| invariante | valor | por quê |
|---|---|---|
| `JSON.stringify(tools).length` | **< 14.000** | ~3,5k tokens só de schema; com 6k–12k TPM por modelo, cada rodada acima disso encosta no 413/429 e força a escada de modelos |
| `descricao` de cada skill | < 220 chars | é a linha que o modelo lê para escolher a skill; a versão LONGA vai só para a UI (`skillsParaUI()`) |
| `description` de cada parâmetro | ≤ 90 chars no teste, mas o `registry` **trunca em 70** (`slice(0,67) + '...'`) na projeção para o modelo | um parâmetro exposto custa ~110 chars **por rodada**; passar de 70 chega cortado no modelo |

Medido em 04/08/2026: **13.186 caracteres com 23 skills** — ~800 de folga, ou seja ~7
parâmetros novos antes de estourar. Por isso a régua não é "cabe?", é "vale o custo em toda
rodada?".

Consequência prática ao adicionar campo em skill de promoção: **exponha o essencial e deixe
o resto no default do core**. Em `calcular_cobertura_promocao`, `valor_bonus_pct`,
`valor_extra_pct`, `valor_ficha_pct`, `teto_extra`, `teto_ganho`/`teto_incide_sobre` e
`boost_sobre_stake` existem no core mas ficam **fora** do schema; um único flag
`cashback_eh_bonus` cobre "o benefício vem em bônus" na devolução e no extra do boost, que é
o mesmo fato do regulamento. O `tipo` é `enum` com os 6 valores em vez de lista em prosa:
além de custar menos, a lista dos seis passa de 70 caracteres e chegaria **truncada** pelo
corte do `registry` — o último tipo simplesmente desapareceria do schema. O `enum` ainda
restringe a saída do provedor ao vocabulário do core.

## Travas que saíram da revisão adversarial (30/07)

O subsistema passou por uma revisão em 4 lentes (loop, skills, matemática, rota/frontend)
com verificação adversarial de cada achado. O que foi confirmado e corrigido — todo item
tem teste em `tests/unit/{agente,promocoes}.test.ts`:

| onde | defeito | correção |
|---|---|---|
| `comparadorOdds` | cluster sem trava de evento/horário podia cruzar jogos diferentes | exige `areEventsSame` + `mesmoHorario`, como o motor |
| `comparadorOdds` | os DOIS recortes 2-vias do 1X2 (`Vitória X` / `X ou Empate`) se misturavam — `areTeamsSame('Vitória Vasco','Vitória Flamengo')` é TRUE | compara o **núcleo** do rótulo + **tipo de seleção** (simples × dupla) |
| `comparadorOdds` | escolha gulosa (melhor A global) esconde surebet quando uma casa lidera os dois lados | varre os pares (i≠j) e escolhe a menor soma |
| `comparadorOdds` | cluster de uma casa só devolvia `faltaPct` negativo sugerindo arbitragem | campo `umaCasaSo`; roi/falta = null |
| `comparadorOdds` | ROI em base diferente do radar | `roiPct` na base do motor + `lucroSobreInvestidoPct` à parte |
| `agentLoop` | compressão contava MENSAGENS de tool e mutilava resultados da rodada corrente | compressão por RODADA (`inicioRodadas`) |
| `agentLoop` | gate de escrita abria com "quanto rende criar uma surebet?" e ficava aberto na conversa | só a última mensagem, verbo imperativo (ou infinitivo com pedido) + objeto − negação |
| `agentLoop` | tetos só contavam no caminho de sucesso; skill que lançava saía de graça | contagem antes de executar + deadline por pergunta |
| `agentLoop` | queda do provedor depois de uma escrita devolvia erro seco sem `acao` | `acao` em todos os retornos + resumo das skills já executadas |
| `agentLoop` | corpo cru do provedor ia para o cliente | `resumoErroProvedor()` classifica; corpo só no log |
| `chatModels` | N functionResponse do Gemini em N turnos separados | agrupadas em um único content |
| `chatModels` | sem timeout no fetch (default undici = 300s) | `AbortSignal.timeout` (`AGENT_LLM_TIMEOUT_MS`, 45s) |
| `skills/odds` | `incluir_browser=true` era no-op; `casas` como string era ignorada | ambos tratados + `casas_nao_integradas` na resposta |
| `catalogoCasas` | `fonte_scanner` vinha da allowlist crua (BetPix365/MC Games/Stake apareciam como fonte) | interseção com os scrapers instanciados |
| `catalogoCasas` | flags "SVB" ambíguas (B = browser e B = grupo de W.O.) | `scan live browser wo:A|B|?` |
| `skills/acoes` | `linha: null` virava 0 (`Number(null)` é finito) e quebrava a revalidação | guarda explícita de null/'' |
| `skills/banca` | filtro de tipo `QUALIFICATIVA` não casava com `QUALIFYING`; data não entendida era ignorada em silêncio | mapeamento dos dois vocabulários + aviso quando o período não é aplicado |
| `core/promocoes` | "perda_aceita=0 = cobertura total" era falso: o caminho ALL-GREEN pode dar prejuízo grande | aviso explícito com o valor (e a doutrina corrigida) |
| `core/promocoes` | cashback não condicional desequalizava e reportava `equalizado=true` | só a parte condicional entra na equalização; `equalizado` compara os LUCROS |
| `core/promocoes` | aviso da freebet calculava a cobertura ótima com a odd atual (colapsava na odd ruim) | usa a odd ótima; curva marca odds fora do domínio |
| `POST /api/promocoes` | ignorava as casas (comissão de exchange) e `valor_cobertura=0` gravava lucro fabricado | passa as casas; aporte ≤ 0 = ausente (deriva o equalizado) |
| `POST /api/ai/chat` | `modo:'simples'` (escolhido pelo cliente) criava oportunidade sem gate | mesmo gate de escrita do modo agente |
| frontend | `provedores`/`cadeia_agente` sem guarda (tela branca), auto-scroll rolava a página, painel aberto colapsava o chat no mobile | normalização na carga, scroll do container, `maxHeight`/`minHeight` |

## Base de conhecimento

- `IA/conhecimento/doutrinaPromocoes.ts` — 17 seções destiladas (os 6 tipos de promoção,
  proteção/cashback de aposta perdida, cobertura e retenção da freebet SNR, **freebet SRR**,
  **super odd + lucro extra**, qualificativa, cashback, "aposte e ganhe", múltipla, cobertura
  sequencial, escalonamento 1ºT/2ºT, adiar cobertura, abuso de bônus, surebet e seus riscos,
  condução da operação). `RESUMO_DOUTRINA_PROMOCOES` (~2,6k chars) vai no system prompt em
  toda rodada; o detalhe fica por `buscar_conhecimento`, que é busca por palavra-chave.
- `IA/conhecimento/corpusPromocoes.ts` — a conversa completa com o agente do Gemini
  (26 trocas, exportada de `blank.pdf`; versão legível em
  `docs/conhecimento/promocoes_freebets_gemini_2026-07-30.md`).
- Busca por palavra-chave (sem embeddings) em `IA/conhecimento/index.ts` — não depende de
  crédito de IA, que é exatamente o que faltou em 29/07.

Três correções que fizemos sobre o material original, com teste em
`tests/unit/promocoes.test.ts`:

- **A retenção da freebet SNR tem PICO.** `R(O) = (O−1)·(1 − m·(O−1))/O`, ótimo em
  `O* = √(1 + 1/m)`. Com m≈6% o ótimo é ~4,2 — a odd 7.75 do caso real rendeu ~38% de
  retenção (R$ 3,82 de R$ 10), não os "75% a 85%" projetados.
- **Na SRR o ótimo é o INVERSO: a MENOR odd elegível.** Como a ficha volta, a retenção é
  `1 − m·(O−1)` — reta decrescente, sem pico (`oddIdealFreebet(m, 1)` devolve `NaN` de
  propósito e a curva marca `direcaoDoOtimo: 'menor-odd'`). Com m = 6%: odd 1,50 → 97%,
  2,00 → 94%, 4,00 → 82%, e o aporte da cobertura ainda é proporcional a `(odd−1)`. Aplicar
  a doutrina da SNR aqui é perder retenção de propósito; **calcular** uma pela outra
  sub-hedgeia a operação em `O/(O−1)` (metade do aporte em odd 2,00).
- **A cobertura sequencial tem caixa de pico.** `x_k = (S + Σx anteriores − perda aceita)/(h_k − 1)`
  cresce a cada green; o app agora avisa o total antes de começar.

## Matemática de promoções

`core/promocoes.ts` é a fonte única dos **6 tipos** (usada pela skill, pela aba Promoções e
pelo `POST /api/promocoes`, que antes tinha a fórmula duplicada): `calcularPromocao`,
`calcularMultiplaQualificadora`, `curvaRetencaoFreebet`, `margemImplicita`,
`oddIdealFreebet`, `retencaoTeorica`, mais os helpers que evitam reimplementação —
`TIPOS_PROMOCAO`/`PROMO_TYPES_BANCO`, `tipoDoPromoType`/`promoTypeDoTipo` (tradutores
únicos), `tipoPromocaoDeTexto` (vocabulário livre → tipo), `ehFreebetSemCusto` (a regra de
"investimento real": a ficha da freebet não sai do bolso) e `ehTipoComBoost`.

Nos tipos com boost a resposta tem de trazer a **odd efetiva** (`oddEfetivaPromo`, já com
boost e tetos) e o **piso do extra** (`extraParaZerar = S·(H/(H−1) − odd base)`): abaixo dele
o boost não paga o par de odds. Com margem de 6% no mercado de cobertura e boost de 30% em
dinheiro, o rendimento tem pico em odd ~2,02 (8,1% da stake) e em odd 5,00 já é prejuízo
garantido (−5,8%) — o agente não deve sugerir "use o boost na odd mais alta".

## Como adicionar uma skill

1. Crie em `IA/agent/skills/<grupo>.ts` com `nome`, `resumo` (1 linha, para o modelo),
   `descricao` (longa, para a UI), `parametros` (JSON Schema) e `executar(args, ctx)`.
2. Marque `custosa: true` se fizer rede/scraper e `escrita: true` se mudar estado.
3. Exporte no array do grupo — o `registry.ts` agrega e a UI/`/api/ai/skills` refletem sozinhos.
4. Adicione o resumo do resultado em `resumirResultado()` (`agentLoop.ts`) para o trace da UI.
5. Teste em `tests/unit/agente.test.ts`.

## Smokes

```bash
npx ts-node --transpile-only src/scripts/smoke_agente.ts "sua pergunta"
npx ts-node --transpile-only src/scripts/smoke_skills_odds.ts Futebol ["Nome do evento"]
npx vitest run tests/unit/agente.test.ts tests/unit/promocoes.test.ts tests/unit/whatsappAgente.test.ts
```

Webhook do WhatsApp sem depender da Evolution (payload no formato do evolution-go):

```bash
curl -s -X POST "http://localhost:4000/api/whatsapp/webhook?token=$AGENT_WHATSAPP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"event":"Message","instanceName":"Geek-Imperial","data":{"Info":{"Chat":"120363411828181043@g.us","Sender":"5516999@s.whatsapp.net","IsFromMe":false,"ID":"TESTE1","PushName":"Joao","Timestamp":"'"$(date -Iseconds)"'"},"Message":{"conversation":"/status"}}}'
```
