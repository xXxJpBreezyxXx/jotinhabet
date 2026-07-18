import { fetchTextoComRetry } from '../utils/http';
import { generateWithFallback } from '../IA/aiProvider';
import { extrairJsonDeLLM } from '../IA/jsonUtils';
import { normalizarDataHora } from '../IA/extractors/telegramSignalExtractor';

/**
 * Resolução de data/horário da partida para sinais do Telegram.
 *
 * Cascata (do mais barato/confiável pro mais caro):
 *  1. dataHora extraída dos prints de casa (feita no extrator/ingest);
 *  2. feed de uma casa com scraper (RevalidationService.dataHoraDoEvento);
 *  3. ESTE módulo: abrir o LINK direto colhido do grupo e ler a data da página
 *     — fetch simples primeiro; se a página for SPA (texto raso), Playwright.
 */

const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** ISO-8601 → "DD/MM/AAAA HH:MM" no fuso de Brasília; null se não parseável. */
export function isoParaBrasilia(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

/** Reduz HTML a texto corrido legível (remove script/style/tags/espaço). */
export function htmlParaTexto(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Texto da página via Playwright (SPA que não rende nada no HTML cru). */
async function textoViaPlaywright(url: string): Promise<string> {
  // Import dinâmico: o Playwright é pesado e este caminho é raro — não paga o
  // custo no boot nem nos testes unitários.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ userAgent: UA_BROWSER });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(3_000); // SPA: espera o conteúdo hidratar
    return (await page.innerText('body').catch(() => '')) || '';
  } finally {
    await browser.close().catch(() => { /* segue */ });
  }
}

/**
 * Abre o link do grupo e extrai a data/horário da partida via LLM sobre o
 * texto da página. Retorna "DD/MM/AAAA HH:MM" (Brasília) ou null. Nunca lança.
 */
export async function dataHoraViaLink(url: string, evento: string): Promise<string | null> {
  let texto = '';
  try {
    const resp = await fetchTextoComRetry(url, { headers: { 'User-Agent': UA_BROWSER } }, 2, 'Telegram/link', 12_000);
    if (resp.status >= 200 && resp.status < 400) texto = htmlParaTexto(resp.body);
  } catch { /* tenta Playwright */ }

  if (texto.length < 400) {
    try {
      texto = (await textoViaPlaywright(url)).replace(/\s+/g, ' ').trim();
    } catch (e: any) {
      console.warn(`⚠️ [Telegram] Playwright falhou no link ${url}: ${e?.message || e}`);
    }
  }
  if (texto.length < 100) return null;

  try {
    const { text } = await generateWithFallback(
      `Texto de uma página de casa de apostas sobre a partida "${evento}":\n\n${texto.slice(0, 12_000)}\n\n` +
      `Qual a DATA e o HORÁRIO de início dessa partida (horário de Brasília, como exibido na página)? ` +
      `Responda ESTRITAMENTE JSON: {"dataHora": "DD/MM/AAAA HH:MM"} ou {"dataHora": null} se não estiver na página. Não invente.`,
      'Você extrai dados de páginas de apostas. Responda apenas o JSON pedido.'
    );
    if (text.startsWith('[Mock')) return null;
    const obj = extrairJsonDeLLM(text);
    return normalizarDataHora(obj?.dataHora);
  } catch {
    return null;
  }
}
