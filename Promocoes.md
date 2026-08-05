# Especificação Técnica: Módulo de Estratégias e Promoções (Surebets)

Este documento centraliza as definições, lógicas matemáticas, parâmetros de entrada e regras de negócio para a implementação de todas as modalidades de bônus, surebets e coberturas no sistema.

---

## 1. Aposta Qualificativa (Qualifying Bet)

### Descrição
Aposta feita com saldo real com o único objetivo de cumprir os requisitos de uma casa de apostas para destravar uma promoção (geralmente uma Freebet). O foco não é o lucro imediato, mas sim minimizar a perda na qualificação.

### Parâmetros de Cálculo
* `stake_qualificativa`: Valor exigido pela casa para qualificar (ex: R$ 30,00).
* `odd_promo`: Odd da seleção na casa promocional.
* `odd_cob`: Odd da seleção oposta na casa de cobertura (exchange ou bookie).
* `comissao_cob`: Taxa da casa de cobertura (se aplicável, comum em exchanges).

### Lógica no Sistema
O sistema deve calcular a stake exata de cobertura para que o "Red" (perda) da operação seja o menor possível, independentemente do resultado do jogo. Esse Red é o custo de aquisição da Freebet.

---

## 2. SNR (Stake Not Returned / Aposta Grátis Padrão)

### Descrição
É a Freebet tradicional. Caso a aposta seja vencedora, apenas o lucro líquido é creditado na conta do usuário; o valor da aposta grátis original (stake) não é devolvido.

### Parâmetros de Cálculo
* `stake_free`: Valor da Freebet.
* `odd_promo`: Odd na casa promocional.
* `odd_cob`: Odd de cobertura.

### Fórmula de Cobertura (Texto Simples)
Stake de Cobertura = (stake_free * (odd_promo - 1)) / odd_cob

### Lógica de Retorno
O objetivo do sistema é garantir um lucro líquido igual em qualquer cenário, convertendo a Freebet em dinheiro real com uma taxa de conversão ideal acima de 70%.

---

## 3. SRR (Stake Returned / Aposta Grátis com Retorno do Stake) — ✅ IMPLEMENTADO

### Descrição
Diferente da SNR, na modalidade SRR o valor apostado inicial (a stake da aposta grátis) retorna para a conta junto com o lucro líquido caso a seleção seja vencedora. A ficha devolvida pode voltar em **dinheiro** (o caso normal) ou em **bônus/freebet nova** — e aí ela não vale a face, vale a retenção que se consegue extrair.

### Parâmetros de Cálculo
* `stake_free`: valor da Freebet utilizada.
* `odd_promo`: odd da seleção na casa promocional.
* `odd_cob`: odd de cobertura na casa oposta.
* `valor_ficha_pct`: quanto vale a ficha devolvida, em % (default **100** = dinheiro sacável; **70** = a ficha volta como bônus). É o `v` da fórmula; `0` degenera em SNR.
* `teto_stake`: stake máxima elegível pela promoção.
* `teto_ganho` + `teto_incide_sobre` (`GANHO` | `RETORNO`): teto do regulamento, quando houver.

### Fórmula de Cobertura (Texto Simples)
```
S = min(stake_free, teto_stake)              -- stake ELEGÍVEL
v = valor_ficha_pct / 100                    -- 1 = dinheiro, 0,7 = ficha volta em bônus
Retorno bruto R    = S × (odd_promo − 1 + v)          -- com v=1: S × odd_promo
Stake de Cobertura = R / odd_cob
Lucro travado      = R − cobertura = cobertura × (odd_cob − 1)
Retencao           = lucro / S               -- PASSA de 100% quando v=1 (a ficha volta)
Investimento real  = cobertura               -- a ficha não sai do bolso
```
A fórmula antiga (`stake_free × odd_promo / odd_cob`) é o **caso particular v = 1**. Com a ficha voltando em bônus ela superestima a cobertura e transforma parte do "lucro garantido" em bônus a converter.

### Lógica no Sistema
**Caso base validado**: freebet de R$ 50 @2,00 com cobertura @2,05 → cobertura R$ 48,78, **+R$ 51,22 nos dois cenários**, retenção **102,44%**. A SNR do mesmo par pediria R$ 24,39 — exatamente `odd/(odd−1)` = 2× menos.

