/**
 * MARKDOWN (como o agente escreve) → formatação do WhatsApp.
 *
 * O agente responde em markdown (negrito com `**`, títulos com `#`, listas, tabelas
 * GFM). No WhatsApp isso aparece CRU: `**Flamengo**` mostra os asteriscos, `## Resumo`
 * mostra as cerquilhas e uma tabela vira uma parede de pipes. O WhatsApp entende outro
 * dialeto, bem menor:
 *
 *   *negrito*   _itálico_   ~riscado~   ```bloco monoespaçado```   > citação
 *
 * e NÃO entende: título, tabela, link `[texto](url)`, código inline com um backtick.
 *
 * A conversão é ORDEM-DEPENDENTE: `**x**` (negrito md) e `*x*` (itálico md) disputam o
 * mesmo caractere, então o negrito é protegido por marcador antes de o itálico ser
 * convertido — sem isso `**Flamengo**` viraria `_Flamengo_` (itálico) em vez de
 * `*Flamengo*` (negrito).
 */

/** Marcador interno (caractere de controle: não aparece em texto de LLM nem no WhatsApp). */
const MARCA = String.fromCharCode(1);

/**
 * Remove caracteres de CONTROLE (mantendo tabulação e quebra de linha).
 *
 * O marcador interno desta conversão é um caractere de controle: se o texto do modelo
 * trouxer um, a restauração do passo 11 casaria um índice inexistente e a tela mostraria
 * "*undefined*". Escrito por código (e não por classe de regex) para o byte ficar
 * explícito no fonte.
 */
function semControle(txt: string): string {
  let out = '';
  for (const c of txt) {
    const n = c.codePointAt(0) as number;
    if (n < 9 || (n > 10 && n < 32)) continue;
    out += c;
  }
  return out;
}

/** Remove a ênfase de markdown de um trecho (usado no título, que já vai em negrito). */
function semEnfase(txt: string): string {
  return txt
    .replace(/\*\*([^\n*]+?)\*\*/g, '$1')
    .replace(/__([^\n_]+?)__/g, '$1')
    .replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s.,;:!?)])/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1');
}

/** Tabela GFM → bloco monoespaçado com colunas alinhadas (o WhatsApp não tem tabela). */
function tabelaParaMono(linhas: string[]): string {
  const celulas = linhas.map((l) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      // Só o pipe NÃO escapado separa coluna: "KTO \| BR" é uma célula, não duas — com o
      // split cru a odd escorregava para debaixo do cabeçalho errado.
      .split(/(?<!\\)\|/)
      // O bloco todo é monoespaçado, então ênfase dentro da célula só deixaria os
      // asteriscos crus na tela.
      .map((c) => semEnfase(c.replace(/\\\|/g, '|').trim()))
  );
  // Descarta a linha separadora (|---|:--:|) — é sintaxe, não dado.
  const corpo = celulas.filter((cs) => !cs.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
  if (!corpo.length) return linhas.join('\n');

  const nCols = Math.max(...corpo.map((cs) => cs.length));
  const larguras: number[] = [];
  for (let c = 0; c < nCols; c++) {
    // Teto de 24: coluna larga quebra a linha no celular e destrói o alinhamento.
    larguras[c] = Math.min(24, Math.max(...corpo.map((cs) => (cs[c] || '').length)));
  }
  // Devolve só o CORPO alinhado: a cerca é responsabilidade de quem registra o bloco.
  return corpo
    .map((cs) =>
      Array.from({ length: nCols }, (_, c) => (cs[c] || '').padEnd(larguras[c]))
        .join(' | ')
        .trimEnd()
    )
    .join('\n');
}

/**
 * Agrupa linhas de tabela GFM contíguas e converte cada bloco.
 *
 * `registrar` recebe o corpo já alinhado e devolve o MARCADOR do bloco: a tabela entra na
 * lista de blocos protegidos direto, sem passar por uma cerca de texto que depois teria de
 * ser re-encontrada por regex. Antes era assim, e uma cerca ÓRFÃ na resposta (o modelo abre
 * ``` e esquece de fechar antes de uma tabela) casava com a cerca de ABERTURA da tabela —
 * o corpo dela saía FORA do monoespaçado e um backtick solto chegava ao usuário.
 */
function converterTabelas(texto: string, registrar: (corpo: string) => string): string {
  const saida: string[] = [];
  let buffer: string[] = [];
  const despejar = () => {
    if (!buffer.length) return;
    // Tabela de verdade tem cabeçalho + separador (>= 2 linhas). Uma linha isolada com
    // pipes é texto normal e sai como veio.
    saida.push(buffer.length >= 2 ? registrar(tabelaParaMono(buffer)) : buffer.join('\n'));
    buffer = [];
  };
  for (const l of texto.split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(l)) buffer.push(l);
    else {
      despejar();
      saida.push(l);
    }
  }
  despejar();
  return saida.join('\n');
}

/**
 * Converte texto em markdown para o dialeto do WhatsApp.
 *
 * O contrato de ENTRADA é markdown (é o que o agente escreve): `*x*` de uma estrela é
 * itálico e sai como `_x_`. Quem já produz no dialeto do WhatsApp não deve passar por
 * aqui.
 */
