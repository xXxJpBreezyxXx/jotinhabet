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