**O ótimo é INVERTIDO em relação à SNR.** Substituindo a cobertura de mercado (`odd_cob = odd/((odd−1)(1+m))`) na retenção, com v=1:

```
retencao(odd) = 1 − m × (odd − 1)
```

Uma reta que só desce: **não há pico**, e o ótimo é a **MENOR odd elegível** pelo regulamento. Por isso `oddIdealFreebet(m, 1)` devolve `NaN` de propósito e `curvaRetencaoFreebet` marca `direcaoDoOtimo = 'menor-odd'` — imprimir o `√(1+1/m)` da SNR numa SRR é conselho ativamente errado. Curva com m = 6% (freebet de R$ 100): odd 1,50 → retenção 97% (aporte R$ 53); odd 2,00 → 94% (R$ 106); odd 4,00 → 82% (R$ 318). O aporte é proporcional a `(odd−1)`, então odd curta rende mais **e** imobiliza menos caixa.

### Armadilhas (todas codificadas como aviso)
1. **Sub-hedge de `odd/(odd−1)`**: calcular a SRR com a fórmula da SNR aporta metade do necessário em odd 2,00. No caso base isso dá +R$ 75,61 no green e +R$ 25,61 no red — como a ficha é grátis nenhum cenário fica negativo, e é por isso que o erro passa despercebido ("lucro nos dois lados"). O red fica em `(odd−1)/(odd−1+v)` do lucro travado correto, e a fração piora com odd curta: R$ 100 @1,50 com cobertura 2,83 deveria pagar R$ 97,00 nos dois lados, e com o aporte da SNR (R$ 17,67 em vez de R$ 53,00) paga +R$ 132,33 no green contra +R$ 32,34 no red — **um terço** da retenção, decidido pelo jogo. Quando o aporte é informado à mão, o core marca `equalizado: false` e avisa com o aporte que equaliza.
2. **Ficha em bônus**: R$ 100 @2,00 com `valor_ficha_pct=70` e cobertura @1,8868 → R = R$ 170, cobertura R$ 90,10, lucro travado R$ 79,90 — mas R$ 70 é bônus: o **caixa do dia** no green é R$ 9,90.
3. **Teto de GANHO ≠ teto de RETORNO**: numa SRR de R$ 100 @4,00 com cobertura 1,2579, "ganhe até R$ 100" dá R = 200 (a ficha ainda volta) → cobertura R$ 159,00 e lucro R$ 41,00; "retorno máximo R$ 100" dá R = 100 → cobertura R$ 79,50 e lucro R$ 20,50. Ler `RETORNO` como `GANHO` manda aportar R$ 159 contra um pagamento de R$ 100: **green −R$ 59,00**.

---

## 4. Aposta Sem Risco (Risk-Free Bet)

### Descrição
Aposta realizada com saldo em dinheiro real. Caso a aposta seja perdedora, a casa de apostas devolve o valor investido (integral ou parcialmente) em dinheiro ou bônus.

### Campos do Módulo
* `stake_invested`: Valor real apostado.
* `odd_promo`: Odd da aposta na casa promocional.
* `refund_type`: `CASH` (Dinheiro real) ou `BONUS` (Saldo de bônus/Freebet).
* `max_refund_limit`: Teto máximo de reembolso estipulado pela casa.

### Estratégia de Execução
1. O sistema tenta cruzar os dados como uma surebet convencional se houver margem direta.
2. Caso contrário, calcula o custo esperado da aposta considerando o valor de conversão futuro do reembolso (se for pago em bônus, aplica a taxa de conversão esperada do SNR).

---

## 5. Bônus de Depósito com Rollover (Deposit Bonus)

### Descrição
Módulo de acompanhamento de liberação de saldo de bônus atrelado a um requisito obrigatório de volume de apostas (*rollover*).

### Estrutura de Dados (Objeto / JSON)
```json
{
  "promotion_id": "dep_bonus_08",
  "deposit_amount": 150.00,
  "bonus_amount": 150.00,
  "rollover_multiplier": 6,
  "required_total_volume": 1800.00,
  "current_progress": 0.00,
  "min_odds_requirement": 1.60,
  "status": "ACTIVE"
}
```

### Lógica no Sistema
Não é um tipo de entrada e sim uma **campanha**: o bônus não vira lucro numa aposta, vira lucro depois de girar o volume exigido. Cada volta coberta custa a margem do par de odds, então o valor líquido do bônus é:

