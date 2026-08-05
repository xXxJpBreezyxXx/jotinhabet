import './utils/logger';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './db/client';
import { GeminiProvider } from './IA/Provedores/Gemini';
import { OpenAIProvider } from './IA/Provedores/OpenAI';
import { calcularArbitragem } from './core/calculator';
import { projetarEvolucaoDiaria } from './core/evolution';
import { SchedulerService } from './scheduler/scheduler';
import { EnrichmentService } from './scheduler/enrichmentService';
import { GreenMonitorService } from './scheduler/greenMonitorService';
import { BrowserScrapeWorker } from './scheduler/browserScrapeWorker';
import { DigestNoturnoService } from './scheduler/digestNoturno';
import { RevalidationService } from './core/revalidationService';
import { getValorAtivas, deleteValor, getMiddlesAtivos, deleteMiddle } from './core/valorRepo';
import { getResumoCalibracao, getAlertasRecentes } from './core/calibracaoRepo';
import { requireApiToken } from './auth/apiToken';
import { seletorTuneis } from './utils/tunelResidencial';
import { generateWithFallback, statusProvedores, cadeiaTexto } from './IA/aiProvider';
import { rodarAgente, pediuEscritaExplicita } from './IA/agent/agentLoop';
import { WhatsAppAgentBridge, tokenWebhookValido, chatsPermitidos } from './IA/agent/whatsappBridge';
import { skillsParaUI } from './IA/agent/registry';
import { catalogoCasas, casasSemIntegracao } from './IA/agent/catalogoCasas';
import { cadeiaAgente, criarMotor } from './IA/agent/chatModels';
import {
  calcularPromocao, VALOR_BONUS_PADRAO_PCT, PROMO_TYPES_BANCO, TIPOS_PROMOCAO,
  ehFreebetSemCusto, ehTipoComBoost, tipoDoPromoType, promoTypeDoTipo,
  type TipoPromocao, type ResultadoPromocao,
} from './core/promocoes';
import { WhatsAppNotifier } from './notify/whatsapp';
import { avisarDeployWhatsApp } from './notify/deployNotice';
import { extrairSinalDeImagem } from './IA/extractors/telegramSignalExtractor';
import { lerImagemDaConversa, mensagemComImagem } from './IA/extractors/imagemChat';
import { SignalPipeline } from './signals/signalPipeline';
import { montarContextoApp, PROTOCOLO_ACAO_COPILOT, extrairAcaoCopilot, executarCriarOportunidade, resumirResultadoCriacao } from './IA/copilot';
import { TelegramIngestService } from './signals/telegramIngestService';
import { regraPermiteOportunidade } from './arbitrage/regras';
import { cashoutCapture } from './cashout/cashoutCapture';
import { cashoutBetMonitor } from './cashout/cashoutBetMonitor';
import { casasComFonteLive } from './cashout/cashoutSources';
import {
  getRecentOpportunities, getOpportunityById, getLatestTargetOdd, deleteOpportunity,
  insertUserBet, listUserBets, getUserBetById, updateUserBetStatus,
} from './cashout/cashoutRepo';
import { CASHOUT_CONFIG, devig2Way } from './cashout/cashoutEngine';
import { alignOdd } from './cashout/cashoutMatch';
import { areEventsSame, splitEvento } from './arbitrage/matcher';
import { mesmaOferta, normalizarMercado } from './arbitrage/markets';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// CORS restrito à origem do frontend quando configurado (decisão de segurança do plano de IA).
const frontendOrigin = process.env.FRONTEND_ORIGIN;
if (frontendOrigin) {
  app.use(cors({ origin: frontendOrigin }));
} else {
  console.warn('⚠️ [CORS] FRONTEND_ORIGIN não configurado — CORS aberto (apenas dev). Defina em produção.');
  app.use(cors());
}
// Parser JSON: limite padrão (100kb) em tudo, exceto nas rotas do Telegram —
// um print de sinal em base64 tem ~1-3 MB e estouraria o parser global.
const jsonPadrao = express.json();
const jsonGrande = express.json({ limit: '8mb' });
// (o webhook do WhatsApp entra no grande pelo mesmo motivo: payload de mídia da Evolution
// traz metadados longos e um 413 do parser faria a Evolution re-tentar 3x.)
//
// ANTES do parser, o webhook do WhatsApp confere o token — que vem na QUERY STRING e não
// exige corpo lido. Sem isso, qualquer um na internet fazia o backend desserializar 8 MB de
// JSON por request só para ser recusado depois.
app.use('/api/whatsapp/webhook', (req, res, next) => {
  if (req.method !== 'POST') return next();
  if (tokenWebhookValido(req.query?.token ?? req.header('x-webhook-token'))) return next();
  console.warn('⚠️ [WA-Agente] webhook recebido com token inválido — ignorado (antes do parser).');
  res.json({ ok: false, motivo: 'token inválido' });
});
// /api/ai/chat entra no grande porque o chat aceita IMAGEM (print de promoção/cupom): um
// base64 de 1-3 MB estouraria o limite de 100kb do parser padrão com 413.
app.use((req, res, next) =>
  (req.path.startsWith('/api/telegram') || req.path.startsWith('/api/whatsapp') || req.path === '/api/ai/chat'
    ? jsonGrande
    : jsonPadrao)(req, res, next)
);

// Worker de enriquecimento assíncrono de risco por IA.
const enrichment = new EnrichmentService();
// Serviço de revalidação de odds (§6 do kickoff).
const revalidation = new RevalidationService();
// Listener do grupo de sinais no Telegram (GramJS) — no-op sem envs TELEGRAM_*.
const telegramIngest = new TelegramIngestService();
// Ponte WhatsApp ↔ agente (grupo "Sure Agent"): recebe o webhook da Evolution, roda o
// MESMO agente da aba "IA & Automação" e responde no grupo.
const whatsappAgente = new WhatsAppAgentBridge(revalidation);

// Initialize AI providers
const geminiProvider = new GeminiProvider();
const openaiProvider = new OpenAIProvider();

// Health Check Endpoint
/**
 * LIVENESS puro — é isto que o HEALTHCHECK do Docker consulta.
 *
 * Responde na hora, sem tocar no banco e sem nenhum await: o único que ele responde
 * "estou vivo" é o event loop conseguir atender. Um probe de liveness NÃO pode depender
 * de serviço externo — com o /api/health (que faz select no Supabase) uma lentidão ou
 * blip do banco derrubava um backend perfeitamente saudável, porque 3 falhas seguidas
 * fazem o Swarm matar a task com SIGKILL (exit 137).
 *
 * O /api/health continua existindo com o status rico (banco + IA) para o painel.
 */
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
});

app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    // Check if we can perform a simple select (even if it returns empty, it verifies client connection status)
    // TIMEOUT: sem ele a consulta pode pendurar indefinidamente (o client não impõe limite)
    // e o /api/health nunca responde — o painel fica com o indicador girando pra sempre.
    const consulta = supabase.from('casas_apostas').select('id').limit(1);
    const limite = new Promise<{ error: { code: string } }>((r) =>
      setTimeout(() => r({ error: { code: 'TIMEOUT_LOCAL' } }), 4000)
    );
    const { error } = (await Promise.race([consulta, limite])) as { error: { code: string } | null };
    if (error?.code === 'TIMEOUT_LOCAL') {
      dbStatus = 'timeout';
    } else if (!error || error.code !== 'PGRST116') { // PGRST116 is just "no rows returned" in some cases or similar, but if connection failed it would be a network error
      dbStatus = 'connected';
    }
  } catch (err) {
    dbStatus = 'error';
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      // Túneis residenciais (exit nodes Tailscale) — quem está ativo e por que os outros
      // não estão. Visão em CACHE de propósito: quem re-testa é a varredura, o health não
      // pode pagar 8s de probe. Ver utils/tunelResidencial.ts.
      tuneis: seletorTuneis().status(),
      ai: {
        gemini: process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your-') ? 'configured' : 'mock-mode',
        openai: process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your-') ? 'configured' : 'mock-mode',
        groq: process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.includes('your-') ? 'configured' : 'mock-mode',
        // Cadeia efetiva + quem está em cooldown por cota esgotada (ver IA/aiProvider.ts).
        cadeia: cadeiaTexto(),
        provedores: statusProvedores(),
      }
    }
  });
});

