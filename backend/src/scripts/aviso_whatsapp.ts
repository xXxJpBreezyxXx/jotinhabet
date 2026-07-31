/**
 * Envia UM aviso de texto livre para o destino configurado no WhatsApp (Evolution).
 *
 * Existe porque a Evolution só responde DENTRO da rede do Swarm
 * (EVOLUTION_API_URL = evolution_go_evolution_go:4000): não há como avisar de fora da
 * VPS. Rodando dentro do container, o env_file já traz as credenciais.
 *
 * Uso na VPS (imagem já buildada):
 *   docker exec $(docker ps -qf name=jotinhabet_backend) node dist/scripts/aviso_whatsapp.js
 *   docker exec $(docker ps -qf name=jotinhabet_backend) node dist/scripts/aviso_whatsapp.js "sua mensagem"
 *
 * Em dev (dentro da rede da Evolution):
 *   npx ts-node --transpile-only src/scripts/aviso_whatsapp.ts "sua mensagem"
 *
 * Sem argumento, manda o resumo da entrega do AGENTE DE IA (lote de 30/07/2026).
 */

import dotenv from 'dotenv';
dotenv.config();

import { WhatsAppNotifier } from '../notify/whatsapp';

const AVISO_AGENTE_IA = `🤖 *Agente de IA — etapa concluída* (30/07)

A aba *IA & Automação* deixou de ser um chat e virou um AGENTE com *20 skills* e acesso real ao app:

🏠 *Odds/scraper (22 casas integradas)*
• odds ao vivo de um evento em qualquer casa
• comparar o MESMO jogo em várias casas: melhor odd de cada lado, ROI se fecha surebet ou quanto falta
• revalidar uma oportunidade do radar ao vivo

📊 *Radar/banca*: surebets com filtro, value bets, middles, cashout, banca ativa, saldos por casa, histórico de entradas e de promoções
⚖️ *Regras*: Diretrizes, grupos de W.O. do tênis, política de void por casa
🧮 *Calculadoras*: surebet, freebet SNR × qualificativa (com cashback), odd ótima da freebet e múltipla qualificadora com cobertura sequencial
📚 *Conhecimento*: toda a sua conversa com o Gemini (blank.pdf) + doutrina destilada — o agente cita a fonte

Cada resposta mostra *quais skills foram usadas* (com tempo e resultado), pra você auditar de onde veio cada número.

🔑 *Groq entrou na cadeia de IA* com a sua chave e está em 1º lugar (OpenAI e Gemini seguem com crédito zerado). Isso destravou o copiloto, a análise de risco e o digest. Provedor sem crédito agora entra em cooldown e é pulado em vez de travar tudo.

⚠️ *Achado que muda a operação*: odd alta de freebet NÃO retém mais. A retenção tem PICO em √(1+1/m) — com margem de 6% o ótimo é ~4,20. A odd 7.75 daquele caso rendeu 38% (R$ 3,82 de R$ 10), não os 75-85% projetados. A faixa "4.00–5.00 com cobertura 1,22–1,28" está certa, e o agente já calcula isso sozinho.

✅ 332 testes passando, backend e frontend compilando.`;

async function main() {
  const texto = process.argv.slice(2).join(' ').trim() || AVISO_AGENTE_IA;
  const ok = await new WhatsAppNotifier().enviarTexto(texto);
  if (!ok) {
    console.error('❌ Aviso NÃO enviado. Confira EVOLUTION_API_URL/KEY/INSTANCE/RECIPIENT e se a instância está conectada.');
    process.exit(1);
  }
  console.log('✅ Aviso enviado no WhatsApp.');
}

main().catch((e) => {
  console.error('❌ Erro ao enviar aviso:', e?.message || e);
  process.exit(1);
});