```
custo_do_rollover  ≈ volume_exigido × margem_media_por_par
valor_liquido      ≈ bonus_amount − custo_do_rollover
margem_por_par     = (1 / odd_promo) + (1 / odd_cob) − 1
```

Exemplo com a estrutura acima (volume R$ 1.800, margem média 2%): custo ~R$ 36 → sobra ~R$ 114 dos R$ 150. Só aceitar a promoção se `valor_liquido > 0` **e** o volume couber no prazo de validade do bônus.

Regras que mudam a conta e precisam estar no cadastro: se a base do rollover é o bônus ou depósito+bônus; odd mínima (`min_odds_requirement`) — odd mínima alta encarece o giro, porque a margem cresce nas pontas; e se a casa aceita aposta coberta durante o rollover (algumas anulam o bônus).

O acompanhamento é de progresso: `current_progress` sobe com o volume apostado elegível, e o app avisa quando falta volume e o prazo está fechando.

---

## 6. Proteção / Cashback de Aposta Perdida (Parcial) — ✅ IMPLEMENTADO

### Descrição
A casa devolve uma **fração** da aposta se ela perder ("50% da aposta perdida de volta", "seguro da aposta"). É a versão parcial da Aposta Sem Risco (seção 4): a perna promocional é dinheiro real, a cobertura serve para **recuperar o principal** e a devolução sobra como lucro. É o único tipo em que a promoção paga justamente no cenário de red.

### Parâmetros de Cálculo
* `stake_invested`: valor real apostado na casa da promoção.
* `odd_promo` / `odd_cob`: odds das duas pernas.
* `cashback_pct`: percentual devolvido se perder (ex.: 50).
* `cashback_teto`: teto do regulamento ("50% até R$ 50").
* `cashback_eh_bonus` + `valor_bonus_pct`: se a devolução cai em bônus, quanto ela vale de fato (default 70%).

### Fórmula de Cobertura (Texto Simples)
```
Devolucao (face)    = min(stake_invested × cashback_pct / 100, cashback_teto)
Devolucao (efetiva) = face × (bonus ? valor_bonus_pct/100 : 1)
Stake de Cobertura  = (stake_invested × odd_promo − Devolucao efetiva) / odd_cob
Se a promo ganha    = stake_invested × (odd_promo − 1) − cobertura
Se a promo perde    = cobertura × (odd_cob − 1) − stake_invested + Devolucao efetiva
```

### Lógica no Sistema
Os dois cenários pagam igual por construção. O piso de rentabilidade é:

```
Devolucao minima (D0) = stake_invested × (odd_promo − odd_cob × (odd_promo − 1))
```

Acima de `D0` o lucro é travado; abaixo, o prejuízo é garantido. `D0` cai rápido quando a odd de cobertura sobe — com `odd_promo=2,00` e `odd_cob=1,90`, `D0` é 10% da stake, então um cashback de 50% tem folga enorme. Se `D0` sair negativo, o par de odds já é surebet e a devolução é lucro em cima de lucro.

**Caso base validado em produção**: R$ 100 @2,00 com 50% de volta, cobertura @2,05 → cobertura R$ 73,17, **+R$ 26,83 nos dois cenários**, ROI 15,49% sobre os R$ 173,17 na mesa.

### Armadilhas (todas codificadas como aviso)
1. **Teto**: "50% até R$ 50" com stake R$ 200 devolve R$ 50, não R$ 100. A stake ótima é `teto ÷ %`; acima dela cada real entra **sem proteção** e só afina o ROI.
2. **Devolução em bônus**: não é dinheiro. Equalizar pela face infla o cenário de red — o sistema usa o valor efetivo e informa separadamente o **caixa do dia** (que pode ser negativo até o bônus ser convertido).
3. **Devolução incondicional** (cai ganhando ou perdendo) não é proteção: não muda o aporte, só soma no lucro dos dois cenários.
4. **Condição de placar** ("perdeu por 1 gol") **não** é este tipo — ver seção 9.