// Test AI Integration
app.post('/api/test-ai', requireApiToken, async (req, res) => {
  const { provider, prompt, systemInstruction } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    let result = '';
    if (provider === 'openai') {
      result = await openaiProvider.generateText(prompt, systemInstruction);
    } else {
      // Default to Gemini
      result = await geminiProvider.generateText(prompt, systemInstruction);
    }
    
    res.json({ provider: provider || 'gemini', response: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error executing AI generation' });
  }
});

// Copiloto de Arbitragem — chat conversacional (multi-turno) COM acesso aos dados
// ao vivo do app (CONTEXTO_APP) e à ação criar_oportunidade (ver IA/copilot.ts).
const COPILOT_SYSTEM =
  'Você é o Copiloto do JotinhaBet, um assistente especialista em arbitragem esportiva (surebets), ' +
  'gestão de banca e regras de casas de apostas. Responda SEMPRE em português do Brasil, de forma objetiva e prática. ' +
  'Explique riscos quando relevante: erro palpável (odds absurdas), regras de anulação/void divergentes entre casas ' +
  '(ex.: desistência no tênis, prorrogação no basquete), liquidez e limitação de conta. ' +
  'Nunca prometa lucro garantido sem ressalvas e lembre que a execução da aposta é manual — o sistema nunca aposta sozinho. ' +
  'Se não souber, diga que não sabe. Seja conciso.\n\n' +
  'Você recebe abaixo um bloco CONTEXTO_APP com dados AO VIVO do sistema (banca ativa, saldos por casa, histórico de ' +
  'entradas com lucro/ROI, surebets ativas do radar, value bets, middles e calibração do alerta). Quando a pergunta for ' +
  'sobre as entradas/operações do usuário, a banca ou as oportunidades atuais, responda COM BASE NESSES DADOS, citando ' +
  'números exatos. Se a informação não estiver no contexto, diga que não tem acesso a ela (não invente).';

// Catálogo de SKILLS do agente + estado dos provedores de IA (a aba "IA & Automação"
// mostra isso para o usuário saber o que o agente consegue fazer e com qual motor).
app.get('/api/ai/skills', (_req, res) => {
  const skills = skillsParaUI();
  res.json({
    total: skills.length,
    skills,
    grupos: Array.from(new Set(skills.map((s) => s.grupo))),
    casas_integradas: catalogoCasas().length,
    casas: catalogoCasas().map((c) => ({
      nome: c.nome,
      chave: c.chave,
      plataforma: c.plataforma,
      fonte_scanner: c.fonte_scanner,
      odd_ao_vivo: c.odd_ao_vivo,
      varredura_ao_vivo: c.varredura_ao_vivo,
      consulta_ao_vivo: c.consulta_ao_vivo,
      grupo_wo_tenis: c.grupo_wo_tenis,
    })),
    casas_sem_integracao: casasSemIntegracao().map((c) => c.nome),
    provedores: statusProvedores(),
    cadeia_agente: cadeiaAgente(),
    cadeia_texto: cadeiaTexto(),
    // O agente pode usar um modelo diferente do de texto (GROQ_MODEL_AGENTE): é ESTE
    // que o painel deve mostrar como motor ativo.
    modelo_agente: criarMotor(cadeiaAgente()[0]).modelo,
    agente_ativo: process.env.AGENT_DESATIVADO !== '1',
  });
});

app.post('/api/ai/chat', requireApiToken, async (req, res) => {
  const { messages, imagemBase64, mimeType } = req.body;
  // Mantém só mensagens com conteúdo textual real e limita o histórico enviado ao LLM.
  const validas = (Array.isArray(messages) ? messages : [])
    .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-40);
  const temImagem = typeof imagemBase64 === 'string' && imagemBase64.trim().length > 100;
  if (validas.length === 0 && !temImagem) {
    return res.status(400).json({ error: 'Envie ao menos uma mensagem com conteúdo.' });
  }

  // IMAGEM anexada no chat (print de promoção, cupom, tela de odds): a visão converte em
  // texto e ele entra na ÚLTIMA mensagem do usuário — daí o agente segue com as skills
  // normais, sem precisar de um caminho paralelo só para imagem.
  let avisoImagem: string | null = null;
  if (temImagem) {
    const legenda = validas.length ? `${validas[validas.length - 1].content}`.trim() : '';
    try {
      const b64 = imagemBase64.replace(/^data:[^;]+;base64,/, '');
      const leitura = await lerImagemDaConversa(b64, mimeType || 'image/jpeg', legenda);
      const conteudo = mensagemComImagem(leitura.texto, legenda);
      if (validas.length) validas[validas.length - 1] = { ...validas[validas.length - 1], content: conteudo };
      else validas.push({ role: 'user', content: conteudo });
      console.log(`🖼️ [ai/chat] imagem lida por ${leitura.provider} (${leitura.texto.length} chars)`);
    } catch (error: any) {
      avisoImagem = `não consegui ler a imagem (${`${error?.message || error}`.slice(0, 120)})`;
      console.error('[ai/chat] visão falhou:', avisoImagem);
      if (!validas.length) {
        return res.json({
          reply: `👁️ Recebi a imagem, mas a leitura falhou: ${avisoImagem}. Me descreve o que está nela que eu sigo daqui.`,
          provider: 'nenhum',
        });
      }
    }
  }

  // MODO AGENTE (default): tool-calling com as skills de scraper/odds/radar/banca/
  // regras/cálculo/conhecimento. `modo:'simples'` no corpo (ou AGENT_DESATIVADO=1)
  // cai no chat de turno único abaixo — válvula de escape se um provedor quebrar
  // function calling.
  const modoSimples = req.body?.modo === 'simples' || process.env.AGENT_DESATIVADO === '1';
  if (!modoSimples) {
    try {
      const r = await rodarAgente(
        validas.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.trim() })),
        revalidation
      );
      const usadas = r.passos.map((p) => p.skill).join(', ');
      console.log(`🤖 [Agente] ${r.provider}/${r.modelo} — ${r.passos.length} skill(s)${usadas ? `: ${usadas}` : ''}`);
      return res.json({
        reply: r.reply,
        provider: r.provider,
        modelo: r.modelo,
        passos: r.passos,
        avisos: avisoImagem ? [...r.avisos, avisoImagem] : r.avisos,
        ...(r.acao ? { acao: r.acao } : {}),
      });
    } catch (error: any) {
      console.error('[ai/chat agente] erro:', error?.message || error);
      // Cai no modo simples em vez de devolver 500 — melhor uma resposta sem skills.
    }
  }

  try {
    // Monta o histórico multi-turno em um prompt textual (a interface IAProvider é single-prompt).
    const historico = validas
      .map((m: any) => `${m.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${m.content.trim()}`)
      .join('\n');
    const prompt = `${historico}\nAssistente:`;

    // Retrato ao vivo do app injetado no system a cada mensagem (tolerante a falha).
    const contexto = await montarContextoApp();
    const system = `${COPILOT_SYSTEM}\n${PROTOCOLO_ACAO_COPILOT}\n\n${contexto}`;

    const { text, provider } = await generateWithFallback(prompt, system);

    // Ação criar_oportunidade: se o modelo emitiu o bloco JSON, valida e roda o
    // MESMO pipeline dos sinais do Telegram (gates + dedup + revalidação + alerta).
    const acao = extrairAcaoCopilot(text);
    if (!acao) {
      return res.json({ reply: text, provider });
    }
    if (acao.erro || !acao.dados) {
      return res.json({
        reply: `${acao.replySemBloco}\n\n❌ A ação de criação veio malformada (${acao.erro}). Reformule o pedido com evento, esporte, mercado, opções, odds e casas.`,
        provider,
      });
    }
    // MESMO gate de escrita do modo agente: o modo simples é escolhido pelo CLIENTE, e sem
    // isto era um caminho para criar oportunidade (que pode disparar alerta no grupo) sem
    // pedido explícito do usuário.
    const ultimaDoUsuario = [...validas].reverse().find((m: any) => m.role !== 'assistant')?.content || '';
    if (!pediuEscritaExplicita(ultimaDoUsuario)) {
      return res.json({
        reply:
          `${acao.replySemBloco}\n\n🛡️ Não criei nada: a criação de oportunidade só roda quando você pede explicitamente ` +
          '(ex.: "crie essa oportunidade no radar"). Confirme e eu lanço.',
        provider,
      });
    }
    console.log(`🤖 [Copiloto] criar_oportunidade: ${acao.dados.evento} | ${acao.dados.mercado} | ${acao.dados.casaA}×${acao.dados.casaB}`);
    const resultado = await executarCriarOportunidade(acao.dados, new SignalPipeline(revalidation));
    res.json({
      reply: `${acao.replySemBloco}\n\n${resumirResultadoCriacao(resultado)}`,
      provider,
      acao: { tipo: 'criar_oportunidade', ...resultado },
    });
  } catch (error: any) {
    console.error('[ai/chat] erro:', error?.message || error);
    res.status(500).json({ error: 'Erro no chat de IA' });
  }
});

// Telegram: valida a extração de um sinal (print em base64) SEM depender do
// listener — é o loop de calibração do prompt/template. Default: dry-run
// (extração + construção + gates, sem tocar banco/WhatsApp); com
// executarPipeline:true roda o fluxo completo (insert + revalidação + alerta).
app.post('/api/telegram/test-extract', requireApiToken, async (req, res) => {
  const { imageBase64, mimeType, executarPipeline } = req.body || {};
  if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    return res.status(400).json({ error: 'Envie { imageBase64 } (base64, com ou sem prefixo data-URI).' });
  }
  try {
    const b64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
    const extracao = await extrairSinalDeImagem(b64, mimeType || 'image/jpeg');
    if (!extracao.sinal) {
      return res.json({ extracao });
    }

    const pipeline = new SignalPipeline(revalidation);
    const oportunidade = pipeline.construirOportunidade(extracao.sinal);
    const gates = oportunidade
      ? {
          regra: regraPermiteOportunidade({
            esporte: oportunidade.esporte,
            mercado: oportunidade.mercado,
            casaA: oportunidade.casaA,
            casaB: oportunidade.casaB,
          }),
        }
      : undefined;

    if (executarPipeline === true) {
      const resultado = await pipeline.processarSinal(extracao.sinal);
      return res.json({ extracao, oportunidade, gates, pipeline: resultado });
    }
    res.json({ dryRun: true, extracao, oportunidade, gates });
  } catch (error: any) {
    console.error('[telegram/test-extract] erro:', error?.message || error);
    res.status(500).json({ error: 'Erro na extração do sinal' });
  }
});

// Telegram: status do listener do grupo (conexão, contadores de triagem).
app.get('/api/telegram/status', requireApiToken, (_req, res) => {
  res.json(telegramIngest.getStatus());
});

// WhatsApp: lista os grupos (subject + JID "…@g.us") para descobrir o EVOLUTION_RECIPIENT.
// Abra no navegador, copie o "id" do grupo desejado e coloque em EVOLUTION_RECIPIENT no .env.
app.get('/api/whatsapp/grupos', async (_req, res) => {
  try {
    const grupos = await new WhatsAppNotifier().listarGrupos();
    res.json({ count: grupos.length, grupos });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Erro ao listar grupos do WhatsApp' });
  }
});

/**
 * WEBHOOK DA EVOLUTION — é aqui que a conversa do WhatsApp com o agente entra.
 *
 * Cole esta URL no campo "Webhook" da instância na Evolution (ou via
 * POST /instance/connect {webhookUrl, subscribe:["MESSAGE"]}):
 *   https://jotinhabet.eurekmind.com/api/whatsapp/webhook?token=<AGENT_WHATSAPP_WEBHOOK_TOKEN>
 * De dentro da overlay do Swarm, o caminho curto também serve:
 *   http://jotinhabet_backend:4000/api/whatsapp/webhook?token=...
 *
 * SEMPRE responde 200 — a Evolution re-tenta 3x quando o webhook não devolve 2xx, e cada
 * re-tentativa viraria uma execução duplicada do agente (com scraper e cota de IA).
 * A triagem é síncrona; a execução do agente roda em background.
 */
