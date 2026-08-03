# 🎾 Auditoria de Regras de W.O. no Tênis — Todas as Casas da Matriz

**Data:** 17 de Julho de 2026
**Escopo:** as 22 casas classificadas na matriz A/B (`regras.ts` / Diretrizes §3) + 1xbet
(ativa no scanner, nunca classificada). Fonte de cada linha: documento oficial de regras
publicado pela própria casa (citação literal + URL). Casas sem regra oficial acessível
ficam como **"?"** — nunca chute.

**Legenda dos grupos** (mercado Vencedor da Partida em abandono/desistência/lesão):
- **A** = anula (void) se a partida não for concluída, salvo mercado já determinado.
- **B** = "quem avança vence": com ≥1 set concluído, o desistente perde e o adversário ganha.
- **win/void** = variante da Betnacional: quem avança GANHA, mas a perna do desistente é
  DEVOLVIDA (não perde). Compatível com A e B no moneyline (nunca gera red por abandono).

## Tabela consolidada

| Casa | Grupo atual | Regra publicada (abandono no Vencedor) | **Sugestão** | Confiança | Fonte |
|---|:---:|---|:---:|:---:|---|
| AlfaBet | A | Void ("todos os mercados que ainda não tiveram seu resultado determinado serão liquidados como nulos") | **A** ✅ | alta | [alfa.bet.br/regras-de-apostas-esportivas](https://alfa.bet.br/regras-de-apostas-esportivas) §5.3 |
| Aposta Ganha | A | NÃO publicada acessível (central só define mercados; sportsbook BETBY = mesma plataforma da Alfa/Blaze, ambas void) | **?** ⚠️ | baixa | [ajuda.apostaganha.bet.br](https://ajuda.apostaganha.bet.br/category/17364-regras-gerais-de-apostas) |
| Aposta1 | A | Void ("se um jogador abandonar antes do ponto final ser concluído, o mercado de vencedor da partida será anulado") | **A** ✅ | alta | [aposta1.bet.br/lp/regras-apostas-esportivas](https://www.aposta1.bet.br/lp/regras-apostas-esportivas) §25 |
| bet365 (BR) | A | Void em partida não finalizada; DESQUALIFICAÇÃO → quem avança vence (igual Vbet/SeuBet) | **A** ✅ | alta | [help.bet365.bet.br/.../tennis](https://help.bet365.bet.br/s/pt-br/sportsrules/tennis) (via snapshot 10/2025; 403 p/ não-browser) |
| Bet7k (7K) | A | Regra específica de tênis NÃO localizada; regra genérica oficial é void ("abandonado antes do tempo integral → anuladas, exceto mercado incondicionalmente determinado") | **?** ⚠️ (tendência A) | baixa | [7k.bet.br/ajuda](https://7k.bet.br/ajuda/o-jogo-que-apostei-foi-adiado-ou-cancelado-e-agora) |
| BetBoom | A | Void ("as outras apostas serão liquidadas com base nas probabilidades '1'"; exemplo oficial anula W1/W2 em desistência 4:4) | **A** ✅ | média¹ | [betboom.bet.br/info/24845](https://betboom.bet.br/info/24845/Regulamento%20de%20apostas%20esportivas) §4.11 (texto via snapshot do doc idêntico) |
| Betão | A | Void ("se um jogador se aposentar, for desclassificado, ou houver um walkover... todas as apostas serão anuladas") | **A** ✅ | alta | [betao.bet.br/betting-rules](https://betao.bet.br/betting-rules) |
| Betnacional | A | **Variante win/void**: ATP/WTA/GS/Challenger pós-1º set → quem avança GANHA e a perna do desistente é ANULADA; ITF/UTR/exibição → void sempre | **A (manter)** ✅² | alta | [rules.betnacional.bet.br/regras-de-mercado](https://rules.betnacional.bet.br/regras-de-mercado) §3 (re-verificada) |
| Betsul | A | Void genérico (partida não concluída → aguarda 24h → cancela e devolve); sem cláusula específica de desistência | **A** ✅ | média¹ | [betsul.bet.br/regras-procedimentos](https://betsul.bet.br/regras-procedimentos) §2.10 (via snapshot 12/2025) |
| Blaze | A | Void ("em caso de desistência, W.O. ou encerramento antecipado... mercados não liquidados serão anulados") | **A** ✅ | alta | [blaze.bet.br/pt/sports-betting-rules](https://blaze.bet.br/pt/sports-betting-rules) §2.3 |
| BolsaDeAposta | A | **AVANÇO/1 SET** ("o jogador que avançar... será considerado o vencedor, A MENOS que a partida tenha durado menos de um set completo") | **B** 🚨 | alta | [mexchange.bolsadeaposta.bet.br/.../sports-rules](https://mexchange.bolsadeaposta.bet.br/rules-and-regulations/sports-rules) (re-verificada) |
| Novibet | A | NÃO VERIFICÁVEL (SPA + Cloudflare + geoblock; sem snapshot). Regra 2015 (intl) era void, mas promo BR atual "Pagamento Garantido em Desistências" sugere liquidação por avanço | **?** 🚨 | baixa | [novibet.bet.br/info/rules](https://www.novibet.bet.br/info/rules) (inacessível) |
| PixBet | A | Void ("em caso de desistência ou walkover de qualquer jogador, todas as apostas não decididas serão anuladas") | **A** ✅ | alta | [pixbet.bet.br/about/regras_de_apostas](https://pixbet.bet.br/about/regras_de_apostas) §2 |
| Rei do Pitaco | A | **AVANÇO/1 SET** ("será considerado como vencedor... o adversário do jogador que desistiu... necessário que pelo menos um set tenha sido completado") | **B** 🚨 | alta | [pitaco.bet.br/lps/regras-de-jogos-e-apostas](https://pitaco.bet.br/lps/regras-de-jogos-e-apostas) §12.2 (re-verificada) |
| SeuBet | A | Void em desistência/retirada; DESQUALIFICAÇÃO → quem avança vence | **A** ✅ | alta | [seubet.io/docs/regrasDeApostas](https://seubet.io/docs/regrasDeApostas) (PDF oficial, Tabela 165) |
| Stake | A | **AVANÇO/1 SET** ("o jogador/time que passam para a próxima rodada... é considerado como o vencedor da aposta, independentemente de desistências... exigem que pelo menos um set seja completado") | **B** 🚨 | alta | [stake.bet.br/regras-apostas](https://stake.bet.br/regras-apostas) §C-28 (re-verificada por mim via túnel) |
| Superbet | A | Void ("no caso de desistência ou desclassificação... todas as apostas não decididas serão invalidadas") — âncora confirmada | **A** ✅ | alta | [support.superbet.bet.br/.../41802572481041](https://support.superbet.bet.br/hc/pt-br/articles/41802572481041-Regras-Gerais-de-Apostas) |
| Vbet | A | Void em partida não concluída; DQ → quem avança (verificada hoje, ver VBET.md) | **A** ✅ | alta | [vbet.bet.br/pb/help/3385](https://vbet.bet.br/pb/help/3385) (go-cms partner 692) |
| Betano | **B** | **VOID PURO** ("3.3.4: Todas as apostas serão anuladas nos casos em que uma partida começar, mas não for concluída") — SEM regra de avanço | **A** 🚨🚨 | alta | [betano.bet.br/artigo/regras-de-apostas/326561](https://www.betano.bet.br/artigo/regras-de-apostas/326561/) §3.3.2/3.3.4 (re-verificada por mim via túnel) |
| BetWarrior | B | Avanço/1 set ("quem passa para a próxima rodada... vencedor da aposta... exige pelo menos um set completado") | **B** ✅ | alta | [PDF oficial T&C](https://s3.sa-east-1.amazonaws.com/static-content.betwarrior.bet/Product/burrger_menu/tycs_kambi/kambi_tyc_pt.pdf) §27 |
| KTO | B | Avanço/1 set — regra publicada BATE com a liquidação real do caso Brumm×Savkin (KTO.md) | **B** ✅ | alta | [ajuda.kto.bet.br/.../regras-gerais-de-esportes](https://ajuda.kto.bet.br/pt-BR/articles/9245479-regras-gerais-de-esportes) §28 |
| Pinnacle | B | Avanço/1 set ("apostas na partida no money line terão validade desde que um set tenha sido concluído, caso contrário... canceladas") | **B** ✅ | alta | [pinnacle.com/pt/future/betting-rules](https://www.pinnacle.com/pt/future/betting-rules) |
| 1xbet | — | Avanço/1 set ("permanecerão em vigor caso o primeiro set tenha sido realizado completamente... será atribuída a derrota técnica"; exemplo oficial dá red no desistente) | **B** (nova) | alta | [1xbet.bet.br/pt/information/rules](https://1xbet.bet.br/pt/information/rules) (entidade BR, DEFY LTDA) |

¹ *média* = regra oficial, mas obtida por snapshot (página viva atrás de WAF) ou apenas regra genérica.
² Betnacional NUNCA deve ir para o B: em ITF/UTR (onde mais há desistência) ela anula tudo — num B×B contra Pinnacle/KTO a perna dela voltaria (void) enquanto a outra casa dá red na perna oposta = prejuízo. No Grupo A ela é segura em todos os torneios (a variante win/void nunca dá red por abandono; no pior caso devolve, no melhor paga o avanço).

## Lote de 31/07/2026 — 4 casas novas (cada classificação verificada por um 2º revisor)

| Casa | Regra publicada (abandono no Vencedor) | **Grupo** | Confiança | Fonte |
|---|---|:---:|:---:|---|
| **BrBET** | **VOID**, declarado 2x no mesmo documento: "em caso de desistência de um jogador, ou ausência (lesão, doença ou circunstância pessoal), … desqualificação ou abandono, todos os mercados determinados em campo são liquidados em conformidade e todos os restantes indecisos são declarados nulos e sem efeito. Para evitar dúvidas, se um jogador de ténis desistir antes da conclusão do último ponto, **o mercado do vencedor do jogo é nulo**" | **A** ✅ | alta | [PDF oficial da casa](https://d1na21dgvoed1l.cloudfront.net/documents/661e5f86a6e23b0027c2ad6a/AltenarBettingRulesv1.29-English(1)pt-BR_pt_br.pdf) — "Altenar Betting Rules v1.29" traduzido, 196 p., p.61 §Tênis e p.6 §Regras Gerais |
| **MarjoSports** | **VOID**: "abandono ou desqualificação de ao menos um dos competidores, poderão ter as apostas não definidas como nulas"; "partidas definidas sem que sejam disputadas (WO), todos os mercados de tais eventos serão anulados"; ao vivo, "desqualificação, abandono ou WO … gera a anulação de todas as apostas não decididas" | **A** ✅ | alta | [PDF de regras de tênis](https://d1na21dgvoed1l.cloudfront.net/general/rules/tennis_pt.pdf) — "V1.0.0. - 16/07/2025", §Observações Gerais |
| **Onabet** | **NÃO PUBLICA REGRA NENHUMA de apostas.** Ausência PROVADA por enumeração: o CMS da casa expõe a lista completa de páginas (`/api/cms-go/v2/site/page/list`) = 10 páginas, nenhuma de regras. No T&C inteiro (217 mil caracteres): `desist`=0, `walkover`=0, `um set`=0, `avanç`=0, `desqualific`=0, `tênis`=0. Só existe §22.1 genérico de evento adiado/suspenso com janela de 72h — que não descreve desistência de tenista (a partida ENCERRA e alguém avança) | **?** 🚨 | alta (na ausência) | [T&C via API do CMS](https://ona.bet.br/page/terms-and-conditions) §22.1 (a URL humana está atrás de Cloudflare; o texto sai por `page?lang=BR_PT&name=terms-and-conditions`) |
| **BetEsporte** | **NÃO PUBLICA** cláusula de abandono. O regulamento oficial completo (8 documentos, 523 KB, via `GET /api/regulation/getRegulations`) TEM seção "TÊNIS" que define os mercados (Vencedor, Handicap, Total…) mas não diz o que acontece em desistência/W.O. | **?** 🚨 | alta (na ausência) | [API pública de regulamento](https://betesporte.bet.br/api/regulation/getRegulations) — doc id 25 "Mercados e Apostas", §Tênis |

### 01/08/2026 — Esportes da Sorte (a marca principal do mesmo grupo da Onabet)

| Casa | Regra publicada (abandono no Vencedor) | **Grupo** | Confiança | Fonte |
|---|---|:---:|:---:|---|
| **Esportes da Sorte** | **VOID PURO**, §tênis do rulebook do sportsbook: "No caso de aposentadoria ou desqualificação de uma partida, todos os mercados que ainda não tiveram seu resultado determinado serão considerados nulos" + "No caso de uma Passagem [walkover], todos os mercados serão liquidados como nulos". Tênis de mesa idem. Preâmbulo declara que "as Regras Especiais terão precedência sobre as Regras Gerais" | **A** ✅ | alta | módulo CMS `support-rules` (93.317 chars, `lastUpdateDate` 12/06/2026), página humana [/ptb/contents/support-rules](https://esportesdasorte.bet.br/ptb/contents/support-rules); texto obtido por `GET /api/generic/getWebModuleContentByCode/esportesdasorte.bet.br/support-rules/d/23` (curl pelado, sem header nenhum) |

**Desqualificação anula junto com a desistência** — na MESMA frase. Isso a diferencia de
bet365/Vbet/SeuBet, que anulam na desistência mas dão a vitória a quem avança em DQ.

🔑 **A lição do lote: a regra que classifica é do SPORTSBOOK, não do grupo empresarial.**
Esportes da Sorte e Onabet são do mesmo operador (Esportes Gaming Brasil LTDA) e compartilham
LITERALMENTE o mesmo T&C — que é mudo sobre desistência (censo idêntico nas duas: `desist`=0,
`walkover`=0, `um set`=0, `avanç`=0, `desqualific`=0). O que classificou a Esportes da Sorte foi
um SEGUNDO documento, o rulebook do sportsbook Sportingtech, que a Onabet não tem porque roda
outra plataforma (Altenar + CMS Atlas-IAC) e outra mesa de trading. Portanto **a Onabet segue
"?"** — estender o A dela seria a classificação por semelhança que a doutrina proíbe. A Lottu
(3ª marca do grupo) segue igualmente sem classificação.

**Endpoint reaproveitável (casas Sportingtech/TraderX):** o CMS inteiro sai sem auth por
`GET /api/generic/getUsedWebModuleCodesByTraderLanguageAndDevice/<host>/d/23` (enumera os
códigos; foram 38 nesta casa) e `GET /api/generic/getWebModuleContentByCode/<host>/<code>/d/23`
(conteúdo). Só o `support-rules` tem regra de esporte. Serve para auditar Lottu e qualquer
outra Sportingtech.

**Correção de registro:** a URL `/api/cms-go/v2/site/page/list` da Onabet (anotada em 31/07)
hoje devolve **401** — a enumeração viva agora sai do `window.CMS_CONFIG` inline no HTML da
home, que traz a árvore de navegação completa (19 entradas, 5 páginas estáticas, nenhuma de
regras de apostas). A conclusão "?" foi reconfirmada por esse caminho novo.

**Por que "?" e não "tendência A"** nas duas últimas: a Onabet roda **Altenar**, e a Altenar
tem operador em A (Aposta1 = void publicado) e em B (KTO = avanço, comprovado na liquidação
real do caso Brumm × Savkin). Sem regra do OPERADOR, a liquidação segue o default do trading
da plataforma — que no tênis é tipicamente avanço com ≥1 set. Chutar "A" aqui é exatamente a
armadilha A×B que já custou dinheiro neste projeto. A assimetria decide: bloquear uma casa
que era A custa OPORTUNIDADE; liberar uma casa que era B custa DINHEIRO.

Detalhe operacional descoberto no caminho: a **Onabet é do mesmo operador da EsportesDaSorte**
— Esportes Gaming Brasil LTDA (CNPJ 56.075.466/0001-00, licença SPA/MF Portaria 136/2025),
grupo que opera "Esportes da Sorte", "Onabet" e "Lottu". A EsportesDaSorte também está sem
classificação; se algum dia aparecer regra de tênis do grupo, ela resolve as duas de uma vez.

E um endpoint reaproveitável: as casas da plataforma **Atlas-IAC** (Onabet, Luvabet, Geralbet,
Realsbet, Lucksports, MMABet, 1pra1) expõem o CMS em `/api/cms-go/v2/site/page?lang=BR_PT&name=<slug>`
e a lista de páginas em `/api/cms-go/v2/site/page/list` — sem Cloudflare, sem browser. Serve
para auditar regra de qualquer uma delas. (Pegadinha: `page/<slug>` no path dá 500; tem de ser
query string.)

## 🚨 Divergências críticas (regra publicada ≠ grupo atual)

| Casa | Hoje | Deveria ser | Risco se ficar como está |
|---|:---:|:---:|---|
| **Betano** | B | **A** | Está na whitelist da KTO (KTO.md §2)! KTO×Betano com abandono pós-1º set: KTO dá red numa perna, Betano anula a outra = **prejuízo** (mesmo padrão do incidente KTO) |
| **Stake** | A | **B** | Stake×Superbet (A×A hoje): abandono pós-1º set → Stake dá red, Superbet anula = **prejuízo** |
| **BolsaDeAposta** | A | **B** | Idem Stake: cruzamento com qualquer A real vira void×red |
| **Rei do Pitaco** | A | **B** | Idem Stake |
| **Novibet** | A | **?** | Regra atual não verificável + promo sugere avanço; manter no A é aposta cega |
| **Aposta Ganha / Bet7k** | A | **?** | Sem regra publicada acessível; provável A (plataforma/regra genérica), mas sem confirmação |
| **1xbet** | — | **B** | Hoje o tênis dela fica bloqueado (grupo desconhecido); classificar como B destrava cruzamentos com Pinnacle/BetWarrior/KTO |

**Impacto no scanner:** as casas raspadas diretamente (KTO, BetWarrior, Superbet, Aposta1,
Pinnacle, BetBoom, SeuBet, Vbet, Blaze) estão TODAS corretas. As divergências entram pelo
**SureRadar** (que traz Betano, Stake etc.) e pela **whitelist da KTO** — os cruzamentos
envolvendo Betano são os mais urgentes.

## Observações de mercado secundário (Handicap/Totais de games)

- Template Sportradar (KTO, BetWarrior, Stake, 1xbet, Blaze/BETBY, bet365, Betano):
  liquidação parcial "matemática" — linhas já garantidas no momento do abandono PAGAM
  (inclusive dando red no lado perdedor); só as indeterminadas anulam.
- Template void-integral (Betão, Betsul, PixBet aparente): anula tudo que não estiver
  decidido, sem liquidação parcial.
- Cruzar handicap/total entre casas de templates diferentes tem risco residual em abandono
  mesmo dentro do mesmo grupo de moneyline (motivo do bloqueio atual da KTO nesses
  mercados — o mesmo raciocínio pode valer para outras se o volume justificar análise).

## Lições de método (para re-auditar)

- Betano/Stake/1xbet/Pinnacle bloqueiam datacenter → usar Playwright pelo túnel Tailscale
  (`PINNACLE_PROXY`) no container backend.
- BetConstruct (Vbet): conteúdo em `go-cms.{casa}/api/public/v1/pt-br/partners/{id}/contents/{pageId}`
  (id da página no `footer_menu_*.json` do skin). SeuBet foge do padrão: PDF em seubet.io.
- Zendesk (Superbet, BetWarrior): API `…zendesk.com/api/v2/help_center/…` entrega o texto.
- BetBoom/Betsul: WAF por fingerprint TLS mesmo via túnel → Wayback do documento oficial.
- Regra publicada ≠ liquidação real (lição KTO): mudanças de grupo pedem monitoramento da
  primeira liquidação real de abandono.

## ✅ Aplicação (17/07/2026, aprovada pelo usuário)

Reclassificações aplicadas em `regras.ts` + KTO.md (whitelist) + Diretrizes §3 + testes
(`regras.test.ts`, suíte completa 99/99 ✅):
- **betano B→A** (removida da whitelist da KTO — KTO×Betano agora é rejeitado pelo motor);
- **stake, bolsadeaposta, reidopitaco A→B**;
- **1xbet → B** (nova — destrava o tênis dela no scanner);
- **novibet removida** do Grupo A (desconhecida → bloqueada no tênis até verificação manual);
- **betnacional mantida em A** (variante win/void);
- **apostaganha e bet7k mantidas em A por status quo** (fora do escopo aprovado; regra não
  confirmada — decidir/verificar se ganharem volume de cruzamento via SureRadar).

Ressalva permanente (lição KTO): monitorar a primeira liquidação real de abandono das
casas reclassificadas (Betano, Stake, BolsaDeAposta, Rei do Pitaco, 1xbet).

---

## Lote 29/07/2026 — casas novas (Luvabet, Rivalo, Brazino777, Aposta Ganha)

Auditoria feita ao integrar as casas novas. Metodologia igual à de 17/07: só o documento
oficial da própria casa, citação literal + URL; sem regra acessível = **?** (nunca chutar).

| Casa | Documento | Regra publicada (abandono no Vencedor) | **Sugestão** | Confiança | Fonte |
|---|---|---|:---:|:---:|---|
| Brazino777 | acessível | **AUTOCONTRADITÓRIA.** A mesma seção "Tênis" diz "No caso de uma aposentadoria e de passar por cima de qualquer jogador, todas as apostas indecisas são consideradas nulas" E TAMBÉM "se a partida tiver começado e pelo menos **um ponto** tiver sido jogado e depois disso o jogador se aposentar, **todas as apostas são consideradas válidas**" | **?** 🚨 | alta (no texto, não na interpretação) | [brazino777.bet.br/blog/betting-terms](https://www.brazino777.bet.br/blog/betting-terms) |
| Luvabet | acessível | **NÃO PUBLICADA.** `/page/terms-and-conditions` (95k chars, 534 linhas) é T&C genérico, sem nenhuma seção por esporte; todas as ocorrências de "retirada" são de SAQUE de valores. `/page/termos-de-apostas` é stub de 270 chars | **?** ⚠️ | alta | [luva.bet.br/page/terms-and-conditions](https://luva.bet.br/page/terms-and-conditions) |
| Aposta Ganha | acessível | **NÃO PUBLICADA.** `/regras-de-apostas` (25k chars) não tem UMA menção a desistência/aposentadoria/abandono/walkover | **remover de A** 🚨 | alta | [apostaganha.bet.br/regras-de-apostas](https://apostaganha.bet.br/regras-de-apostas) |
| Rivalo | não localizado | O rodapé de `/pt/` não expõe link de regras (só links de aposta ao vivo) | **?** ⚠️ | — | — |

### Decisões aplicadas

- **Luvabet, Rivalo, Brazino777**: ficam FORA de A e de B → `grupoTenis()` = `null` → todo
  cruzamento de tênis/tênis de mesa delas é rejeitado. Nenhuma pôde ser promovida.
- **Brazino777** merece destaque: o texto dela não é nem A nem B. Liquidar como válido após
  **1 ponto** é ainda mais agressivo que o Grupo B (que exige 1 SET completo). Logo, cruzá-la
  com uma casa B *também* daria red quando a desistência acontece antes do 1º set fechar.
- **Aposta Ganha: REMOVIDA do Grupo A.** Ela estava em A "por status quo" com confiança
  **baixa**, e o único fundamento registrado em 17/07 era *"sportsbook BETBY = mesma
  plataforma da Alfa/Blaze, ambas void"*. **Esse fundamento é falso**: o recon de 29/07
  provou que ela roda **NSoft** (tenant `aposta_ganha_sportsbook`), não BetBy. Como ela
  passou a ser FONTE de odds em 29/07 (antes era só alvo de recon), a classificação deixou
  de ser inócua e passou a gerar cruzamento real de tênis com regra não verificada — mesma
  situação que motivou remover a Novibet. Doutrina: desconhecida bloqueia.
- **Bet7k** continua em A pelo mesmo "status quo" frágil, mas NÃO é fonte de odds hoje —
  fica no radar para quando/se for integrada.

---

## Lote 03/08/2026 — Betsson (integrada como fonte de odds neste lote)

Auditoria feita ao integrar o scraper da Betsson. Mesma metodologia: só o documento oficial
da própria casa, citação literal + fonte; sem regra acessível = **?**.

**Obtenção da fonte:** as páginas HTML da Betsson são barradas por AWS WAF (HTTP 202 com
corpo vazio) e o texto das regras **não está no HTML servido** — o site é todo web
components e o conteúdo vem do CMS por API que também é WAF-protegida fora do browser.
O texto foi extraído com chromium headed sob xvfb, atravessando o **shadow DOM**
(`document.body.innerText` devolve 0 chars; é preciso descer em `shadowRoot`
recursivamente). O mesmo corpo sai da API `GET /api/v2/content/documentgroups/game-rules`
quando chamada DE DENTRO do browser (308 KB).

| Casa | Documento | Regra publicada (abandono no Vencedor da Partida) | **Sugestão** | Confiança | Fonte |
|---|---|---|:---:|:---:|---|
| **Betsson** | acessível (via shadow DOM) | **"1 SET CONCLUÍDO"**: §17.57 Tênis → *"Vencedor da partida, inclusive durante o jogo — **Um set completo deve ser completado para que as apostas sejam válidas. Se menos de um set for completado na partida, todas as apostas serão consideradas nulas.**"* Não há cláusula de void por desistência: com ≥1 set fechado a aposta é VÁLIDA e liquida pelo resultado oficial (= quem avança) | **B** 🚨 | alta | [betsson.bet.br/my-account/game-rules/sportsbook](https://www.betsson.bet.br/my-account/game-rules/sportsbook) §17.57 (censo do doc: `um set`=8, `avanç`=7, `desist`=14, `desqualific`=22, `aposentad`=0) |

**Por que B e não A — o argumento que sustenta a classificação:**

1. A redação é **estruturalmente idêntica à da Pinnacle**, já classificada B com confiança
   alta: *"apostas na partida no money line terão validade desde que um set tenha sido
   concluído, caso contrário… canceladas"*. Mesma forma, mesma consequência.
2. O documento **prova que a Betsson sabe escrever cláusula de avanço explícita quando é
   isso que ela quer** — §17.50 Snooker: *"Se uma partida começar, mas não for concluída por
   qualquer motivo, **o jogador que avançar** para a próxima rodada ou receber a vitória
   será considerado o vencedor."* No tênis ela escolheu a forma "1 set válida"; em nenhum
   lugar do §17.57 aparece anulação por desistência do Vencedor da Partida.
3. Contraste com as casas do Grupo A: todas elas têm frase EXPLÍCITA de void por
   desistência no mercado de vencedor (BrBET, MarjoSports, Esportes da Sorte, Superbet,
   PixBet…). A Betsson não tem nenhuma.

**Ressalva registrada (não bloqueante, mas anotada):** no MESMO §17.57, handicap de partida
e Match Games (totais) são **anulados** se a partida não terminar, *"a menos que não haja
nenhuma maneira possível de a partida ser jogada até sua conclusão natural sem determinar
incondicionalmente o resultado desse mercado"* — com exemplos numéricos oficiais. É o mesmo
padrão da KTO que motivou o bloqueio do KTO.md §3 em Handicap/Totais de tênis. A diferença
é que na KTO havia caso real de liquidação divergente; aqui é só a redação padrão do
mercado (que a Pinnacle também tem). Fica anotado para reavaliar se a Betsson ganhar volume
em Handicap/Totais de tênis.

### Decisão aplicada (03/08/2026)

**APLICADA com aprovação do usuário no mesmo dia:** `'betsson'` entrou no `GRUPO_B` de
`regras.ts`. `grupoTenis('Betsson')` agora devolve `'B'`, liberando cruzamentos de tênis
Betsson×Pinnacle / ×BetWarrior / ×KTO / ×Stake / ×BolsaDeAposta / ×ReiDoPitaco / ×1xbet.
Cruzamento com qualquer casa do Grupo A segue rejeitado (A×B), como manda a doutrina.

Duas consequências que valem registro:
- **Tênis de mesa não muda nada na prática**: a Betsson não oferta tênis de mesa.
- **A ressalva da KTO segue valendo por cima**: em Handicap/Totais de tênis, o par
  Betsson×KTO continua bloqueado pelo gate do KTO.md §3 (que é por CASA, não por grupo).

Monitorar a 1ª liquidação real de abandono da Betsson — mesma cautela aplicada às
reclassificadas de 17/07 (lição da KTO: regra publicada ≠ liquidação do provedor).

---

## Lote 03/08/2026 (2ª parte) — EstrelaBet e 4Play

As duas eram FONTES de odds desde 26/07 com o tênis **inteiro rejeitado** pelo fail-safe
(nunca classificadas) — juntas somam ~4.500 odds/varredura. Auditadas a pedido do usuário,
com autorização para aplicar direto o que fosse confiança ALTA.

**Obtenção da fonte (as duas resistem a HTTP puro):**
- **4Play**: tudo 403 (Akamai) em fetch pelado. Cedeu com chromium HEADED sob xvfb: o
  rodapé expõe `/info/regrasesportivas`, que rende **4,9 MB** de regras.
- **EstrelaBet**: SPA cujo Zendesk dá 403 e cujas rotas `/pagina/*` renderizam conteúdo
  GENÉRICO (as 4 que testei devolveram o mesmo texto, sem a palavra "tênis" — armadilha:
  parecem existir, HTTP 200). O documento real é **`/policy/sports-betting-rules`**
  (2,2 MB), descoberto lendo os âncoras do rodapé no browser após rolar a página.
- Nos dois casos o texto exige extração por **shadow DOM** (a receita da Betsson).

| Casa | Regra publicada (abandono no Vencedor) | **Grupo** | Confiança | Fonte |
|---|---|:---:|:---:|---|
| **4Play** | **VOID PURO** (template Altenar traduzido): "em caso de desistência do jogador (lesão, doença ou circunstância pessoal), decisão de adulto, vitória fácil, desqualificação ou abandono, todos os mercados determinados no campo são liquidados em conformidade e todo o resto indecisos declarado nulo e sem validade. **Para evitar dúvidas, se um tenista se retirar antes do último ponto concluído, o mercado vencedor da partida é anulado**, mas todos os mercados relacionados a sets ou jogos específicos que são determinados são liquidados de acordo" | **A** ✅ | alta | [4play.bet.br/info/regrasesportivas](https://4play.bet.br/info/regrasesportivas) |
| **EstrelaBet** | **VOID PURO** — texto LITERALMENTE IGUAL ao da 4Play (mesmo template Altenar, só troca o nome da marca) | **A** ✅ | alta | [estrelabet.bet.br/policy/sports-betting-rules](https://www.estrelabet.bet.br/policy/sports-betting-rules) |

### Verificação adversarial (feita nos dois documentos)

Tentei derrubar a classificação procurando a regra de 1-set/avanço do Grupo B:
- **"avanço"/"próxima rodada"/"vencedor da aposta"**: nenhuma ocorrência ligada a tênis. O
  único hit próximo é a promo de *pagamento antecipado* do BASQUETE ("quando a equipe estiver
  com dezoito ou vinte pontos de vantagem") — não é regra de liquidação de W.O.
- **"um set"** (40 ocorrências): todas são **definição de mercado** ("Jogador 1 para ganhar
  um set", "Ambos os jogadores vencerão um set", "Total de jogos do Set X"), nunca condição
  de validade do vencedor da partida. Não existe a cláusula "é necessário um set completo
  para as apostas serem válidas" que caracteriza o Grupo B.
- Contraste que reforça: as casas do Grupo B (Pinnacle, KTO, BetWarrior, Betsson, Stake)
  TÊM essa frase explícita. Aqui ela não existe, e existe a frase oposta ("é anulado").

### Decisão aplicada (03/08/2026)

`'estrelabet'` e `'4play'` entraram no **GRUPO_A** de `regras.ts`. O tênis das duas passa a
cruzar com todo o Grupo A (Aposta1, Superbet, BetBoom, Betnacional, SeuBet, Vbet,
EsportesDaSorte, BrBET, MarjoSports, Betano, Blaze…) e segue rejeitado contra o Grupo B
(Kambi, Pinnacle, Betsson, Stake, 1xbet, Bolsa, Pitaco).

Como as duas são Altenar, vale repetir a lição do lote 31/07: **isto NÃO se estende para
outras casas Altenar** (Onabet, Luvabet) — o que classifica é o documento do OPERADOR, e
Altenar tem operador em A (Aposta1, BrBET, e agora estas duas) e em B (KTO).

Monitorar a 1ª liquidação real de abandono das duas — mesma cautela das reclassificadas.