### Estado
Rodando em produção desde 04/08/2026, com a **migration 021 aplicada no banco** (`promo_type = 'PROTECAO'`, `cashback_pct`, `cashback_teto`, `cashback_eh_bonus`, `valor_bonus_pct`) — o `cashback_so_se_perder` é da 022. O código ainda **não está commitado**. A **migration 022** (SRR + super odd + lucro extra — escrita, ainda a aplicar no banco) acrescenta campos de regulamento que valem **também para a proteção**: `teto_ganho` + `teto_incide_sobre` (`GANHO` limita o lucro, `RETORNO` limita o pagamento inteiro) e `teto_stake` (a conta roda na stake elegível). O bônus da proteção cai no cenário de **red**; nos tipos com boost (seções 7 e 8) ele cai no **green** — são ramos opostos e o core mantém os dois campos de caixa (`lucroEmCaixaSePromoGanha` / `lucroEmCaixaSeCoberturaGanha`) separados por isso.

---

## 7. Super Odd / Odd Turbinada (Enhanced Odds) — ✅ IMPLEMENTADO

### Descrição
A casa oferece uma odd acima do preço de mercado num evento de vitrine, quase sempre com **teto de stake** (ex.: até R$ 30) e fora do feed padrão (o scraper não vê — a odd vem da tela/print do usuário). A perna promocional é **dinheiro real**: o que paga a operação é o excedente sobre a odd normal.

### Parâmetros de Cálculo
* `stake_invested`, `odd_promo` (a turbinada), `odd_cob`.
* `odd_padrao`: odd normal do mesmo mercado, para medir o boost e a margem real. **Obrigatória** quando o excedente é pago em bônus.
* `teto_stake`: limite da promoção ("super odd até R$ 30").
* `extra_em_bonus` + `valor_extra_pct`: se o excedente é pago em bônus em vez de dinheiro, e quanto ele vale (default 70%; **0 é válido** — bônus que não converte).
* `teto_extra`, `teto_ganho` + `teto_incide_sobre`: tetos do regulamento.

### Fórmula de Cobertura (Texto Simples)
```
S = min(stake_invested, teto_stake)          -- stake ELEGÍVEL (a conta é nela, não no valor digitado)
v = valor_extra_pct / 100                    -- 1 quando o excedente é pago em dinheiro

Excedente em DINHEIRO:  R = S × odd_promo               -- a odd turbinada JÁ contém o excedente
Excedente em BONUS:     R = S × odd_padrao + v × min( S × (odd_promo − odd_padrao), teto_extra )
                            -- o teto corta a FACE do excedente, antes de valorizar o bônus

odd_efetiva        = R / S
Stake de Cobertura = R / odd_cob
Lucro travado se   1/odd_efetiva + 1/odd_cob < 1   <=>   odd_efetiva > odd_cob/(odd_cob − 1)
Extra minimo (efetivo, em R$) = S × ( odd_cob/(odd_cob − 1) − odd_base )
                                -- odd_base = a odd paga em CAIXA: odd_promo, ou odd_padrao
                                --            quando o excedente vem em bônus
```

### Lógica no Sistema
Com excedente em dinheiro é surebet clássica (`1/odd_promo + 1/odd_cob < 1`, a mesma conta do motor) e o **excedente é medida do boost, não parcela a somar**: somá-lo por cima da odd turbinada dava R$ 72 de retorno onde a casa paga R$ 60 (S = 30 @2,00) e inflava o aporte — dupla contagem que aparece como "lucro" inexistente.

**Caso base validado**: R$ 30 @2,00 (odd padrão 1,60) com cobertura @2,50 → aporte R$ 24,00, **+R$ 6,00 nos dois cenários**, ROI 11,11%. Com o excedente em **bônus** a 70%: face R$ 12,00 → efetivo R$ 8,40, R = R$ 56,40, aporte R$ 22,56 e lucro travado R$ 3,84 — com **caixa de −R$ 4,56 no green** (o bônus só vira dinheiro depois de convertido). O que justifica registrar como promoção é o teto de stake e o fato de a odd não ser reproduzível: ordene por **lucro em reais**, não por ROI, porque uma super odd de R$ 30 raramente paga o tempo de execução.