app.post('/api/whatsapp/webhook', (req, res) => {
  if (!tokenWebhookValido(req.query?.token ?? req.header('x-webhook-token'))) {
    console.warn('⚠️ [WA-Agente] webhook recebido com token inválido — ignorado.');
    return res.json({ ok: false, motivo: 'token inválido' });
  }
  try {
    const triagem = whatsappAgente.receber(req.body);
    res.json({ ok: true, ...triagem });
  } catch (error: any) {
    console.error('[whatsapp/webhook] erro na triagem:', error?.message || error);
    res.json({ ok: false, motivo: 'erro interno na triagem' });
  }
});

// Estado do canal do WhatsApp (sessões, contadores, chats autorizados).
app.get('/api/whatsapp/webhook', requireApiToken, (_req, res) => {
  res.json({ ...whatsappAgente.getStatus(), chats_autorizados: chatsPermitidos() });
});

// Últimos payloads CRUS recebidos — o formato do webhook varia por versão do
// evolution-go; é por aqui que se confere o que chegou de verdade.
app.get('/api/whatsapp/webhook/debug', requireApiToken, (_req, res) => {
  res.json({ ultimos: whatsappAgente.ultimosPayloads() });
});

// Arbitrage Calculator Endpoint
app.post('/api/calculator', (req, res) => {
  const result = calcularArbitragem(req.body);
  if (!result) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }
  res.json(result);
});

// Daily Evolution Projections Endpoint
app.post('/api/evolution', (req, res) => {
  const { bancaInicial, dias, maxStakePct, roiMedioTurnoPct, turnosPorDia } = req.body;
  if (!bancaInicial || isNaN(Number(bancaInicial))) {
    return res.status(400).json({ error: 'Banca inicial é obrigatória' });
  }
  const result = projetarEvolucaoDiaria({
    bancaInicial: Number(bancaInicial),
    dias: dias ? Number(dias) : undefined,
    maxStakePct: maxStakePct ? Number(maxStakePct) : undefined,
    roiMedioTurnoPct: roiMedioTurnoPct ? Number(roiMedioTurnoPct) : undefined,
    turnosPorDia: turnosPorDia ? Number(turnosPorDia) : undefined
  });
  res.json(result);
});

import { ArbitrageScannerV2 } from './core/scanner_v2';
import { sureradarSync } from './core/sureradarSync';

// Manual Scanner Endpoint
const scanner = new ArbitrageScannerV2();
let scanManualEmAndamento = false;
app.post('/api/scan', async (req, res) => {
  const { dataFiltro, aoVivo, sureradarOnly, apenasApi } = req.body;
  // apenasApi default = true: varredura GERAL manual usa o caminho de API (KTO,
  // Superbet, BetWarrior, Aposta1, Pinnacle + SureRadar), rápido e sem Playwright —
  // igual ao scheduler. Só o scan completo (browser: Blaze/Betano/1xBet) exige
  // apenasApi:false explícito (lento; evitar num clique de botão).
  const usarApenasApi = apenasApi !== false;

  if (scanManualEmAndamento) {
    return res.json({ success: true, started: false, message: 'Uma varredura manual já está em andamento.' });
  }

  // FIRE-AND-FORGET: a varredura geral leva ~60s (motor + SureRadar + revalidação),
  // acima do timeout de proxy de 60s. Responde já e roda em background — o painel
  // atualiza pelo polling (a cada 8s). Guard evita disparos concorrentes.
  scanManualEmAndamento = true;
  res.json({ success: true, started: true });
  scanner
    .executarVarredura(dataFiltro, !!aoVivo, !!sureradarOnly, usarApenasApi)
    .then((ops) => console.log(`✅ [scan manual] concluído — ${ops.length} nova(s) surebet(s).`))
    .catch((err) => console.error('❌ [scan manual] erro:', err?.message || err))
    .finally(() => {
      scanManualEmAndamento = false;
    });
});

// Status da varredura manual (o painel usa p/ manter o spinner até concluir).
app.get('/api/scan/status', (_req, res) => {
  res.json({ running: scanManualEmAndamento });
});

// Sincronia com o SureRadar: quando ELES recalcularam, de quanto em quanto tempo recalculam,
// quanto depois disso a NOSSA varredura capturou e quanto de vida resta ao dado do banco.
// Sem estado em disco: medição de fase em memória. Restart perde só a CADÊNCIA (volta em ~30
// min, quando 4 recálculos deles tiverem sido observados); o resto vem na 1ª varredura.
app.get('/api/sureradar/sync', (_req, res) => {
  try {
    res.json(sureradarSync.snapshot());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'falha ao montar o snapshot de sincronia' });
  }
});

// GET list of opportunities
app.get('/api/opportunities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('oportunidades')
      .select('*')
      .order('detectada_em', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao buscar oportunidades' });
  }
});

// DELETE all opportunities (useful for clearing dashboard list).
// Oportunidades SALVAS pelo usuário ficam — só o delete individual as remove.
app.delete('/api/opportunities', async (req, res) => {
  try {
    const { error } = await supabase
      .from('oportunidades')
      .delete()
      .eq('salva', false);

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao limpar histórico' });
  }
});

// Salvar/dessalvar uma oportunidade (fica imune a TODA limpeza automática do rescan:
// >24h, reconciliação SureRadar/motor e expiradas — ver migration 009).
app.post('/api/opportunities/:id/save', async (req, res) => {
  const salva = req.body?.salva !== false; // default: salvar
  try {
    const { data, error } = await supabase
      .from('oportunidades')
      .update({ salva })
      .eq('id', req.params.id)
      .select('id, salva')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Oportunidade não encontrada' });
    res.json({ success: true, salva: data.salva });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao salvar oportunidade' });
  }
});

// Reenriquecer (sob demanda) o veredito de risco por IA de uma oportunidade
app.post('/api/opportunities/:id/enrich', requireApiToken, async (req, res) => {
  try {
    const veredito = await enrichment.enriquecerPorId(req.params.id);
    if (!veredito) {
      return res.status(404).json({ error: 'Oportunidade não encontrada ou falha ao enriquecer' });
    }
    res.json({ success: true, veredito });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao enriquecer oportunidade' });
  }
});

// Revalidar a odd de uma oportunidade (reconsulta a cotação atual — §6 do kickoff)
app.post('/api/opportunities/:id/revalidate', requireApiToken, async (req, res) => {
  try {
    const revalidacao = await revalidation.revalidar(req.params.id);
    res.json({ success: true, revalidacao });
  } catch (error: any) {
    console.error('[revalidate] erro:', error?.message || error);
    if (/n[ãa]o encontrada/i.test(error?.message || '')) {
      return res.status(404).json({ error: 'Oportunidade não encontrada' });
    }
    res.status(500).json({ error: 'Erro ao revalidar oportunidade' });
  }
});

// DELETE a specific opportunity by ID
app.delete('/api/opportunities/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('oportunidades')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao deletar oportunidade' });
  }
});

// POST - Salvar uma nova operação (Lançar na Banca)
app.post('/api/operations', async (req, res) => {
  const { oportunidade_id, stake_real_1, stake_real_2, lucro_real, detalhes } = req.body;

  // Payload mínimo: apenas colunas garantidas pela migration 001. O campo
  // 'resultado' guarda os detalhes completos (casa/odd/opção) em JSON e o GET
  // reconstrói 'detalhes' a partir dele — então as colunas dedicadas são redundantes.
  const basePayload = {
    oportunidade_id: oportunidade_id || null,
    stake_real_1: Number(stake_real_1),
    stake_real_2: Number(stake_real_2),
    lucro_real: Number(lucro_real),
    resultado: JSON.stringify(detalhes || {})
  };

  // Colunas estendidas (migration 004). Podem não existir se a migration não foi aplicada.
  const extendedPayload = {
    ...basePayload,
    evento: detalhes?.evento || null,
    mercado: detalhes?.mercado || null,
    casa_a: detalhes?.casaA || null,
    casa_b: detalhes?.casaB || null,
    opcao_a: detalhes?.opcaoA || null,
    opcao_b: detalhes?.opcaoB || null,
    odd_a: detalhes?.oddA ? Number(detalhes.oddA) : null,
    odd_b: detalhes?.oddB ? Number(detalhes.oddB) : null,
    roi: detalhes?.roi ? Number(detalhes.roi) : null
  };

  // Detecta o erro do PostgREST quando uma coluna não existe no schema (cache).
  const isMissingColumn = (err: any) =>
    !!err && (err.code === 'PGRST204' || /column|schema cache/i.test(err.message || ''));

  try {
    let { data, error } = await supabase.from('operacoes').insert(extendedPayload).select().single();

    // Fallback: se as colunas estendidas não existirem, grava só o payload mínimo.
    if (isMissingColumn(error)) {
      console.warn(
        '⚠️ [operations] Colunas estendidas ausentes em "operacoes" (aplique a migration 004). ' +
        'Gravando payload mínimo — os detalhes seguem preservados no campo "resultado" (JSON).'
      );
      ({ data, error } = await supabase.from('operacoes').insert(basePayload).select().single());
    }

    if (error) throw error;
    res.json({ success: true, operation: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao lançar operação na banca' });
  }
});

// GET - Listar histórico de operações salvas
app.get('/api/operations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('operacoes')
      .select('*')
      .order('confirmado_em', { ascending: false });

    if (error) throw error;

    // Converte os detalhes em JSON para facilitar no frontend
    const parsedData = (data || []).map(item => {
      let detalhes = {};
      try {
        if (item.resultado && item.resultado.startsWith('{')) {
          detalhes = JSON.parse(item.resultado);
        }
      } catch (e) {
        // Ignora falha de parse
      }
      return {
        ...item,
        detalhes
      };
    });

    res.json(parsedData);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter histórico de operações' });
  }
});

// DELETE - Remover uma entrada lançada na banca (reverter entrada indevida).
// Só apaga a operação; o estorno do lucro na "banca ativa" é feito no frontend
// (a banca vive no localStorage do cliente e não no banco).
app.delete('/api/operations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('operacoes')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao excluir operação da banca' });
  }
});

