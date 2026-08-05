# Sincronia com o SureRadar (fase da varredura)

Estado: **em produção** desde 05/08/2026 (código em `backend/src/core/sureradarSync.ts`).

## O problema

O painel do SureRadar recalcula as surebets a cada ~10 min. A nossa varredura roda a cada 5.
Intervalo fixo fixa também a **fase**: se a nossa varredura cai 30 s antes do recálculo deles,
ela cai 30 s antes **para sempre** — e toda surebet importada nasce com a vida esgotada. O
usuário abre o card, clica no deep-link e a oportunidade já não existe no site.

Não é erro de matemática (o break-even é revalidado) nem de cobertura. É erro de fase, e só
aparece se alguém estiver medindo os dois relógios.

## O que a API deles entrega de graça

`GET https://sureradar.site/api/surebets` devolve, além das surebets:

```json
"status": {
  "total": 211,
  "ultima_atualizacao": "2026-08-05 13:13:46 UTC (conta)",
  "updated_ts": 1785935626.88,
  "idade_seg": 59,
  "conectado": true,
  "online": true
}
```

e um **`updated_at` por surebet** (`"2026-08-05 13:11:21 UTC"`).

Dois carimbos, e eles **não andam juntos** — na leitura de 05/08 13:14 o painel se dizia
atualizado há 59 s enquanto **todas** as 31 linhas tinham 204 s. Os dois são usados, com papéis
diferentes:

| carimbo | para que serve |
|---|---|
| `idade_seg` / `updated_ts` (painel) | prever **quando vem o próximo recálculo** (a cadência) |
| `updated_at` de cada surebet | dizer se **a odd na tela ainda é a odd da casa** |

`idade_seg` é medido por eles no instante da resposta, então é o campo preferido: converter
para o nosso relógio é `fim da requisição − idade_seg`, sem depender do desvio entre as
máquinas. O desvio medido (`relogioSkewSeg`, 0,2 s em produção) fica exposto só para
diagnóstico. `updated_ts` cru é o fallback quando `idade_seg` falta.

## Como funciona

1. **`scraping/casa_sureradar.ts`** — `lerRelogioDoPainel()` publica `ultimoStatus` a cada
   extração via API (o fallback de browser não tem `status`, e aí fica `null`). Inclui a idade
   das linhas: mínima (a odd mais fresca), mediana, máxima e o evento da mais velha.
2. **`core/scanner_v2.ts`** — ao fim de cada varredura registra a observação no monitor
   (início, fim, fonte, quantas importou, status). Varredura que **falhou** também é registrada:
   "ficamos cegos neste ciclo" é dado de sincronia.
3. **`core/sureradarSync.ts`** — mede cadência, defasagem, atualizações perdidas/pendentes e
   prevê o próximo recálculo. Estado **em memória** (é medição de fase, não histórico contábil):
   um restart zera a cadência, que se reconstrói em ~30 min (3 intervalos = 4 recálculos deles
   observados, a ~10 min cada), com o snapshot dizendo quantas amostras já tem. O estado do
   momento — quando eles atualizaram, idade do dado, defasagem da captura — volta na **primeira**
   varredura, porque vem pronto no `idade_seg` da resposta deles.
4. **`scheduler/scheduler.ts`** — trocou `setInterval` fixo por `setTimeout` reagendado e
   pergunta ao monitor, a cada ciclo, quantos segundos deslocar a próxima varredura. O
   intervalo médio não muda; muda o instante dentro do ciclo deles.
5. **`GET /api/sureradar/sync`** — snapshot completo, consumido pela faixa no topo do radar
   (poll de 15 s, countdown recontado no cliente a cada 5 s).

## Estimativa de cadência

Mediana dos intervalos entre atualizações **distintas** observadas. Duas armadilhas tratadas:

- **Varredura nossa que falha pula um recálculo deles** → o delta observado vem 2× (ou 3×) o
  período. Cada delta é dividido pelo número inteiro de períodos que contém, usando o
  **percentil 25** como base (a mediana crua viraria 900 s num histórico meio-a-meio de 600 e
  1200), e cada período pulado entra em `atualizacoesPerdidas`.