### Armadilhas (todas codificadas como aviso)
1. **Teto de stake**: a conta roda em `S = min(stake, teto)`. R$ 100 numa super odd @2,00 de teto R$ 30 com cobertura 2,50 dá aporte R$ 24,00, lucro R$ 6,00 e investimento R$ 54,00. Escrever a fórmula com os R$ 100 (teto só no custo) inflava o aporte ~3,3× e virava **prejuízo travado nos dois cenários**; o excedente acima do teto entraria na odd NORMAL, virando uma qualificativa com prejuízo colada na operação.
2. **Sem `odd_padrao` não há como medir o boost**: medir a margem pela odd turbinada dá negativo, clampa em zero e esconde o pedágio. Se o excedente é em bônus e falta a odd padrão, a conta trata tudo como caixa (o app avisa).
3. **Bônus cai no GREEN** — ramo **oposto** ao da proteção (seção 6), onde a devolução cai no red. Informe sempre lucro travado **e** caixa de hoje.
4. **Boost que não paga a margem**: se o excedente efetivo for menor que `S × (odd_cob/(odd_cob−1) − odd_base)`, é prejuízo garantido. Ex.: odd 1,70 sobre padrão 1,60 com cobertura 2,00 e excedente em bônus precisa de R$ 40 por R$ 100 de stake (`100 × (2,00 − 1,60)`) e não chega perto.
5. **Opt-in** antes da aposta, como em toda promoção.

---

## 8. Lucro Extra / Ganhos Turbinados (Profit Boost) — ✅ IMPLEMENTADO

### Descrição
"Ganhe +30% de lucro extra nesta aposta." O acréscimo incide sobre o **lucro**, não sobre o retorno — confundir os dois superestima o ganho. Há regulamento que aplica o percentual sobre o **valor apostado**, e isso é outro número.

### Parâmetros de Cálculo
* `stake_invested`, `odd_promo`, `odd_cob`.
* `boost_pct`: percentual de lucro extra (ex.: 30).
* `boost_sobre_stake`: `true` = o regulamento aplica o % sobre o **valor apostado**, não sobre o lucro.
* `extra_em_bonus` + `valor_extra_pct`: se o extra é creditado em bônus e quanto vale (default 70%; **0 é válido**).
* `teto_extra`: teto em reais do acréscimo. `teto_stake`, `teto_ganho` + `teto_incide_sobre`: os outros tetos do regulamento.

### Fórmula de Cobertura (Texto Simples)
```
S    = min(stake_invested, teto_stake)       -- stake ELEGÍVEL
v    = valor_extra_pct / 100                 -- 1 quando o extra é pago em dinheiro
b    = boost_pct / 100
base = S × (odd_promo − 1)                   -- % sobre o LUCRO (leitura padrão)
     | S                                     -- % sobre o VALOR APOSTADO (boost_sobre_stake)

extra_nominal = min(b × base, teto_extra)    -- o teto corta a FACE, ANTES de valorizar o bônus
extra_efetivo = v × extra_nominal
R             = S × odd_promo + extra_efetivo
odd_efetiva   = R / S = 1 + (odd_promo − 1) × (1 + v × b)     -- caso "sobre o lucro"
              = odd_promo + v × b                             -- caso "sobre a stake"
Stake de Cobertura = R / odd_cob
Extra minimo (efetivo) = S × ( odd_cob/(odd_cob − 1) − odd_promo )
```

### Lógica no Sistema
Depois da odd efetiva é super odd: lucro travado se `1/odd_efetiva + 1/odd_cob < 1`. **Caso base validado**: R$ 100 @2,00 com cobertura 1,90 e boost de 30% → extra R$ 30, R = R$ 230, odd efetiva 2,30, aporte R$ 121,05, **+R$ 8,95 nos dois cenários**. Com o extra em bônus a 70%: extra efetivo R$ 21, R = R$ 221, aporte R$ 116,32, lucro travado R$ 4,68 e caixa de −R$ 16,32 no green.

**Onde o rendimento tem pico.** Com a cobertura precificada pelo mercado (`odd_cob = odd/((odd−1)(1+m))`, margem m), o lucro travado por real de stake se decompõe em três parcelas exatas:

```
L/S = b×v×(odd−1)  −  m×(odd−1)  −  b×v×(1+m)×(odd−1)²/odd
      premio do        pedagio da    pedagio da margem sobre
      boost            perna crua    o proprio premio
```

Daí saem duas leituras: (a) **condição necessária `b × v > m`** — boost de 5% em mercado com 6% de margem não paga em nenhuma odd, e um boost de face 30% pago em bônus a 70% é `b×v = 21%`, não 30%; (b) o termo **quadrático** mata odd alta, com ótimo em `odd* = √( b×v×(1+m) / (m×(1 + b×v)) )`. Com b = 30% em dinheiro e m = 6%: `odd* = 2,019` e lucro travado de **8,10% da stake**. A curva no mesmo par: odd 1,50 → 6,70%; 2,00 → 8,10%; 2,50 → 7,38%; 3,00 → 5,60%; **5,00 → −5,76%**.