// Detecta erro do PostgREST quando a TABELA não existe (migration não aplicada):
// PGRST205 ("Could not find the table ... in the schema cache") ou 42P01 do Postgres.
const isMissingTable = (err: any) =>
  !!err && (err.code === 'PGRST205' || err.code === '42P01' || /find the table|does not exist/i.test(err.message || ''));

// GET - Banca ativa salva no banco (app_config['banca_ativa']); null se nunca salva.
app.get('/api/banca', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('valor, atualizado_em')
      .eq('chave', 'banca_ativa')
      .maybeSingle();
    if (error) throw error;
    res.json({ banca: data ? Number(data.valor) : null, atualizado_em: data?.atualizado_em ?? null });
  } catch (error: any) {
    if (isMissingTable(error)) {
      console.warn('⚠️ [banca] Tabela app_config ausente (aplique a migration 008). Tratando como "nunca salva".');
      return res.json({ banca: null, atualizado_em: null });
    }
    res.status(500).json({ error: error.message || 'Erro ao obter banca salva' });
  }
});

// POST - Salvar a banca ativa no banco (upsert em app_config).
app.post('/api/banca', async (req, res) => {
  const banca = Number(req.body?.banca);
  if (!Number.isFinite(banca) || banca <= 0) {
    return res.status(400).json({ error: 'Valor de banca inválido' });
  }
  try {
    const { error } = await supabase
      .from('app_config')
      .upsert({ chave: 'banca_ativa', valor: banca.toFixed(2), atualizado_em: new Date().toISOString() });
    if (error) throw error;
    res.json({ success: true, banca: Number(banca.toFixed(2)) });
  } catch (error: any) {
    if (isMissingTable(error)) {
      return res.status(500).json({ error: 'Tabela app_config ausente no banco — aplique a migration 008.' });
    }
    res.status(500).json({ error: error.message || 'Erro ao salvar banca' });
  }
});

// GET - Saldos disponíveis por casa (app_config['saldos_casas'] como JSON). [] se nunca salvo.
app.get('/api/saldos', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('valor, atualizado_em')
      .eq('chave', 'saldos_casas')
      .maybeSingle();
    if (error) throw error;
    let saldos: Array<{ casa: string; valor: number }> = [];
    if (data?.valor) {
      try {
        const parsed = JSON.parse(data.valor);
        if (Array.isArray(parsed)) saldos = parsed;
      } catch {
        /* valor corrompido → trata como vazio */
      }
    }
    res.json({ saldos, atualizado_em: data?.atualizado_em ?? null });
  } catch (error: any) {
    if (isMissingTable(error)) {
      console.warn('⚠️ [saldos] Tabela app_config ausente (aplique a migration 008). Tratando como "nunca salvo".');
      return res.json({ saldos: [], atualizado_em: null });
    }
    res.status(500).json({ error: error.message || 'Erro ao obter saldos por casa' });
  }
});

// POST - Salvar os saldos por casa (upsert em app_config). Sanitiza nome/valor
// no servidor para nunca persistir lixo (linha sem casa ou valor não numérico).
app.post('/api/saldos', async (req, res) => {
  const entrada = req.body?.saldos;
  if (!Array.isArray(entrada)) {
    return res.status(400).json({ error: 'Payload inválido: "saldos" deve ser uma lista.' });
  }
  const saldos = entrada
    .map((s: any) => ({ casa: String(s?.casa ?? '').trim(), valor: Number(s?.valor) }))
    .filter((s) => s.casa.length > 0 && Number.isFinite(s.valor) && s.valor >= 0)
    .map((s) => ({ casa: s.casa, valor: Number(s.valor.toFixed(2)) }));
  try {
    const { error } = await supabase
      .from('app_config')
      .upsert({ chave: 'saldos_casas', valor: JSON.stringify(saldos), atualizado_em: new Date().toISOString() });
    if (error) throw error;
    const total = Number(saldos.reduce((acc, s) => acc + s.valor, 0).toFixed(2));
    res.json({ success: true, saldos, total });
  } catch (error: any) {
    if (isMissingTable(error)) {
      return res.status(500).json({ error: 'Tabela app_config ausente no banco — aplique a migration 008.' });
    }
    res.status(500).json({ error: error.message || 'Erro ao salvar saldos por casa' });
  }
});

// ═════════ Surebets de PROMOÇÃO (histórico manual — tabela promo_surebets) ═════════
// Lucro extraído de promoções das casas: perna promocional numa casa + cobertura na
// outra. Vive fora do radar, não mexe na banca ativa e tem ROI próprio.
//
// TODA a matemática vem de core/promocoes.ts (fonte única, 57 testes). Esta camada só
// lê o corpo, chama o core e grava. Os 6 tipos, e o que cada um muda na conta:
//   FREEBET_SNR   ficha não volta   → retorno S×(odd−1), custo R$ 0 (só a cobertura é investimento)
//   FREEBET_SRR   ficha volta       → retorno S×(odd−1+v), custo R$ 0; v = valor_ficha_pct
//   QUALIFYING    dinheiro real     → retorno S×odd, custo S (o qualificador quase sempre dá prejuízo)
//   PROTECAO      dinheiro real     → idem + devolução se a perna promocional PERDER
//   SUPERODD      odd turbinada     → em caixa a odd JÁ contém o excedente; em bônus paga odd_padrao + bônus
//   LUCRO_EXTRA   % de lucro extra  → retorno S×odd + extra valorizado (boost_pct, teto_extra)
// S = stake ELEGÍVEL (min(valor, teto_stake)) — não é o valor digitado quando há teto.
//
// Armadilhas desta camada (todas já custaram dinheiro no repo):
//   • promo_type do BANCO ≠ tipo do core só na qualificativa (QUALIFYING ↔ QUALIFICATIVA).
//     Traduza SEMPRE com tipoDoPromoType/promoTypeDoTipo; tradutor novo aqui volta a
//     divergir e faz filtro devolver zero em silêncio.
//   • tipo desconhecido é ERRO 400, não default: coagir para FREEBET_SNR respondendo
//     success:true gravava custo zero onde havia dinheiro real na mesa.
//   • "investido" = dinheiro que sai do bolso → ehFreebetSemCusto(tipo) decide, e a stake
//     que entra é a elegível.
//   • coluna nova só vai no INSERT quando o tipo/regulamento a usa (degradação sem
//     migration): um banco sem a 022 continua gravando freebet/qualificativa/proteção.

// GET - lista o histórico de promoções (mais recente primeiro)
app.get('/api/promocoes', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_surebets')
      .select('*')
      .order('criado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    if (isMissingTable(error)) return res.json([]); // migration 018 não aplicada → lista vazia
    res.status(500).json({ error: error.message || 'Erro ao listar promoções' });
  }
});

// Migration que introduziu cada coluna/tipo de promoção. Existe para a mensagem de erro
// apontar a migration que REALMENTE falta: o texto fixo em "021" mandava reaplicar uma
// migration já aplicada, e a regex /cashback|promo_type_check/ passou a casar com o CHECK
// da 022 (que já tem os 6 tipos) — ou seja, "falta a 022" era lido como "aplique a 021".
const MIGRACOES_PROMO: Array<{ arquivo: string; colunas: string[]; tipos: string[] }> = [
  { arquivo: '019_promo_odds.sql', colunas: ['odd_promocao', 'odd_cobertura'], tipos: [] },
  { arquivo: '020_promo_type.sql', colunas: ['promo_type'], tipos: ['FREEBET_SNR', 'QUALIFYING'] },
  {
    arquivo: '021_promo_protecao.sql',
    colunas: ['cashback', 'cashback_pct', 'cashback_teto', 'cashback_eh_bonus', 'valor_bonus_pct'],
    tipos: ['PROTECAO'],
  },
  {
    arquivo: '022_promo_srr_superodd_lucro_extra.sql',
    colunas: [
      'valor_ficha_pct', 'odd_padrao', 'teto_stake', 'boost_pct', 'boost_sobre_stake', 'teto_extra',
      'extra_em_bonus', 'valor_extra_pct', 'teto_ganho', 'teto_incide_sobre', 'extra_nominal',
      'extra_efetivo', 'odd_efetiva_promo',
    ],
    tipos: ['FREEBET_SRR', 'SUPERODD', 'LUCRO_EXTRA'],
  },
];
const migrationDaColunaPromo = (coluna: string) =>
  MIGRACOES_PROMO.find((m) => m.colunas.includes(coluna))?.arquivo ?? null;
const migrationDoTipoPromo = (promoType: string) =>
  MIGRACOES_PROMO.find((m) => m.tipos.includes(promoType))?.arquivo ?? null;

/**
 * Traduz erro de SCHEMA (coluna ausente ou CHECK de promo_type) em instrução útil: o que o
 * banco não aceitou e qual a migration mais nova a aplicar. `colunasEnviadas` são as chaves
 * que este INSERT realmente mandou — sem elas a mensagem teria de adivinhar quando o
 * PostgREST cita só a primeira coluna que faltou. Devolve null se o erro não é de schema.
 */
function erroDeSchemaPromo(err: any, promoType: string, colunasEnviadas: string[]): string | null {
  const msg = `${err?.message ?? ''} ${err?.details ?? ''}`;
  const codigo = `${err?.code ?? ''}`;
  const ehColunaAusente =
    codigo === 'PGRST204' || codigo === '42703' || /column .*(schema cache|does not exist)/i.test(msg);
  const ehCheckDeTipo = /promo_type_check/i.test(msg);
  if (!ehColunaAusente && !ehCheckDeTipo) return null;

  const faltando: string[] = [];
  const migrations = new Set<string>();
  if (ehCheckDeTipo) {
    faltando.push(`o tipo ${promoType} (CHECK de promo_type desatualizado)`);
    const arquivo = migrationDoTipoPromo(promoType);
    if (arquivo) migrations.add(arquivo);
  }
  if (ehColunaAusente) {
    const citada = /'([a-z0-9_]+)'|"([a-z0-9_]+)"/.exec(msg);
    const nome = citada ? citada[1] || citada[2] : null;
    // Se a coluna citada é conhecida, ela basta; senão listamos todas as opcionais deste
    // INSERT, porque as demais da mesma migration também vão faltar.
    const alvos = nome && migrationDaColunaPromo(nome) ? [nome] : colunasEnviadas;
    for (const coluna of alvos) {
      const arquivo = migrationDaColunaPromo(coluna);
      if (arquivo) {
        faltando.push(`a coluna ${coluna}`);
        migrations.add(arquivo);
      }
    }
  }
  const lista = [...migrations].sort();
  const maisNova = lista[lista.length - 1];
  if (!maisNova || !faltando.length) return null;
  return (
    `Banco sem ${faltando.join(', ')} — aplique a migration ${maisNova}` +
    (lista.length > 1 ? ` (e, se ainda faltarem, ${lista.slice(0, -1).join(', ')})` : '') +
    ' e REINICIE o PostgREST (o NOTIFY sozinho não basta).'
  );
}

