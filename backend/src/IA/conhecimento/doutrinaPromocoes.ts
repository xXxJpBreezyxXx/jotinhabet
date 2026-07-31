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
    titulo: 'Os dois tipos de perna promocional (e por que confundir zera o lucro)',
    tags: ['freebet', 'snr', 'qualificativa', 'tipo', 'aposta extra', 'bônus'],
    texto: `Toda operação de promoção tem uma PERNA PROMOCIONAL e uma PERNA DE COBERTURA (mercado oposto, em outra casa). O tipo da perna promocional muda TODA a matemática:

- FREEBET SNR (Stake Not Returned) — "aposta grátis", "aposta extra", "bônus de R$ X". A ficha NÃO volta no ganho: se bater, você recebe só o lucro, stake·(odd−1). Custo real da perna = R$ 0,00. É por isso que subtrair o valor da freebet do investimento é erro grosseiro: o ROI aparece negativo sem existir prejuízo.
- QUALIFICATIVA (dinheiro real) — você aposta o seu dinheiro para cumprir o requisito de uma promoção ("aposte R$ 50 e ganhe R$ 50 em freebet"). Custo real = stake. Se bater, recebe stake·odd.

Sempre pergunte/confirme o tipo antes de calcular. Se o usuário disser "aposta extra", "prêmio", "bônus" ou "freebet", trate como FREEBET SNR; se disser "aposta qualificadora", "aposta de qualificação", "com meu dinheiro", trate como QUALIFICATIVA.`,
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
    tags: ['retenção', 'odd ideal', 'freebet', 'otimizar', 'margem', 'extração'],
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
- Freebet SNR: custo real 0; aporte da cobertura c = F·(O−1)/C; lucro L = c·(C−1); métrica = retenção L/F. NUNCA subtraia a freebet do investimento.
- Qualificativa: c = S·O/C; a perda é o pedágio do bônus; escolha o par de casas com 1/O + 1/C mais perto de 1.
- Retenção da freebet tem PICO: R(O) = (O−1)(1−m(O−1))/O, ótimo em O* = √(1+1/m) (m≈6% → O*≈4,2 com retenção ~62%). Odd esticada com cobertura em 1.06 rende ~40%, não 80%.
- Qualificativa: a perda é S·O·(soma−1) — para a MESMA soma, quanto MENOR a odd da qualificadora, menor a perda em reais. Não escolha o par só pela soma.
- Cashback CONDICIONAL (só se perder) entra na equalização: c = (retorno bruto − cashback)/C. Cashback que cai nos dois cenários NÃO muda o aporte, só soma no lucro.
- "Aposte e ganhe": bônus independe do resultado; o que importa é opt-in, odd mínima por seleção, odd total, competição elegível e prazo de creditação (24h após o FIM da promoção).
- Múltipla qualificadora: pernas equilibradas em T^(1/n); cobertura SEQUENCIAL x_k = (S + Σx anteriores − perda aceita)/(h_k − 1), só cobrindo a perna k após green na k−1; exige resoluções em horários diferentes (ou escalonar 1º/2º tempo). O caminho ALL-GREEN NÃO é coberto e pode dar prejuízo grande — sempre informe o lucro/prejuízo se tudo bater e o caixa de pico.
- Nunca aposte o oposto exato na mesma casa (abuso de bônus/limitação); arredonde stakes.
- Surebet: 1/oddA + 1/oddB < 1; riscos = velocidade da odd, limitação, erro palpável, void divergente, limite de aposta.`;
