/**
 * DOUTRINA de apostas de promoção (matched betting) — freebets, qualificativas,
 * múltiplas qualificadoras, cobertura sequencial e cashback.
 *
 * Origem: conversa do usuário com o agente do Gemini exportada em 30/07/2026
 * (blank.pdf → docs/conhecimento/promocoes_freebets_gemini_2026-07-30.md, corpus
 * bruto em conhecimento/corpusPromocoes.ts). Aqui ficam as REGRAS destiladas que o
 * Agente deve seguir sempre; o corpus é a fonte para "o que combinamos naquele dia".
 *
 * Duas correções que fizemos sobre o material original (matemática conferida em
 * core/promocoes.ts e testada em tests/promocoes.test.ts):
 *
 *  a) "quanto maior a odd da freebet, maior a retenção" é FALSO no limite. Com
 *     margem m no mercado oposto, a retenção é R(O) = (O-1)·(1 - m·(O-1)) / O, que
 *     SOBE, atinge o pico em O* = √(1 + 1/m) e DESPENCA depois. Foi exatamente o que
 *     aconteceu no caso real da odd 7.75: retenção ~40% (R$ 4,00 de R$ 10) em vez
 *     dos "75% a 85%" projetados. Com m≈6% o ótimo é O*≈4,2 — o que valida a faixa
 *     4.00–5.00 recomendada, mas pelo motivo certo.
 *
 *  b) A cobertura sequencial de múltipla tem fórmula fechada por perna
 *     (xk = (S + Σx anteriores − perda aceita) / (hk − 1)) e um custo que o material
 *     não menciona: o CAIXA DE PICO (S + Σx) cresce a cada perna que dá green.
 *
 *  c) A doutrina de "estique a odd" vale só para a SNR. Na SRR (a ficha volta) a
 *     retenção é 1 − m·(O−1): não tem pico, só desce, e o ótimo é a MENOR odd
 *     elegível. Aplicar a regra da SNR na SRR é perder retenção de propósito — e
 *     calcular uma pela outra sub-hedgeia a operação em O/(O−1).
 */

export interface SecaoDoutrina {
  id: string;
  titulo: string;
  /** Palavras-chave para a busca da skill `buscar_conhecimento`. */
  tags: string[];
  texto: string;
}