const numPromo = (v: any) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const strPromo = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);

interface PromocaoLida {
  tipo: TipoPromocao;
  /** Vocabulário do BANCO (QUALIFICATIVA vira QUALIFYING). */
  promoType: string;
  casaPromocao: string | null;
  valorPromocao: number | null;
  evento: string | null;
  mercado: string | null;
  casaCobertura: string | null;
  oddPromocao: number | null;
  oddCobertura: number | null;
  aporteInformado: number | null;
  lucroInformado: number | null;
  roiInformado: number | null;
  /** Teto de stake elegível (null = sem teto). Só para o fallback de investimento sem odds. */
  tetoStake: number | null;
  calcular: (coverStake: number | null) => ResultadoPromocao | null;
  /** Colunas que só entram no INSERT quando o tipo/regulamento realmente as usa. */
  colunasOpcionais: (calc: ResultadoPromocao | null) => Record<string, any>;
}

/**
 * Lê o corpo de uma promoção — MESMO formato no registro e no preview — e devolve a entrada
 * já normalizada + o fechamento que chama o core, ou uma mensagem pronta de 400.
 *
 * '' e null contam como ausentes: Number('') é 0, então campo vazio viraria R$ 0,00 válido.
 */
function lerPromocaoDoCorpo(body: any): { erro: string; lido?: undefined } | { erro?: undefined; lido: PromocaoLida } {
  const b = body || {};
  // Aceita snake_case (formulário e colunas) e camelCase (vocabulário do core): campo lido
  // com a grafia errada volta null e a promoção DEGRADA EM SILÊNCIO — sem boost_pct o
  // LUCRO_EXTRA cai para qualificativa crua, que é prejuízo garantido com cara de plano.
  const n = (...chaves: string[]) => {
    for (const k of chaves) {
      const v = numPromo(b[k]);
      if (v !== null) return v;
    }
    return null;
  };
  const flag = (...chaves: string[]) => chaves.some((k) => b[k] === true || b[k] === 'true');
  const erros: string[] = [];
  // Teto 0 é "sem teto" (é como o core trata); negativo é digitação errada e tem de doer.
  const teto = (rotulo: string, ...chaves: string[]) => {
    const v = n(...chaves);
    if (v === null) return null;
    if (v < 0) {
      erros.push(`${rotulo} não pode ser negativo`);
      return null;
    }
    return v > 0 ? v : null;
  };
  // Só para os percentuais de VALORIZAÇÃO de bônus (ficha, extra, cashback), que o core
  // clampa em 0..1: 0 é entrada VÁLIDA (bônus que não vale nada), mas um "700" digitado por
  // engano viraria 100% inventado em silêncio. Percentual de boost/cashback não entra aqui —
  // lá o número não é clampado, então nada é inventado.
  const pct = (rotulo: string, ...chaves: string[]) => {
    const v = n(...chaves);
    if (v === null) return null;
    if (v < 0 || v > 100) {
      erros.push(`${rotulo} tem de ficar entre 0 e 100 (é um percentual)`);
      return null;
    }
    return v;
  };

  // Tipo desconhecido é ERRO, não default: a whitelist anterior coagia qualquer string para
  // FREEBET_SNR e respondia success:true — matemática de freebet (custo zero) gravada sobre
  // uma operação com dinheiro real na mesa. Ausente segue caindo no default histórico.
  const promoTypeBruto = (strPromo(b.promo_type) ?? strPromo(b.tipo) ?? '').toUpperCase();
  const conhecido =
    (PROMO_TYPES_BANCO as readonly string[]).includes(promoTypeBruto) ||
    (TIPOS_PROMOCAO as readonly string[]).includes(promoTypeBruto);
  if (promoTypeBruto && !conhecido) {
    return { erro: `promo_type inválido ("${promoTypeBruto}"). Válidos: ${PROMO_TYPES_BANCO.join(', ')}.` };
  }
  // Tradutores do core nas duas direções — não escreva um terceiro aqui.
  const tipo = tipoDoPromoType(promoTypeBruto || 'FREEBET_SNR');
  const promoType = promoTypeDoTipo(tipo);

  const casaPromocao = strPromo(b.casa_promocao);
  const casaCobertura = strPromo(b.casa_cobertura);
  const evento = strPromo(b.evento);
  const mercado = strPromo(b.mercado);
  const valorPromocao = n('valor_promocao', 'valorPromocao', 'promoStake');
  const oddPromocao = n('odd_promocao', 'oddPromocao', 'promoOdd');
  const oddCobertura = n('odd_cobertura', 'oddCobertura', 'coverOdd');
  if ((oddPromocao !== null && oddPromocao <= 1) || (oddCobertura !== null && oddCobertura <= 1)) {
    return { erro: 'Odds devem ser maiores que 1.' };
  }
  // Valor <= 0 precisa falhar APONTANDO para si: sem isto o cálculo devolvia null e o
  // erro reclamava de valor_cobertura, mandando o usuário mexer no campo errado.
  if (valorPromocao !== null && valorPromocao <= 0) {
    return { erro: 'valor_promocao deve ser maior que zero.' };
  }

  // Devolução da proteção: % da stake (com teto) ou valor direto em reais. Em bônus, o
  // valor efetivo é menor que a face — quem faz esse desconto é o core.
  const cashbackInformado = n('cashback');
  // Devolução acima de 100% da stake não existe em regulamento nenhum, e o core NÃO clampa
  // este percentual: um "500" digitado por engano virava cashback de R$ 500 sobre stake de
  // R$ 100, aporte clampado em zero e lucro de R$ 100 gravado com ROI de 100%.
  const cashbackPct = pct('cashback_pct', 'cashback_pct', 'cashbackPct');
  // Default true (o core usa `!== false`): só desliga com false EXPLÍCITO no corpo.
  const cashbackSoSePerder = !(b.cashback_so_se_perder === false || b.cashbackSoSePerder === false || b.cashback_so_se_perder === 'false');
  const cashbackTeto = teto('cashback_teto', 'cashback_teto', 'cashbackTeto');
  const cashbackEhBonus = flag('cashback_eh_bonus', 'cashbackEhBonus');
  const valorBonusPct = pct('valor_bonus_pct', 'valor_bonus_pct', 'valorBonusPct');
  // SRR: v da fórmula S×(odd−1+v). Ausente = 100 (ficha volta em dinheiro), decidido no core.
  const valorFichaPct = pct('valor_ficha_pct', 'valor_ficha_pct', 'valorFichaPct');
  // SUPERODD / LUCRO_EXTRA.
  const oddPadrao = n('odd_padrao', 'oddPadrao');
  const tetoStake = teto('teto_stake', 'teto_stake', 'tetoStake');
  const boostPct = n('boost_pct', 'boostPct');
  const boostSobreStake = flag('boost_sobre_stake', 'boostSobreStake');
  const tetoExtra = teto('teto_extra', 'teto_extra', 'tetoExtra');
  const extraEmBonus = flag('extra_em_bonus', 'extraEmBonus');
  const valorExtraPct = pct('valor_extra_pct', 'valor_extra_pct', 'valorExtraPct');
  // Teto de regulamento (qualquer tipo).
  const tetoGanho = teto('teto_ganho', 'teto_ganho', 'tetoGanho');
  const tetoIncideBruto = (strPromo(b.teto_incide_sobre) ?? strPromo(b.tetoIncideSobre) ?? '').toUpperCase();
  if (tetoIncideBruto && tetoIncideBruto !== 'GANHO' && tetoIncideBruto !== 'RETORNO') {
    return {
      erro:
        `teto_incide_sobre inválido ("${tetoIncideBruto}"): use GANHO ("ganhe até R$ X", limita o lucro) ou ` +
        'RETORNO ("retorno máximo R$ X", limita o pagamento inteiro). Não são a mesma fórmula.',
    };
  }
  const tetoIncideSobre = tetoIncideBruto === 'RETORNO' ? ('RETORNO' as const) : tetoIncideBruto === 'GANHO' ? ('GANHO' as const) : null;
  if (oddPadrao !== null && oddPadrao <= 1) {
    return { erro: 'odd_padrao (a odd NORMAL do mercado, sem o boost) deve ser maior que 1.' };
  }
  if (boostPct !== null && boostPct < 0) {
    return { erro: 'boost_pct não pode ser negativo.' };
  }
  if (erros.length) return { erro: `Valores fora da faixa: ${erros.join('; ')}.` };

  // Aporte 0/negativo = ausente (0 não é uma cobertura válida): antes ele era gravado
  // como 0 mas o lucro vinha do aporte equalizado — número que nunca existiu na mesa.
  const aporteBruto = n('valor_cobertura', 'valorCobertura', 'coverStake');
  const aporteInformado = (aporteBruto ?? 0) > 0 ? aporteBruto : null;

  // As CASAS entram no cálculo para a comissão de exchange (Bolsa de Aposta 1,5%) valer
  // aqui como vale na skill do Agente.
  const calcular = (coverStake: number | null) =>
    valorPromocao !== null && oddPromocao !== null && oddCobertura !== null
      ? calcularPromocao({
          tipo,
          promoStake: valorPromocao,
          promoOdd: oddPromocao,
          coverOdd: oddCobertura,
          coverStake,
          cashback: cashbackInformado,
          cashbackPct,
          cashbackTeto,
          cashbackEhBonus,
          valorBonusPct,
          cashbackSoSePerder,
          valorFichaPct,
          oddPadrao,
          tetoStake,
          boostPct,
          boostSobreStake,
          tetoExtra,
          extraEmBonus,
          valorExtraPct,
          tetoGanho,
          ...(tetoIncideSobre ? { tetoIncideSobre } : {}),
          casaPromo: casaPromocao,
          casaCobertura,
        })
      : null;

  const comBoost = ehTipoComBoost(tipo);
  const temCashback = tipo === 'PROTECAO' || (cashbackInformado ?? 0) > 0 || (cashbackPct ?? 0) > 0;
  const usaColunasDa022 = tipo === 'FREEBET_SRR' || comBoost || tetoStake !== null || tetoGanho !== null;
  // Degradação sem migration: coluna nova só entra no INSERT quando o tipo/regulamento
  // realmente a usa. O PostgREST rejeita o INSERT INTEIRO por uma coluna desconhecida, então
  // mandar sempre as 13 colunas novas quebraria freebet/qualificativa/proteção num banco
  // que ainda não recebeu a 022.
  const colunasOpcionais = (calc: ResultadoPromocao | null): Record<string, any> => {
    const cols: Record<string, any> = {};
    if (temCashback) {
      // Valor de FACE já com o teto aplicado (quem aplica é o core).
      cols.cashback = calc ? calc.cashbackNominal : cashbackInformado;
      cols.cashback_pct = cashbackPct;
      cols.cashback_teto = cashbackTeto;
      cols.cashback_eh_bonus = cashbackEhBonus;
      cols.valor_bonus_pct = cashbackEhBonus ? (valorBonusPct ?? VALOR_BONUS_PADRAO_PCT) : null;
      // Só grava quando é FALSE (o caso raro): assim uma proteção normal continua entrando
      // em banco sem a 022, e a linha incondicional não é relida como condicional.
      if (!cashbackSoSePerder) cols.cashback_so_se_perder = false;
    }
    if (tipo === 'FREEBET_SRR') {
      // Sem gravar o v a linha não reproduz: ficha em dinheiro (100) e ficha em bônus (70)
      // dão lucros diferentes sob o MESMO tipo.
      cols.valor_ficha_pct = valorFichaPct ?? 100;
    }
    if (comBoost) {
      if (tipo === 'SUPERODD') cols.odd_padrao = oddPadrao;
      if (tipo === 'LUCRO_EXTRA') {
        cols.boost_pct = boostPct;
        cols.boost_sobre_stake = boostSobreStake;
      }
      cols.teto_extra = tetoExtra;
      cols.extra_em_bonus = extraEmBonus;
      cols.valor_extra_pct = extraEmBonus ? (valorExtraPct ?? VALOR_BONUS_PADRAO_PCT) : null;
      // Derivados do core: face e valor efetivo do extra. Ficam gravados para a UI e o
      // histórico não reimplementarem o boost (cópia divergente = número que não foi o executado).
      if (calc) {
        cols.extra_nominal = calc.extraNominal;
        cols.extra_efetivo = calc.extraEfetivo;
      }
    }
    // Tetos são de REGULAMENTO, não de tipo: entram quando informados, em qualquer tipo.
    if (tetoStake !== null) {
      cols.teto_stake = tetoStake;
      // valor_promocao guarda o que o usuário digitou; a stake que FOI À MESA é esta. Sem
      // gravá-la, todo leitor da tabela precisa lembrar de aplicar min(valor, teto) — e o
      // card "Investido" já somava R$ 128,57 onde só R$ 58,57 saíram do bolso.
      if (calc) cols.stake_elegivel = calc.stakeElegivel;
    }
    if (tetoGanho !== null) {
      cols.teto_ganho = tetoGanho;
      cols.teto_incide_sobre = tetoIncideSobre ?? 'GANHO'; // default explícito do core
    }
    // odd_efetiva_promo só é gravada onde a 022 já é obrigatória por outra coluna: nos tipos
    // antigos ela é a própria odd_promocao (nada a somar) e não vale arriscar o INSERT.
    if (calc && usaColunasDa022) cols.odd_efetiva_promo = calc.oddEfetivaPromo;
    return cols;
  };

  return {
    lido: {
      tipo, promoType, casaPromocao, valorPromocao, evento, mercado, casaCobertura,
      oddPromocao, oddCobertura, aporteInformado, tetoStake,
      lucroInformado: n('lucro'),
      roiInformado: n('roi_pct', 'roiPct'),
      calcular, colunasOpcionais,
    },
  };
}

