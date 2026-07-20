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
import { RevalidationService } from './core/revalidationService';
import { requireApiToken } from './auth/apiToken';
import { generateWithFallback } from './IA/aiProvider';
import { WhatsAppNotifier } from './notify/whatsapp';
import { avisarDeployWhatsApp } from './notify/deployNotice';
import { extrairSinalDeImagem } from './IA/extractors/telegramSignalExtractor';
import { SignalPipeline } from './signals/signalPipeline';
import { TelegramIngestService } from './signals/telegramIngestService';
import { regraPermiteOportunidade } from './arbitrage/regras';
import { cashoutCapture } from './cashout/cashoutCapture';
import { getRecentOpportunities, getOpportunityById, getLatestTargetOdd, deleteOpportunity } from './cashout/cashoutRepo';
import { CASHOUT_CONFIG, devig2Way } from './cashout/cashoutEngine';
import { alignOdd } from './cashout/cashoutMatch';
import { areEventsSame, splitEvento } from './arbitrage/matcher';
import { mesmaOferta } from './arbitrage/markets';

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
app.use((req, res, next) => (req.path.startsWith('/api/telegram') ? jsonGrande : jsonPadrao)(req, res, next));

// Worker de enriquecimento assíncrono de risco por IA.
const enrichment = new EnrichmentService();
// Serviço de revalidação de odds (§6 do kickoff).
const revalidation = new RevalidationService();
// Listener do grupo de sinais no Telegram (GramJS) — no-op sem envs TELEGRAM_*.
const telegramIngest = new TelegramIngestService();

// Initialize AI providers
const geminiProvider = new GeminiProvider();
const openaiProvider = new OpenAIProvider();

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    // Check if we can perform a simple select (even if it returns empty, it verifies client connection status)
    const { error } = await supabase.from('casas_apostas').select('id').limit(1);
    if (!error || error.code !== 'PGRST116') { // PGRST116 is just "no rows returned" in some cases or similar, but if connection failed it would be a network error
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
      ai: {
        gemini: process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.includes('your-') ? 'configured' : 'mock-mode',
        openai: process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your-') ? 'configured' : 'mock-mode',
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

// Copiloto de Arbitragem — chat conversacional (multi-turno)
const COPILOT_SYSTEM =
  'Você é o Copiloto do JotinhaBet, um assistente especialista em arbitragem esportiva (surebets), ' +
  'gestão de banca e regras de casas de apostas. Responda SEMPRE em português do Brasil, de forma objetiva e prática. ' +
  'Explique riscos quando relevante: erro palpável (odds absurdas), regras de anulação/void divergentes entre casas ' +
  '(ex.: desistência no tênis, prorrogação no basquete), liquidez e limitação de conta. ' +
  'Nunca prometa lucro garantido sem ressalvas e lembre que a execução da aposta é manual — o sistema nunca aposta sozinho. ' +
  'Se não souber, diga que não sabe. Seja conciso.';

app.post('/api/ai/chat', requireApiToken, async (req, res) => {
  const { messages } = req.body;
  // Mantém só mensagens com conteúdo textual real e limita o histórico enviado ao LLM.
  const validas = (Array.isArray(messages) ? messages : [])
    .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-40);
  if (validas.length === 0) {
    return res.status(400).json({ error: 'Envie ao menos uma mensagem com conteúdo.' });
  }
  try {
    // Monta o histórico multi-turno em um prompt textual (a interface IAProvider é single-prompt).
    const historico = validas
      .map((m: any) => `${m.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${m.content.trim()}`)
      .join('\n');
    const prompt = `${historico}\nAssistente:`;

    const { text, provider } = await generateWithFallback(prompt, COPILOT_SYSTEM);
    res.json({ reply: text, provider });
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
  res.json(cashoutCapture.status());
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

  // Radar Cashout: worker de captura da série temporal de odds (bússola × alvos) e
  // detecção de Dropping Odds. Guardado por CASHOUT_CAPTURE_ENABLED (default on).
  cashoutCapture.start().catch((e) => console.error('❌ [Cashout] Falha ao iniciar captura:', e?.message || e));

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
