# Agente de IA (aba "IA & Automação")

Lote de 30/07/2026. O chat de turno único virou um **agente com ferramentas**: ele
consulta odds ao vivo nas casas, o radar, a banca, as regras e as calculadoras antes de
responder — e mostra no frontend **quais skills usou** em cada resposta.

## Arquitetura

```
POST /api/ai/chat
  └─ IA/agent/agentLoop.ts        loop ReAct (system prompt + tools → executa skill → repete)
       ├─ IA/agent/chatModels.ts  motores com tool-calling: Groq/OpenAI (REST OpenAI-compat) e Gemini (functionDeclarations)
       ├─ IA/agent/registry.ts    registro das skills (+ projeção enxuta para o modelo)
       ├─ IA/agent/skills/*.ts    as ferramentas
       ├─ IA/agent/catalogoCasas.ts  o que cada casa sabe fazer (derivado do código)
       ├─ IA/agent/comparadorOdds.ts tabela comparada entre casas (mesmo matching do motor)
       └─ IA/conhecimento/*       doutrina de promoções + conversa original com o Gemini

GET /api/ai/skills   → catálogo de skills, casas, provedores e cadeia ativa (o painel da aba lê isto)
```

`modo: 'simples'` no corpo do POST (ou `AGENT_DESATIVADO=1`) cai no chat antigo de turno
único — válvula de escape se um provedor quebrar function calling.

## Skills (20)

| grupo | skill | o que faz |
|---|---|---|
| odds | `listar_casas` | catálogo das casas integradas e capacidades |
| odds | `consultar_odds_casa` ⏳ | odds ao vivo de UM evento numa casa |
| odds | `comparar_odds_casas` ⏳ | mesmo evento em N casas: melhor odd por lado, ROI ou quanto falta |
| radar | `surebets_no_radar` | surebets ativas com filtros (ROI, esporte, casa, evento) |
| radar | `revalidar_surebet` ⏳ | reconsulta as duas pernas ao vivo (por id) |
| radar | `value_bets_e_middles` | +EV vs Pinnacle e middles ativos |
| radar | `radar_cashout` | dropping odds recentes |
| banca | `banca_e_saldos` | banca ativa + saldo por casa |
| banca | `historico_entradas` | operações lançadas, com período/esporte/casa e agregados |
| banca | `historico_promocoes` | freebets/qualificativas registradas + retenção média |
| regras | `checar_regras_do_par` | Diretrizes: mercado proibido, grupos de W.O., regra da KTO |
| regras | `regras_de_anulacao_da_casa` | política de void por casa/esporte |
| cálculo | `calcular_surebet` | distribuição de stake, lucro e ROI garantido |
| cálculo | `calcular_cobertura_promocao` | freebet SNR / qualificativa / cashback |
| cálculo | `otimizar_odd_freebet` | curva de retenção e odd ótima √(1+1/m) |
| cálculo | `calcular_multipla_qualificadora` | regulamento + cobertura sequencial |
| conhecimento | `buscar_conhecimento` | doutrina + conversa do Gemini (blank.pdf) |
| ação | `criar_oportunidade_no_radar` ✍️ | registra surebet (via SignalPipeline: gates + dedup + revalidação) |
| ação | `registrar_promocao` ✍️ | grava no histórico de promoções |
| ação | `avisar_no_whatsapp` ✍️ | uma mensagem no grupo de alertas (desligada por padrão) |

⏳ = consulta lenta (rede/scraper). ✍️ = escrita; só roda se a mensagem do usuário pedir
explicitamente (gate no `agentLoop`, além da instrução no prompt).

## Guardas do loop

| guarda | env | default | por quê |
|---|---|---|---|
| rodadas de ferramenta | `AGENT_MAX_PASSOS` | 6 | evita loop infinito; ao estourar, pede fechamento em texto |
| skills lentas por pergunta | `AGENT_MAX_SKILLS_CUSTOSAS` | 4 | VPS de 1 core; um "compara tudo" sem limite a derruba |
| payload de uma skill | `AGENT_MAX_CHARS_SKILL` | 3800 | o resultado fica no histórico e é reenviado a cada rodada |
| skill de WhatsApp | `AGENT_WHATSAPP_SKILL` | off | o destino é o grupo de alertas |

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

- `IA/conhecimento/doutrinaPromocoes.ts` — 13 seções destiladas (freebet SNR, retenção,
  qualificativa, cashback, "aposte e ganhe", múltipla, cobertura sequencial, escalonamento
  1ºT/2ºT, adiar cobertura, abuso de bônus, surebet e seus riscos, condução da operação).
- `IA/conhecimento/corpusPromocoes.ts` — a conversa completa com o agente do Gemini
  (26 trocas, exportada de `blank.pdf`; versão legível em
  `docs/conhecimento/promocoes_freebets_gemini_2026-07-30.md`).
- Busca por palavra-chave (sem embeddings) em `IA/conhecimento/index.ts` — não depende de
  crédito de IA, que é exatamente o que faltou em 29/07.

Duas correções que fizemos sobre o material original, com teste em
`tests/unit/promocoes.test.ts`:

- **A retenção da freebet tem PICO.** `R(O) = (O−1)·(1 − m·(O−1))/O`, ótimo em
  `O* = √(1 + 1/m)`. Com m≈6% o ótimo é ~4,2 — a odd 7.75 do caso real rendeu ~38% de
  retenção (R$ 3,82 de R$ 10), não os "75% a 85%" projetados.
- **A cobertura sequencial tem caixa de pico.** `x_k = (S + Σx anteriores − perda aceita)/(h_k − 1)`
  cresce a cada green; o app agora avisa o total antes de começar.

## Matemática de promoções

`core/promocoes.ts` é a fonte única (usada pela skill e pelo `POST /api/promocoes`, que
antes tinha a fórmula duplicada): `calcularPromocao`, `calcularMultiplaQualificadora`,
`curvaRetencaoFreebet`, `margemImplicita`, `oddIdealFreebet`, `retencaoTeorica`.

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
npx vitest run tests/unit/agente.test.ts tests/unit/promocoes.test.ts
```