// POST - registra uma promoção no histórico. promo_type escolhe a matemática (ver o
// cabeçalho do bloco); a conta em si é toda do core.
// Derivações quando o campo vem vazio: valor_cobertura = cobertura EQUALIZADA (iguala o
// lucro dos dois cenários) a partir de valor+odd da promoção e odd de cobertura;
// lucro = pior cenário entre os dois, na fórmula do tipo; ROI = lucro/investimento real.
app.post('/api/promocoes', async (req, res) => {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const { erro, lido: p } = lerPromocaoDoCorpo(req.body);
  if (!p) return res.status(400).json({ error: erro || 'Corpo da promoção inválido.' });

  const calc = p.calcular(p.aporteInformado);
  let valorCobertura = p.aporteInformado;
  if (valorCobertura === null && calc) valorCobertura = calc.coverStakeEqualizado;
  const faltando = [
    !p.casaPromocao && 'casa_promocao', p.valorPromocao === null && 'valor_promocao',
    !p.evento && 'evento', !p.casaCobertura && 'casa_cobertura',
    // Aporte DERIVADO igual a zero também é ausente: o core clampa o equalizado em zero
    // quando a devolução efetiva passa do retorno bruto, e a linha ia para o banco com
    // valor_cobertura = 0,00 + o "lucro" de uma operação sem cobertura nenhuma. O aporte
    // INFORMADO como 0 já era recusado, e a skill gêmea que grava na MESMA tabela também
    // recusa — era a única porta que aceitava.
    !(valorCobertura! > 0) && 'valor_cobertura (ou odds das duas pernas p/ derivar)',
  ].filter(Boolean);
  if (faltando.length) {
    return res.status(400).json({ error: `Campos obrigatórios ausentes/inválidos: ${faltando.join(', ')}` });
  }

  // Recalcula com o aporte efetivamente gravado (pode ter vindo do corpo, não do equalizado).
  const comAporte = p.calcular(valorCobertura);
  let lucro = p.lucroInformado;
  if (lucro === null) {
    if (p.oddPromocao === null || p.oddCobertura === null) {
      return res.status(400).json({ error: 'Informe o lucro OU as odds das duas pernas (para o cálculo automático).' });
    }
    if (!comAporte) return res.status(400).json({ error: 'Valores inválidos para o cálculo do lucro (valor > 0 e odds > 1).' });
    lucro = comAporte.lucroGarantido;
  }
  // Investimento real = dinheiro que SAI DO BOLSO: quem já calculou isso é o core
  // (investimentoReal = custo do tipo + aporte), com a stake ELEGÍVEL e a polaridade certa
  // de ehFreebetSemCusto (SNR e SRR não contam a ficha; havia duas regras opostas no repo).
  // Sem odds não há cálculo — aí a conta é feita aqui, com a MESMA regra: freebet não conta a
  // ficha, e a stake elegível é o próprio valor (teto de stake sem odds não muda nada).
  // Somar a stake digitada quando o teto morde gravaria investimento que nunca foi à mesa e
  // um ROI que divergiria do lucro (calculado só sobre a parte elegível).
  const investido = comAporte
    ? comAporte.investimentoReal
    : ehFreebetSemCusto(p.tipo)
      ? valorCobertura!
      : Math.min(p.valorPromocao!, p.tetoStake ?? p.valorPromocao!) + valorCobertura!;
  const roiPct = p.roiInformado ?? (investido > 0 ? r2((lucro / investido) * 100) : null);

  const linha: Record<string, any> = {
    promo_type: p.promoType,
    casa_promocao: p.casaPromocao,
    valor_promocao: p.valorPromocao,
    evento: p.evento,
    mercado: p.mercado,
    casa_cobertura: p.casaCobertura,
    valor_cobertura: valorCobertura,
    odd_promocao: p.oddPromocao,
    odd_cobertura: p.oddCobertura,
    roi_pct: roiPct,
    lucro,
    ...p.colunasOpcionais(comAporte),
  };

  try {
    const { data, error } = await supabase.from('promo_surebets').insert(linha).select().single();
    if (error) throw error;
    res.json({ success: true, promocao: data, avisos: comAporte?.avisos || [] });
  } catch (error: any) {
    // Schema ANTES de isMissingTable: o 42703 de coluna ausente ("column ... does not
    // exist") casa com a regex de tabela ausente e mandaria aplicar a 018 sem necessidade.
    const pendencia = erroDeSchemaPromo(error, p.promoType, Object.keys(linha));
    if (pendencia) return res.status(500).json({ error: pendencia });
    if (isMissingTable(error)) {
      return res.status(500).json({ error: 'Tabela promo_surebets ausente no banco — aplique a migration 018_promo_surebets.sql (e as seguintes).' });
    }
    res.status(500).json({ error: error.message || 'Erro ao salvar promoção' });
  }
});

// POST - PREVIEW: mesma leitura de corpo e MESMA matemática do registro, sem gravar nada.
// É daqui que o formulário tira aporte da cobertura, lucro dos dois cenários e avisos: a
// alternativa é o frontend reimplementar as fórmulas, e duas cópias divergem no primeiro
// ajuste — divergir aqui significa mandar o usuário aportar valor errado na casa.
// Sem autenticação nova (o app não tem) e sem efeito colateral: só lê o corpo e calcula.
app.post('/api/promocoes/calcular', (req, res) => {
  const { erro, lido: p } = lerPromocaoDoCorpo(req.body);
  if (!p) return res.status(400).json({ ok: false, error: erro || 'Corpo da promoção inválido.' });
  // Aqui casa/evento não importam (nada é gravado), mas sem valor e as duas odds não existe
  // conta nenhuma — avisar qual campo falta é melhor que devolver zeros plausíveis.
  const faltando = [
    p.valorPromocao === null && 'valor_promocao',
    p.oddPromocao === null && 'odd_promocao',
    p.oddCobertura === null && 'odd_cobertura',
  ].filter(Boolean);
  if (faltando.length) {
    return res.status(400).json({ ok: false, error: `Sem esses campos não há cálculo: ${faltando.join(', ')}.` });
  }
  const calculo = p.calcular(p.aporteInformado);
  if (!calculo) {
    return res.status(400).json({ ok: false, error: 'Valores inválidos para o cálculo (valor_promocao > 0, odd_promocao > 1 e odd_cobertura > 1).' });
  }
  res.json({ ok: true, calculo });
});

