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
import { RevalidationService } from './core/revalidationService';
import { requireApiToken } from './auth/apiToken';
import { generateWithFallback } from './IA/aiProvider';
import { WhatsAppNotifier } from './notify/whatsapp';

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
app.use(express.json());

// Worker de enriquecimento assíncrono de risco por IA.
const enrichment = new EnrichmentService();
// Serviço de revalidação de odds (§6 do kickoff).
const revalidation = new RevalidationService();

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
app.post('/api/scan', async (req, res) => {
  const { dataFiltro, aoVivo, sureradarOnly } = req.body;
  try {
    const opports = await scanner.executarVarredura(dataFiltro, !!aoVivo, !!sureradarOnly);
    res.json({ success: true, count: opports.length, opportunities: opports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao executar varredura' });
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

// DELETE all opportunities (useful for clearing dashboard list)
app.delete('/api/opportunities', async (req, res) => {
  try {
    const { error } = await supabase
      .from('oportunidades')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Erro ao limpar histórico' });
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

// Start Server
app.listen(port, () => {
  console.log(`🚀 JotinhaBet Backend running on http://localhost:${port}`);
  console.log(`👉 Health check: http://localhost:${port}/api/health`);

  // Scan agendado do SureRadar a cada 10 min (alinhado ao ciclo de atualização do próprio SureRadar)
  const scheduler = new SchedulerService();
  scheduler.start(5); // pré-match sempre fresco: varredura + reconciliação a cada 5 min

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
