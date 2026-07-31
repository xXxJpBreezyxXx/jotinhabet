/**
 * Busca por palavra-chave na base de conhecimento do Agente.
 *
 * Duas fontes, com pesos diferentes de propósito:
 *  1. DOUTRINA (conhecimento/doutrinaPromocoes.ts) — as regras destiladas. Vem
 *     primeiro porque é o que o agente deve SEGUIR.
 *  2. CORPUS (conhecimento/corpusPromocoes.ts) — a conversa original com o Gemini,
 *     para quando o usuário perguntar "o que combinamos" / pedir os números daquele
 *     dia (odd 7.75, freebet da Joga Junto, múltiplas da Pagol.bet, etc.).
 *
 * Sem embeddings de propósito: a base tem ~40 documentos curtos e o vocabulário do
 * domínio é fixo ("freebet", "retenção", "sequencial"). BM25-ish com normalização de
 * acento resolve, roda em microssegundos e não depende de crédito de IA — que foi
 * exatamente o que faltou em 29/07.
 */

import { DOUTRINA_PROMOCOES, RESUMO_DOUTRINA_PROMOCOES, SecaoDoutrina } from './doutrinaPromocoes';
import { CONVERSA_GEMINI_PROMOCOES, CONVERSA_GEMINI_DATA } from './corpusPromocoes';

export { DOUTRINA_PROMOCOES, RESUMO_DOUTRINA_PROMOCOES, CONVERSA_GEMINI_PROMOCOES, CONVERSA_GEMINI_DATA };
export type { SecaoDoutrina };

export interface ResultadoConhecimento {
  fonte: 'doutrina' | 'conversa_gemini';
  id: string;
  titulo: string;
  texto: string;
  score: number;
}

const semAcento = (s: string): string =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const PARAR = new Set([
  'a','o','as','os','de','da','do','das','dos','e','em','no','na','nos','nas','um','uma','para','por','com','que',
  'qual','quais','como','quanto','quanta','se','ao','aos','the','of','é','eh','sobre','meu','minha','esse','essa',
  'isso','ele','ela','eu','voce','você','vou','vamos','tem','ter','faz','fazer','mais','menos','ja','já','pra',
]);

function tokens(s: string): string[] {
  return semAcento(s)
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !PARAR.has(t));
}

function contar(alvo: string, termo: string): number {
  if (!termo) return 0;
  let n = 0;
  let i = alvo.indexOf(termo);
  while (i !== -1) {
    n++;
    i = alvo.indexOf(termo, i + termo.length);
  }
  return n;
}

interface DocIndexado {
  fonte: ResultadoConhecimento['fonte'];
  id: string;
  titulo: string;
  texto: string;
  tituloNorm: string;
  tagsNorm: string;
  textoNorm: string;
}

let indice: DocIndexado[] | null = null;

function construirIndice(): DocIndexado[] {
  if (indice) return indice;
  const docs: DocIndexado[] = [];

  for (const s of DOUTRINA_PROMOCOES) {
    docs.push({
      fonte: 'doutrina',
      id: s.id,
      titulo: s.titulo,
      texto: s.texto,
      tituloNorm: semAcento(s.titulo),
      tagsNorm: semAcento(s.tags.join(' ')),
      textoNorm: semAcento(s.texto),
    });
  }

  for (const t of CONVERSA_GEMINI_PROMOCOES) {
    const titulo = `Conversa Gemini #${t.n} — "${t.pergunta.replace(/\s+/g, ' ').slice(0, 90)}"`;
    const texto = `PERGUNTA DO USUÁRIO: ${t.pergunta}\n\nRESPOSTA (Gemini, ${CONVERSA_GEMINI_DATA}): ${t.resposta}`;
    docs.push({
      fonte: 'conversa_gemini',
      id: `conversa-${t.n}`,
      titulo,
      texto,
      tituloNorm: semAcento(titulo),
      tagsNorm: '',
      textoNorm: semAcento(texto),
    });
  }

  indice = docs;
  return docs;
}

/**
 * Top-N trechos relevantes. `consulta` vazia devolve a doutrina inteira (é o que o
 * agente pede quando o usuário fala "me explique tudo de freebet").
 */
export function buscarConhecimento(consulta: string, limite = 4): ResultadoConhecimento[] {
  const docs = construirIndice();
  const termos = tokens(consulta);

  if (!termos.length) {
    return docs
      .filter((d) => d.fonte === 'doutrina')
      .slice(0, limite)
      .map((d) => ({ fonte: d.fonte, id: d.id, titulo: d.titulo, texto: d.texto, score: 1 }));
  }

  const pontuados = docs.map((d) => {
    let score = 0;
    for (const t of termos) {
      // Título e tags valem mais: quem escreveu a doutrina escolheu essas palavras.
      score += contar(d.tituloNorm, t) * 6;
      score += contar(d.tagsNorm, t) * 4;
      const noTexto = contar(d.textoNorm, t);
      // Saturação log: um doc que repete o termo 20x não vale 20 vezes mais.
      score += noTexto > 0 ? 1 + Math.log2(noTexto) : 0;
    }
    // Doutrina tem preferência sobre a conversa bruta em caso de empate.
    if (d.fonte === 'doutrina') score *= 1.15;
    return { d, score };
  });

  return pontuados
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(8, limite)))
    .map((p) => ({
      fonte: p.d.fonte,
      id: p.d.id,
      titulo: p.d.titulo,
      texto: p.d.texto,
      score: Math.round(p.score * 100) / 100,
    }));
}

/** Um trecho específico por id (ex.: "cobertura-sequencial", "conversa-14"). */
export function obterConhecimento(id: string): ResultadoConhecimento | null {
  const d = construirIndice().find((x) => x.id === (id || '').trim().toLowerCase());
  return d ? { fonte: d.fonte, id: d.id, titulo: d.titulo, texto: d.texto, score: 1 } : null;
}

/** Índice legível (id + título) para o agente saber o que existe sem carregar tudo. */
export function listarConhecimento(): Array<{ fonte: string; id: string; titulo: string }> {
  return construirIndice().map((d) => ({ fonte: d.fonte, id: d.id, titulo: d.titulo }));
}