// DELETE - remove uma promoção do histórico
app.delete('/api/promocoes/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('promo_surebets').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao excluir promoção' });
  }
});

// GET last 150 lines of logs/scanner.log
app.get('/api/logs', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.resolve(__dirname, '../logs/scanner.log');
    if (!fs.existsSync(logPath)) {
      return res.json({ logs: 'Aguardando logs do sistema...' });
    }
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const lastLines = lines.slice(-100).join('\n');
    res.json({ logs: lastLines });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao ler arquivo de logs' });
  }
});

// ============================ RADAR CASHOUT ============================
// Módulo isolado (schema cashout_*). Trading pré-live por Dropping Odds: a bússola
// (Pinnacle) define a linha justa e o worker detecta odds atrasadas nas casas alvo.

// GET - Oportunidades de cashout RECENTES (ativas + expiradas há pouco). Cada uma traz
// `ativa` (ainda vale agora). [] se nada recente.
app.get('/api/cashout/opportunities', async (_req, res) => {
  try {
    const oportunidades = await getRecentOpportunities();
    res.json({ oportunidades });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter oportunidades de cashout', oportunidades: [] });
  }
});

// 💎 Value bets (+EV) — RADAR-ONLY (tabela valor_oportunidades, migration 014). Fonte
// separada do arb: nunca dispara alerta, só alimenta a aba de valor no radar.
app.get('/api/valor', async (_req, res) => {
  try {
    const oportunidades = await getValorAtivas();
    res.json({ oportunidades });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter value bets', oportunidades: [] });
  }
});

app.delete('/api/valor/:id', async (req, res) => {
  try {
    const ok = await deleteValor(req.params.id);
    res.json({ ok });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao excluir value bet' });
  }
});

// 🎯 Middles (totais com linhas diferentes) — RADAR-ONLY (tabela middle_oportunidades).
app.get('/api/middles', async (_req, res) => {
  try {
    const oportunidades = await getMiddlesAtivos();
    res.json({ oportunidades });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter middles', oportunidades: [] });
  }
});

app.delete('/api/middles/:id', async (req, res) => {
  try {
    const ok = await deleteMiddle(req.params.id);
    res.json({ ok });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao excluir middle' });
  }
});

// 📐 Calibração do alerta de surebet — precisão scan→revalidação (tabela alerta_log).
app.get('/api/calibracao', async (req, res) => {
  try {
    const dias = Math.max(1, Math.min(365, Number(req.query.dias) || 30));
    const resumo = await getResumoCalibracao(dias);
    res.json(resumo);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter calibração' });
  }
});

app.get('/api/calibracao/alertas', async (_req, res) => {
  try {
    const alertas = await getAlertasRecentes();
    res.json({ alertas });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao obter alertas', alertas: [] });
  }
});

// GET - "Verificar": rebusca a odd MAIS RECENTE da casa desregulada p/ esta oportunidade
// (último snapshot do worker, ≤ ~1min) e diz se a odd mudou e se o valor ainda está de pé.
app.get('/api/cashout/opportunities/:id/verificar', async (req, res) => {
  try {
    const opp = await getOpportunityById(req.params.id);
    if (!opp) return res.status(404).json({ disponivel: false, mensagem: 'Oportunidade não encontrada.' });

    const snap = await getLatestTargetOdd(opp.event_id, opp.target_bookmaker_id, opp.selection, opp.line);
    if (!snap) {
      return res.json({ disponivel: false, casa: opp.target_name, mensagem: 'Sem cotação recente da casa — confira direto no site.' });
    }
    const ageSeconds = Math.round((Date.now() - new Date(snap.captured_at).getTime()) / 1000);
    if (ageSeconds > 180) {
      return res.json({ disponivel: false, casa: opp.target_name, ageSeconds, mensagem: 'Evento saiu do radar (cotação defasada) — confira direto na casa.' });
    }

    const oddAtual = Number(snap.odd_value);
    const oddOriginal = Number(opp.target_odd_value);
    const fair = Number(opp.fair_probability);
    const gapAtual = fair > 0 && oddAtual > 0 ? (fair - 1 / oddAtual) / (1 / oddAtual) : 0;

    res.json({
      disponivel: true,
      casa: opp.target_name,
      selecao: opp.selection_label,
      oddOriginal,
      oddAtual,
      ageSeconds,
      variou: Math.abs(oddAtual - oddOriginal) > 1e-9,
      direcao: oddAtual > oddOriginal ? 'subiu' : oddAtual < oddOriginal ? 'caiu' : 'igual',
      gapAtualPct: Number((gapAtual * 100).toFixed(1)),
      aindaVale: gapAtual >= CASHOUT_CONFIG.minGapPct,
    });
  } catch (error: any) {
    res.status(500).json({ disponivel: false, error: error.message || 'Erro ao verificar a oportunidade' });
  }
});

// GET - "Validar": consulta a odd AO VIVO na casa desregulada (busca dirigida
// oddsDoEvento, mesmo caminho do "revalidar" das surebets) e diz se ainda vale.
app.get('/api/cashout/opportunities/:id/validar', async (req, res) => {
  try {
    const opp = await getOpportunityById(req.params.id);
    if (!opp) return res.status(404).json({ disponivel: false, mensagem: 'Oportunidade não encontrada.' });

    const split = splitEvento(opp.event_label);
    if (!split) return res.json({ disponivel: false, casa: opp.target_name, mensagem: 'Evento inválido.' });
    const [canonHome, canonAway] = split;

    let liveOdds;
    try {
      liveOdds = await revalidation.oddsDaCasa(opp.target_name, opp.event_label, opp.sport);
    } catch {
      return res.json({ disponivel: false, aoVivo: true, casa: opp.target_name, mensagem: 'Casa indisponível agora (falha ao consultar ao vivo).' });
    }
    const match = (liveOdds || []).find(
      (o) => areEventsSame(o.evento, opp.event_label) && mesmaOferta(o.mercado, o.linha, opp.market_label, opp.line)
    );
    if (!match) {
      return res.json({ disponivel: false, aoVivo: true, casa: opp.target_name, mensagem: 'Evento/mercado não encontrado agora na casa (pode ter saído ou mudado a linha).' });
    }
    const legs = alignOdd(match, canonHome, canonAway);
    const leg = legs?.find((l) => l.selection === opp.selection);
    if (!leg) {
      return res.json({ disponivel: false, aoVivo: true, casa: opp.target_name, mensagem: 'Seleção não encontrada agora na casa.' });
    }

    const oddAtual = Number(leg.odd);
    const oddOriginal = Number(opp.target_odd_value);

    // Recalcula a JUSTA AO VIVO pela bússola (Pinnacle) — a justa congelada da detecção
    // mente quando a linha afiada se move (foi o caso da Eva Lopez: 14.46 → 17.01).
    let fairProb = Number(opp.fair_probability);
    let fairDefasada = true;
    let fairOddAtual: number | null = null;
    try {
      const compassOdds = await revalidation.oddsDaCasa('Pinnacle', opp.event_label, opp.sport);
      const cMatch = (compassOdds || []).find(
        (o) => areEventsSame(o.evento, opp.event_label) && mesmaOferta(o.mercado, o.linha, opp.market_label, opp.line)
      );
      if (cMatch) {
        const cLegs = alignOdd(cMatch, canonHome, canonAway);
        const dv = devig2Way(cMatch.oddA, cMatch.oddB);
        const idx = cLegs?.findIndex((l) => l.selection === opp.selection) ?? -1;
        if (dv && (idx === 0 || idx === 1)) {
          fairProb = idx === 0 ? dv.probA : dv.probB;
          fairOddAtual = Number((1 / fairProb).toFixed(2));
          fairDefasada = false;
        }
      }
    } catch {
      /* bússola indisponível — usa a justa congelada e sinaliza defasada */
    }

    const gapAtual = fairProb > 0 && oddAtual > 0 ? (fairProb - 1 / oddAtual) / (1 / oddAtual) : 0;

    res.json({
      disponivel: true,
      aoVivo: true,
      casa: opp.target_name,
      selecao: opp.selection_label,
      oddOriginal,
      oddAtual,
      fairOddOriginal: Number(opp.compass_fair_odd),
      fairOddAtual,
      fairDefasada,
      variou: Math.abs(oddAtual - oddOriginal) > 1e-9,
      direcao: oddAtual > oddOriginal ? 'subiu' : oddAtual < oddOriginal ? 'caiu' : 'igual',
      gapAtualPct: Number((gapAtual * 100).toFixed(1)),
      aindaVale: gapAtual >= CASHOUT_CONFIG.minGapPct,
    });
  } catch (error: any) {
    res.status(500).json({ disponivel: false, error: error.message || 'Erro ao validar a oportunidade' });
  }
});

// DELETE - "lixeira": exclui a oportunidade (e suas repetições) e a SUPRIME no worker,
// pra não reaparecer no próximo ciclo mesmo que ainda esteja sendo detectada.
app.delete('/api/cashout/opportunities/:id', async (req, res) => {
  try {
    const opp = await getOpportunityById(req.params.id);
    if (opp) {
      cashoutCapture.suppress(`${opp.event_label}|${opp.market_label}|${opp.selection_label}|${opp.target_name}`);
    }
    const ok = await deleteOpportunity(req.params.id);
    res.json({ ok });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao excluir a oportunidade' });
  }
});

// GET - Status do worker de captura (habilitado, intervalo, fontes, último ciclo).
app.get('/api/cashout/status', (_req, res) => {
  res.json({ ...cashoutCapture.status(), betMonitor: { ...cashoutBetMonitor.status(), casasComFonteLive: casasComFonteLive() } });
});

