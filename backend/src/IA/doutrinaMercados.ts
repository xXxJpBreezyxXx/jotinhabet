/**
 * Resumo CURADO do documento "Diretrizes" (raiz do repo) para injeção nos
 * prompts do RiskAnalyzer — a IA passa a julgar com a doutrina da operação,
 * não com conhecimento genérico de apostas.
 *
 * Módulo .ts de propósito (mesmo motivo de regrasCasas.ts): o tsc não copia
 * assets para dist/, então ler o arquivo "Diretrizes" em runtime quebraria em
 * produção. Ao ATUALIZAR o documento Diretrizes, refletir aqui.
 *
 * IMPORTANTE: os gates DETERMINÍSTICOS (arbitrage/regras.ts) continuam sendo
 * a autoridade que BLOQUEIA oportunidade; este texto só calibra o veredito
 * consultivo da IA (badge de risco).
 */
export const DOUTRINA_MERCADOS = `DIRETRIZES DA OPERAÇÃO (matriz de risco do projeto — use como critério principal):

FUTEBOL ⚽ — PROIBIDOS (3 vias / risco de empate sem reembolso): Resultado Final (1X2), Handicap Europeu, Vencedor do 1º/2º Tempo, Primeiro Time a Marcar, Resultado Exato. LIBERADOS (2 vias): Empate Anula (DNB), Handicap Asiático, Totais (gols, escanteios, cartões, chutes — Mais/Menos), Ambas Marcam (BTTS).

BASQUETE 🏀 — PROIBIDOS (risco de prorrogação): Vencedor do Tempo Regulamentar (exclui OT), Vencedor por Quarto/Tempo específico, Margem de Vitória Exata. LIBERADOS: Moneyline incluindo prorrogação, Handicap/Spread incluindo prorrogação, Total de Pontos incluindo prorrogação.

TÊNIS 🎾 — mercados binários; o risco NÃO é o mercado, é a política de W.O./abandono das casas: casas do Grupo A (anulam a aposta em abandono) só podem cruzar com Grupo A; casas do Grupo B (quem avançou = venceu) só com Grupo B. Cruzamento A×B deixa uma perna descoberta em abandono. KTO tem regra própria: bloqueada em Handicap e Totais de tênis.

GERAL — Lucro garantido acima de ~25% é forte indício de erro de cotação (palpable error — risco de anulação unilateral pós-jogo). Linhas asiáticas quarter (.25/.75): o lucro nominal é o PISO (cenário do meio devolve metade de cada perna). Sinais externos (grupo do Telegram) chegam atrasados: odds do print podem já ter mudado.`;
