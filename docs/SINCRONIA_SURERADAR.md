# Sincronia com o SureRadar (ritmo das leituras)

Estado: **em produção** desde 05/08/2026 — medição em `backend/src/core/sureradarSync.ts`,
leitura leve em `backend/src/scheduler/sureradarLeve.ts`.

## O problema

A surebet que gravamos no banco pode nascer com a vida esgotada: o painel deles já recalculou, o
usuário abre o card, clica no deep-link e a oportunidade não existe mais. Não é erro de
matemática (o break-even é revalidado) nem de cobertura — é erro de RITMO entre as duas
varreduras, e só aparece se alguém estiver medindo os dois relógios.

### O que a medição achou (05/08/2026, produção)

A premissa era "eles recalculam a cada 10 min". **Errado.** Série derivada de
`fim da leitura − idade_seg` em 6 leituras:

```
13:46:11 · 13:50:32 · 13:54:54 · [nada] · 14:03:48 · 14:09:30
 intervalos:  261 s    262 s      534 s (=2×)  342 s
```

Recalculam a cada **~4,4 min, de forma irregular**. Duas consequências:

1. **A fonte é mais rápida que o nosso ciclo de 5 min** → perder recálculo era matemático, não
   azar. Aconteceu na 4ª leitura: dado deles com **337 s**, estado `desatualizado`, uma
   atualização inteira em branco.
2. **Num grid irregular não existe fase estável para travar.** O alinhamento automático engatou
   uma vez (`-30,3 s`) e se auto-suspendeu quando o intervalo de 342 s estourou o limite de
   dispersão — o guard funcionou, mas a ferramenta é errada para esta fonte.

**A correção é amostrar mais rápido que a fonte**, não alinhar fase: ler o painel custa
**1,2 s**, contra ~2,5 min da varredura completa, que gasta o tempo coletando 15+ casas para o
motor próprio. Daí o worker leve (item 6 abaixo), e o alinhamento de fase virou **opt-in**.

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
   prevê o próximo recálculo. Estado **em memória** (é medição de ritmo, não histórico contábil):
   um restart zera a cadência, que se reconstrói em ~15–20 min (3 intervalos = 4 recálculos deles
   observados, a ~4,4 min cada), com o snapshot dizendo quantas amostras já tem. O estado do
   momento — quando eles atualizaram, idade do dado, defasagem da captura — volta na **primeira**
   leitura, porque vem pronto no `idade_seg` da resposta deles.
4. **`scheduler/scheduler.ts`** — trocou `setInterval` fixo por `setTimeout` reagendado, o que
   permite deslocar a fase da varredura completa. **Opt-in** (ver abaixo); com o flag desligado o
   comportamento é o intervalo fixo de sempre.
5. **`GET /api/sureradar/sync`** — snapshot completo, consumido pela faixa no topo do radar
   (poll de 15 s, countdown recontado no cliente a cada 5 s).
6. **`scheduler/sureradarLeve.ts`** — worker que lê SÓ o painel deles a cada `SURERADAR_LEVE_MIN`
   minutos (default **2**), pelo mesmo caminho `sureradarOnly` do botão "Escanear (só SureRadar)".
   Não roda em cima da varredura completa (a trava global do scanner recusaria; aqui o pulo é
   contado e logado), então a amostragem efetiva fica em ~2,5–3 min — abaixo do menor intervalo
   já observado no painel (261 s), que é a condição para não perder recálculo.
   Três coisas que o caminho `sureradarOnly` garante e por isso ele foi reusado em vez de uma
   rota nova: a reconciliação do **motor** fica de fora (o scanner só a roda quando o cruzamento
   rodou — sem essa guarda um tick leve apagaria as oportunidades do motor a cada 2 min), o
   alerta de WhatsApp só dispara no ramo do **INSERT** (linha realmente nova, então ler mais
   vezes não vira spam) e a reconciliação do **SureRadar** passa a rodar mais vezes, matando mais
   rápido a linha que sumiu do painel deles.

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

## Alinhamento de fase (opt-in, `SURERADAR_SYNC_FASE=1`)

**Desligado por default desde 05/08/2026**: foi desenhado para uma fonte regular, e a medida
mostrou uma irregular. Deslocar a varredura COMPLETA custa frescor do motor próprio sem ganhar
frescor do SureRadar — a leitura leve já cobre isso. O código fica porque, se a cadência deles
virar regular (e a leitura leve for desligada), ele volta com uma variável de ambiente.

Alvo: varrer `SURERADAR_ALVO_APOS_SEG` (default **45 s**) **depois** do recálculo deles.

```
ajuste = (recálculo previsto mais próximo + alvo) − horário já marcado
```

com banda morta de 20 s (sem ela o scheduler corrigiria ±2 s para sempre) e teto de **35% do
intervalo** por ciclo — converge em 2–3 ciclos e o intervalo real nunca sai de ~3–7 min. O
scheduler ainda limita o timer a `[30 s, 1,5 × intervalo]`: cadência corrompida não pode virar
"varre daqui a 3 horas".

Só vale a pena se a cadência deles for **múltipla ou próxima** da nossa: com período deles mais
curto que o nosso (o caso real), o alvo ideal muda de lugar a cada ciclo e o scheduler fica
correndo atrás, com o intervalo real oscilando entre 3 e 7 min sem ganho de frescor.

## Variáveis de ambiente

| variável | default | efeito |
|---|---|---|
| `SURERADAR_ALVO_APOS_SEG` | `45` | quantos segundos depois do recálculo deles queremos varrer |
| `SURERADAR_SYNC_FASE` | `0` | `1` liga o alinhamento de fase da varredura completa (a medição roda sempre) |
| `SURERADAR_LEVE_MIN` | `2` | minutos entre leituras LEVES do painel; `0` desliga o worker |

## Como ler a faixa no radar

- **Vida restante do dado** — segundos até o próximo recálculo previsto. É o número que decide
  se dá tempo de operar. Fica vermelho abaixo de 60 s e aparece o botão "Recapturar".
- **Painel deles atualizou / Odds mais novas** — se as duas divergem muito, a que vale é a das
  odds (o aviso aparece no detalhe).
- **Cadência deles** — o intervalo medido (`~4m24s` na primeira janela observada); com `?` no
  fim é estimativa sem confiança ainda (dispersão alta = fonte irregular).
- **Nossa leitura** — quando foi a última e quando vem a próxima (a mais próxima entre a leve e
  a completa). O tooltip mostra os dois ritmos.
- **Defasagem da captura** — idade do dado quando a varredura terminou. Alvo 45 s.
- Estados: `sincronizado` (verde) · `fora de fase` (âmbar, capturamos tarde no ciclo) ·
  `dado vencido` (vermelho, eles recalcularam e não recapturamos) · `medindo` (cinza).

## Testes

`backend/tests/unit/sureradarSync.test.ts` (15 casos): parse dos dois formatos de carimbo,
cadência pelo `idade_seg`, ciclo pulado (cadência preservada + atualização perdida contada),
`desatualizado` quando o recálculo passou sem captura, ajuste de fase (move para depois do
recálculo, zero na banda morta, zero sem cadência confiável), leitura sem `status` (cookies
expirados) e o caso real "painel fresco com linhas velhas".

## Limites conhecidos

- **Sem persistência**: restart do backend (deploy, `service update --force`, OOM) zera o
  histórico. O que se perde é só a **cadência** — e com ela a previsão do próximo recálculo e a
  "vida restante", suspensas por ~15–20 min até 4 recálculos deles serem observados. Idade do dado, defasagem da captura e a idade das linhas voltam na
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