// ---------------------- MINHA APOSTA (cashout_user_bets) ----------------------
// A pessoa cadastra a aposta que já fez (casa, seleção, odd de entrada, stake) e o
// monitor por-aposta rastreia AO VIVO quanto vale e sinaliza a hora de sacar.

const SELECOES_VALIDAS = ['home', 'away', 'draw', 'over', 'under'];

// POST - cadastra uma aposta do usuário.
app.post('/api/cashout/bets', async (req, res) => {
  try {
    const b = req.body || {};
    const casa = String(b.casa || '').trim();
    const sport = String(b.sport || '').trim();
    const event_label = String(b.event_label || '').trim();
    const market_label = String(b.market_label || '').trim();
    const selection = String(b.selection || '').trim();
    const oddEntrada = Number(b.odd_entrada);

    if (!casa || !sport || !event_label || !market_label || !SELECOES_VALIDAS.includes(selection)) {
      return res.status(400).json({ ok: false, error: 'Campos obrigatórios: casa, sport, event_label, market_label e selection (home/away/draw/over/under).' });
    }
    if (!Number.isFinite(oddEntrada) || oddEntrada <= 1) {
      return res.status(400).json({ ok: false, error: 'odd_entrada deve ser um decimal > 1 (ex.: 2.75).' });
    }
    if (!splitEvento(event_label)) {
      return res.status(400).json({ ok: false, error: 'event_label deve estar no formato "Time A vs Time B".' });
    }
    const lineRaw = b.line === '' || b.line == null ? null : Number(b.line);
    const stakeRaw = b.stake === '' || b.stake == null ? null : Number(b.stake);

    const created = await insertUserBet({
      casa, sport, event_label, market_label,
      market_norm: normalizarMercado(market_label),
      selection: selection as any,
      selection_label: b.selection_label ? String(b.selection_label) : null,
      line: Number.isFinite(lineRaw as number) ? (lineRaw as number) : null,
      odd_entrada: oddEntrada,
      stake: Number.isFinite(stakeRaw as number) ? (stakeRaw as number) : null,
      starts_at: b.starts_at ? String(b.starts_at) : null,
    });
    if (!created) return res.status(500).json({ ok: false, error: 'Falha ao salvar a aposta (ver logs do banco).' });
    res.json({ ok: true, aposta: created });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao cadastrar a aposta' });
  }
});

// GET - lista as apostas (status=open por padrão; ?status=all inclui sacadas/liquidadas).
app.get('/api/cashout/bets', async (req, res) => {
  try {
    const status = String(req.query.status || 'open');
    const statuses = status === 'all' ? ['open', 'cashed', 'settled'] : [status];
    const apostas = await listUserBets(statuses);
    res.json({ apostas, casasComFonteLive: casasComFonteLive() });
  } catch (error: any) {
    res.status(500).json({ apostas: [], error: error.message || 'Erro ao listar apostas' });
  }
});

// GET - "monitorar": avalia UMA aposta AO VIVO agora (busca dirigida) e persiste o eval.
// alertar=false: consulta sob demanda NÃO dispara WhatsApp (só o ciclo do worker alerta).
app.get('/api/cashout/bets/:id/monitorar', async (req, res) => {
  try {
    const bet = await getUserBetById(req.params.id);
    if (!bet) return res.status(404).json({ ok: false, error: 'Aposta não encontrada.' });
    const avaliacao = await cashoutBetMonitor.avaliarAposta(bet, Date.now(), false);
    res.json({ ok: true, avaliacao });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao monitorar a aposta' });
  }
});

// POST - "Monitorar ao vivo": promove uma OPORTUNIDADE detectada para uma aposta em
// "Minhas Apostas" (odd de entrada = a odd atual do alvo), e o worker passa a rastreá-la
// AO VIVO avisando no WhatsApp a cada movimento + a hora de sacar. Dedupe por
// evento/mercado/seleção/casa (não cria duplicata se já estiver monitorando).
app.post('/api/cashout/opportunities/:id/monitorar', async (req, res) => {
  try {
    const opp = await getOpportunityById(req.params.id);
    if (!opp) return res.status(404).json({ ok: false, error: 'Oportunidade não encontrada.' });

    const abertas = await listUserBets(['open']);
    const jaExiste = abertas.find(
      (b) => b.event_label === opp.event_label && b.market_label === opp.market_label &&
        b.selection === opp.selection && b.casa === opp.target_name
    );
    if (jaExiste) return res.json({ ok: true, aposta: jaExiste, jaExistia: true });

    const stakeRaw = req.body && req.body.stake !== '' && req.body.stake != null ? Number(req.body.stake) : null;
    // Odd de entrada: usa a que o USUÁRIO informou (a que ele de fato pegou na aposta);
    // só cai na odd capturada do alvo se não vier nenhuma válida.
    const oddRaw = req.body && req.body.odd_entrada !== '' && req.body.odd_entrada != null ? Number(req.body.odd_entrada) : NaN;
    const oddEntrada = Number.isFinite(oddRaw) && oddRaw > 1 ? oddRaw : Number(opp.target_odd_value);
    const created = await insertUserBet({
      casa: opp.target_name,
      sport: opp.sport,
      event_label: opp.event_label,
      market_label: opp.market_label,
      market_norm: normalizarMercado(opp.market_label),
      selection: opp.selection,
      selection_label: opp.selection_label,
      line: opp.line == null ? null : Number(opp.line),
      odd_entrada: oddEntrada,
      stake: Number.isFinite(stakeRaw as number) ? (stakeRaw as number) : null,
      starts_at: opp.starts_at || null,
    });
    if (!created) return res.status(500).json({ ok: false, error: 'Falha ao criar o monitoramento.' });
    res.json({ ok: true, aposta: created });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao promover a oportunidade' });
  }
});

// PATCH - muda o status da aposta (marcar como sacada/liquidada/reabrir).
app.patch('/api/cashout/bets/:id/status', async (req, res) => {
  try {
    const status = String((req.body || {}).status || '').trim();
    if (!['open', 'cashed', 'settled'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status deve ser open, cashed ou settled.' });
    }
    const ok = await updateUserBetStatus(req.params.id, status);
    res.json({ ok });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao atualizar status' });
  }
});

// DELETE - remove a aposta (soft-delete).
app.delete('/api/cashout/bets/:id', async (req, res) => {
  try {
    const ok = await updateUserBetStatus(req.params.id, 'deleted');
    res.json({ ok });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'Erro ao excluir a aposta' });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`🚀 JotinhaBet Backend running on http://localhost:${port}`);
  console.log(`👉 Health check: http://localhost:${port}/api/health`);

  // Aviso automático de "deploy concluído" (o boot equivale ao fim do service update
  // no Swarm). Espera ~5s a rede/Evolution assentar antes da 1ª tentativa; fire-and-forget.
  setTimeout(() => { void avisarDeployWhatsApp(); }, 5_000);

  // Scan agendado do SureRadar a cada 10 min (alinhado ao ciclo de atualização do próprio SureRadar)
  const scheduler = new SchedulerService();
  scheduler.start(5); // pré-match sempre fresco: varredura + reconciliação a cada 5 min

  // Fonte Telegram: escuta o grupo de sinais e injeta oportunidades extraídas
  // por IA de visão no pipeline (gates + revalidação + WhatsApp).
  telegramIngest.start().catch((e) => console.error('❌ [Telegram] Falha ao iniciar ingest:', e?.message || e));

  // Monitor pós-partida: quando a partida de uma entrada termina, manda o WhatsApp
  // de GREEN (parabéns + lucro + banca). Ciclo de 15 min (timing não é crítico).
  new GreenMonitorService().start(900);

  // Digest noturno de value bets: resumo diário (default 18:30 SP) das +EV que começam
  // à noite — janela em que o usuário tem mais disponibilidade. Value bets são
  // radar-only (sem alerta individual); o digest cobre essa lacuna no WhatsApp.
  if (process.env.DIGEST_NOTURNO_ENABLED !== 'false') {
    new DigestNoturnoService().start();
  } else {
    console.log('ℹ️ [DigestNoturno] Desligado (DIGEST_NOTURNO_ENABLED=false).');
  }

  // Radar Cashout: worker de captura da série temporal de odds (bússola × alvos) e
  // detecção de Dropping Odds. Guardado por CASHOUT_CAPTURE_ENABLED (default on).
  cashoutCapture.start().catch((e) => console.error('❌ [Cashout] Falha ao iniciar captura:', e?.message || e));

  // Radar Cashout — monitor POR-APOSTA ("Minha aposta"): rastreia AO VIVO as apostas
  // que o usuário cadastrou (valor de saque + sinal). Guardado por CASHOUT_BET_MONITOR_ENABLED.
  cashoutBetMonitor.start().catch((e) => console.error('❌ [Cashout/Bets] Falha ao iniciar monitor:', e?.message || e));

  // Worker das casas de BROWSER (Betano/Blaze/1xBet): coleta em cadência própria e alimenta
  // o browserOddsCache, que a varredura lê para incluí-las no scan automático. DESLIGADO por
  // padrão (mexe na carga da VPS 1-core) — ligar com BROWSER_WORKER_ENABLED=true observando o load.
  if (process.env.BROWSER_WORKER_ENABLED === 'true') {
    new BrowserScrapeWorker().start(Number(process.env.BROWSER_WORKER_MINUTES) || 20);
  } else {
    console.log('ℹ️ [BrowserWorker] Desligado (defina BROWSER_WORKER_ENABLED=true p/ incluir Betano/Blaze/1xBet no scan automático).');
  }

  // Enriquecimento de IA é MANUAL (botão "Analisar IA") para poupar tokens/cota das APIs.
  // O worker automático fica desligado de propósito; a análise roda sob demanda via
  // POST /api/opportunities/:id/enrich. (Para religar o modo automático: enrichment.start(30).)

  // Executa a limpeza imediata de oportunidades expiradas ao subir o servidor
  scanner.limparOportunidadesExpiradas();

  // Executa a limpeza de oportunidades expiradas (por horário do evento) a cada 10 minutos
  setInterval(() => {
    scanner.limparOportunidadesExpiradas();
  }, 10 * 60 * 1000);
});