- **Duas varreduras dentro do mesmo ciclo deles** veem a mesma atualização: só conta quando o
  instante muda de verdade (tolerância de 5 s para o jitter do `idade_seg` inteiro).

A cadência só é considerada **confiável** com ≥ 3 amostras, valor entre 60 s e 3600 s e
dispersão ≤ 25% da mediana. Sem confiança, previsões e alinhamento ficam suspensos — e a UI diz
isso em vez de fingir precisão.

## Alinhamento de fase

Alvo: varrer `SURERADAR_ALVO_APOS_SEG` (default **45 s**) **depois** do recálculo deles.

```
ajuste = (recálculo previsto mais próximo + alvo) − horário já marcado
```

com banda morta de 20 s (sem ela o scheduler corrigiria ±2 s para sempre) e teto de **35% do
intervalo** por ciclo — converge em 2–3 ciclos e o intervalo real nunca sai de ~3–7 min. O
scheduler ainda limita o timer a `[30 s, 1,5 × intervalo]`: cadência corrompida não pode virar
"varre daqui a 3 horas".

Como 10 min é múltiplo de 5, alinhar a fase **não reduz** a nossa taxa de varredura: uma
varredura cai logo depois do recálculo deles e a outra no meio do ciclo.

## Variáveis de ambiente

| variável | default | efeito |
|---|---|---|
| `SURERADAR_ALVO_APOS_SEG` | `45` | quantos segundos depois do recálculo deles queremos varrer |
| `SURERADAR_SYNC_FASE` | `1` | `0`/`false` desliga o alinhamento e volta ao intervalo fixo (a medição continua) |

## Como ler a faixa no radar

- **Vida restante do dado** — segundos até o próximo recálculo previsto. É o número que decide
  se dá tempo de operar. Fica vermelho abaixo de 60 s e aparece o botão "Recapturar".
- **Painel deles atualizou / Odds mais novas** — se as duas divergem muito, a que vale é a das
  odds (o aviso aparece no detalhe).
- **Cadência deles** — `~10m02s` medido; com `?` no fim é estimativa sem confiança ainda.
- **Nossa varredura** — quando foi e quando vem, já com o ajuste de fase aplicado.
- **Defasagem da captura** — idade do dado quando a varredura terminou. Alvo 45 s.
- Estados: `sincronizado` (verde) · `fora de fase` (âmbar, capturamos tarde no ciclo) ·
  `dado vencido` (vermelho, eles recalcularam e não recapturamos) · `medindo` (cinza).

## Testes

`backend/tests/unit/sureradarSync.test.ts` (12 casos): parse dos dois formatos de carimbo,
cadência pelo `idade_seg`, ciclo pulado (cadência preservada + atualização perdida contada),
`desatualizado` quando o recálculo passou sem captura, ajuste de fase (move para depois do
recálculo, zero na banda morta, zero sem cadência confiável), leitura sem `status` (cookies
expirados) e o caso real "painel fresco com linhas velhas".

## Limites conhecidos

- **Sem persistência**: restart do backend (deploy, `service update --force`, OOM) zera o
  histórico. O que se perde é só a **cadência** — e com ela a previsão do próximo recálculo, a
  "vida restante" e o alinhamento automático, que ficam suspensos por ~30 min até 4 recálculos
  deles serem observados. Idade do dado, defasagem da captura e a idade das linhas voltam na
  primeira varredura.
  Se valer a pena persistir, o caminho **sem DDL** é a tabela `app_config` (migration 008, já em
  produção, chave/valor com JSON — é onde moram `banca_ativa` e `saldos_casas`): gravar a lista
  dos últimos instantes de recálculo em `app_config['sureradar_sync']` e recarregá-la no boot.
  Tabela nova é que custaria DDL + `GRANT` + reinício do PostgREST.
- **Idade por surebet é agregada, não por linha no banco**: guardar o `updated_at` de cada
  oportunidade pediria coluna nova em `oportunidades`. Hoje a faixa mostra mínima/mediana/máxima
  da última leitura; o card individual segue com o `visto_em` do nosso lado.
- O fallback de browser não expõe `status`, então um ciclo servido por ele fica sem medição
  (aparece como aviso).
