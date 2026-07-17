Ótima pergunta — e a melhor forma de responder é olhando **onde o sistema hoje descarta ou não busca oportunidades**, não teoria genérica. Deixa eu levantar os limitadores reais no código:

Ran terminal command: cd /root/jotinhabet/backend/src
echo "=== 1) TETO de eventos por casa/esporte (quanto do catálogo é varrido) ==="
grep -rnE "maxEventos|maxCampeonatos|maxEventosDetalhe|slice\(0," scraping/*.ts | grep -iE "maxEvent|maxCamp|slice\(0, *(this|[0-9])" | head
echo
echo "=== 2) FILTRO de linha (só meia-linha) — quantos mercados isso descarta ==="
grep -rnE "ehMeiaLinha|Math.abs\(l % 1\)" scraping/*.ts | head
echo
echo "=== 3) esportes varridos ==="
grep -n "const esportes" core/scanner_v2.ts
echo
echo "=== 4) matcher: limiar de similaridade de time ==="
grep -nE "threshold|jaroWinkler.*>=|areTeamsSame" arbitrage/matcher.ts | head
echo
echo "=== 5) ao vivo? (aoVivo) ==="
grep -rnE "aoVivo|isLive|prematch|PRÉ-JOGO|ehPreJogo" core/scanner_v2.ts scraping/casa_pinnacle.ts | head
echo
echo "=== 6) SureRadar plano/paywall ==="
grep -nE "free|VIP|liberadas|min_profit|plano" scraping/casa_sureradar.ts | head

Analisei os limitadores reais no código. A boa notícia: o gargalo **não** é o algoritmo — é **quanto do mercado a gente olha**. Hoje o sistema descarta muita oportunidade legítima antes mesmo de avaliar. Aqui está o diagnóstico e o roteiro, do mais barato/seguro ao mais estratégico.

## Onde estamos perdendo oportunidades (medido no código)

| Limitador | Hoje | Impacto |
|---|---|---|
| **Teto de eventos/casa** | Pinnacle **25**, Kambi **60**, Altenar **20 ligas**, browser **5** | A Pinnacle é a âncora sharp e só olhamos 25 jogos dela! |
| **Só meia-linha** (`.5`) | descarta toda linha `.25/.75` | Perde ~metade dos handicaps/totais asiáticos (fortíssimo na Pinnacle) |
| **Só 4 esportes** | Futebol, Basquete, Tênis, Esports | Vôlei, Tênis de Mesa, Beisebol, Hóquei ficam de fora — as APIs já têm (KTO tem 211 jogos de tênis de mesa, 860 de beisebol) |
| **Só 5-6 casas** | KTO, BW, Superbet, Aposta1, Pinnacle + SureRadar | Recon achou 6 casas novas prontas |
| **Só pré-jogo** | ao vivo bloqueado | Ao vivo tem muito mais arb (odds atrasam) — mas risco de execução |
| **SureRadar free** | ~75% atrás do paywall VIP | Volume curado bloqueado |

## Roteiro priorizado (impacto × esforço × risco)

**🟢 Tier 1 — barato, seguro, alto retorno (começaria aqui):**
1. **Subir os tetos de eventos** — Pinnacle 25→80, Kambi 60→120, Altenar 20→40 ligas. É só config + mais tempo de scan. **Destrava arb que já existe e a gente nem olha.** Risco ~zero.
2. **Adicionar esportes** (Vôlei, Tênis de Mesa, Beisebol, Hóquei) — as APIs Kambi/Pinnacle/Superbet já expõem; é mapear sportId/path + rótulo de total. Tênis de mesa e vôlei têm volume enorme e gaps frequentes.
3. **Melhorar o casamento de times** (aliases, acentos, "(BR)", sufixo feminino "(W)") — o limiar é 0.75; nomes divergentes fazem arbs reais **não cruzarem**. Descobre oportunidade que já está lá.

**🟡 Tier 2 — médio esforço, multiplicador:**
4. **Suportar quarter-lines** (asiático `.25/.75`) com a matemática de stake dividido — praticamente **dobra** a superfície de handicap/total, principalmente contra a Pinnacle.
5. **Integrar as casas do recon** (BetBoom REST primeiro → Vbet → Betnacional) — cada casa de plataforma nova é multiplicativo nos cruzamentos.

**🔴 Tier 3 — estratégico:**
6. **Ao vivo (in-play)** para esportes de bola — maior volume de arb, mas exige tratar latência/rejeição de bilhete. Mais risco.
7. **Modo +EV / value bet** usando a Pinnacle como "odd justa" — explode o volume, mas **não é surebet garantida** (é aposta de valor esperado positivo). Decisão de produto/risco.
8. **SureRadar pago** — decisão de custo sua; destrava volume na hora.

## Princípio (importante depois desta sessão)
Passamos horas **removendo falsos positivos**. "Mais oportunidades" aqui significa **ampliar a superfície real** (mais casas/mercados/eventos/esportes/matching) — **nunca** baixar os filtros de qualidade. Cada item acima adiciona arb legítima, não ruído.

## Minha recomendação
Começar pelo **Tier 1 inteiro** — é quase de graça, sem risco, e o ganho é imediato (especialmente subir a Pinnacle de 25 e ligar vôlei/tênis de mesa). Faço os três de uma vez, com teste e verificação ao vivo, como temos feito.

Quer que eu comece pelo Tier 1? Ou prefere priorizar as **casas novas** (Tier 2.5) ou o **ao vivo**?

---

# 📅 Sessões de 17/07/2026 — registro consolidado

## O que entrou no sistema hoje (sessões anteriores do dia)

- **Tier 1 completo**: tetos de eventos (Pinnacle 25→80 via endpoint bulk pelo túnel; Kambi 60→120; Altenar 20→40; Superbet 40→80); esportes novos (Vôlei, Tênis de Mesa, Beisebol — hóquei adiado p/ outubro: regulamentar×OT diverge entre casas); matching melhorado (vírgula "Sobrenome, Nome", país "(BRA)", guardas feminino/Sub-N/reserva, aliases VNL/MLB).
- **Quarter-lines (.25/.75)**: parsers aceitam; ROI exibido/alertado é o PISO (nominal/2); revalidação e stakes idem (`ehLinhaQuarter`/`linhaArbitravel`).
- **BetBoom integrada** (`casa_betboom.ts`, REST sptpub ~5 req/scan).
- **SeuBet integrada** (`casa_swarm.ts` — classe genérica `SwarmScraper` BetConstruct via WS; ~3.8k odds/scan).
- **Bug grave corrigido**: parser Kambi tinha fail-open que rotulava mercado desconhecido como 'Resultado Final' (ROI falso de 29% no beisebol) → whitelist fail-closed.
- **Incidente VPS resolvido**: com 7 casas o cruzamento O(n²) derrubou a VPS (load 56) → buckets por (esporte|mercado|linha) + memoização + trava global de varredura. Benchmark: 72k odds em 3.7s.
- **Feature "salvar oportunidade"**: migration 009 (`salva`), POST /api/opportunities/:id/save, limpezas automáticas pulam salvas, botão bookmark no card. WhatsAppNotifier ganhou `enviarTexto()`.

## Sessão da tarde/noite — Vbet + auditoria de W.O.

### 1. Vbet integrada e classificada (FEITO)
- `VbetScraper` (subclasse do `SwarmScraper`, site_id 692, `wss://eu-swarm-newm.vbet.bet.br/`) plugado no scanner e na revalidação.
- **Classificada Grupo A no tênis** pelas regras publicadas: "apostas em partidas de tênis serão anuladas se não forem concluídas"; "quem avança vence" só em DESQUALIFICAÇÃO. Evidência + endpoint de re-verificação em **`VBET.md`** (raiz).
- Método novo descoberto p/ casas BetConstruct: `footer_menu_{siteId}_pt-br.json` do skin → id da página de regras → `go-cms.{casa}/api/public/v1/pt-br/partners/{id}/contents/{pageId}` (conteúdo integral sem browser).
- Aplicado: `regras.ts` (vbet em GRUPO_A), Diretrizes §3, comentário do scraper, testes `regras.test.ts` (15/15 ✅).
- Ressalva registrada: monitorar a 1ª liquidação real de abandono (lição KTO: regra publicada ≠ liquidação).

### 2. Auditoria de regras de W.O. das 23 casas (FEITO — decisão PENDENTE)
Pedido do usuário: verificar as regras de TODAS as casas da matriz + coluna de sugestão. Executado com 5 agentes paralelos + re-verificação manual de todas as divergências (Betano e Stake via Playwright pelo túnel Tailscale `PINNACLE_PROXY`; demais via fetch direto). Resultado completo com citações literais e fontes: **`GRUPOS_WO_CASAS.md`** (raiz). Aviso enviado no WhatsApp ✅.

**🚨 Divergências encontradas (regra publicada ≠ grupo atual do motor):**
| Casa | Hoje | Sugestão | Nota |
|---|---|---|---|
| **Betano** | B | **A** | VOID puro (3.3.2/3.3.4). CRÍTICO: está na whitelist da KTO (KTO.md §2) → KTO×Betano em abandono = red+void = prejuízo. Chega via SureRadar. |
| **Stake** | A | **B** | Template Sportradar de avanço/1 set |
| **BolsaDeAposta** | A | **B** | Avanço/1 set (regras do exchange) |
| **Rei do Pitaco** | A | **B** | Regra 12.2, avanço/1 set |
| **Novibet** | A | **?** | Regra inacessível (Cloudflare+geoblock); promo sugere avanço |
| **Aposta Ganha / Bet7k** | A | **?** | Regra de tênis não publicada acessível |
| **1xbet** | — | **B** | Entidade BR (1xbet.bet.br) com regra própria; destravaria o tênis dela |
| **Betnacional** | A | **A (manter)** | Variante "win/void": ATP pós-1set avança GANHA + desistente DEVOLVIDO; ITF/UTR void. Nunca mover p/ B (perderia em ITF/UTR×B). |

**Confirmadas corretas:** Superbet, Aposta1, BetBoom, SeuBet, Vbet, Blaze, bet365, Betão, Betsul, PixBet, AlfaBet (A) / Pinnacle, BetWarrior, KTO (B — regra publicada bate com a liquidação real do caso Brumm×Savkin). As casas raspadas diretamente pelo scanner estão TODAS corretas; o risco das divergências entra pelo SureRadar.

**✅ APLICADO (aprovado pelo usuário na mesma noite):** betano→A, stake/bolsadeaposta/reidopitaco→B, 1xbet→B, novibet sem grupo (bloqueada); betnacional mantida em A; apostaganha/bet7k mantidas em A por status quo (regra não confirmada — decidir depois). Whitelist do KTO.md atualizada (Betano fora; Stake/1xbet/BolsaDeAposta/ReiDoPitaco entram como pares B), Diretrizes §3 reescrita (KTO corrigida p/ B lá também) e testes novos — suíte completa 99/99 ✅. Monitorar 1ª liquidação real de abandono das reclassificadas.

## Estado do working tree
Tudo de hoje está SEM commit (push é o usuário quem faz — SSH da VPS não autorizada). Deploy pendente: build TS + `docker service update --force` (ver memória deploy-swarm-vps). Validação do `VbetScraper` em produção ainda não feita.

## Próximos passos (retomar por aqui)
1. ~~Decisão do usuário: aplicar as reclassificações da auditoria~~ ✅ FEITO (aprovado e aplicado em 17/07).
2. ~~Deploy na VPS + validação da Vbet~~ ✅ FEITO (17/07 ~19h40): backend buildado e rolado (`service update --force`), healthy; scan de produção validado com Vbet viva (**3.463 odds**: 425 tênis + 155 mesa + futebol/basquete/vôlei/e-sports), ciclo completo sem erros (6 surebets salvas, SureRadar 29 opps, reconciliação ok); grupos novos confirmados no dist do container. Frontend já estava atualizado (imagem mais nova que o working tree). **Falta só: commit + push (usuário).**
3. Roteiro de casas: **Betnacional** (BFF bet6 + WS, auth médio) → **EsportesDaSorte** (re-probe Playwright capturando feed) → Sportingbet/Novibet (só-browser, por último). BetPix365 é trivial (Altenar) mas redundante com Aposta1.
4. Tier 3 (backlog): ao vivo (in-play), modo +EV com Pinnacle como odd justa, SureRadar pago (decisão de custo).
5. Hóquei: reavaliar em outubro (NHL).