export function markdownParaWhatsApp(md: string): string {
  if (!md) return '';
  // Controle sai NA ENTRADA (ver semControle): o marcador interno é um deles.
  let t = semControle(md).replace(/\r\n?/g, '\n');

  // 1) Blocos de código saem de cena ANTES de tudo (o conteúdo é literal: um `**` dentro
  //    de um bloco não é negrito). O marcador NÃO usa espaços em volta: ` B0 ` mudaria a
  //    pontuação ao voltar (`**Flamengo**:` viraria `*Flamengo* :`).
  const blocos: string[] = [];
  const marcarBloco = (corpo: string) => {
    blocos.push(`\`\`\`\n${corpo.replace(/\n+$/, '')}\n\`\`\``);
    return `${MARCA}C${blocos.length - 1}${MARCA}`;
  };
  // A cerca só vale no INÍCIO DA LINHA (é o que o markdown define). Sem o `^`, um texto
  // com duas cercas na MESMA linha ("veja ```a``` e ```b```") era casado como um bloco só e
  // o conteúdo entre elas desaparecia da resposta.
  t = t.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_m, corpo) => marcarBloco(String(corpo)));

  // 2) Tabelas GFM → bloco monoespaçado, registrado DIRETO como bloco protegido.
  t = converterTabelas(t, marcarBloco);

  // 3) Títulos → negrito. Vai como marcador PROTEGIDO (e não como `*titulo*` direto):
  //    solto, ele seria devorado pela regra de itálico do passo 6 e o título viraria
  //    _itálico_ em vez de *negrito*.
  const negritos: string[] = [];
  const marcarNegrito = (txt: string) => {
    negritos.push(txt);
    return `${MARCA}B${negritos.length - 1}${MARCA}`;
  };
  //    A ênfase DENTRO do título é removida (o título já vai todo em negrito): sem isso
  //    `### Sub *item*` viraria `*Sub *item**`, com asteriscos aninhados que o WhatsApp
  //    renderiza torto.
  t = t.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, titulo) =>
    marcarNegrito(semEnfase(String(titulo).trim()))
  );

  // 4) Links e imagens: o WhatsApp já transforma URL crua em link.
  t = t.replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, txt, url) =>
    String(txt).trim() === String(url).trim() ? String(url) : `${String(txt).trim()}: ${url}`
  );

  // 5) Negrito protegido ANTES do itálico.
  t = t.replace(/\*\*([^\n*]+?)\*\*|__([^\n_]+?)__/g, (_m, a, b) => marcarNegrito(String(a ?? b)));

  // 6) Itálico do markdown (`*x*`) → `_x_` do WhatsApp (`_x_` já está certo).
  t = t.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s.,;:!?)])/g, (_m, pre, txt) => `${pre}_${txt}_`);

  // 7) Riscado: `~~x~~` → `~x~`.
  t = t.replace(/~~([^\n~]+?)~~/g, '~$1~');

  // 8) Sobra de cerca (```) fora de bloco: o modelo às vezes escreve ```assim``` no meio da
  //    frase. Vira um backtick só, para o passo seguinte tratar como código inline em vez
  //    de deixar cerca ímpar (que faz o WhatsApp perder a formatação do resto).
  t = t.replace(/`{2,}/g, '`');

  //    Código inline: um backtick não formata nada no WhatsApp — sobra só o texto.
  t = t.replace(/`([^`\n]+)`/g, '$1');

  // 9) Listas: marcador do markdown → bullet, preservando o nível de indentação.
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, (_m, ident) => {
    const nivel = Math.floor(String(ident).replace(/\t/g, '  ').length / 2);
    return `${'  '.repeat(nivel)}${nivel > 0 ? '◦' : '•'} `;
  });

  // 10) Régua horizontal (--- / *** / ___).
  t = t.replace(/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '──────────');

  // 11) Restaura negritos e blocos.
  t = t.replace(new RegExp(`${MARCA}B(\\d+)${MARCA}`, 'g'), (_m, i) => `*${negritos[Number(i)]}*`);
  t = t.replace(new RegExp(`${MARCA}C(\\d+)${MARCA}`, 'g'), (_m, i) => blocos[Number(i)]);

  // 12) Higiene: no máximo uma linha em branco entre parágrafos.
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fatia a mensagem em pedaços legíveis no celular, cortando em fronteira de parágrafo
 * (ou de linha/espaço) para não partir formatação no meio. O teto do WhatsApp é ~65k
 * caracteres; o corte em ~3.500 é de LEGIBILIDADE, não de protocolo.
 */
export function dividirMensagem(texto: string, max = 3500): string[] {
  const t = (texto || '').trim();
  if (!t) return [];
  if (t.length <= max) return [t];

  const partes: string[] = [];
  let resto = t;
  while (resto.length > max) {
    const janela = resto.slice(0, max);
    // Preferência de corte: parágrafo > linha > espaço > corte seco.
    let corte = janela.lastIndexOf('\n\n');
    if (corte < max * 0.5) corte = janela.lastIndexOf('\n');
    if (corte < max * 0.5) corte = janela.lastIndexOf(' ');
    if (corte < max * 0.5) corte = max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);

  // Cerca de código não pode ficar ABERTA numa parte: o corte cai no meio de um bloco
  // monoespaçado (uma tabela longa, por exemplo) e o WhatsApp renderiza o resto da
  // mensagem como texto solto, quebrando o alinhamento. Fecha aqui e reabre na próxima.
  let abertaAnterior = false;
  const fechadas = partes.map((parte) => {
    let p = abertaAnterior ? `\`\`\`\n${parte}` : parte;
    const cercas = (p.match(/```/g) || []).length;
    abertaAnterior = cercas % 2 === 1;
    if (abertaAnterior) p = `${p}\n\`\`\``;
    return p;
  });

  // Numera: sem isso, no celular as partes parecem mensagens desconexas.
  const total = fechadas.length;
  return fechadas.map((p, i) => (total > 1 ? `${p}\n\n_(${i + 1}/${total})_` : p));
}
