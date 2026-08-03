/**
 * LEITURA DE IMAGEM PARA A CONVERSA — o que o usuário manda no chat/WhatsApp.
 *
 * Diferente do `telegramSignalExtractor`, que espera UM template específico (o print da
 * calculadora do grupo) e devolve schema fechado, aqui a imagem é qualquer uma: print de
 * regulamento de promoção, cupom/bilhete, tela de odds da casa, comprovante, print da
 * calculadora. A saída é TEXTO — que entra na conversa como se o usuário tivesse digitado
 * o que está na imagem, e o agente então usa as skills normais (cobertura de promoção,
 * montar múltipla, comparar odds…).
 *
 * Por que texto e não JSON: o agente já sabe agir a partir de texto e tem 23 skills; um
 * schema fechado aqui obrigaria a prever de antemão TODO tipo de print que ele manda.
 */

import { chromium } from 'playwright';
import { generateFromImageWithFallback } from '../aiProvider';

/** Acima disto a imagem é reduzida antes de ir para a visão (ver reduzirImagem). */
const TETO_KB = Number(process.env.VISAO_IMAGEM_MAX_KB) > 0 ? Number(process.env.VISAO_IMAGEM_MAX_KB) : 900;

/**
 * Reduz a imagem para caber no teto, mantendo a legibilidade do texto.
 *
 * Print de celular passa fácil de 2 MB e o free tier da OpenRouter devolve 500 nesses
 * casos (medido em 31/07). Usa o Chromium que JÁ está instalado para os scrapers em vez de
 * trazer sharp/jimp: nesta VPS, dependência binária nova é build de vários minutos e risco
 * de OOM. O redimensionamento é feito no canvas da página, mantendo proporção e uma largura
 * mínima de 1.100px — abaixo disso o OCR começa a perder odd de 3 dígitos.
 */
async function reduzirImagem(base64: string, mimeType: string): Promise<{ base64: string; mimeType: string }> {
  const kb = Math.round((base64.length * 3) / 4 / 1024);
  if (kb <= TETO_KB) return { base64, mimeType };
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const menor = await page.evaluate(
      async ([dataUrl, tetoKb]) => {
        const img = new Image();
        await new Promise((ok, erro) => {
          img.onload = ok;
          img.onerror = erro;
          img.src = dataUrl as string;
        });
        const LARGURA_MIN = 1100;
        let escala = Math.min(1, Math.sqrt((Number(tetoKb) * 1024) / ((dataUrl as string).length * 0.75)));
        if (img.width * escala < LARGURA_MIN) escala = Math.min(1, LARGURA_MIN / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * escala));
        canvas.height = Math.max(1, Math.round(img.height * escala));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // JPEG 0.82: menor que o PNG do print e sem artefato visível em texto de UI.
        return canvas.toDataURL('image/jpeg', 0.82);
      },
      [`data:${mimeType};base64,${base64}`, TETO_KB] as [string, number]
    );
    if (!menor || typeof menor !== 'string') return { base64, mimeType };
    const novo = menor.replace(/^data:[^;]+;base64,/, '');
    console.log(`🗜️ [visão] imagem reduzida de ~${kb} KB para ~${Math.round((novo.length * 3) / 4 / 1024)} KB`);
    return { base64: novo, mimeType: 'image/jpeg' };
  } catch (err: any) {
    // Falha na redução não é motivo para não tentar ler: segue com a original.
    console.warn(`⚠️ [visão] não consegui reduzir a imagem (${`${err?.message || err}`.slice(0, 90)}) — enviando original.`);
    return { base64, mimeType };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

const SYSTEM = `Você lê imagens do universo de apostas esportivas para um assistente de arbitragem e promoções.
Responda em PORTUGUÊS, só com o que está VISÍVEL na imagem. Não interprete, não recomende, não invente.
Se um valor estiver ilegível, escreva "ilegível" naquele campo — nunca chute número.`;

const PROMPT = `Descreva o conteúdo desta imagem de forma ESTRUTURADA e curta, no formato abaixo, pulando o que não se aplicar:

TIPO: (regulamento/oferta de promoção | print de calculadora de surebet | bilhete/cupom | tela de odds de uma casa | comprovante | outro)
CASA: nome da casa de apostas, se aparecer
EVENTO(S): time A x time B (+ data/hora se visível)
MERCADO/SELEÇÃO: mercado e a seleção marcada, com a LINHA quando houver (ex.: "Total de Gols 2.5 — Mais de 2.5")
ODDS: cada odd visível, com o lado a que pertence
VALORES: stake, aporte, retorno, bônus, freebet — com a moeda
REGULAMENTO (se for promoção): valor do bônus, odd mínima por seleção, odd total mínima, número mínimo de seleções, mercados/esportes elegíveis, prazo/validade, se a ficha volta (freebet SNR) ou não, rollover
OUTROS: qualquer texto relevante (aviso, restrição, código de promoção)

Se a imagem não tiver nada de apostas, responda só: "TIPO: outro" e uma linha dizendo o que é.

ARMADILHA (já erramos nisso): em print de CALCULADORA DE SUREBET, as faixas cinza escuras com texto centralizado — "Chance", "Aposta", "Com comissão", "Lucro", "Taxas de câmbio" — são CABEÇALHOS DE SEÇÃO, nunca nome de casa. O nome da casa é o texto em NEGRITO no topo de cada coluna, quase sempre com sufixo "(BR)" (ex.: "Stake (BR)", "Novibet (BR)"). Se não conseguir ler o nome da casa, escreva "casa ilegível" — não use o cabeçalho no lugar dela.`;

export interface LeituraImagem {
  texto: string;
  provider: string;
}

/**
 * Lê a imagem e devolve a descrição estruturada.
 * @param contexto legenda que o usuário mandou junto (entra como pedido explícito).
 * @throws quando nenhum provedor de visão responde — o chamador decide o que dizer.
 */
export async function lerImagemDaConversa(
  imagemBase64: string,
  mimeType: string,
  contexto?: string
): Promise<LeituraImagem> {
  const prompt = contexto?.trim()
    ? `${PROMPT}\n\nO usuário escreveu junto com a imagem: "${contexto.trim()}" — se isso apontar para algo específico da imagem, priorize esse trecho na descrição.`
    : PROMPT;
  const menor = await reduzirImagem(imagemBase64, mimeType);
  const { text, provider } = await generateFromImageWithFallback(
    prompt,
    { mimeType: menor.mimeType, dataBase64: menor.base64 },
    SYSTEM
  );
  // Mock (nenhuma chave configurada) não é leitura: quem chamou precisa saber.
  if (text.startsWith('[Mock')) throw new Error('nenhum provedor de visão configurado');
  return { texto: text.trim(), provider };
}

/**
 * Monta a mensagem que vai para o agente no lugar da imagem.
 * Deixa explícito que o conteúdo veio de OCR/visão — o agente precisa saber que pode ter
 * erro de leitura antes de recomendar dinheiro em cima disso.
 */
export function mensagemComImagem(leitura: string, legenda?: string): string {
  const pedido = legenda?.trim() ? `${legenda.trim()}\n\n` : '';
  return (
    `${pedido}[IMAGEM ENVIADA — leitura automática por visão computacional, pode ter erro de OCR; ` +
    `confirme com o usuário qualquer número decisivo antes de recomendar aporte]\n${leitura}`
  );
}