### Armadilhas (todas codificadas como aviso)
1. **Boost em odd alta é prejuízo**: em odd 5,00 com m = 6%, um boost de 30% perde R$ 5,76 por R$ 100 de stake — ali o boost precisaria ser de ~39,5% só para empatar. É o erro simétrico ao da freebet SNR ("estique a odd").
2. **`%` do lucro ≠ `%` da stake**: os dois coincidem exatamente em odd 2,00 e divergem para os dois lados — em R$ 100 @3,00 um boost de 30% vale R$ 60 sobre o lucro contra R$ 30 sobre a stake; em odd 1,50, R$ 15 contra R$ 30.
3. **Teto do extra corta a FACE** antes da valorização (`min(v × extra, teto)` devolveria mais do que a casa paga) — e, com o teto mordendo, **aumentar a stake piora**: R$ 500 @2,00 com cobertura 1,90 e boost de 30% limitado a R$ 50 fecha em −R$ 2,63 (aporte R$ 552,63), contra +R$ 8,95 dos mesmos R$ 100 sem teto.
4. **Extra em bônus valendo 0%**: entrada válida (bônus que não converte) e a conta vira uma qualificativa crua, com prejuízo garantido. O app avisa em vez de assumir 70%.
5. **Piso do extra**: `S × (odd_cob/(odd_cob−1) − odd_promo)`. Ex.: R$ 100 @4,00 com cobertura 1,25 precisa de R$ 100 de extra efetivo; um boost de 30% entrega R$ 90 e a operação fecha em −R$ 2,00 (o boost mínimo é 33,3%).

---

## 9. Seguro de Múltipla ("1 erro devolvemos")

### Descrição
Múltipla de N seleções em que a casa devolve a stake se **exatamente uma** perna falhar (quase sempre em freebet e com teto).

### Parâmetros de Cálculo
* `stake`, lista de pernas com `odd` e `odd_cobertura`, e o **horário de resolução** de cada perna.
* `seguro_valor`, `seguro_em_bonus`, `seguro_teto`, `max_erros_cobertos` (quase sempre 1).

### Fórmula de Cobertura (Texto Simples)
A cobertura é **sequencial** (só cobre a perna k depois do green da k−1) e o seguro barateia todos os aportes, porque num red o dinheiro recuperado inclui a devolução:

```
aporte_k = (gasto_acumulado − perda_aceita − seguro_efetivo) / (odd_cobertura_k − 1)
```

### Lógica no Sistema
Estende `calcularMultiplaQualificadora`, que já monta a cadeia sequencial, o caixa de pico e o resultado de cada caminho de red. Armadilhas: (a) o seguro cobre **1** erro — caminhos com 2+ reds voltam à conta crua; (b) o caminho **all-green** é o que a cobertura sequencial não protege e pode dar prejuízo (o app já avisa); (c) duas pernas que resolvem no mesmo momento quebram a cadeia.

---

## 10. Devolução Condicional a Placar

### Descrição
"Devolvemos se der empate", "perdeu por 1 gol devolvemos", "0x0 devolve". A devolução depende de um **evento específico**, não do red — então **não** existe cobertura universal e usar a matemática da seção 6 aqui é erro.

### Casos e tratamento
* **"Empate devolve" (futebol 3-way)**: é literalmente um **DNB** (empate anula aposta). A cobertura correta é DNB (ou handicap 0, que o motor já normaliza como DNB) na outra casa. **Trava lucro** — é o caso fácil da família.
* **"Perdeu por 1 gol / 1 ponto"**: o evento condicional só é apostável de lado (handicap asiático ±1, placar exato) e com margem alta. Dá **hedge parcial**, não lucro travado: o sistema deve mostrar EV e o pior cenário, sem prometer garantia.

---

## 11. Cashback de Perdas do Período (Diário/Semanal)

### Descrição
"X% do seu prejuízo líquido da semana de volta." Incide sobre o **net loss** por casa/período, não por aposta — não vira entrada, vira **acompanhamento**.

### Lógica no Sistema
* Saldo de perdas por casa dentro da janela → cashback projetado.
* Efeito prático: subsidia operações levemente negativas naquela casa dentro da janela.
* Alerta quando a janela está fechando com prejuízo acumulado a resgatar.

---

## 12. Cashout Promocional

