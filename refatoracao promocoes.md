Você precisa refatorar o componente/módulo de cálculo de Apostas de Promoção (Surebet/Matched Betting) no nosso projeto. 

### 🐛 Problema Atual
O cálculo atual trata todas as apostas de promoção como apostas com dinheiro real (Apostas Qualificativas). Quando o usuário insere uma Freebet (SNR - Stake Not Returned), o sistema subtrai o valor da promoção do lucro da cobertura, gerando um prejuízo/ROI negativo irreal na tela.

### 🎯 Objetivo
Adicionar suporte a múltiplos tipos de promoção, corrigindo a fórmula de cálculo de Lucro Líquido, ROI e os cenários de resultado na interface.

---

### ⚙️ Especificação Técnica e Regras de Negócio

1. **Novo Campo de Estado no Formulário (`promoType`)**:
   - `FREEBET_SNR` (Padrão): Aposta Extra/Freebet onde o valor da ficha não retorna no ganho. Custo do lado da promoção = R$ 0.00.
   - `QUALIFYING`: Aposta Qualificativa / Dinheiro Real. Custo do lado da promoção = `promoStake`.

2. **Fórmulas de Cálculo**:

   - **Se `promoType === 'FREEBET_SNR'`**:
     - `lucroPromoWin = (promoStake * (promoOdd - 1)) - coverStake`
     - `lucroCoverWin = (coverStake * coverOdd) - coverStake`
     - `investimentoTotal = coverStake` *(apenas o dinheiro real investido na cobertura)*
     - `lucroGarantido = min(lucroPromoWin, lucroCoverWin)`
     - `roi = (lucroGarantido / investimentoTotal) * 100`

   - **Se `promoType === 'QUALIFYING'`**:
     - `investimentoTotal = promoStake + coverStake`
     - `lucroPromoWin = (promoStake * promoOdd) - investimentoTotal`
     - `lucroCoverWin = (coverStake * coverOdd) - investimentoTotal`
     - `lucroGarantido = min(lucroPromoWin, lucroCoverWin)`
     - `roi = (lucroGarantido / investimentoTotal) * 100`

3. **Atualizações na Interface (UI)**:
   - Adicione um seletor/toggle visível no formulário para escolher o **Tipo de Promoção**: `Freebet (SNR)` ou `Qualificativa (Dinheiro Real)`.
   - Atualize os cards/textos de resultado dinamicamente:
     - `Se a promoção ganhar: +R$ [lucroPromoWin]`
     - `Se a cobertura ganhar: +R$ [lucroCoverWin]`
     - `Garantido (pior caso): +R$ [lucroGarantido]`
     - `ROI (%): [roi]%`
   - Garanta que valores negativos fiquem vermelhos e valores positivos fiquem verdes.

---

### 🛠️ O que fazer agora:
1. Localize o arquivo do formulário/calculadora de promoções e suas funções utilitárias de cálculo.
2. Atualize os tipos TypeScript/interfaces para incluir `promoType`.
3. Ajuste a função de cálculo com as condicionais fornecidas.
4. Adicione o elemento visual (Select/Radio/Toggle) para `promoType` na UI e teste o caso:
   - Promo Stake: 50.00 | Odd Promo: 4.45
   - Cover Stake: 144.96 | Odd Cover: 1.19
   - Tipo: Freebet (SNR)
   - **Resultado Esperado:** Lucro de +R$ 27,54 em ambos os lados e ROI positivo (~19% sobre o investimento real de R$ 144,96).