## 🚨 Atualização Crítica de Risco: Matriz de Tênis (KTO)

**Data da Revisão:** 17 de Julho de 2026
**Status Anterior:** Grupo A (Regra da Partida Completa)
**Novo Status Operacional:** Grupo B (Regra de 1 Set Concluído)

### 1. Histórico do Incidente (Edge Case de Provedor)
Durante o monitoramento de varredura em torneios de menor expressão (*UTR Pro Tennis Series - Newport Beach*), foi mapeado um comportamento divergente no provedor de *odds* da KTO (Altenar) no mercado de **Vencedor da Partida**.

* **Cenário Identificado:** Partida entre Jacob Brumm e Ivan Savkin.
* **Gatilho:** Abandono (W.O.) de um dos tenistas após a conclusão do 1º set.
* **Comportamento da KTO:** Em vez de anular a aposta (Void) como as casas do Grupo A, a KTO aplica a regra de avanço de fase. O jogador que avança no torneio é liquidado como "Vencedor" e a aposta adversária recebe "Perdida" (Red).

### 2. Novas Regras de Cruzamento (Engine de Validação)
Para evitar furos de liquidação e perdas de capital, a KTO foi rebaixada e seu escopo de pareamento no tênis foi estritamente limitado.

**🟢 Whitelist (Cruzamentos Liberados):** *(atualizada em 17/07/2026 pela auditoria GRUPOS_WO_CASAS.md)*
A KTO só pode ser cruzada com casas que possuem a mesma regra matemática de 1 Set Concluído.
* Pinnacle
* BetWarrior / BetWarrior (BR)
* Stake (regra publicada é de avanço/1 set — reclassificada A→B na auditoria)
* 1xbet (idem, entidade BR)
* BolsaDeAposta (idem)
* Rei do Pitaco (idem)
* ~~Betano (BR)~~ — **REMOVIDA em 17/07/2026**: a regra publicada da Betano é VOID puro
  (Grupo A); cruzar KTO×Betano em abandono pós-1º set = red na KTO + void na Betano = prejuízo.

**🔴 Blacklist (Cruzamentos Proibidos):**
O motor do sistema deve disparar `REJECTED_BY_RISK_MATRIX` se tentar cruzar a KTO com:
* SuperBet, Bet365, **Betano**, KTO, ou qualquer outra integrante do **Grupo A**;
* Novibet e demais casas SEM grupo verificado (desconhecida nunca cruza).

### 3. Restrição de Mercados Secundários na KTO
A regra de rebaixamento para o Grupo B se aplica primariamente ao Vencedor da Partida (*Moneyline*). 
* **Handicap de Games / Total de Games (Over/Under):** Nestes mercados, a KTO anula o bilhete em caso de lesão, *exceto* se o limite matemático do mercado já tiver sido ultrapassado antes do abandono. 
* **Ação do Sistema:** Bloquear inteiramente Surebets envolvendo a KTO em Handicaps e Totais de tênis para mitigar riscos de interpretação do provedor.