export const DOUTRINA_PROMOCOES: SecaoDoutrina[] = [
  {
    id: 'tipos-de-promocao',
    titulo: 'Os SEIS tipos de perna promocional (e por que confundir zera o lucro)',
    tags: [
      'freebet', 'snr', 'srr', 'qualificativa', 'proteção', 'super odd', 'odd turbinada',
      'lucro extra', 'profit boost', 'tipo', 'tipos de promocao', 'quantos tipos', 'seis tipos',
      'aposta extra', 'bônus',
    ],
    texto: `Toda operação de promoção tem uma PERNA PROMOCIONAL e uma PERNA DE COBERTURA (mercado oposto, em OUTRA casa). O tipo muda TODA a matemática — e são SEIS, todos calculados pelo app (core/promocoes.ts). Notação: S = stake elegível (min(valor, teto)), O = odd da promoção, v = valor de R$ 1 de bônus/ficha devolvida (default 70%).

- FREEBET SNR ("aposta grátis", "aposta extra", "prêmio"): a ficha NÃO volta no ganho. R = S·(O−1), custo real R$ 0,00 — subtrair a freebet do investimento é erro grosseiro (ROI negativo sem prejuízo).
- FREEBET SRR ("devolve a ficha", "com retorno do stake"): R = S·(O−1+v), custo real R$ 0,00; retenção acima de 100%, aporte O/(O−1)× o da SNR e ótimo INVERTIDO (freebet-srr).
- QUALIFICATIVA (dinheiro real: "aposta qualificadora", "com meu dinheiro"): R = S·O, custo S; o resultado, quase sempre negativo, é o pedágio do bônus.
- PROTEÇÃO (cashback de aposta perdida, "seguro"): R = S·O, custo S, MAIS a devolução D se a perna promocional PERDER — o único tipo que paga no cenário de red.
- SUPERODD ("super odd", "odd turbinada", com TETO DE STAKE): em dinheiro R = S·O — a odd turbinada JÁ contém o excedente; em bônus R = S·O_padrao + v·S·(O − O_padrao). Custo S.
- LUCRO_EXTRA (profit boost: "lucro extra", "+30% de lucro"): R = S·O + v·min(b·S·(O−1), teto do extra), custo S, b = % do boost.

Vocabulário → tipo e o anti-regressão: tipos-de-promocao-roteamento.`,
  },
  {
    id: 'tipos-de-promocao-roteamento',
    titulo: 'Roteamento: do vocabulário do usuário para um dos SEIS tipos',
    tags: [
      'roteamento', 'vocabulário', 'sinônimos', 'tipo', 'tipos de promocao', 'quantos tipos',
      'seis tipos', 'confirmar o tipo', 'freebet', 'snr', 'srr', 'qualificativa', 'proteção',
      'cashback', 'super odd', 'lucro extra',
    ],
    texto: `Roteamento do vocabulário (é o que tipoPromocaoDeTexto já faz): "aposta extra"/"prêmio"/"bônus"/"freebet" → FREEBET SNR; "devolve a ficha"/"stake returned"/"com retorno do stake"/"a aposta volta"/"SRR" → FREEBET SRR; "aposta qualificadora"/"aposta de qualificação"/"com meu dinheiro" → QUALIFICATIVA; "se perder eu recebo X%"/"cashback"/"seguro"/"devolvem a aposta" → PROTEÇÃO; "super odd"/"turbinada"/"aumentada"/"melhorada"/"enhanced" → SUPERODD; "lucro extra"/"+X% de lucro"/"profit boost"/"lucro turbinado"/"ganhos turbinados" → LUCRO_EXTRA.

NUNCA diga que o app só sabe freebet, qualificativa e cashback: os SEIS tipos (FREEBET_SNR, FREEBET_SRR, QUALIFICATIVA, PROTECAO, SUPERODD, LUCRO_EXTRA) têm fórmula própria, avisos de regulamento (tetos, bônus, opt-in) e gravação no histórico — é a mesma conta no core, na skill, na aba Promoções e no histórico.

E confirme o tipo ANTES de calcular — a mesma odd com o tipo errado erra o aporte e o "lucro garantido" deixa de ser garantido: uma SRR calculada como SNR aporta O/(O−1) vezes MENOS do que precisa (metade, em odd 2,00) e o resultado volta a depender do jogo. Se o usuário não disse se a ficha volta, PERGUNTE.`,
  },
  {
    id: 'protecao-aposta-perdida',
    titulo: 'PROTEÇÃO: como a devolução da aposta perdida vira lucro travado',
    tags: [
      'proteção', 'cashback', 'seguro', 'aposta perdida', 'devolução', 'cálculo',
      'piso da devolução', 'equalizar',
    ],
    texto: `Cenário: a casa promete devolver X% se a aposta PERDER (ex.: 50% de R$ 100 = R$ 50). Aposte S na odd O na casa da promoção e cubra o mercado OPOSTO com c na odd H, em outra casa.

  aporte da cobertura  c = (S·O − D) / H          (D = devolução EFETIVA)
  se a promo GANHA     S·(O−1) − c
  se a promo PERDE     c·(H−1) − S + D
  investimento real    S + c   (a devolução vem depois; não abate o aporte)

Os dois cenários pagam igual por construção. Onde está o lucro: sem promoção a operação custaria S·O·(1/O + 1/H − 1); a devolução paga esse pedágio e o que sobra é lucro travado.

Piso da devolução (com cobertura equalizada):

  D₀ = S·(O − H·(O − 1))

Se D > D₀ a operação é lucro garantido; se D < D₀ é prejuízo garantido. D₀ cai rápido quando H sobe: com O=2,00 e H=1,90, D₀ = 10% da stake — um cashback de 50% tem folga enorme. Com O=2,00 e H=2,05, D₀ é NEGATIVO (o par já é surebet e o cashback é lucro em cima de lucro).

Exemplo do caso base: S=100 @2,00, cashback 50% (D=R$ 50), cobertura @2,05 → c = (200−50)/2,05 = R$ 73,17. Promo ganha: 100 − 73,17 = +R$ 26,83. Promo perde: 73,17·1,05 − 100 + 50 = +R$ 26,83. ROI 15,5% sobre os R$ 173,17 na mesa.

As cinco armadilhas (teto, devolução em bônus, condição, opt-in, devolução incondicional): seção protecao-armadilhas.`,
  },
  {
    id: 'protecao-armadilhas',
    titulo: 'PROTEÇÃO: as cinco armadilhas da devolução de aposta perdida',
    tags: [
      'proteção', 'cashback', 'seguro', 'aposta perdida', 'armadilha', 'teto',
      'devolução em bônus', 'opt-in', 'regulamento',
    ],
    texto: `ARMADILHAS da proteção/cashback de aposta perdida (todas já custaram dinheiro a alguém):
1. TETO. "50% até R$ 50" com stake de R$ 200 devolve R$ 50, não R$ 100. Acima da stake que consome o teto (teto ÷ %), cada real entra SEM proteção e só afina o ROI. A stake ótima é justamente a que casa com o teto.
2. DEVOLUÇÃO EM BÔNUS. Freebet/bônus não é dinheiro: vale a retenção que você consegue extrair (~70%). Equalizar pela FACE infla o cenário de red e o "lucro garantido" só aparece depois de converter o bônus. Use o valor efetivo na conta e diga qual parte é caixa hoje e qual é bônus a extrair.
3. CONDIÇÃO. Confirme no regulamento: só aposta simples? odd mínima? mercado elegível? devolve em quanto tempo? só a primeira aposta do dia? "Perdeu por 1 gol" e afins NÃO são proteção total — nesse caso a devolução é condicional a um placar, não ao red, e a matemática da seção protecao-aposta-perdida não vale.
4. OPT-IN antes de apostar, como em toda promoção.
5. Devolução incondicional (cai ganhando ou perdendo) não é proteção: ela não muda o aporte, só soma no lucro dos dois cenários.`,
  },
  {
    id: 'cobertura-freebet-snr',
    titulo: 'Cobertura de freebet SNR — fórmula e prova',
    tags: ['cobertura', 'freebet', 'snr', 'cálculo', 'aporte', 'equalizar'],
    texto: `Freebet de valor F na odd O, cobertura no mercado oposto na odd C:

  aporte da cobertura  c = F·(O − 1) / C
  lucro garantido      L = c·(C − 1) = F·(O − 1)·(C − 1) / C

O lucro é o MESMO nos dois cenários (é isso que "equalizar" significa):
- freebet bate: recebe F·(O−1) e perde c → F·(O−1) − c = c·C − c = L
- cobertura bate: recebe c·C, perde c de aporte e nada da freebet (era bônus) → L

Exemplo real conferido (caso da odd 7.75): F=10, O=7.75, C=1.06 → c = 10·6,75/1,06 = R$ 63,68 e L = 63,68·0,06 = R$ 3,82. Com C=1.07 → c = R$ 63,08 e L = R$ 4,42.

O investimento REAL da operação é só c (a freebet não sai do bolso), então o ROI se mede sobre c — mas a métrica que importa numa freebet é a RETENÇÃO: L/F.`,
  },
  {
    id: 'odd-ideal-freebet',
    titulo: 'Odd ideal da freebet: a retenção tem PICO (√(1 + 1/m))',
    // 'melhor odd'/'odd otima'/'snr': o usuário pergunta "qual a melhor odd para a freebet" e
    // essa é a seção com a resposta (o pico √(1+1/m) da SNR). Sem elas a consulta caía na
    // super odd e na SRR — que dizem o CONTRÁRIO (ótimo em ~2,02 / menor odd possível).
    tags: [
      'retenção', 'odd ideal', 'melhor odd', 'odd otima', 'snr', 'freebet', 'otimizar',
      'margem', 'extração',
    ],
    texto: `Retenção = lucro garantido / valor da freebet. Como a casa recolhe a ficha, odd baixa queima uma fatia grande do bônus — daí a ideia (correta no começo) de "buscar odd alta". Mas o mercado oposto tem margem: se a odd justa oposta é O/(O−1), a casa de cobertura oferece C = O / ((O−1)·(1+m)) com margem m. Substituindo na fórmula da retenção:

  R(O) = (O − 1) · (1 − m·(O − 1)) / O
  odd ótima  O* = √(1 + 1/m)      (pico de retenção)

Consequências práticas (números conferidos com retencaoTeorica/curvaRetencaoFreebet):
- m = 4% → O* ≈ 5,10 (retenção ~67%, cobertura ~1,20)
- m = 5% → O* ≈ 4,58 (retenção ~64%, cobertura ~1,22)
- m = 6% → O* ≈ 4,20 (retenção ~62%, cobertura ~1,24)
- m = 8% → O* ≈ 3,67 (retenção ~57%, cobertura ~1,27)
- m = 12% → O* ≈ 3,06 (retenção ~51%, cobertura ~1,33)

Ou seja: a faixa recomendada de 4.00 a 5.00 (com cobertura pagando 1.22 a 1.28) está certa, e odd ESTICADA piora — a odd 7.75 do caso real rendeu ~40% de retenção (R$ 4,00 numa freebet de R$ 10) exatamente por isso, não por azar. Antes de mandar o usuário buscar odd alta, pergunte a odd de cobertura disponível: ela revela a margem.

Regra de bolso: rejeite coberturas com C < 1,10 quando a freebet estiver acima de 6.00 — a retenção cai para a faixa dos 40%.`,
  },
  {
    id: 'freebet-srr',
    titulo: 'FREEBET SRR — a ficha volta (stake returned): fórmula, custo zero e sub-hedge',
    // 'aposta gratis'/'retorno do stake'/'com retorno'/'aposta volta': é o vocabulário canônico
    // da SRR (a frase do próprio texto). Sem eles a consulta caía na proteção, e aplicar o
    // modelo da proteção numa SRR erra o CUSTO (dinheiro real vs ficha grátis).
    tags: [
      'srr', 'freebet', 'aposta gratis', 'retorno do stake', 'com retorno', 'aposta volta',
      'ficha volta', 'devolve a ficha', 'stake returned', 'sub-hedge', 'cobertura', 'cálculo',
    ],
    texto: `Na SRR a casa devolve a FICHA junto com o lucro quando a aposta ganha — "aposta grátis com retorno do stake", "devolve a ficha", "a aposta volta". S = stake elegível, O = odd da promo, H = odd da cobertura, v = valor da ficha devolvida (1 = dinheiro; 0,7 = bônus):

  retorno bruto  R = S·(O−1+v)   (v = 1 → R = S·O)
  custo real     R$ 0,00 (a ficha não sai do bolso)
  cobertura      c = R / H
  lucro travado  L = R − c = c·(H−1)   (igual nos dois cenários)
  retenção       L / S   (PASSA de 100% — correto: a ficha volta)

Caso base do core: freebet R$ 50 @2,00, cobertura @2,05 → c = R$ 48,78 e lucro +R$ 51,22 nos DOIS cenários (retenção 102,44%). A SNR pediria R$ 24,39 — O/(O−1) = 2× menos.

SUB-HEDGE (o erro caro): usar S·(O−1) quando a ficha volta aporta O/(O−1) vezes MENOS que o necessário. No caso base o resultado deixa de ser travado: +R$ 75,61 se a freebet bater, +R$ 25,61 se a cobertura bater — e como a ficha é grátis nenhum cenário fica negativo ("lucro nos dois lados") — daí passar despercebido. O lado da cobertura fica em (O−1)/(O−1+v) do lucro correto, fração que PIORA em odd curta: R$ 100 @1,50 com cobertura 2,83 pede R$ 53,00 nos dois lados (retenção 97%); o aporte da SNR (R$ 17,67) entrega +R$ 132,33 no green e só +R$ 32,34 no red — um TERÇO da retenção, sorteado pelo jogo. Confirme sempre se a ficha volta.

Ver também freebet-srr-otimo e freebet-srr-tetos.`,
  },
  {
    id: 'freebet-srr-otimo',
    titulo: 'FREEBET SRR: o ótimo é a MENOR odd elegível (o inverso da SNR)',
    tags: [
      'srr', 'freebet', 'retenção', 'ótimo', 'menor odd', 'curva', 'margem', 'snr',
      'ficha volta', 'caixa',
    ],
    texto: `POR QUE O ÓTIMO DA SRR É INVERTIDO (é contra-intuitivo de verdade). Substituindo a cobertura de um mercado com margem m (H = O/((O−1)·(1+m))) na retenção, com v = 1:

  retenção(O) = 1 − m·(O − 1)

Uma reta que só desce: não existe pico. A SNR tem pico em √(1+1/m) porque a casa RECOLHE a ficha — odd baixa devolve pouco lucro e queima o bônus, então vale esticar a odd até a margem do lay comer o ganho. Na SRR não há ficha a recuperar: o ÚNICO vazamento é a margem paga na cobertura, e ela é proporcional a (O−1). Logo o ótimo é a MENOR odd que o regulamento aceitar. É por isso que oddIdealFreebet(m, 1) devolve NaN de propósito (não há pico interior) e curvaRetencaoFreebet marca direcaoDoOtimo = 'menor-odd' — nunca imprima o √(1+1/m) da SNR numa SRR: é conselho ativamente errado.

Curva com m = 6% (números do core, freebet de R$ 100):
- odd 1,50 → cobertura ~2,83, aporte R$ 53, retenção 97%
- odd 2,00 → cobertura ~1,89, aporte R$ 106, retenção 94%
- odd 4,00 → cobertura ~1,26, aporte R$ 318, retenção 82%

Segundo efeito: o aporte é proporcional a (O−1), então a odd 4,00 imobiliza 6× mais caixa que a odd 1,50 para render 15 pontos MENOS de retenção. Na SRR a odd curta ganha nas duas dimensões — o app avisa isso sozinho quando o tipo é SRR e a odd está em 2,00 ou acima.`,
  },
  {
    id: 'freebet-srr-tetos',
    titulo: 'FREEBET SRR: ficha que volta em bônus e os dois tipos de teto do regulamento',
    tags: [
      'srr', 'freebet', 'ficha volta', 'bônus', 'valor da ficha', 'teto', 'ganho máximo',
      'retorno máximo', 'caixa', 'regulamento',
    ],
    texto: `FICHA QUE VOLTA EM BÔNUS (v < 1): R$ 100 @2,00 com a ficha voltando em bônus valendo 70% e cobertura @1,8868 → R = R$ 170, aporte R$ 90,10, lucro travado R$ 79,90 — mas R$ 70 disso é BÔNUS. O caixa do dia no green é R$ 9,90 e o resto depende de converter a ficha nova (cobrindo-a como freebet). Diga sempre as duas coisas. Se a ficha volta em DINHEIRO, valorFichaPct = 100.

TETO DO REGULAMENTO na SRR: "ganhe até R$ 100" limita só o LUCRO (a ficha ainda volta: R = v·S + 100), "retorno máximo R$ 100" limita o pagamento INTEIRO. Não é a mesma fórmula — numa SRR de R$ 100 @4,00 com cobertura 1,2579, a leitura GANHO dá R = 200, aporte R$ 159,00 e lucro R$ 41,00; a leitura RETORNO dá R = 100, aporte R$ 79,50 e lucro R$ 20,50. Ler "retorno" como "ganho" manda aportar R$ 159 contra um pagamento de R$ 100: o green fecha em −R$ 59,00.`,
  },
  {
    id: 'superodd',
    titulo: 'SUPER ODD: retorno efetivo em caixa ou em bônus, dupla contagem e teto de stake',
    // Sem repetir "odd" à toa e sem a tag 'melhorada' ('turbinada'/'aumentada' já cobrem o
    // vocabulário, porque a busca é por termo): cada "odd" extra em título/tag pesa 6/4 pontos
    // e roubava "melhor odd para a freebet" da seção do pico da SNR (odd-ideal-freebet), que é
    // a resposta certa para ela — e esta seção diz o contrário (ótimo em odd curta/média).
    tags: [
      'super odd', 'turbinada', 'aumentada', 'excedente', 'odd efetiva', 'teto de stake',
      'stake elegível', 'boost', 'bônus', 'cálculo', 'cobertura',
    ],
    texto: `Na SUPER ODD a perna promocional é DINHEIRO REAL (custo S) e quem paga a operação é o retorno TURBINADO. A conta colapsa numa surebet comum ao reduzir tudo a uma ODD EFETIVA (oddEfetivaPromo do core = retorno bruto / S), com v = valor de R$ 1 de bônus:

  paga em dinheiro  O_ef = O   (a odd turbinada JÁ contém o excedente)
  paga em bônus     O_ef = O_padrao + v·(O − O_padrao)
  cobertura         c = S·O_ef / H
  LUCRO TRAVADO se  1/O_ef + 1/H < 1   ⇔   O_ef > H/(H−1)

Paga em DINHEIRO, o excedente é MEDIDA do boost, não parcela a somar: somá-lo dava R$ 72 onde a casa paga R$ 60 (S = 30 @2,00) e inflava o aporte — "lucro" que não existe.

TETO DE STAKE ("super odd até R$ 30"): a conta roda na parte ELEGÍVEL, S = min(valor, teto). R$ 100 numa super odd @2,00 com teto de R$ 30 e cobertura 2,50 vira aporte R$ 24,00, lucro R$ 6,00 e investimento R$ 54,00. Com os R$ 100 na fórmula o aporte inflava ~3,3× e virava prejuízo travado nos DOIS cenários. O que não cabe no teto entra na odd NORMAL da casa: uma qualificativa com prejuízo colada na operação.

NÃO modele margem aqui: a odd anunciada não é de mercado — use o piso (boost-piso) com a odd de cobertura REAL da tela. OPT-IN antes de apostar; super odd quase nunca está no feed (o scraper não a vê; a odd vem do print); e com teto baixo ordene por LUCRO EM REAIS, não por ROI — R$ 30 de super odd raramente pagam o tempo de execução.`,
  },
  {
    id: 'lucro-extra',
    titulo: 'LUCRO EXTRA (profit boost): retorno efetivo, "% do lucro" ≠ "% da stake" e o teto do extra',
    tags: [
      'lucro extra', 'profit boost', 'boost', 'ganhos turbinados', 'odd efetiva',
      'teto do extra', 'percentual', 'sobre o lucro', 'sobre a stake', 'cálculo', 'cobertura',
    ],
    texto: `No LUCRO EXTRA a perna promocional é DINHEIRO REAL (custo S) e quem paga a operação é o boost. A conta colapsa numa surebet comum ao reduzir tudo a uma ODD EFETIVA (oddEfetivaPromo do core = retorno bruto / S), com v = valor de R$ 1 de bônus e b = percentual do boost:

  % sobre o LUCRO   O_ef = 1 + (O−1)·(1 + v·b)
  % sobre a STAKE   O_ef = O + v·b
  cobertura         c = S·O_ef / H
  LUCRO TRAVADO se  1/O_ef + 1/H < 1   ⇔   O_ef > H/(H−1)

"% DO LUCRO" ≠ "% DO VALOR APOSTADO". A leitura padrão é sobre o LUCRO (extra = b·S·(O−1)); o regulamento alternativo aplica sobre a STAKE (extra = b·S). Os dois coincidem em odd 2,00 e divergem para os dois lados: em R$ 100 @3,00 um boost de 30% vale R$ 60 sobre o lucro contra R$ 30 sobre a stake; em odd 1,50 vale R$ 15 contra R$ 30. Em odd curta é a diferença entre lucro e prejuízo — confirme no regulamento antes de calcular.

TETO DO EXTRA ("+30% até R$ 50"): ele corta a FACE, ANTES de valorizar o bônus (fazer min(v·extra, teto) devolve mais do que a casa paga sempre que o teto morde). Com o teto mordendo, aumentar a stake PIORA — R$ 500 @2,00 com cobertura 1,90 e boost de 30% limitado a R$ 50 fecha em −R$ 2,63 (aporte R$ 552,63), enquanto os mesmos R$ 100 sem teto dão +R$ 8,95: depois do teto, cada real a mais só paga pedágio de cobertura.

Piso: boost-piso. Pico: boost-pico. Extra em bônus: boost-em-bonus. E OPT-IN antes de apostar.`,
  },
  {
    id: 'boost-piso',
    titulo: 'Piso do boost: qual o extra mínimo que fecha a operação (sem estimar margem)',
    tags: [
      'piso', 'boost mínimo', 'extra efetivo', 'fronteira', 'super odd', 'profit boost',
      'cobertura', 'cálculo',
    ],
    texto: `PISO DO EXTRA (sem estimar margem nenhuma), direto da fronteira O_ef ≥ H/(H−1):

  extra efetivo mínimo = S·( H/(H−1) − O_base )

onde O_base é a odd que a casa paga em CAIXA (a própria odd promocional; a odd PADRÃO quando o excedente vem em bônus). Exemplos do core: lucro extra em R$ 100 @4,00 com cobertura 1,25 precisa de R$ 100 de extra efetivo (100·(5,00 − 4,00)) — um boost de 30% entrega R$ 90 e a operação fecha em −R$ 2,00; o boost mínimo ali é 33,3%. Super odd 1,70 contra padrão 1,60 com cobertura 2,00 e excedente em bônus precisa de R$ 40 por R$ 100 de stake (100·(2,00 − 1,60)) e não chega perto.

Use este piso sempre que a odd anunciada NÃO for de mercado (é o caso da super odd): ele depende só da odd de cobertura REAL da tela, sem hipótese de margem.`,
  },
  {
    id: 'boost-pico',
    titulo: 'Pico do rendimento do boost: a condição b·v > m e o termo quadrático',
    tags: [
      'boost', 'profit boost', 'lucro extra', 'pico', 'rendimento', 'margem', 'quadrático',
      'curva', 'prejuízo garantido', 'cobertura',
    ],
    texto: `ONDE O RENDIMENTO TEM PICO. No LUCRO EXTRA, com a cobertura precificada pelo mercado (H = O/((O−1)·(1+m)), margem m), o lucro travado por real de stake se decompõe em três parcelas exatas:

  L/S = b·v·(O−1)  −  m·(O−1)  −  b·v·(1+m)·(O−1)²/O
        prêmio do      pedágio da    pedágio da margem sobre
        boost          perna crua    o próprio prêmio

Duas leituras saem daí:
- CONDIÇÃO NECESSÁRIA b·v > m. Boost de 5% em mercado com 6% de margem não paga em NENHUMA odd — e boost em bônus de face 30% valendo 70% é b·v = 21%, não 30%.
- O termo QUADRÁTICO é o que mata odd alta. O ótimo é O* = √( b·v·(1+m) / (m·(1 + b·v)) ). Com b = 30% pago em dinheiro (v = 1) e m = 6%: O* = 2,019, com lucro travado de 8,10% da stake. A curva no mesmo par (b = 30%, m = 6%): odd 1,50 → 6,70%; 2,00 → 8,10%; 2,50 → 7,38%; 3,00 → 5,60%; 5,00 → −5,76%.

Ou seja: EM ODD 5,00 UM BOOST DE 30% É PREJUÍZO GARANTIDO (−R$ 5,76 por R$ 100 de stake); ali o boost precisaria ser de ~39,5% só para empatar. Boost é para odd curta/média — "usei o boost na odd alta para maximizar o prêmio" é o erro simétrico ao da freebet SNR.`,
  },
  {
    id: 'boost-em-bonus',
    titulo: 'Excedente do boost pago em BÔNUS cai no green (ramo oposto ao da proteção)',
    tags: [
      'bônus', 'excedente', 'boost', 'super odd', 'lucro extra', 'caixa', 'valor do bônus',
      'odd padrão', 'green', 'cálculo',
    ],
    texto: `EXTRA EM BÔNUS CAI NO GREEN — ramo OPOSTO ao da proteção (lá o bônus cai no red). Super odd de R$ 30 @2,00 sobre padrão 1,60 com cobertura 2,50: em dinheiro R = R$ 60, aporte R$ 24,00, lucro R$ 6,00 (ROI 11,11%); com o excedente em bônus a 70%, a face é R$ 12,00, o efetivo R$ 8,40, R = R$ 56,40, aporte R$ 22,56 e o lucro travado cai para R$ 3,84 — com CAIXA de −R$ 4,56 no green, positivo só depois de converter o bônus. Informe sempre os dois números (lucro travado e caixa de hoje).

Se o excedente é em bônus, a odd PADRÃO é obrigatória: sem ela a conta trata tudo como caixa, e medir a margem pela odd turbinada dá negativo, clampa em zero e esconde o pedágio.`,
  },
  {
    id: 'cobertura-qualificativa',
    titulo: 'Cobertura de aposta qualificativa (dinheiro real)',
    tags: ['qualificativa', 'qualificadora', 'cobertura', 'perda', 'cálculo'],
    texto: `Stake real S na odd O, cobertura na odd C:

  aporte da cobertura  c = S·O / C
  resultado garantido  = S·O − (S + c) = −S·O·(1/O + 1/C − 1)   → normalmente NEGATIVO

A perda do qualificador é o "pedágio" para destravar o bônus, e a fórmula acima diz exatamente o que minimizar: o produto S·O·(soma − 1), onde soma = 1/O + 1/C.

ATENÇÃO à armadilha: minimizar SÓ a soma não basta, porque ela é multiplicada pela odd da promoção. Um par com soma 1,010 e O=20,00 custa MUITO mais caro (S=100 → perda ~R$ 20) que um par com soma 1,020 e O=2,00 (perda ~R$ 4). Regra correta: para a MESMA soma, prefira a MENOR odd na perna qualificadora; e entre pares, compare O·(soma − 1), não a soma isolada. Se a soma der < 1 o qualificador vira lucro (é surebet) e o bônus é lucro em cima de lucro.

Só aceite a perda depois de comparar: perda do qualificador vs. valor extraível do bônus (freebet × retenção da seção odd-ideal-freebet). Se a perda passar de ~35% do bônus, procure outro par de casas/mercado.`,
  },
  {
    id: 'cashback',
    titulo: 'Cashback entra como redução de custo do cenário em que a promo perde',
    tags: ['cashback', 'devolução', 'perda', 'cálculo'],
    texto: `Cashback quase sempre é condicional ("devolvemos X% se a aposta perder"). Então ele NÃO entra nos dois cenários: entra só naquele em que a perna promocional perde (ou seja, quando a cobertura ganha). A equalização passa a ser:

  c = (retorno bruto da promo − cashback) / C
  onde retorno bruto = F·(O−1) para freebet SNR, ou S·O para qualificativa.

Caso real: múltipla qualificadora de R$ 20 com 50% de cashback → custo efetivo R$ 10. Com a cobertura de R$ 39,50 @1.43 retornando R$ 56,48, o qualificador que era −R$ 3,02 virou +R$ 6,98 de lucro real ANTES da freebet. Sempre pergunte se a casa dá cashback de perda: ele frequentemente transforma o pedágio em lucro.`,
  },
  {
    id: 'aposte-e-ganhe',
    titulo: '"Aposte e Ganhe": o bônus não depende do resultado',
    tags: ['aposte e ganhe', 'promoção', 'regra', 'qualificador', 'freebet'],
    texto: `Nas promoções do tipo "aposte e ganhe", green ou red no bilhete qualificador é IRRELEVANTE para receber o bônus. O que importa é cumprir o regulamento. Checklist obrigatório antes de apostar:

1. OPT-IN: clicar em "Participe aqui"/"Ativar oferta" ANTES de montar o bilhete — sem isso a casa não contabiliza (é o erro que mais queima promoção).
2. Tipo de bilhete: simples ou múltipla com N seleções mínimas.
3. Odd mínima POR SELEÇÃO e odd TOTAL mínima.
4. Competição/mercado elegível (ex.: "exclusivamente Copa Sul-Americana").
5. Valor mínimo por aposta e quantas vezes a oferta pode ser repetida.
6. Janela de validade da promoção e PRAZO DE CREDITAÇÃO do bônus.
7. Regras da freebet recebida: odd mínima para usar, validade, e se é SNR.

Prazo de creditação: costuma ser "até 24h após o ENCERRAMENTO da promoção" — a contagem começa no fim da campanha, não na sua aposta. Só acione o suporte (com print do regulamento e do bilhete) depois desse prazo.`,
  },
  {
    id: 'multipla-qualificadora',
    titulo: 'Montagem da múltipla qualificadora: pernas equilibradas',
    tags: ['múltipla', 'parlay', 'qualificadora', 'odd total', 'montagem'],
    texto: `Quando a promoção exige odd total mínima T com n seleções, distribua a odd de forma EQUILIBRADA: cada perna perto de T^(1/n).

- T=4.00 com 3 pernas → ~1,59 por perna (1,59³ ≈ 4,02)
- T=4.00 com 4 pernas → ~1,42 por perna (1,42⁴ ≈ 4,07)

Evite uma perna esticada (ex.: 2.50) com as outras no piso (1.20): a perna alta encarece muito a cobertura daquele jogo, porque o mercado oposto dela paga pouco. Quanto mais equilibrado, menor o caixa total exigido na cobertura sequencial.

E confira sempre a odd total ANTES de confirmar: o caso real chegou a montar 3.15 numa promoção que exigia 4.00 — o bilhete não qualificaria. Correção rápida: adicionar uma seleção de odd ≥ T/atual (3.15 → precisa de 1,27) ou esticar um mercado existente.`,
  },
  {
    id: 'cobertura-sequencial',
    titulo: 'Cobertura sequencial (jogo a jogo) — a única forma sã de cobrir múltipla',
    tags: ['cobertura sequencial', 'múltipla', 'parlay', 'hedge', 'jogo a jogo'],
    texto: `NUNCA cubra as n pernas de uma múltipla de uma vez. Cubra PERNA POR PERNA, e só faça a cobertura k depois que a perna k−1 der green:

  x_k = (S + x_1 + … + x_{k−1} − perda_aceita) / (h_k − 1)

onde S é o stake da múltipla e h_k é a odd do mercado OPOSTO da perna k na casa de cobertura. Com perda_aceita = 0, qualquer red pelo caminho devolve todo o dinheiro gasto até ali e a operação morre ali mesmo — sem precisar apostar nas pernas seguintes. Se todas as pernas baterem, o lucro é S·(odd total) − S − Σx.

Requisito estrutural: os jogos precisam RESOLVER em momentos diferentes. Se duas pernas começam no mesmo horário, a cobertura sequencial quebra (você teria que cobrir as duas de uma vez, o que encarece e embaralha a matemática).

TRÊS pontos que o material original não menciona e você deve avisar SEMPRE:
- O CAMINHO ALL-GREEN NÃO É COBERTO. A fórmula protege todo caminho de RED; se tudo bater, cada cobertura perdida foi dinheiro gasto. Quando a soma das coberturas passa do retorno do bilhete, o "risco zero" vira PREJUÍZO. Caso concreto: R$ 50 em 4 pernas de 1,42 (total 4,07) cobertas a 2,70 → caixa de pico R$ 318,14 e retorno do bilhete R$ 203,50 = −R$ 114,64 se tudo bater. Compare essa perda com o valor do bônus antes de executar (ou aceite perda parcial para baratear as coberturas).
- CAIXA DE PICO: o aporte cresce a cada green (x_k depende de tudo que já foi gasto). Confira se a banca aguenta o pior caminho ANTES de começar.
- A cobertura de cada perna precisa ser do MESMO escopo do mercado da múltipla (1º tempo cobre 1º tempo, partida inteira cobre partida inteira).`,
  },
  {
    id: 'escalonamento-temporal',
    titulo: 'Truque do escalonamento: 1º tempo × 2º tempo cria sequência em jogos simultâneos',
    tags: ['escalonamento', 'simultâneo', 'primeiro tempo', 'segundo tempo', 'linha do tempo'],
    texto: `Jogos no mesmo horário não impedem cobertura sequencial se os MERCADOS resolverem em momentos diferentes. Escolhendo um mercado de 1º tempo num jogo e de 2º tempo no outro, você recria uma linha do tempo: o 1º tempo do jogo B resolve antes do 2º tempo do jogo C, e o intervalo do jogo C ainda dá 10–15 minutos para entrar ao vivo na cobertura.

Ao aplicar isso, escreva a linha do tempo explícita (horário previsto de resolução de cada perna) e avise que a cobertura da última perna será AO VIVO — com risco de mercado suspenso e odd pior que a pré-jogo.`,
  },
  {
    id: 'adiar-cobertura',
    titulo: 'Adiar a cobertura para "girar a banca": os dois riscos reais',
    tags: ['adiar', 'risco', 'odd drift', 'suspensão', 'liquidez'],
    texto: `Deixar a perna promocional exposta e cobrir depois libera liquidez, mas cobra:

1. ODD DRIFT — a odd da cobertura se move (escalação, notícia, volume). Se ela SOBE, o aporte necessário cai (bom); se CAI, o aporte sobe e a retenção some. A assimetria é ruim porque o lado que interessa (odd de favorito extremo, 1.05–1.15) tende a cair conforme o jogo se aproxima.
2. MERCADO SUSPENSO / esquecimento — imprevisto na casa ou o jogo começar deixa a perna 100% exposta: de lucro certo vira aposta comum.

Se o usuário optar por adiar mesmo assim: (a) marcar alarme para no mínimo 1h antes do início; (b) checar a odd de cobertura pelo menos duas vezes no dia e fechar na hora se começar a cair. No JotinhaBet isso é literal: use a skill de consultar odds da casa para medir o drift em vez de estimar.`,
  },
  {
    id: 'abuso-de-bonus',
    titulo: 'Não pareça abusador de bônus (e não seja limitado)',
    tags: ['abuso de bônus', 'limitação', 'conta limitada', 'contraditória'],
    texto: `Cuidados de conta, que valem mais que alguns centavos de lucro:
- Não aposte o EXATO OPOSTO do seu próprio bilhete na MESMA casa: a casa lê como aposta contraditória/abuso de bônus. A cobertura vai em OUTRA casa; se precisar de um segundo bilhete na mesma casa, use mercados alternativos (gols, ambas marcam, escanteios, empate anula) nos mesmos jogos.
- Casas recreativas identificam padrão de arbitragem rápido (sobretudo em ligas alternativas) e cortam o limite máximo para centavos. Distribua volume, arredonde stakes, evite valores "de calculadora" (R$ 144,96 → R$ 145) e não aposte só em ligas exóticas.
- Repetir o mesmo evento em bilhetes diferentes normalmente é permitido, mas confira o regulamento da promoção.`,
  },
  {
    id: 'surebet-fundamento',
    titulo: 'Surebet: o que o alerta do SureRadar está dizendo',
    tags: ['surebet', 'arbitragem', 'roi', 'aporte', 'explicação'],
    texto: `Surebet é o mesmo evento precificado de forma incompatível em duas casas. Se 1/oddA + 1/oddB < 1, apostar nos dois lados opostos garante retorno maior que o investido, qualquer que seja o resultado.

Leitura de um alerta (exemplo real): BetBoom "Suwon mantém a baliza inviolada – Não" @2.60 com R$ 166,83 e Stake "Sejong menos de 0.5 gols" @1.84 com R$ 235,74. Os dois lados são o MESMO evento binário (o Sejong marca ou não marca), então retorno igual nos dois cenários: 166,83·2,60 = 235,74·1,84 = R$ 433,76. Investido R$ 402,57 → lucro garantido R$ 31,19 = 7,75% de ROI.

Ao explicar um alerta, sempre traduza os dois rótulos para o MESMO evento binário; se você não conseguir mostrar que são opostos exatos, o par pode ser um falso positivo de matching — avise em vez de mandar apostar.`,
  },
  {
    id: 'surebet-riscos',
    titulo: 'Riscos de execução da surebet (não é dinheiro grátis)',
    tags: ['risco', 'surebet', 'erro palpável', 'void', 'limitação', 'defasagem'],
    texto: `1. VELOCIDADE DA ODD: a odd cai enquanto você digita a outra perna → perna descompensada. Aposte primeiro a perna da casa mais instável/menos líquida e revalide antes de confirmar (no app: botão Revalidar / skill de odds ao vivo).
2. LIMITAÇÃO DE CONTA: casa recreativa reduz limite ao detectar arbitragem.
3. ERRO PALPÁVEL (palpable error): odd absurda por falha técnica pode ser anulada (paga 1.00) e te deixa exposto na outra casa.
4. REGRAS DE VOID DIVERGENTES: W.O. no tênis, prorrogação no basquete, jogo adiado. Duas casas com política diferente transformam surebet em aposta simples — no JotinhaBet isso é checado pelos grupos de W.O. (skill de regras da casa).
5. LIQUIDEZ/limite máximo por aposta menor que o aporte calculado: se só couber metade de uma perna, você fica descoberto.`,
  },
  {
    id: 'gestao-operacao',
    titulo: 'Condução da operação: uma perna por vez, com confirmação',
    tags: ['gestão', 'operação', 'checklist', 'banca', 'execução'],
    texto: `Padrão de condução que o usuário já espera (foi assim na conversa original):
1. Confirmar tipo da promo, regras e valores ANTES de qualquer cálculo.
2. Calcular a perna promocional e mandar apostar primeiro a que pode desaparecer (a promocional, ou a odd mais volátil).
3. Pedir a odd EXATA da cobertura na tela no momento da entrada — nunca calcular com odd estimada — e devolver o aporte "no centavo".
4. Registrar os dois cenários em dinheiro e o resultado garantido; deixar claro que a execução é manual e o app nunca aposta sozinho.
5. Ao fim do evento, reconciliar (o que entrou/saiu de cada casa) e só então declarar o lucro.

Nunca prometa lucro sem ressalva, e nunca invente odd, casa, valor de bônus ou regra de promoção: pergunte ou use uma skill para buscar o dado.`,
  },
];