### Descrição
"Encerre antecipado e ganhe bônus" / cashout aumentado. O preço de cashout é definido pela casa, não pelo mercado: sem feed confiável a conta é de EV, não de arbitragem. Encaixa no módulo **Radar Cashout** (dropping odds), não na aba de Promoções.

---

## 13. Campanhas Multi-etapas (Missões, Clube, "Aposte e Ganhe" em série)

### Descrição
A recompensa (freebet) exige uma qualificadora antes; hoje as duas pontas são calculadas em separado e o lucro da campanha inteira não aparece em nenhum lugar.

### Fórmula (Texto Simples)
```
lucro_campanha = pedagio_da_qualificadora (negativo) + retencao × valor_da_freebet
```

Regra de corte da doutrina: pedágio acima de ~35% do valor do bônus pede outro par de casas/mercado. Entregável: identificador de campanha nas linhas do histórico + card "lucro por campanha".

---

## Apêndice A — Mapa: especificação × código

| seção | tipo no banco (`promo_type`) | status | onde |
|---|---|---|---|
| 1. Qualificativa | `QUALIFYING` | ✅ produção | `core/promocoes.ts` |
| 2. SNR | `FREEBET_SNR` | ✅ produção | idem |
| 3. SRR (stake retorna) | `FREEBET_SRR` | ✅ implementado (migration 022) | `core/promocoes.ts` (`valorFichaPct`) + aba Promoções + skill; `R = S×(odd−1+v)`, e a fórmula antiga era só o caso v=1 |
| 4. Aposta Sem Risco (100%) | `PROTECAO` com `cashback_pct = 100` | ✅ produção | `refund_type=BONUS` → `cashback_eh_bonus`; `max_refund_limit` → `cashback_teto` |
| 5. Bônus com rollover | — (campanha, não entrada) | ⏳ pendente | calculadora de valor líquido + progresso |
| 6. Proteção parcial | `PROTECAO` | ✅ rodando em produção (021 aplicada no banco; código não commitado) | `core/promocoes.ts` + aba Promoções |
| 7. Super odd | `SUPERODD` | ✅ implementado (migration 022) | `odd_padrao` + `teto_stake` + `extra_em_bonus`; odd efetiva (`oddEfetivaPromo`) → mesma conta do motor |
| 8. Lucro extra | `LUCRO_EXTRA` | ✅ implementado (migration 022) | `boost_pct`, `boost_sobre_stake`, `teto_extra`; odd efetiva + piso do extra (`extraParaZerar`) |
| 9. Seguro de múltipla | — (extensão da múltipla) | ⏳ pendente | `calcularMultiplaQualificadora` |
| 10. Devolução por placar | `DEVOLUCAO_PLACAR` | ⏳ pendente | empate = DNB trava; resto é EV |
| 11. Cashback do período | — (acompanhamento) | ⏳ pendente | por casa/janela |
| 12. Cashout promocional | — | ⏳ pendente | Radar Cashout |
| 13. Campanhas | — (agregação) | ⏳ pendente | id de campanha no histórico |

Prioridade sugerida: ~~3 (SRR)~~ → ~~7/8 (odd efetiva)~~ **FEITOS na migration 022** → **9 (seguro de múltipla)** → **5 (rollover)** → resto.

"Implementado" aqui = core + endpoint + frontend + skills + migration escritos e com teste. Estado exato em 04/08/2026: a **021 foi aplicada no banco de produção** (psql no container `afiliadodb_supabase_db` + `GRANT` + reinício do PostgREST) e a imagem com o código da proteção **está rodando** na VPS — mas **nada disso está commitado no git ainda**, então um clone novo ou um rebuild a partir do repositório remoto não tem a proteção. A **022 depende de aplicar a migration + deploy**. Até lá o app degrada sem quebrar: o `POST /api/promocoes` traduz erro de coluna/CHECK ausente em instrução do que falta aplicar.

O que a migration 022 entregou (os 6 tipos do `CHECK` de `promo_type` = `PROMO_TYPES_BANCO` do core): `valor_ficha_pct` (SRR), `odd_padrao` (super odd), `boost_pct` + `boost_sobre_stake` + `teto_extra` + `extra_em_bonus` + `valor_extra_pct` (lucro extra), `teto_stake`, `teto_ganho` + `teto_incide_sobre` (qualquer tipo) e os derivados gravados do core (`extra_nominal`, `extra_efetivo`, `odd_efetiva_promo`) — para o histórico não reimplementar o boost. O `POST /api/promocoes` mantém coluna nova **fora do INSERT** quando o tipo não a usa, então um banco sem a 022 continua gravando SNR/qualificativa/proteção.

