# 📋 Classificação de Risco: Matriz de Tênis (Vbet)

**Data da Análise:** 17 de Julho de 2026
**Status Anterior:** Não classificada (bloqueada no tênis pelo default conservador)
**Status Operacional:** **Grupo A** (Regra da Partida Completa — Void em abandono)

## 1. Fonte da Verificação

Regras oficiais publicadas pela Vbet Brasil ("Regras de Apostas Esportivas", link "Legal"
do rodapé do site, página `vbet.bet.br/pb/help/3385`). O conteúdo é servido pelo CMS da
plataforma e pode ser re-verificado sem browser:

```
curl 'https://go-cms.vbet.bet.br/api/public/v1/pt-br/partners/692/contents/3385?country=BR&with_meta=1&platform=0'
```

(345KB de JSON; campo `data.content` = HTML do documento completo de regras por esporte.)

## 2. Regra decisiva (seção "Tênis" → "Apostas em jogos, incluindo ao vivo")

> "As apostas em partidas de tênis **serão anuladas se não forem concluídas**, salvo nos
> casos em que o mercado já tenha sido integralmente determinado (ex.: vencedor do 1º set).
> Em caso de **desqualificação**, o jogador ou equipe que avançar será considerado o
> vencedor para fins de liquidação."

* **Abandono/desistência/lesão (o caso frequente, ex.: UTR/ITF):** Vencedor da Partida é
  **ANULADO** → comportamento clássico de **Grupo A**.
* A exceção "quem avança é o vencedor" vale **apenas para desqualificação** (punição do
  árbitro — raríssima no circuito). Ver ressalva em §4.

**Regras acessórias coerentes com o Grupo A:**
* Handicap de games / Total de games: "baseiam-se em um número regulamentário de sets…
  No caso de o número regulamentário de sets ser alterado ou diferir daqueles oferecidos,
  todas as apostas serão anuladas" (+ regra geral de anulação de partida não concluída).
* Apostas em sets: anuladas se o número regulamentário de sets não for completado.
* **Tênis de mesa** (seção própria): "No caso de um jogo começar, mas não ser concluído,
  todas as apostas serão anuladas, a menos que o resultado do mercado específico já tenha
  sido determinado" → mesa herda o Grupo A sem conflito.

## 3. Corroboração de plataforma

A Vbet roda na BetConstruct (Swarm, site_id 692) — **mesma plataforma da SeuBet**, que já
está mapeada no Grupo A (Diretrizes §3). O texto das regras é o mesmo template
BetConstruct nas duas casas, o que reduz o risco de divergência entre regra publicada e
liquidação real do provedor.

## 4. Ressalvas operacionais (lição do caso KTO)

1. **Regra publicada ≠ garantia de liquidação** — a KTO publicava regra de anulação e o
   provedor liquidou por avanço de fase (perda real, ver KTO.md). **Monitorar a primeira
   liquidação real da Vbet num abandono de tênis** antes de considerar a classificação
   consolidada. Enquanto isso, o cruzamento A×A dela é permitido pelo motor normalmente.
2. **Desqualificação diverge dentro do próprio Grupo A**: na Vbet, DQ liquida "quem avança
   vence"; em casas que anulam também na DQ, um cruzamento A×A pode ter uma perna paga e
   outra anulada (cenário raríssimo — poucas DQs/ano no circuito; risco aceito).
3. Mercados "ao vivo" têm regras próprias mais restritivas (set ao vivo exige partida
   concluída etc.) — irrelevante hoje (scanner é só pré-jogo), revisar se o Tier 3
   (in-play) for ativado.

## 5. Ação no motor

* `regras.ts`: `vbet` adicionada ao `GRUPO_A` (17/07/2026).
* Cruzamentos liberados no tênis/mesa: Vbet × Superbet, Aposta1, BetBoom, SeuBet, Blaze
  e demais Grupo A. Proibidos: Vbet × Pinnacle/BetWarrior/Betano/KTO (Grupo B).