/** Resumo compacto (vai no system prompt do Agente; o detalhe vem por skill). */
export const RESUMO_DOUTRINA_PROMOCOES = `DOUTRINA DE PROMOÇÕES (resumo — detalhe completo na skill buscar_conhecimento):
- 6 TIPOS, todos calculados: FREEBET_SNR, FREEBET_SRR, QUALIFICATIVA, PROTECAO, SUPERODD, LUCRO_EXTRA. Nunca diga que só há freebet/qualificativa/cashback.
- Freebet SNR: custo real 0; aporte da cobertura c = F·(O−1)/C; lucro L = c·(C−1); métrica = retenção L/F. NUNCA subtraia a freebet do investimento.
- Freebet SRR (a ficha VOLTA): R = S·(O−1+v), custo 0, c = R/C — aporte O/(O−1)× o da SNR (2× em odd 2,00). Retenção = 1 − m·(O−1) → ótimo é a MENOR odd, inverso da SNR (m=6%: 1,50→97%, 4,00→82%).
- Qualificativa: c = S·O/C; a perda (pedágio do bônus) é S·O·(soma−1) com soma = 1/O + 1/C — escolha o par com soma perto de 1 e, para a MESMA soma, a MENOR odd na qualificadora. Não escolha só pela soma.
- Retenção da freebet tem PICO: R(O) = (O−1)(1−m(O−1))/O, ótimo em O* = √(1+1/m) (m≈6% → O*≈4,2 com retenção ~62%). Odd esticada com cobertura em 1.06 rende ~40%, não 80%.
- Cashback CONDICIONAL (só se perder) entra na equalização: c = (retorno bruto − cashback)/C. Cashback que cai nos dois cenários NÃO muda o aporte, só soma no lucro.
- PROTEÇÃO (devolução da aposta perdida): dinheiro real + a casa devolve X% no red. c = (S·O − D)/H; lucro travado se D > D₀ = S·(O − H·(O−1)). Cuide do TETO ("50% até R$ 50" → a stake ótima é teto÷%) e de devolução em BÔNUS (vale ~70% da face, e só é caixa depois de converter).
- SUPER ODD (dinheiro real): em caixa R = S·O — a odd turbinada JÁ contém o excedente (não some 2×); em bônus R = S·O_pad + v·S·(O−O_pad). Conta na stake ELEGÍVEL S = min(valor, teto).
- LUCRO EXTRA: O_ef = 1 + (O−1)(1+v·b) e aí é surebet comum; extra efetivo mínimo = S·(C/(C−1) − O). Só paga se b·v > m: b=30%/m=6% → pico em odd ~2,02 (8,1% da stake) e odd 5,00 dá −5,8%. Extra em bônus cai no GREEN.
- "Aposte e ganhe": bônus independe do resultado; o que importa é opt-in, odd mínima por seleção, odd total, competição elegível e prazo de creditação (24h após o FIM da promoção).
- Múltipla qualificadora: pernas equilibradas em T^(1/n); cobertura SEQUENCIAL x_k = (S + Σx anteriores − perda aceita)/(h_k − 1), só cobrindo a perna k após green na k−1; exige resoluções em horários diferentes (ou escalonar 1º/2º tempo). O caminho ALL-GREEN NÃO é coberto e pode dar prejuízo grande — sempre informe o lucro/prejuízo se tudo bater e o caixa de pico.
- Nunca aposte o oposto exato na mesma casa (abuso de bônus/limitação); arredonde stakes.
- Surebet: 1/oddA + 1/oddB < 1; riscos = velocidade da odd, limitação, erro palpável, void divergente, limite de aposta.`;