## Apêndice B — Onde mexer para cada tipo novo

1. **`backend/src/core/promocoes.ts`** — `TipoPromocao`, campos de entrada, retorno bruto/custo real e os avisos do regulamento. Única fonte da matemática.
2. **`backend/src/migrations/0XX_*.sql`** — recriar o CHECK de `promo_type` e adicionar as colunas. Depois `GRANT` + **reiniciar o PostgREST** (`docker service update --force afiliadodb_supabase_rest`); `NOTIFY pgrst` não basta.
3. **`backend/src/index.ts`** (`POST /api/promocoes`) — aceitar tipo e campos, e manter colunas novas **fora do INSERT** quando o tipo não as usa (para não quebrar num banco sem a migration).
4. **`frontend/src/App.tsx`** — chip do tipo, campos condicionais, badge na tabela e a métrica "Investido" (a perna promocional é dinheiro real?). **TODO número vem de `POST /api/promocoes/calcular`** — nunca reimplemente a fórmula aqui. A cópia local existiu até 04/08 e o caso SRR mostrou por quê: a cobertura saía certa por acidente e o lucro saía errado, então um número fechava e o outro não.
   - Dois `Record<PromoTipo, …>` obrigam o tipo novo a se declarar (sem verbete **não compila**): `PROMO_META` (chip/rótulos/armadilha curta) e **`PROMO_GUIA`** (o modal do "i": o que é, como a casa anuncia, fórmula, exemplo numérico, armadilhas e "não confunda com"). Os números dos exemplos do guia saem de rodar `calcularPromocao()` nas entradas descritas em cada verbete — nunca de conta feita no frontend; guia que discorda do preview da própria tela ensina a modalidade errada. Coberturas ditas "de mercado" nos exemplos usam a convenção da doutrina, `cob = O/((O−1)·(1+m))` com `m = 6%`, para as odds de um mesmo tipo serem comparáveis entre si.
   - Se a modalidade nova puder ser confundida com uma existente, acrescente a distinção **nos dois** verbetes (`naoConfundaCom`) e um nó em `PROMO_GUIA_ARVORE` — a árvore é o que separa SNR de SRR e super odd de lucro extra antes de o usuário digitar qualquer número.
5. **Skills do Agente** — `skills/calculo.ts`, `skills/acoes.ts`, `skills/banca.ts`. **Cota**: o payload de ferramentas é reenviado em toda rodada e o teste trava em **14.000 caracteres** (Groq free tier: 6k–12k TPM); medido em 04/08: 13.186 com 23 skills, ~800 de folga. Cada parâmetro exposto custa ~110 caracteres — exponha o essencial, deixe o resto no default do core. E `description` de parâmetro acima de **70 caracteres** chega TRUNCADA ao modelo (`registry.ts` corta em 67 + `...`), então lista longa vira `enum`, não prosa.
6. **`backend/src/IA/conhecimento/doutrinaPromocoes.ts`** — seção nova + uma linha curta no `RESUMO_DOUTRINA_PROMOCOES` (vai no system prompt).
7. **`backend/tests/unit/promocoes.test.ts`** — caso base com números fechados, teto, bônus, piso de rentabilidade e o aviso de cada armadilha.

## Apêndice C — Regras de regulamento (valem para qualquer promoção)

1. **OPT-IN** na oferta ANTES de montar o bilhete (é o que mais queima promoção).
2. Tipo de bilhete aceito (simples? múltipla com N seleções?).
3. Odd mínima **por seleção** e odd **total** mínima.
4. Competição/mercado elegível.
5. Valor mínimo e **tetos** (de stake, de devolução, de ganho).
6. Janela da promoção e **prazo de creditação** (costuma ser "até 24h após o FIM da campanha", não após a sua aposta).
7. Regras do bônus recebido: SNR ou SRR? odd mínima? validade? rollover?
8. Uma aposta por evento/CPF/dia? a oferta é repetível?

E as regras da casa que o app já aplica: nunca apostar o oposto exato na mesma casa (abuso de bônus/limitação), arredondar stakes, casas vetadas na operação e grupos de W.O. no tênis.