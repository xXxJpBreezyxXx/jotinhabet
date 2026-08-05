import { Component, useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { 
  TrendingUp, 
  Cpu, 
  DollarSign, 
  Layers, 
  CheckCircle, 
  Send, 
  Activity, 
  AlertCircle,
  Calculator,
  Percent,
  RefreshCw,
  Trash2,
  X,
  ChevronRight,
  ExternalLink,
  Sun,
  Moon,
  Save,
  Bookmark,
  BookmarkCheck,
  Wallet,
  Plus,
  Radar,
  Gift,
  Menu,
  Wrench,
  Image as ImageIcon,
  ChevronDown,
  Info
} from 'lucide-react';

// Markdown das respostas do agente (aba IA & Automação) em CHUNK SEPARADO: as libs
// (react-markdown + remark-gfm, ~47 KB gzip) só baixam quando a aba do chat abre — o
// bundle inicial, que todo mundo paga, fica igual.
const Markdown = lazy(() => import('./Markdown'));

/**
 * Casca de segurança do chunk de markdown. Se o download do chunk falhar (rede ruim no
 * celular) ou o renderer lançar em algum markdown estranho, o React propaga o erro e
 * DESMONTA a aba inteira — tela branca no lugar da conversa. Aqui o erro degrada para o
 * texto cru, que é exatamente o que era exibido antes deste lote.
 */
class MarkdownBoundary extends Component<{ texto: string; children: ReactNode }, { erro: boolean }> {
  state = { erro: false };
  static getDerivedStateFromError() {
    return { erro: true };
  }
  render() {
    if (this.state.erro) return <div style={{ whiteSpace: 'pre-wrap' }}>{this.props.texto}</div>;
    return this.props.children;
  }
}

interface HealthStatus {
  status: string;
  timestamp: string;
  services: {
    database: string;
    ai: {
      gemini: string;
      openai: string;
    }
  }
}

interface CalculatorResult {
  isArbitrage: boolean;
  oddMinimaExigida: number;
  margemTeoricaPct: number;
  stake1: number;
  stake2: number;
  investimentoTotal: number;
  retornoCasa1: number;
  retornoCasa2: number;
  lucroCasa1: number;
  lucroCasa2: number;
  piorLucro: number;
  melhorLucro: number;
  piorRoiPct: number;
  melhorRoiPct: number;
}



interface OpportunityItem {
  id: string;
  evento: string;
  odd_casa_1: number;
  odd_casa_2: number;
  margem_mercado: number;
  stake_casa_1: number;
  stake_casa_2: number;
  lucro_esperado: number;
  roi_pct: number;
  status: string;
  detectada_em: string;
  casa_a_nome?: string;
  casa_b_nome?: string;
  opcao_a?: string;
  opcao_b?: string;
  mercado?: string;
  analise_ia?: string;
  esporte?: string;
  salva?: boolean; // salva pelo usuário: o rescan nunca a remove (migration 009)
  url?: string;
  fonte?: string;  // origem explícita (migration 010): 'telegram' | null (demais fontes inferem por url)
  // Links diretos do grupo do Telegram (migration 017): por perna + lista completa
  url_casa_1?: string | null;
  url_casa_2?: string | null;
  links_grupo?: Array<{ url: string; casa?: string | null }> | null;
  // Enriquecimento de risco por IA (async)
  ia_status?: 'pendente' | 'processando' | 'concluido' | 'erro';
  ia_risco?: 'ok' | 'atencao' | 'critico';
  ia_veredito?: {
    nivel_risco: 'ok' | 'atencao' | 'critico';
    tipo: string;
    motivo: string;
    confianca: number;
    fonte?: string;
  };
  // "Visto por último" (reconfirmado no re-scan) e revalidação (§6)
  visto_em?: string;
  revalidado_em?: string;
  revalidacao?: {
    checado_em: string;
    fonte?: string;
    odd_a: number | null;
    odd_b: number | null;
    roi_anterior?: number;
    roi_atual: number | null;
    status: string;
    movimento: { tipo: string; explicacao: string } | null;
  };
}

/** Idade da odd a partir de um ISO timestamp, com nível de "frescor". */
function oddAgeInfo(iso?: string): { label: string; level: 'fresh' | 'warn' | 'stale' } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  const label =
    mins < 1 ? 'agora' : mins < 60 ? `há ${mins} min` : `há ${Math.floor(mins / 60)}h${(mins % 60).toString().padStart(2, '0')}`;
  // SureRadar atualiza a cada ~10 min → fresh <10, atenção 10–20, velho >20.
  const level: 'fresh' | 'warn' | 'stale' = mins < 10 ? 'fresh' : mins < 20 ? 'warn' : 'stale';
  return { label, level };
}

/** Timestamp mais recente entre detecção, "visto por último" e revalidação (idade real da odd). */
function latestOddTs(opp: { detectada_em?: string; visto_em?: string; revalidado_em?: string }): string | undefined {
  const cands = [opp.detectada_em, opp.visto_em, opp.revalidado_em].filter(Boolean) as string[];
  if (cands.length === 0) return undefined;
  return cands.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b));
}

/** URL do site da casa a partir do nome (não há deep-link no SureRadar; abre a home da casa).
 *  Fallback: busca no Google, pra nunca abrir em branco. */
function getHouseUrl(casaRaw: string): string {
  const c = (casaRaw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(br\)/g, '')
    .replace(/[^a-z0-9]/g, '');
  const map: [string, string][] = [
    ['betano', 'https://www.betano.bet.br'],
    ['superbet', 'https://superbet.bet.br'],
    ['kto', 'https://www.kto.bet.br'],
    ['blaze', 'https://blaze.bet.br'],
    ['1xbet', 'https://1xbet.bet.br'],
    ['bet365', 'https://www.bet365.bet.br'],
    ['betnacional', 'https://betnacional.bet.br'],
    ['betboom', 'https://betboom.bet.br'],
    ['betwarrior', 'https://betwarrior.bet.br'],
    ['aposta1', 'https://www.aposta1.bet.br'],
    ['novibet', 'https://www.novibet.bet.br'],
    ['estrelabet', 'https://www.estrelabet.bet.br'],
    ['sportingbet', 'https://sports.sportingbet.bet.br'],
    ['betpix365', 'https://betpix365.bet.br'],
    ['bet7k', 'https://bet7k.com'],
    ['pixbet', 'https://pixbet.com'],
    ['seubet', 'https://seubet.bet.br'],
  ];
  for (const [key, url] of map) {
    if (c.includes(key)) return url;
  }
  return `https://www.google.com/search?q=${encodeURIComponent((casaRaw || '').replace(/\(BR\)/gi, '').trim() + ' apostas bet.br')}`;
}

/** Surebet "VIP": oculta no painel do SureRadar e capturada via API. O backend marca
 *  essas oportunidades no texto da análise (ver backend/src/scraping/casa_sureradar.ts). */
function isVipOpportunity(opp: { analise_ia?: string }): boolean {
  return /surebet vip/i.test(opp.analise_ia || '');
}

/** Origem da oportunidade: 'telegram' (sinal do grupo, coluna fonte da migration 010),
 *  'sureradar' (agregador, inferida por url) ou 'prematch' (motor próprio). */
function fonteOportunidade(opp: { url?: string; analise_ia?: string; fonte?: string }): 'telegram' | 'sureradar' | 'prematch' {
  if (opp.fonte === 'telegram') return 'telegram';
  const s = `${opp.url || ''} ${opp.analise_ia || ''}`.toLowerCase();
  return s.includes('sureradar') ? 'sureradar' : 'prematch';
}

/** Uma casa e o valor que o usuário tem disponível nela (valor como string p/ o input). */
interface SaldoCasa {
  casa: string;
  valor: string;
}

/** Casas pré-carregadas na aba "Saldo nas Casas" no primeiro uso — o usuário pode
 *  adicionar/remover livremente; a lista salva passa a ser a fonte da verdade. */
const CASAS_PADRAO = [
  'Betano', 'Superbet', 'KTO', 'Blaze', '1xBet', 'Bet365', 'Betnacional', 'BetBoom',
  'BetWarrior', 'Aposta1', 'Novibet', 'Sportingbet', 'SeuBet', 'Vbet', 'Pinnacle',
];

/** Aposta de VALOR (+EV vs Pinnacle), como devolvida por GET /api/valor. */
interface ValorOportunidade {
  id: string;
  esporte?: string;
  evento: string;
  mercado: string;
  linha?: number | null;
  casa: string;
  opcao: string;
  odd_casa: number;
  fair_odd: number;
  prob_real: number;
  edge_pct: number;       // 5.0 = +5% de EV
  referencia: string;     // ex.: 'Pinnacle'
  confianca?: number | null;
  starts_at?: string | null;
  detected_at: string;
}

/** Calibração do alerta — resumo (GET /api/calibracao) e itens (GET /api/calibracao/alertas). */
interface CalibFaixa {
  enviados: number;
  suprimidos: number;
  naoVerificados: number;
  taxaSobrevivencia: number | null; // % dos flagrados que a revalidação confirmou
}
interface CalibResumo {
  dias: number;
  total: number;
  geral: CalibFaixa;
  driftMedioPp: number | null;      // média (ROI revalidado − ROI scan), em pontos %
  porFonte: Record<string, CalibFaixa>;
  comPinnacle: CalibFaixa;
  semPinnacle: CalibFaixa;
  atualizadoEm: string;
}
interface CalibAlerta {
  id: string;
  fonte: string;
  esporte?: string;
  evento: string;
  mercado?: string;
  casa_a?: string;
  casa_b?: string;
  roi_scan?: number;
  roi_revalidado?: number;
  confianca?: number;
  envolve_pinnacle?: boolean;
  resultado: string;                // 'enviado' | 'suprimido' | 'nao_verificado'
  motivo?: string;
  created_at: string;
}

/** Middle (totais com linhas diferentes), como devolvido por GET /api/middles. */
interface ValorMiddle {
  id: string;
  esporte?: string;
  evento: string;
  mercado: string;
  over_casa: string;
  over_odd: number;
  over_linha: number;
  under_casa: string;
  under_odd: number;
  under_linha: number;
  largura: number;
  pior_caso_roi_pct: number;   // >=0: lucro garantido + middle; <0: custo se o meio não bater
  starts_at?: string | null;
  detected_at: string;
}

/** Oportunidade do Radar Cashout, como devolvida por GET /api/cashout/opportunities. */
interface CashoutOpportunity {
  id: string;
  event_label: string;
  sport: string;
  market_label: string;
  selection_label: string;
  target_name: string;
  compass_fair_odd: number;
  target_odd_value: number;
  gap_pct: number;             // 0.05 = 5%
  drop_pct?: number;           // queda da odd afiada na janela (0.04 = caiu 4%)
  confirming_sources: string[];
  ttl_estimated_seconds: number | null;
  r_squared: number | null;
  detected_at: string;
  starts_at?: string | null;
  status?: string;
  ativa?: boolean;
}

/** Resultado do "Verificar" (rebusca a odd atual da casa). */
interface CashoutVerificacao {
  loading?: boolean;
  disponivel?: boolean;
  mensagem?: string;
  oddOriginal?: number;
  oddAtual?: number;
  ageSeconds?: number;
  variou?: boolean;
  direcao?: 'subiu' | 'caiu' | 'igual';
  gapAtualPct?: number;
  aindaVale?: boolean;
  fairOddOriginal?: number;
  fairOddAtual?: number | null;
  fairDefasada?: boolean;
}

interface CashoutStatus {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  sports: string[];
  targets: string[];
  compass: string;
  minConfirmingSources: number;
  trackedSeries: number;
  lastCycle: { at: number; snapshots: number; opportunities: number; compassOdds: number };
}

/** Aposta do usuário monitorada AO VIVO (GET /api/cashout/bets). */
interface CashoutBet {
  id: string;
  casa: string;
  sport: string;
  event_label: string;
  market_label: string;
  selection: 'home' | 'away' | 'draw' | 'over' | 'under';
  selection_label?: string | null;
  line?: number | string | null;
  odd_entrada: number | string;
  stake?: number | string | null;
  status: string;
  last_fair_prob?: number | string | null;
  last_fair_odd?: number | string | null;
  last_house_odd?: number | string | null;
  last_cashout_value?: number | string | null;
  last_profit?: number | string | null;
  last_drop_pct?: number | string | null;
  last_signal?: boolean | null;
  last_note?: string | null;
  last_eval_at?: string | null;
  starts_at?: string | null;
  created_at?: string;
}

/** Nº seguro (PostgREST devolve numeric como string às vezes). */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** True quando o kickoff já passou (badge AO VIVO derivado do starts_at). */
function ehAoVivo(startsAt?: string | null): boolean {
  if (!startsAt) return false;
  const t = Date.parse(startsAt);
  return !isNaN(t) && t <= Date.now();
}

function AoVivoBadge() {
  return (
    <span style={{
      background: '#ef4444', color: '#fff', fontSize: '10px', fontWeight: 800,
      padding: '2px 7px', borderRadius: '999px', letterSpacing: '0.05em', whiteSpace: 'nowrap',
    }}>● AO VIVO</span>
  );
}

/** Data LOCAL (não UTC) de um timestamp, no formato YYYY-MM-DD (o mesmo do <input type="date">). */
function dataLocalYMD(iso: string | Date): string {
  const dt = new Date(iso);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" → "dd/mm" para exibição compacta nas tabelas. */
function ymdParaDDMM(ymd: string): string {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

const ESPORTE_EMOJI: Record<string, string> = {
  'Futebol': '⚽', 'Basquete': '🏀', 'Tênis de Mesa': '🏓', 'Tênis': '🎾',
  'Esports': '🎮', 'Vôlei': '🏐', 'Beisebol': '⚾', 'Hóquei': '🏒', 'Outro': '🏆',
};

/**
 * Esporte canônico de uma entrada do histórico (para filtro/badge). Usa
 * detalhes.esporte quando gravado (entradas novas); nas antigas, sem o campo,
 * infere pelo nome do evento com a MESMA heurística do badge dos cards do radar
 * (inclusive "vs"/"×" → Futebol), para o histórico classificar igual ao card
 * que o usuário viu ao lançar.
 */
function esporteDaEntrada(d: { esporte?: string; evento?: string } | null | undefined): string {
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const esp = norm(String(d?.esporte || ''));
  if (esp) {
    if (esp.includes('futebol') || esp.includes('football') || esp.includes('soccer')) return 'Futebol';
    if (esp.includes('basquete') || esp.includes('basket')) return 'Basquete';
    // Mesa ANTES de tênis: "tenis de mesa" contém "tenis".
    if (esp.includes('mesa') || esp.includes('table tennis')) return 'Tênis de Mesa';
    if (esp.includes('tenis') || esp.includes('tennis')) return 'Tênis';
    if (esp.includes('esport')) return 'Esports';
    if (esp.includes('volei') || esp.includes('volley')) return 'Vôlei';
    if (esp.includes('beisebol') || esp.includes('baseball')) return 'Beisebol';
    if (esp.includes('hoquei') || esp.includes('hockey')) return 'Hóquei';
  }
  const evento = String(d?.evento || '');
  const ev = evento.toLowerCase();
  if (ev.includes('lakers') || ev.includes('celtics') || ev.includes('nba')) return 'Basquete';
  if (ev.includes('djokovic') || ev.includes('alcaraz') || ev.includes('federer') || ev.includes('nadal')) return 'Tênis';
  if (ev.includes('loud') || ev.includes('pain') || ev.includes('gaming')) return 'Esports';
  if (evento.includes('×') || ev.includes(' vs ')) return 'Futebol';
  return 'Outro';
}

/** Data/horário do evento em pt-BR (America/Sao_Paulo), ex.: "21/07 20:00". null se ausente/inválido. */
function fmtDataHora(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(t)).replace(',', '');
  } catch {
    return null;
  }
}

/** Badge do gap/EV — verde forte >=8%, âmbar >=5%, cinza abaixo. */
function CashoutGapBadge({ gapPct }: { gapPct: number }) {
  const bg = gapPct >= 0.08 ? '#10b981' : gapPct >= 0.05 ? '#f59e0b' : '#64748b';
  return (
    <span style={{
      background: bg, color: '#fff', fontSize: '12px', fontWeight: 700,
      padding: '3px 10px', borderRadius: '999px', whiteSpace: 'nowrap',
    }}>
      +{(gapPct * 100).toFixed(1)}%
    </span>
  );
}

/**
 * Espelho SÓ DE TIPO do SnapshotSincronia de backend/src/core/sureradarSync.ts (os campos que
 * esta tela usa). Nada é calculado aqui: cadência, defasagem e previsões vêm do backend, que é
 * quem mede. O painel só converte segundos em texto e desconta o desvio de relógio.
 */
interface SyncSnapshot {
  geradoEm: string;
  deles: {
    ultimaAtualizacao: string | null;
    idadeSeg: number | null;
    cadenciaSeg: number | null;
    cadenciaConfiavel: boolean;
    cadenciaAmostras: number;
    proximaAtualizacaoPrevista: string | null;
    vidaRestanteSeg: number | null;
    total: number | null;
    conectado: boolean | null;
  };
  nosso: {
    ultimaVarredura: string | null;
    duracaoUltimaSeg: number | null;
    intervaloSeg: number | null;
    proximaVarredura: string | null;
    segundosParaProxima: number | null;
    /** Leitura LEVE (só o painel deles, ~1,2s) — null quando o worker está desligado. */
    intervaloLeveSeg: number | null;
    proximaLeituraLeve: string | null;
    segundosParaProximaLeitura: number | null;
    ajusteFaseSeg: number | null;
    alinhamentoAtivo: boolean;
    importadasUltima: number | null;
    fonteUltima: 'api' | 'browser' | 'none' | null;
  };
  sincronia: {
    estado: 'sincronizado' | 'desalinhado' | 'desatualizado' | 'sem-dados';
    alvoSeg: number;
    defasagemUltimaSeg: number | null;
    defasagemMedianaSeg: number | null;
    atualizacoesPerdidas: number;
    atualizacoesPendentes: number;
    ciclosObservados: number;
    atualizacoesObservadas: number;
    recomendacao: string | null;
  };
  dados: {
    /** Idade da linha mais nova: a idade REAL das odds (o carimbo do painel deles é outro). */
    legIdadeMinSeg: number | null;
    legIdadeMedianaSeg: number | null;
    legIdadeMaxSeg: number | null;
    eventoMaisAntigo: string | null;
  };
  avisos: string[];
}

/** Segundos → "45s" / "4m20s" / "1h05m". null/negativo viram "—"/"0s". */
function durSeg(seg: number | null | undefined): string {
  if (seg == null || !Number.isFinite(seg)) return '—';
  const s = Math.max(0, Math.round(seg));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Faixa de SINCRONIA com o SureRadar (topo do radar).
 *
 * O número que importa é "vida restante": o painel deles recalcula a cada ~10 min e, quando a
 * nossa varredura cai pouco antes do recálculo, a surebet entra no banco com a vida quase toda
 * gasta — some do site antes de alguém clicar. Aqui dá para ver a cadência DELES, a nossa, e a
 * defasagem entre as duas (o backend é quem mede; ver core/sureradarSync.ts).
 *
 * `agoraServidorMs` é o "agora" do BACKEND (Date.now() do navegador menos o desvio medido no
 * último poll): os instantes do snapshot estão na base de tempo do servidor, e comparar com o
 * relógio do navegador faria um PC atrasado exibir contagem negativa com tudo em ordem.
 */
function SincroniaSureRadar({ sync, agoraServidorMs, onEscanear }: { sync: SyncSnapshot; agoraServidorMs: number; onEscanear: () => void }) {
  const [aberto, setAberto] = useState(false);
  const desde = (iso: string | null): number | null => (iso ? (agoraServidorMs - Date.parse(iso)) / 1000 : null);
  const ate = (iso: string | null): number | null => (iso ? (Date.parse(iso) - agoraServidorMs) / 1000 : null);

  const estado = sync.sincronia.estado;
  const visual = {
    sincronizado: { cor: '#10b981', rotulo: 'sincronizado', dica: `A varredura cai logo depois do recálculo do SureRadar (alvo: ${sync.sincronia.alvoSeg}s).` },
    desalinhado: { cor: '#f59e0b', rotulo: 'fora de fase', dica: 'Capturamos tarde no ciclo deles: as surebets entram no banco com boa parte da vida já gasta.' },
    desatualizado: { cor: '#ef4444', rotulo: 'dado vencido', dica: 'O SureRadar já recalculou depois da nossa última captura — o que está na tela pode não existir mais no site.' },
    'sem-dados': { cor: 'var(--text-muted)', rotulo: 'medindo', dica: 'Ainda sem leitura do relógio do painel: a medição começa na próxima varredura.' },
  }[estado];

  // Vida restante recontada no cliente a partir da previsão (o poll é a cada 15s; sem isso o
  // número ficaria congelado entre polls e pareceria travado).
  const vidaRestante = ate(sync.deles.proximaAtualizacaoPrevista) ?? sync.deles.vidaRestanteSeg;
  const idadeDeles = desde(sync.deles.ultimaAtualizacao) ?? sync.deles.idadeSeg;
  // A próxima leitura do painel é a MAIS PRÓXIMA entre a leve e a completa (o backend já manda
  // esse mínimo; aqui é só recontado no cliente para o número andar entre polls).
  const proximosIso = [sync.nosso.proximaLeituraLeve, sync.nosso.proximaVarredura]
    .map((iso) => ate(iso))
    .filter((v): v is number => v != null);
  const proximaLeitura = proximosIso.length ? Math.min(...proximosIso) : sync.nosso.segundosParaProximaLeitura;
  const vidaCurta = vidaRestante != null && vidaRestante <= 60;

  const celula = (rotulo: string, valor: string, dica: string, cor?: string) => (
    <div className="sync-celula" title={dica}>
      <span className="sync-rotulo">{rotulo}</span>
      <strong style={cor ? { color: cor } : undefined}>{valor}</strong>
    </div>
  );

  return (
    <div className="glass-panel sync-faixa">
      <div className="sync-linha">
        <button className="sync-badge" style={{ borderColor: visual.cor, color: visual.cor }} onClick={() => setAberto((a) => !a)} title={visual.dica}>
          🕒 Sincronia SureRadar · {visual.rotulo}
          <ChevronDown size={11} style={{ transform: aberto ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
        </button>

        {celula(
          'Vida restante do dado',
          durSeg(vidaRestante),
          'Tempo até o próximo recálculo do painel deles (previsto pela cadência medida). Chegando a zero, as odds da tela podem já ter mudado no site.',
          vidaCurta ? '#ef4444' : undefined
        )}
        {celula('Painel deles atualizou', `há ${durSeg(idadeDeles)}`, 'Última vez que o SureRadar recalculou, pelo relógio do próprio painel (campo idade_seg da API deles).')}
        {/* O carimbo do painel e o `updated_at` das linhas divergem (numa leitura de 05/08:
            painel há 59s, linhas com 204s). A idade que vale para a ODD é a da linha. */}
        {sync.dados.legIdadeMinSeg != null &&
          celula(
            'Odds mais novas',
            `há ${durSeg(sync.dados.legIdadeMinSeg + (desde(sync.nosso.ultimaVarredura) ?? 0))}`,
            'Idade da surebet mais fresca da última leitura (updated_at da própria linha) somada ao tempo desde a nossa varredura. ' +
              'O painel deles pode se dizer atualizado agora com as linhas mais velhas que isso.'
          )}
        {celula(
          'Cadência deles',
          `~${durSeg(sync.deles.cadenciaSeg)}${sync.deles.cadenciaConfiavel ? '' : '?'}`,
          `Medida por nós em ${sync.deles.cadenciaAmostras} intervalo(s) observado(s).` +
            (sync.deles.cadenciaConfiavel ? '' : ' Ainda sem confiança: previsões e alinhamento automático seguem suspensos.')
        )}
        {/* "Nossa leitura" e não "nossa varredura": desde 05/08 quem lê o painel com mais
            frequência é o worker leve (~1,2s), e a varredura completa (5 min) virou a lenta das
            duas. O que interessa é quando o painel será reconferido — a mais próxima das duas. */}
        {celula(
          'Nossa leitura',
          `há ${durSeg(desde(sync.nosso.ultimaVarredura))} · próxima em ${durSeg(proximaLeitura)}`,
          (sync.nosso.intervaloLeveSeg != null
            ? `Leitura leve do painel a cada ${durSeg(sync.nosso.intervaloLeveSeg)} (só o SureRadar) + varredura completa a cada ${durSeg(sync.nosso.intervaloSeg)} (com o motor próprio).`
            : `Só a varredura completa lê o painel, a cada ${durSeg(sync.nosso.intervaloSeg)} — a leitura leve está desligada (SURERADAR_LEVE_MIN=0).`) +
            (sync.nosso.alinhamentoAtivo ? ' Alinhamento de fase ATIVO.' : '')
        )}
        {celula(
          'Defasagem da captura',
          `${durSeg(sync.sincronia.defasagemUltimaSeg)} após o recálculo`,
          `Idade do dado quando a nossa varredura terminou. Alvo: ${sync.sincronia.alvoSeg}s. Mediana das últimas: ${durSeg(sync.sincronia.defasagemMedianaSeg)}.`
        )}

        {(estado === 'desatualizado' || vidaCurta) && (
          <button
            className="btn sync-acao"
            onClick={onEscanear}
            title="Recapturar agora, antes de operar: o dado que está na tela nasceu no ciclo anterior do SureRadar."
          >
            <RefreshCw size={11} /> Recapturar
          </button>
        )}
      </div>

      {aberto && (
        <div className="sync-detalhe">
          {sync.sincronia.recomendacao && <div className="sync-reco">{sync.sincronia.recomendacao}</div>}
          <div className="sync-grade">
            <span>Ciclos observados: <strong>{sync.sincronia.ciclosObservados}</strong> (desde o último restart do backend)</span>
            <span>Atualizações deles vistas: <strong>{sync.sincronia.atualizacoesObservadas}</strong></span>
            <span>Atualizações perdidas: <strong>{sync.sincronia.atualizacoesPerdidas}</strong></span>
            <span>Recálculos pendentes de captura: <strong>{sync.sincronia.atualizacoesPendentes}</strong></span>
            <span>Última leitura: <strong>{sync.nosso.fonteUltima || '—'}</strong>{sync.nosso.importadasUltima != null ? ` · ${sync.nosso.importadasUltima} surebets em ${durSeg(sync.nosso.duracaoUltimaSeg)}` : ''}</span>
            <span>Ritmo das leituras: <strong>leve {sync.nosso.intervaloLeveSeg != null ? durSeg(sync.nosso.intervaloLeveSeg) : 'desligada'} · completa {durSeg(sync.nosso.intervaloSeg)}</strong></span>
            <span>Ajuste de fase aplicado: <strong>{sync.nosso.ajusteFaseSeg ? `${sync.nosso.ajusteFaseSeg > 0 ? '+' : ''}${sync.nosso.ajusteFaseSeg}s` : 'nenhum'}</strong></span>
            <span>Total no painel deles: <strong>{sync.deles.total ?? '—'}</strong></span>
            {/* Painel recalculado ≠ odd recalculada: cada surebet tem o seu próprio updated_at. */}
            <span>Idade das linhas na leitura: <strong>mais nova {durSeg(sync.dados.legIdadeMinSeg)} · mediana {durSeg(sync.dados.legIdadeMedianaSeg)} · máx {durSeg(sync.dados.legIdadeMaxSeg)}</strong>{sync.dados.eventoMaisAntigo ? ` (mais velha: ${sync.dados.eventoMaisAntigo})` : ''}</span>
          </div>
          {sync.avisos.map((a, i) => (
            <div key={i} className="sync-aviso">⚠️ {a}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Vocabulário do BANCO (coluna promo_type), idêntico ao do core exceto QUALIFYING (no core é
 * QUALIFICATIVA, herança de antes do core existir). O frontend não traduz nada: a mesma
 * string vai no POST e volta no histórico — tradutor a mais nesta borda já fez filtro
 * devolver zero em silêncio.
 *
 * Vive no escopo do módulo (e não dentro de App) porque PROMO_GUIA é tipado por ele.
 */
type PromoTipo = 'FREEBET_SNR' | 'FREEBET_SRR' | 'QUALIFYING' | 'PROTECAO' | 'SUPERODD' | 'LUCRO_EXTRA';

/** Uma linha do exemplo numérico do guia: rótulo à esquerda, número/afirmação à direita. */
interface GuiaLinha {
  rotulo: string;
  valor: string;
  /** Destaca o resultado da operação (lucro travado / custo). */
  forte?: boolean;
}
interface PromoGuia {
  /** Nome completo, com o termo em inglês que aparece no regulamento. */
  titulo: string;
  /** Como a CASA anuncia — é por aqui que se identifica a modalidade sem errar. */
  anuncio: string[];
  /** O que é, em 2–3 frases. */
  oQueE: string;
  /** Fórmula em texto simples (bloco monoespaçado). Mesma da doutrina/core. */
  formula: string[];
  /** Exemplo numérico: setup, linhas da conta e o veredito. */
  exemplo: { titulo: string; linhas: GuiaLinha[]; leitura: string };
  /** Um segundo exemplo (teto, bônus, odd errada) — opcional. */
  exemplo2?: { titulo: string; linhas: GuiaLinha[]; leitura: string };
  /** A armadilha do tipo: o erro que dá número plausível e errado. */
  armadilhas: string[];
  /** Contra o que ESTE tipo é confundido, e como diferenciar na hora. */
  naoConfundaCom: string;
}

/**
 * Guia das modalidades — conteúdo do modal "i" da aba Promoções.
 *
 * TODO número daqui saiu de `calcularPromocao()` (backend/src/core/promocoes.ts) rodado nas
 * entradas descritas em cada exemplo, e não de conta feita à mão neste arquivo: guia que
 * discorda do preview da própria tela ensina a modalidade errada. Coberturas "de mercado"
 * usam a convenção da doutrina — cob = O/((O−1)·(1+m)) com margem m = 6% —, então dá para
 * comparar as odds de um mesmo tipo entre si.
 *
 * É um Record<PromoTipo, …> de propósito: tipo novo sem verbete aqui NÃO COMPILA.
 */
const PROMO_GUIA: Record<PromoTipo, PromoGuia> = {
  QUALIFYING: {
    titulo: 'Aposta qualificativa (qualifying bet)',
    anuncio: [
      '"Aposte R$ 50 e ganhe R$ 50 em freebet"',
      '"Deposite e aposte X para liberar seu bônus"',
      'Regulamento fala em aposta ELEGÍVEL/qualificadora, com odd mínima',
    ],
    oQueE:
      'Dinheiro real nas duas pernas. Não é para lucrar: é o pedágio para destravar o bônus. ' +
      'O objetivo é fechar com o MENOR custo garantido possível — e o custo é o mesmo nos dois cenários.',
    formula: [
      'R (retorno bruto)   = S × odd_promo        (dinheiro real: a stake volta no green)',
      'Cobertura           = R / odd_cob',
      'Custo garantido     = cobertura × (odd_cob − 1) − S     (igual nos dois cenários)',
      'Investimento real   = S + cobertura',
    ],
    exemplo: {
      titulo: 'R$ 50 @ 2,00 · cobertura @ 1,95',
      linhas: [
        { rotulo: 'Retorno bruto da perna promo', valor: 'R$ 100,00  (50 × 2,00)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 51,28  (100 ÷ 1,95)' },
        { rotulo: 'Se a promo ganha', valor: '−R$ 1,28' },
        { rotulo: 'Se a cobertura ganha', valor: '−R$ 1,28' },
        { rotulo: 'Custo garantido', valor: '−R$ 1,28  (2,6% da stake)', forte: true },
      ],
      leitura:
        'Se esses R$ 50 destravam uma freebet de R$ 50 que rende ~47% (SNR @2,00), o pedágio come 5% do bônus: ' +
        'operação ótima. Com um par pior (cobertura @1,8868) o mesmo qualificador custa R$ 3,00.',
    },
    armadilhas: [
      'Pedágio acima de ~35% do valor extraível do bônus: pare e troque o par de casas/mercado — a doutrina é essa.',
      'Odd mínima do regulamento manda no par: qualificar em odd 1,20 porque "é mais barato" costuma não ser elegível.',
      'A freebet que a qualificativa libera é OUTRA operação (SNR ou SRR). Lançar as duas como uma só esconde o pedágio.',
    ],
    naoConfundaCom:
      'Proteção: lá a casa devolve parte da aposta se ela PERDER, e é a devolução que paga o lucro. Se não há devolução ' +
      'prometida, é qualificativa e o resultado é negativo por construção — prejuízo garantido não é bug da conta.',
  },
  FREEBET_SNR: {
    titulo: 'Freebet SNR (stake not returned)',
    anuncio: [
      '"Aposta grátis de R$ 50"',
      'Regulamento: "o valor da aposta grátis NÃO é devolvido / não integra o retorno"',
      'No bilhete, o retorno exibido é menor que stake × odd',
    ],
    oQueE:
      'A ficha é grátis e NÃO volta no green: a casa paga só o lucro, S × (odd − 1). Perder a ficha custa R$ 0, ' +
      'então o dinheiro que sai do bolso é apenas a cobertura. O jogo aqui é converter a ficha em dinheiro real ' +
      '(retenção = lucro travado ÷ valor da ficha).',
    formula: [
      'R (retorno bruto)   = S × (odd_promo − 1)        ← a ficha NÃO volta',
      'Cobertura           = R / odd_cob',
      'Lucro travado       = cobertura × (odd_cob − 1)   (igual nos dois cenários)',
      'Retenção            = lucro travado / S           ← sempre < 100%',
      'Odd ótima           ≈ √(1 + 1/margem)  →  ~4,00 com margem de 6%',
    ],
    exemplo: {
      titulo: 'Freebet R$ 50 @ 2,00 · cobertura de mercado @ 1,8868',
      linhas: [
        { rotulo: 'Retorno bruto da ficha', valor: 'R$ 50,00  (50 × 1,00)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 26,50' },
        { rotulo: 'Lucro travado', valor: '+R$ 23,50 nos dois cenários', forte: true },
        { rotulo: 'Retenção da ficha', valor: '47%' },
      ],
      leitura: 'Investimento real R$ 26,50 (a ficha não sai do bolso) — ROI de 88,7% sobre o dinheiro aportado.',
    },
    exemplo2: {
      titulo: 'A MESMA ficha em odd alta: R$ 50 @ 4,00 · cobertura @ 1,2579',
      linhas: [
        { rotulo: 'Retorno bruto da ficha', valor: 'R$ 150,00  (50 × 3,00)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 119,25' },
        { rotulo: 'Lucro travado', valor: '+R$ 30,75', forte: true },
        { rotulo: 'Retenção da ficha', valor: '61,5%' },
      ],
      leitura:
        'Mesma ficha, +R$ 7,25 de lucro só por esticar a odd: na SNR a retenção tem PICO em odd alta. O preço é caixa — ' +
        'a cobertura salta de R$ 26,50 para R$ 119,25.',
    },
    armadilhas: [
      'Se a casa devolve a stake no green, NÃO é SNR: é SRR, e a conta da SNR aporta metade do necessário.',
      'Odd alta exige caixa na casa de cobertura: sem saldo lá, a odd ótima é teórica.',
      'Validade curta e odd mínima da ficha limitam o "estique a odd" — o regulamento manda mais que a fórmula.',
    ],
    naoConfundaCom:
      'SRR. O teste é único: no green, o retorno é stake × odd (SRR) ou stake × (odd − 1) (SNR)? Confira no cupom ' +
      'antes de apostar; é o mesmo botão "aposta grátis" nas duas.',
  },
  FREEBET_SRR: {
    titulo: 'Freebet SRR (stake returned)',
    anuncio: [
      '"Aposta grátis com o valor devolvido" / "stake returned"',
      '"Devolvemos o valor da aposta grátis junto com o lucro"',
      'No bilhete, o retorno exibido é stake × odd (igual a uma aposta normal)',
    ],
    oQueE:
      'A ficha é grátis E volta no green, junto do lucro. Isso muda o retorno bruto — e portanto TODA a cobertura: ' +
      'ela fica quase o dobro da SNR. Se a ficha devolvida vier como bônus/nova freebet, ela não vale a face: ' +
      'informe quanto vale (campo "valor da ficha").',
    formula: [
      'v = valor da ficha devolvida  (1 = dinheiro sacável · 0,7 = volta como bônus)',
      'R (retorno bruto)   = S × (odd_promo − 1 + v)     ← com v=1: S × odd_promo',
      'Cobertura           = R / odd_cob',
      'Retenção            ≈ 1 − margem × (odd − 1)      ← só DESCE: sem pico',
      'Odd ótima           = a MENOR odd elegível pelo regulamento',
    ],
    exemplo: {
      titulo: 'Freebet R$ 50 @ 2,00 · cobertura @ 2,05 (caso base validado em produção)',
      linhas: [
        { rotulo: 'Retorno bruto da ficha', valor: 'R$ 100,00  (50 × 2,00 — a ficha volta)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 48,78' },
        { rotulo: 'Lucro travado', valor: '+R$ 51,22 nos dois cenários', forte: true },
        { rotulo: 'Retenção da ficha', valor: '102,4%  (passa de 100% porque a ficha volta)' },
      ],
      leitura:
        'A mesma ficha calculada como SNR pediria R$ 24,39 de cobertura — metade. E o erro não aparece: os dois ' +
        'cenários seguem positivos (+R$ 75,61 no green contra +R$ 25,61 no red), só que o resultado passa a ser decidido pelo jogo.',
    },
    exemplo2: {
      titulo: 'Curva da odd (cobertura de mercado, m = 6%) e ficha em BÔNUS',
      linhas: [
        { rotulo: 'R$ 50 @ 1,50 (cob. 2,8302)', valor: 'aporte R$ 26,50 → +R$ 48,50 · retenção 97%', forte: true },
        { rotulo: 'R$ 50 @ 4,00 (cob. 1,2579)', valor: 'aporte R$ 159,00 → +R$ 41,00 · retenção 82%' },
        { rotulo: 'R$ 100 @ 2,00 com ficha em bônus (v=70%)', valor: 'aporte R$ 90,10 → lucro travado R$ 79,90' },
        { rotulo: '↳ caixa do dia no green', valor: 'R$ 9,90 (R$ 70 voltaram como bônus)' },
      ],
      leitura:
        'Odd curta rende MAIS e imobiliza MENOS caixa: é o oposto da SNR. Aplicar aqui o "estique a odd" da SNR ' +
        'é perder retenção de propósito.',
    },
    armadilhas: [
      'Usar a fórmula da SNR (odd ÷ (odd−1)) sub-hedgeia: em odd 2,00 aporta metade — e "lucro nos dois lados" esconde o erro.',
      'Ficha devolvida em bônus não é caixa: o lucro travado continua, mas o dinheiro do dia é menor (o app separa os dois).',
      'Teto de GANHO ≠ teto de RETORNO: numa SRR de R$ 100 @4,00, "ganhe até R$ 100" dá cobertura R$ 159 e lucro R$ 41; ' +
      '"retorno máximo R$ 100" dá cobertura R$ 79,50 e lucro R$ 20,50. Ler um pelo outro fecha o green em −R$ 59.',
    ],
    naoConfundaCom:
      'SNR (o retorno do bilhete é o teste) e super odd (lá a ficha é dinheiro SEU e o que turbina é a odd, não a devolução).',
  },
  PROTECAO: {
    titulo: 'Proteção / cashback de aposta perdida (parcial ou total)',
    anuncio: [
      '"Perdeu? Devolvemos 50% até R$ 50"',
      '"Seguro da aposta" / "aposta sem risco" (sem risco = o caso 100%)',
      '"Cashback da primeira aposta" — confira se cai em dinheiro ou em bônus',
    ],
    oQueE:
      'Dinheiro real nas duas pernas + devolução SE A PERNA DA PROMOÇÃO PERDER. É o único tipo em que a promoção paga ' +
      'justamente no cenário de red: a cobertura recupera o principal e a devolução sobra como lucro.',
    formula: [
      'Devolução (face)     = min( S × %, teto )',
      'Devolução (efetiva)  = face × (bônus ? valor_do_bônus : 1)',
      'Cobertura            = (S × odd_promo − devolução efetiva) / odd_cob',
      'Se a promo ganha     = S × (odd_promo − 1) − cobertura',
      'Se a promo perde     = cobertura × (odd_cob − 1) − S + devolução efetiva',
      'Piso (D₀)            = S × ( odd_promo − odd_cob × (odd_promo − 1) )   ← abaixo dele é prejuízo garantido',
    ],
    exemplo: {
      titulo: 'R$ 100 @ 2,00 · 50% de volta se perder · cobertura @ 2,05 (caso base de produção)',
      linhas: [
        { rotulo: 'Devolução prometida', valor: 'R$ 50,00 (efetiva: R$ 50,00 — cai em dinheiro)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 73,17  ((200 − 50) ÷ 2,05)' },
        { rotulo: 'Se a promo ganha', valor: '+R$ 26,83' },
        { rotulo: 'Se a promo perde', valor: '+R$ 26,83  (aqui entra a devolução)' },
        { rotulo: 'Lucro travado', valor: '+R$ 26,83 · ROI 15,5% sobre R$ 173,17 na mesa', forte: true },
      ],
      leitura:
        'O piso desse par é R$ 10 de devolução (D₀ = 100 × (2,00 − 2,05 × 1,00)); com 50% prometidos, a folga é enorme. ' +
        'Cashback abaixo do piso = prejuízo travado, e o app avisa.',
    },
    exemplo2: {
      titulo: 'O teto manda na stake: "50% até R$ 50" com R$ 200 apostados',
      linhas: [
        { rotulo: 'Devolução', valor: 'R$ 50,00 (o teto corta — NÃO são R$ 100)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 170,73' },
        { rotulo: 'Lucro travado', valor: '+R$ 29,27 · ROI 7,9%', forte: true },
        { rotulo: 'Stake que aproveita 50% cheios', valor: 'R$ 100,00  (teto ÷ %)' },
      ],
      leitura:
        'Dobrar a stake rendeu +R$ 2,44 e cortou o ROI pela metade: cada real acima de teto ÷ % entra na mesa SEM proteção.',
    },
    armadilhas: [
      'Devolução em BÔNUS não é dinheiro: equalizar pela face infla o cenário de red. Informe quanto o bônus vale (default 70%).',
      'Devolução INCONDICIONAL (cai ganhando ou perdendo) não é proteção: não muda o aporte, só soma no lucro dos dois cenários.',
      'Sem informar o %, isto é uma qualificativa — e o resultado é prejuízo garantido.',
    ],
    naoConfundaCom:
      'Devolução condicionada a PLACAR ("perdeu por 1 gol", "0x0 devolve") — ali não existe cobertura universal e a conta ' +
      'desta tela não se aplica. Exceção: "empate devolve" no futebol é literalmente um DNB, e a cobertura correta é DNB na outra casa.',
  },
  SUPERODD: {
    titulo: 'Super odd / odd turbinada (enhanced odds)',
    anuncio: [
      '"Super odd: de 1,60 para 2,00 neste jogo"',
      '"Odd turbinada / odds aumentadas", quase sempre com teto (ex.: até R$ 30)',
      'Vem na vitrine do site ou no push, fora do feed padrão',
    ],
    oQueE:
      'Dinheiro real, mas com a odd ACIMA do preço de mercado. O que paga a operação é o excedente sobre a odd normal — ' +
      'e o regulamento quase sempre limita a stake. A conta roda na stake ELEGÍVEL, min(valor, teto).',
    formula: [
      'S = min(stake, teto_stake)          ← stake elegível: a conta é NELA',
      'Excedente em DINHEIRO:  R = S × odd_promo        ← a odd turbinada já contém o excedente',
      'Excedente em BÔNUS:     R = S × odd_padrao + v × min( S × (odd_promo − odd_padrao), teto_extra )',
      'Cobertura           = R / odd_cob        ·        odd efetiva = R / S',
      'Trava lucro se      odd_efetiva > odd_cob / (odd_cob − 1)',
    ],
    exemplo: {
      titulo: 'R$ 30 @ 2,00 (odd padrão 1,60) · cobertura @ 2,50 — excedente em dinheiro',
      linhas: [
        { rotulo: 'Excedente sobre a odd normal', valor: 'R$ 12,00  (30 × 0,40)' },
        { rotulo: 'Retorno bruto', valor: 'R$ 60,00  (30 × 2,00)' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 24,00' },
        { rotulo: 'Lucro travado', valor: '+R$ 6,00 nos dois cenários · ROI 11,1%', forte: true },
      ],
      leitura:
        'Com o excedente em dinheiro é surebet clássica: 1/2,00 + 1/2,50 = 0,90 < 1. O excedente de R$ 12 é MEDIDA do boost, ' +
        'não uma parcela a somar — somá-lo por cima daria R$ 72 de retorno onde a casa paga R$ 60.',
    },
    exemplo2: {
      titulo: 'Teto de stake e excedente em BÔNUS (70%)',
      linhas: [
        { rotulo: 'R$ 100 digitados, teto de R$ 30', valor: 'a conta é a de R$ 30: aporte R$ 24,00 → +R$ 6,00' },
        { rotulo: 'Excedente em bônus: face R$ 12', valor: 'efetivo R$ 8,40 → R = R$ 56,40' },
        { rotulo: '↳ aporte / lucro travado', valor: 'R$ 22,56 → +R$ 3,84', forte: true },
        { rotulo: '↳ caixa do dia no green', valor: '−R$ 4,56 (o bônus só vira dinheiro depois de convertido)' },
      ],
      leitura:
        'Escrever a fórmula com os R$ 100 (teto só no custo) infla o aporte ~3,3× e vira prejuízo travado nos dois cenários. ' +
        'Aposte só o valor elegível: o excedente entraria na odd NORMAL, virando uma qualificativa com prejuízo colada na operação.',
    },
    armadilhas: [
      'Sem a odd PADRÃO não há como medir o boost — e, se o excedente vem em bônus, a conta trata bônus como dinheiro.',
      'O bônus aqui cai no GREEN (ramo oposto ao da proteção, onde a devolução cai no red).',
      'Boost que não paga a margem é prejuízo: o excedente efetivo precisa passar de S × (odd_cob/(odd_cob−1) − odd_base).',
      'Ordene por LUCRO EM REAIS, não por ROI: uma super odd de R$ 30 raramente paga o tempo de execução.',
    ],
    naoConfundaCom:
      'Lucro extra: lá a odd é a normal e a casa paga +X% por cima do retorno. Aqui a própria odd já está turbinada. ' +
      'Se a promoção mostra as duas odds (de/para), é super odd.',
  },
  LUCRO_EXTRA: {
    titulo: 'Lucro extra / ganhos turbinados (profit boost)',
    anuncio: [
      '"Ganhe +30% de lucro extra nesta aposta"',
      '"Ganhos turbinados" / "profit boost", com teto em reais',
      'Token/opt-in aplicado ao bilhete ANTES de confirmar',
    ],
    oQueE:
      'Dinheiro real na odd normal, e a casa paga um acréscimo POR CIMA do retorno. A leitura padrão do regulamento é ' +
      '% sobre o LUCRO; há casa que aplica sobre o VALOR APOSTADO — são números diferentes, e coincidem só em odd 2,00.',
    formula: [
      'b = boost %          ·        v = valor do extra (1 = dinheiro · 0,7 = bônus)',
      'base = S × (odd_promo − 1)     ← % sobre o LUCRO (padrão)     |     base = S ← % sobre a STAKE',
      'extra (face)        = min( b × base, teto_extra )     ← o teto corta a FACE, antes de valorizar o bônus',
      'R (retorno bruto)   = S × odd_promo + v × extra',
      'Cobertura           = R / odd_cob        ·        odd efetiva = R / S',
      'Condição necessária: b × v > margem  ·  ótimo perto de odd 2,00',
    ],
    exemplo: {
      titulo: 'R$ 100 @ 2,00 · cobertura @ 1,90 · boost de 30% sobre o lucro',
      linhas: [
        { rotulo: 'Extra', valor: 'R$ 30,00  (30% de R$ 100 de lucro)' },
        { rotulo: 'Retorno bruto / odd efetiva', valor: 'R$ 230,00 · 2,30' },
        { rotulo: 'Aporte na cobertura', valor: 'R$ 121,05' },
        { rotulo: 'Lucro travado', valor: '+R$ 8,95 nos dois cenários · ROI 4,0%', forte: true },
      ],
      leitura: 'Depois da odd efetiva (2,30) é a mesma conta da super odd: trava lucro porque 1/2,30 + 1/1,90 < 1.',
    },
    exemplo2: {
      titulo: '% do lucro ≠ % da stake, e odd alta mata o boost',
      linhas: [
        { rotulo: 'R$ 100 @ 3,00 (cob. 1,50) — sobre o LUCRO', valor: 'extra R$ 60,00 → +R$ 20,00', forte: true },
        { rotulo: 'O mesmo, mas sobre a STAKE', valor: 'extra R$ 30,00 → +R$ 10,00' },
        { rotulo: 'R$ 100 @ 5,00 (cob. de mercado 1,1792)', valor: '−R$ 5,78 TRAVADO: precisaria de boost de ~39,5%' },
        { rotulo: 'Teto mordendo: R$ 500 @ 2,00, boost 30% até R$ 50', valor: '−R$ 2,63 (contra +R$ 8,95 dos mesmos R$ 100)' },
      ],
      leitura:
        'Em odd 1,50 a relação inverte (R$ 15 sobre o lucro contra R$ 30 sobre a stake). E é o erro simétrico ao da SNR: ' +
        'aqui esticar a odd DESTRÓI o boost — o ótimo fica perto de 2,00.',
    },
    armadilhas: [
      'Extra em bônus valendo 0% é entrada válida (bônus que não converte) — aí a operação é uma qualificativa crua.',
      'Com o teto do extra mordendo, aumentar a stake PIORA: o extra congela e só o pedágio da cobertura cresce.',
      'Boost de 5% em mercado com 6% de margem não paga em NENHUMA odd (b × v > m é condição necessária).',
    ],
    naoConfundaCom:
      'Super odd (lá a odd exibida já está turbinada) e SRR (lá a ficha é grátis). Se você apostou dinheiro seu na odd ' +
      'normal e a casa promete um acréscimo, é lucro extra.',
  },
};

/**
 * Como escolher a modalidade — a árvore que evita o erro caro (usar a doutrina de um tipo
 * em outro). Fica no topo do modal "i", antes dos verbetes.
 */
const PROMO_GUIA_ARVORE: Array<{ pergunta: string; sim: string; nao: string }> = [
  {
    pergunta: 'A ficha que você vai apostar é GRÁTIS (nenhum real sai do bolso)?',
    sim: 'No green a casa devolve o valor da ficha junto do lucro? SIM → 🎟️ SRR · NÃO → 🎟️ SNR (confira o retorno do cupom)',
    nao: 'É dinheiro real: siga para as perguntas de baixo.',
  },
  {
    pergunta: 'A casa devolve parte/tudo da aposta se ela PERDER?',
    sim: '🛡️ Proteção (100% de volta = "aposta sem risco"). Informe o %, o teto e se cai em dinheiro ou bônus.',
    nao: 'Sem devolução no red: veja se algo turbina o retorno.',
  },
  {
    pergunta: 'A odd exibida está ACIMA do mercado (a promoção mostra "de 1,60 por 2,00")?',
    sim: '🚀 Super odd. Informe a odd padrão e o teto de stake — a conta roda na stake elegível.',
    nao: 'A odd é a normal da casa.',
  },
  {
    pergunta: 'A casa promete +X% POR CIMA do retorno/lucro?',
    sim: '📈 Lucro extra. Confira se o % incide sobre o LUCRO (padrão) ou sobre o valor apostado, e o teto do extra.',
    nao: '💵 Qualificativa: a aposta só serve para destravar o bônus, e o resultado é um CUSTO por construção.',
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'radar-cashout' | 'valor' | 'calibracao' | 'calculadora' | 'juros-compostos' | 'saldos' | 'ai-test'>('dashboard');
  // Menu hambúrguer do mobile: navegar fecha o menu (no desktop a classe não tem efeito).
  const [navOpen, setNavOpen] = useState(false);
  const irPara = (tab: typeof activeTab) => { setActiveTab(tab); setNavOpen(false); };
  const [systemStatus, setSystemStatus] = useState<HealthStatus | null>(null);

  // Value bets (+EV vs Pinnacle) + middles — radar-only (polling só quando a aba está aberta).
  const [valorOpps, setValorOpps] = useState<ValorOportunidade[]>([]);
  const [middlesOpps, setMiddlesOpps] = useState<ValorMiddle[]>([]);
  const [valorLoading, setValorLoading] = useState(true);

  // Calibração do alerta (precisão scan→revalidação).
  const [calibResumo, setCalibResumo] = useState<CalibResumo | null>(null);
  const [calibAlertas, setCalibAlertas] = useState<CalibAlerta[]>([]);
  const [calibLoading, setCalibLoading] = useState(true);

  // Radar Cashout: oportunidades ativas + status do worker (polling só quando a aba está aberta).
  const [cashoutOpps, setCashoutOpps] = useState<CashoutOpportunity[]>([]);
  const [cashoutStatus, setCashoutStatus] = useState<CashoutStatus | null>(null);
  const [cashoutLoading, setCashoutLoading] = useState(true);
  // Resultado do "Verificar" por oportunidade (id → estado).
  const [cashoutVerif, setCashoutVerif] = useState<Record<string, CashoutVerificacao>>({});

  // "Minhas Apostas": apostas cadastradas + casas com odd ao vivo + estado do formulário.
  const [cashoutBets, setCashoutBets] = useState<CashoutBet[]>([]);
  const [casasLive, setCasasLive] = useState<string[]>([]);
  const [betMonitorLoading, setBetMonitorLoading] = useState<Record<string, boolean>>({});
  const [betSubmitting, setBetSubmitting] = useState(false);
  const [betError, setBetError] = useState<string | null>(null);
  const [betForm, setBetForm] = useState({
    casa: 'KTO', sport: 'Futebol', event_label: '',
    mercado: 'Resultado Final', selection: 'home', line: '', odd_entrada: '', stake: '',
  });
  // Estado do botão "Monitorar ao vivo" por oportunidade (promoção → Minhas Apostas).
  const [cashoutPromo, setCashoutPromo] = useState<Record<string, 'idle' | 'form' | 'loading' | 'done' | 'error'>>({});
  // Inputs do mini-formulário de promoção (odd de entrada REAL do usuário + stake).
  const [promoInputs, setPromoInputs] = useState<Record<string, { odd: string; stake: string }>>({});

  const carregarBets = () => {
    fetch('/api/cashout/bets')
      .then((r) => r.json())
      .then((d) => {
        setCashoutBets(Array.isArray(d.apostas) ? d.apostas : []);
        if (Array.isArray(d.casasComFonteLive)) setCasasLive(d.casasComFonteLive);
      })
      .catch(() => { /* mantém o último estado */ });
  };

  const criarBet = (e: React.FormEvent) => {
    e.preventDefault();
    setBetError(null);
    const teams = betForm.event_label.split(/\s+vs\.?\s+/i);
    const timeA = (teams[0] || '').trim();
    const timeB = (teams[1] || '').trim();
    if (!timeA || !timeB) { setBetError('Confronto deve estar no formato "Time A vs Time B".'); return; }
    const odd = Number(betForm.odd_entrada);
    if (!Number.isFinite(odd) || odd <= 1) { setBetError('Odd de entrada deve ser um decimal > 1 (ex.: 2.75).'); return; }

    // Mercado normalizável na mesma família da bússola (Total por esporte).
    let market_label = betForm.mercado;
    if (betForm.mercado === 'Total') {
      market_label = betForm.sport === 'Basquete' ? 'Total de Pontos'
        : betForm.sport === 'Tenis' ? 'Total de Games'
        : betForm.sport === 'Esports' ? 'Total de Mapas'
        : 'Total de Gols';
    }
    let selection_label = '';
    if (betForm.selection === 'home') selection_label = timeA;
    else if (betForm.selection === 'away') selection_label = timeB;
    else if (betForm.selection === 'draw') selection_label = 'Empate';
    else if (betForm.selection === 'over') selection_label = `Mais de ${betForm.line}`;
    else if (betForm.selection === 'under') selection_label = `Menos de ${betForm.line}`;

    setBetSubmitting(true);
    fetch('/api/cashout/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casa: betForm.casa, sport: betForm.sport, event_label: `${timeA} vs ${timeB}`,
        market_label, selection: betForm.selection, selection_label,
        line: betForm.line || null, odd_entrada: odd, stake: betForm.stake || null,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setBetError(d.error || 'Falha ao salvar.'); return; }
        setBetForm((f) => ({ ...f, event_label: '', line: '', odd_entrada: '', stake: '' }));
        carregarBets();
      })
      .catch(() => setBetError('Falha de rede ao salvar a aposta.'))
      .finally(() => setBetSubmitting(false));
  };

  const excluirBet = (id: string) => {
    setCashoutBets((bs) => bs.filter((b) => b.id !== id));
    fetch(`/api/cashout/bets/${id}`, { method: 'DELETE' }).catch(() => { /* já removi localmente */ });
  };

  const monitorarBet = (id: string) => {
    setBetMonitorLoading((m) => ({ ...m, [id]: true }));
    fetch(`/api/cashout/bets/${id}/monitorar`)
      .then((r) => r.json())
      .then((d) => { if (d?.ok) setCashoutBets((bs) => bs.map((b) => (b.id === id ? { ...b, ...d.avaliacao } : b))); })
      .catch(() => { /* mantém */ })
      .finally(() => setBetMonitorLoading((m) => ({ ...m, [id]: false })));
  };

  // "Monitorar ao vivo": abre o mini-form pra o usuário confirmar a odd que ELE pegou
  // (pré-preenchida com a odd do alvo) e o stake, antes de promover p/ Minhas Apostas.
  const abrirPromo = (opp: CashoutOpportunity) => {
    setPromoInputs((p) => ({ ...p, [opp.id]: { odd: opp.target_odd_value != null ? String(opp.target_odd_value) : '', stake: '' } }));
    setCashoutPromo((p) => ({ ...p, [opp.id]: 'form' }));
  };

  // Confirma a promoção com a odd/stake informados (o worker passa a rastrear ao vivo e
  // avisar no WhatsApp o movimento + a hora de sacar).
  const confirmarPromo = (id: string) => {
    const inp = promoInputs[id] || { odd: '', stake: '' };
    setCashoutPromo((p) => ({ ...p, [id]: 'loading' }));
    fetch(`/api/cashout/opportunities/${id}/monitorar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ odd_entrada: inp.odd || undefined, stake: inp.stake || undefined }),
    })
      .then((r) => r.json())
      .then((d) => {
        setCashoutPromo((p) => ({ ...p, [id]: d?.ok ? 'done' : 'error' }));
        if (d?.ok) carregarBets(); // aparece na hora em Minhas Apostas
      })
      .catch(() => setCashoutPromo((p) => ({ ...p, [id]: 'error' })));
  };

  const validarCashout = (id: string) => {
    setCashoutVerif((v) => ({ ...v, [id]: { loading: true } }));
    fetch(`/api/cashout/opportunities/${id}/validar`)
      .then((r) => r.json())
      .then((d) => setCashoutVerif((v) => ({ ...v, [id]: { ...d, loading: false } })))
      .catch(() => setCashoutVerif((v) => ({ ...v, [id]: { loading: false, disponivel: false, mensagem: 'Falha ao validar.' } })));
  };

  const excluirCashout = (id: string) => {
    setCashoutOpps((ops) => ops.filter((o) => o.id !== id)); // some da lista na hora
    fetch(`/api/cashout/opportunities/${id}`, { method: 'DELETE' }).catch(() => { /* já removi localmente */ });
  };

  // Excluir uma aposta de valor / middle do radar (soft-delete no backend; some da lista local).
  const excluirValor = (id: string) => {
    setValorOpps((prev) => prev.filter((o) => o.id !== id));
    fetch(`/api/valor/${id}`, { method: 'DELETE' }).catch(() => { /* já removi localmente */ });
  };
  const excluirMiddle = (id: string) => {
    setMiddlesOpps((prev) => prev.filter((o) => o.id !== id));
    fetch(`/api/middles/${id}`, { method: 'DELETE' }).catch(() => { /* já removi localmente */ });
  };

  useEffect(() => {
    if (activeTab !== 'valor') return;
    let vivo = true;
    const puxar = () => {
      fetch('/api/valor')
        .then((r) => r.json())
        .then((d) => { if (vivo) setValorOpps(Array.isArray(d.oportunidades) ? d.oportunidades : []); })
        .catch(() => { /* mantém o último estado */ })
        .finally(() => { if (vivo) setValorLoading(false); });
      fetch('/api/middles')
        .then((r) => r.json())
        .then((d) => { if (vivo) setMiddlesOpps(Array.isArray(d.oportunidades) ? d.oportunidades : []); })
        .catch(() => { /* mantém o último estado */ });
    };
    puxar();
    const id = setInterval(puxar, 8000);
    return () => { vivo = false; clearInterval(id); };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'calibracao') return;
    let vivo = true;
    const puxar = () => {
      fetch('/api/calibracao')
        .then((r) => r.json())
        .then((d) => { if (vivo) setCalibResumo(d && typeof d === 'object' && 'geral' in d ? d : null); })
        .catch(() => { /* mantém o último estado */ })
        .finally(() => { if (vivo) setCalibLoading(false); });
      fetch('/api/calibracao/alertas')
        .then((r) => r.json())
        .then((d) => { if (vivo) setCalibAlertas(Array.isArray(d.alertas) ? d.alertas : []); })
        .catch(() => { /* mantém o último estado */ });
    };
    puxar();
    const id = setInterval(puxar, 15000);
    return () => { vivo = false; clearInterval(id); };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'radar-cashout') return;
    let vivo = true;
    const puxar = () => {
      fetch('/api/cashout/opportunities')
        .then((r) => r.json())
        .then((d) => { if (vivo) setCashoutOpps(Array.isArray(d.oportunidades) ? d.oportunidades : []); })
        .catch(() => { /* mantém o último estado */ })
        .finally(() => { if (vivo) setCashoutLoading(false); });
      fetch('/api/cashout/status')
        .then((r) => r.json())
        .then((d) => { if (vivo) setCashoutStatus(d); })
        .catch(() => { /* status é opcional */ });
      if (vivo) carregarBets();
    };
    puxar();
    const id = setInterval(puxar, 5000);
    return () => { vivo = false; clearInterval(id); };
  }, [activeTab]);
  
  // Real-time Calculator State
  const [calcOdd1, setCalcOdd1] = useState('2.00');
  const [calcOdd2, setCalcOdd2] = useState('2.15');
  const [calcBanca1, setCalcBanca1] = useState('500');
  const [calcBanca2, setCalcBanca2] = useState('500');
  const [calcMaxStakePct, setCalcMaxStakePct] = useState('50'); // 50%
  const [calcRoundStep1, setCalcRoundStep1] = useState('1'); // step 1.00 standard
  const [calcRoundStep2, setCalcRoundStep2] = useState('1');
  // Exchange (comissão de 1,5% sobre o lucro, ex.: Bolsa de Aposta) por lado.
  const [calcExchange1, setCalcExchange1] = useState(false);
  const [calcExchange2, setCalcExchange2] = useState(false);
  const [calcResult, setCalcResult] = useState<CalculatorResult | null>(null);
  const [calcError, setCalcError] = useState('');

  // Daily Evolution Projections State (Planilha)
  // A banca ativa vive no BANCO (app_config['banca_ativa']) — ÚNICA fonte da
  // verdade; o mount busca de lá e '50.00' é só o valor até a resposta chegar.
  // Sem cache em localStorage: uma aba com valor velho sobrescrevia crédito
  // feito por fora (e o backend também lê do banco p/ stakes/copiloto/digest).
  const [userBanca, setUserBanca] = useState('50.00');
  const [projBancaInicial, setProjBancaInicial] = useState('50.00');

  // Persistência da banca no BANCO (app_config).
  // 'saving'/'saved'/'error' alimentam o feedback do botão Salvar do card.
  const [bancaSaveState, setBancaSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Fonte SÍNCRONA da verdade da banca: evita stale closure em read-modify-write
  // concorrente (ex.: dois lançamentos/exclusões antes do re-render).
  const userBancaRef = useRef(userBanca);
  // Usuário/fluxo já escreveu a banca depois do mount? Se sim, o GET tardio de
  // /api/banca NÃO pode sobrescrever o valor local.
  const bancaTocadaRef = useRef(false);
  // Timer do reset do feedback do botão — cancelado a cada transição p/ não zerar
  // um 'saving' de um clique mais novo.
  const bancaSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Escrita canônica da banca: ref (síncrono) + state; opcionalmente persiste no
  // banco (silencioso). Todos os fluxos que mudam a banca passam aqui.
  const aplicarBanca = (v: string, persistirNoBanco = false) => {
    userBancaRef.current = v;
    bancaTocadaRef.current = true;
    setUserBanca(v);
    if (persistirNoBanco) salvarBancaNoBanco(v, true);
  };

  const agendarResetBotao = () => {
    if (bancaSaveTimerRef.current) clearTimeout(bancaSaveTimerRef.current);
    bancaSaveTimerRef.current = setTimeout(() => setBancaSaveState('idle'), 2500);
  };

  // Salva a banca no banco. `silencioso` = sem feedback de botão (usado nos
  // salvamentos automáticos após lançar/excluir entrada/promoção). Sem cache
  // local, valor não salvo NÃO sobrevive ao reload — falha em modo silencioso
  // avisa por alert para o usuário salvar de novo (no botão do card é o 'error').
  const salvarBancaNoBanco = (valor: string | number, silencioso = false) => {
    const banca = parseFloat(String(valor));
    if (!Number.isFinite(banca) || banca <= 0) {
      console.warn('[banca] Valor inválido, não sincronizado com o banco:', valor);
      if (!silencioso) {
        setBancaSaveState('error');
        agendarResetBotao();
      }
      return;
    }
    if (!silencioso) {
      if (bancaSaveTimerRef.current) clearTimeout(bancaSaveTimerRef.current);
      setBancaSaveState('saving');
    }
    const avisarFalha = (motivo?: string) => {
      console.warn('Falha ao salvar banca no banco:', motivo);
      if (silencioso) {
        alert(`Atenção: não consegui salvar a banca (R$ ${banca.toFixed(2)}) no banco — o valor se perde ao recarregar a página. Confira a conexão e salve de novo no campo Banca Ativa.`);
      } else {
        setBancaSaveState('error');
        agendarResetBotao();
      }
    };
    fetch('/api/banca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banca }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return avisarFalha(d.error);
        if (!silencioso) {
          setBancaSaveState('saved');
          agendarResetBotao();
        }
      })
      .catch((err) => avisarFalha(err?.message || String(err)));
  };
  const [projDias, setProjDias] = useState('30');
  const [projMaxStakePct, setProjMaxStakePct] = useState('50'); // 50%
  const [projRoiMedioPct, setProjRoiMedioPct] = useState('4'); // 4%
  const [projTurnosPorDia, setProjTurnosPorDia] = useState('3'); // 3 turns

  // Saldo disponível por casa (aba "Saldo nas Casas"). localStorage = cache local
  // instantâneo; o banco (app_config['saldos_casas']) é sincronizado no botão Salvar.
  const [saldosCasas, setSaldosCasas] = useState<SaldoCasa[]>(() => {
    const cache = localStorage.getItem('jotinhabet_saldos_casas');
    if (cache) {
      try {
        const arr = JSON.parse(cache);
        if (Array.isArray(arr) && arr.length) return arr.map((s: any) => ({ casa: String(s.casa ?? ''), valor: String(s.valor ?? '') }));
      } catch { /* cache corrompido → cai no default */ }
    }
    return CASAS_PADRAO.map((casa) => ({ casa, valor: '' }));
  });
  const [saldosSaveState, setSaldosSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [novaCasa, setNovaCasa] = useState('');
  const saldosSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saldosTocadoRef = useRef(false); // usuário já editou nesta sessão? GET tardio não sobrescreve.

  // Escrita canônica dos saldos: state + cache local (instantâneo, sobrevive ao reload).
  const aplicarSaldos = (next: SaldoCasa[]) => {
    saldosTocadoRef.current = true;
    setSaldosCasas(next);
    localStorage.setItem('jotinhabet_saldos_casas', JSON.stringify(next));
  };
  const atualizarSaldoCasa = (i: number, valor: string) =>
    aplicarSaldos(saldosCasas.map((s, idx) => (idx === i ? { ...s, valor } : s)));
  const removerCasa = (i: number) => aplicarSaldos(saldosCasas.filter((_, idx) => idx !== i));
  const adicionarCasa = () => {
    const nome = novaCasa.trim();
    if (!nome) return;
    if (saldosCasas.some((s) => s.casa.toLowerCase() === nome.toLowerCase())) {
      alert(`A casa "${nome}" já está na lista.`);
      return;
    }
    aplicarSaldos([...saldosCasas, { casa: nome, valor: '' }]);
    setNovaCasa('');
  };

  const agendarResetBotaoSaldos = () => {
    if (saldosSaveTimerRef.current) clearTimeout(saldosSaveTimerRef.current);
    saldosSaveTimerRef.current = setTimeout(() => setSaldosSaveState('idle'), 2500);
  };

  // Persiste os saldos no banco (upsert em app_config). Só envia linhas com casa
  // preenchida; valor vazio vira 0. Feedback no botão via saldosSaveState.
  const salvarSaldosNoBanco = () => {
    const payload = saldosCasas
      .map((s) => ({ casa: s.casa.trim(), valor: parseFloat(s.valor) }))
      .filter((s) => s.casa.length > 0)
      .map((s) => ({ casa: s.casa, valor: Number.isFinite(s.valor) && s.valor > 0 ? s.valor : 0 }));
    if (saldosSaveTimerRef.current) clearTimeout(saldosSaveTimerRef.current);
    setSaldosSaveState('saving');
    fetch('/api/saldos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saldos: payload }),
    })
      .then((r) => r.json())
      .then((d) => {
        setSaldosSaveState(d.success ? 'saved' : 'error');
        if (!d.success) console.warn('Falha ao salvar saldos no banco:', d.error);
        agendarResetBotaoSaldos();
      })
      .catch((err) => {
        console.error('Erro ao salvar saldos no banco:', err);
        setSaldosSaveState('error');
        agendarResetBotaoSaldos();
      });
  };


  // AI Test Form State
  // Chat do AGENTE de IA (aba "IA & Automação").
  // A mensagem do assistente carrega o TRACE das skills usadas (passos) e qual motor
  // respondeu — é o que dá para o usuário auditar de onde veio cada número.
  type PassoSkill = { skill: string; ok: boolean; ms: number; resumo: string; erro?: string };
  type ChatMsg = {
    role: 'user' | 'assistant';
    content: string;
    passos?: PassoSkill[];
    provider?: string;
    modelo?: string;
    avisos?: string[];
  };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSkills, setChatSkills] = useState<{
    total: number;
    skills: { nome: string; grupo: string; descricao: string; custosa: boolean; escrita: boolean }[];
    casas_integradas: number;
    provedores: { provider: string; configurado: boolean; em_cooldown: boolean; modelo: string | null }[];
    cadeia_agente: string[];
    modelo_agente?: string;
    agente_ativo: boolean;
  } | null>(null);
  // Imagem anexada ao chat (print de promoção/cupom/tela de odds): vai em base64 junto da
  // mensagem e o backend converte em texto por visão antes de rodar o agente.
  const [chatImagem, setChatImagem] = useState<{ nome: string; dataUrl: string; mimeType: string } | null>(null);
  const chatFileRef = useRef<HTMLInputElement | null>(null);
  const [chatSkillsAbertas, setChatSkillsAbertas] = useState(false);
  const [chatTraceAberto, setChatTraceAberto] = useState<Record<number, boolean>>({});
  const chatFimRef = useRef<HTMLDivElement | null>(null);
  const chatQuickPrompts = [
    'Compare as odds de um jogo entre as casas e veja se dá surebet.',
    'Tenho uma freebet de R$ 50 — qual odd usar e quanto cubro?',
    'Qual a melhor surebet ativa no radar agora pra minha banca?',
    'Monte a cobertura sequencial de uma múltipla qualificadora de R$ 50.'
  ];
  const [simulationMode, setSimulationMode] = useState(true);
  const [opportunities, setOpportunities] = useState<OpportunityItem[]>([]);
  const [selectedBookmakers, setSelectedBookmakers] = useState<string[]>([]);
  const [selectedSports, setSelectedSports] = useState<string[]>([]);
  const [vipOnly, setVipOnly] = useState<boolean>(false);
  const [fonteFiltro, setFonteFiltro] = useState<'todas' | 'sureradar' | 'prematch' | 'telegram'>('todas');
  const [soSalvas, setSoSalvas] = useState(false); // filtra só oportunidades salvas (⭐)

  const mockOpportunities: OpportunityItem[] = [
    {
      id: 'mock-1',
      evento: 'Almagro × Atlético Rafaela',
      odd_casa_1: 1.34,
      odd_casa_2: 4.10,
      margem_mercado: 99.01,
      stake_casa_1: 753.68,
      stake_casa_2: 246.32,
      lucro_esperado: 9.90,
      roi_pct: 0.99,
      status: 'pendente',
      detectada_em: new Date().toISOString(),
      casa_a_nome: 'Betano',
      casa_b_nome: 'KTO',
      opcao_a: 'Vitória Almagro',
      opcao_b: 'Atlético Rafaela ou Empate',
      mercado: 'Resultado Final',
      analise_ia: '🟢 Risco Baixo. Ambas as casas (Betano e KTO) resolvem dupla chance de forma padronizada. Jogo de menor expressão argentina, liquidez pode flutuar rápido, faça a entrada imediatamente começando pela KTO (odd 4.10).',
      ia_status: 'concluido',
      ia_risco: 'ok',
      ia_veredito: { nivel_risco: 'ok', tipo: 'ok', motivo: 'Regras de dupla chance padronizadas entre Betano e KTO. Sem conflito conhecido.', confianca: 80, fonte: 'gemini' }
    },
    {
      id: 'mock-2',
      evento: 'LOUD vs paiN Gaming',
      odd_casa_1: 2.10,
      odd_casa_2: 2.05,
      margem_mercado: 96.39,
      stake_casa_1: 493.97,
      stake_casa_2: 506.03,
      lucro_esperado: 37.35,
      roi_pct: 3.73,
      status: 'pendente',
      detectada_em: new Date().toISOString(),
      casa_a_nome: 'Superbet',
      casa_b_nome: 'Blaze',
      opcao_a: 'LOUD',
      opcao_b: 'paiN Gaming',
      mercado: 'Vencedor da Partida',
      analise_ia: '🟡 Risco Moderado. Casas como Blaze em E-Sports (CBLOL) tendem a suspender a partida se houver First Blood muito rápido. Recomendado ter as duas abas já logadas e fazer clique simultâneo.',
      ia_status: 'concluido',
      ia_risco: 'atencao',
      ia_veredito: { nivel_risco: 'atencao', tipo: 'conflito_regras', motivo: 'Políticas de suspensão em e-sports podem divergir entre Superbet e Blaze; confirme a regra de abandono antes de entrar.', confianca: 60, fonte: 'gemini' }
    },
    {
      id: 'mock-3',
      evento: 'Carlos Alcaraz vs Novak Djokovic',
      odd_casa_1: 2.05,
      odd_casa_2: 2.02,
      margem_mercado: 98.29,
      stake_casa_1: 496.31,
      stake_casa_2: 503.69,
      lucro_esperado: 17.10,
      roi_pct: 1.71,
      status: 'pendente',
      detectada_em: new Date().toISOString(),
      casa_a_nome: 'Betano',
      casa_b_nome: '1xBet',
      opcao_a: 'Carlos Alcaraz',
      opcao_b: 'Novak Djokovic',
      mercado: 'Vencedor da Partida',
      analise_ia: '🟢 Risco Baixo. Final de Grand Slam. Sem empate (2-way). Oportunidade excelente com liquidez extremamente alta.',
      ia_status: 'pendente'
    }
  ];

  // Scanner and filtering
  const [loadingScan, setLoadingScan] = useState(false);

  // Calculator Modal State
  const [selectedOpp, setSelectedOpp] = useState<OpportunityItem | null>(null);
  // Re-preenchido com a banca vigente sempre que um modal abre (useEffect abaixo).
  const [modalTotalInvestment, setModalTotalInvestment] = useState(userBanca);
  const [modalOdd1, setModalOdd1] = useState('');
  const [modalOdd2, setModalOdd2] = useState('');
  const [revalResult, setRevalResult] = useState<OpportunityItem['revalidacao'] | null>(null);
  const [revalLoading, setRevalLoading] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (selectedOpp) {
      setModalTotalInvestment(userBanca);
      setModalOdd1(selectedOpp.odd_casa_1.toString());
      setModalOdd2(selectedOpp.odd_casa_2.toString());
      setRevalResult(selectedOpp.revalidacao || null);
    }
  }, [selectedOpp, userBanca]);

  const [launchedKeys, setLaunchedKeys] = useState<string[]>(() => {
    return JSON.parse(localStorage.getItem('jotinhabet_launched_keys') || '[]');
  });

  // Entrada MANUAL de surebet: lança na banca uma operação digitada pelo usuário,
  // sem depender de uma oportunidade detectada pelo radar (oportunidade_id = null).
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    evento: '', esporte: '', mercado: '', casaA: '', opcaoA: '', oddA: '', casaB: '', opcaoB: '', oddB: ''
  });
  const [manualTotal, setManualTotal] = useState('50.00');
  const [manualStakeA, setManualStakeA] = useState('');
  const [manualStakeB, setManualStakeB] = useState('');
  // false = distribui o total pelas odds (como no modal do radar); true = o usuário
  // digitou as stakes que de fato apostou e o total passa a ser a soma delas.
  const [manualStakesEditadas, setManualStakesEditadas] = useState(false);

  const abrirEntradaManual = () => {
    setManualForm({ evento: '', esporte: '', mercado: '', casaA: '', opcaoA: '', oddA: '', casaB: '', opcaoB: '', oddB: '' });
    setManualTotal(userBanca);
    setManualStakeA('');
    setManualStakeB('');
    setManualStakesEditadas(false);
    setManualOpen(true);
  };

  const [dashboardSubTab, setDashboardSubTab] = useState<'radar' | 'historico' | 'promocoes'>('radar');
  const [filterDate, setFilterDate] = useState<string>(''); // YYYY-MM-DD
  // Filtros do HISTÓRICO de entradas (data do lançamento + esporte) — os cards de
  // métricas (lucro, ROI médio) do histórico respondem a este recorte.
  const [histFiltroData, setHistFiltroData] = useState<string>(''); // YYYY-MM-DD ('' = todas)
  const [histFiltroEsporte, setHistFiltroEsporte] = useState<string>(''); // '' = todos
  const [sortBy, setSortBy] = useState<'roi' | 'horario'>('roi'); // 'roi' or 'horario'
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('jotinhabet_theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('jotinhabet_theme', theme);
    // Barra de status/URL do Chrome Android acompanha o tema (senão fica escura no
    // modo claro e destoa). Valores = --bg-main de cada tema no index.css.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? '#f8fafc' : '#070b13');
  }, [theme]);

  // Live System Logs State
  const [systemLogs, setSystemLogs] = useState('Carregando console do JotinhaBet...');
  const [logsExpanded, setLogsExpanded] = useState(true);

  // Operations history state
  const [operationsHistory, setOperationsHistory] = useState<any[]>([]);
  const [loadingOperation, setLoadingOperation] = useState(false);

  // Histórico de surebets de PROMOÇÃO (inserção manual — tabela promo_surebets).
  //
  // A MATEMÁTICA NÃO VIVE AQUI: cada tipo é uma fórmula diferente de retorno bruto e de
  // custo real, e a fonte única é backend/src/core/promocoes.ts (testada). Esta tela só
  // manda os campos para POST /api/promocoes/calcular e exibe o ResultadoPromocao que
  // volta. Havia um "espelho" da conta neste arquivo e ele já divergia: na freebet SRR a
  // cobertura saía certa por acidente e o lucro saía errado.
  //
  // `promoTipo` usa o vocabulário do BANCO (coluna promo_type) — o tipo `PromoTipo` vive no
  // escopo do MÓDULO (acima), porque PROMO_GUIA (o modal "i") também é tipado por ele.
  type PromoGrupo = 'freebet' | 'dinheiro' | 'turbinada';
  interface PromoMeta {
    /** Rótulo curto do chip (6 tipos têm de caber em ~480px de viewport). */
    chip: string;
    /** Rótulo do badge na tabela do histórico. */
    badge: string;
    cor: string;
    grupo: PromoGrupo;
    /** O campo de valor muda de nome por tipo (ficha grátis ≠ dinheiro apostado). */
    rotuloValor: string;
    /** Uma linha ao lado dos chips, explicando o tipo ativo. */
    resumo: string;
    /** title: a ARMADILHA do tipo — é o que evita usar a doutrina do tipo errado. */
    dica: string;
    /** true = a ficha da promoção não sai do bolso (espelha ehFreebetSemCusto do core). */
    semCustoDaFicha: boolean;
  }
  // Metadados de exibição dos 6 tipos. É um Record<PromoTipo, …> de propósito: tipo novo
  // sem entrada aqui NÃO COMPILA. Antes existia uma escada com `else`, e o `else` rotulava
  // qualquer tipo como "freebet" — inclusive afirmando no tooltip que a ficha não retorna,
  // mentira na SRR e na super odd.
  const PROMO_META: Record<PromoTipo, PromoMeta> = {
    FREEBET_SNR: {
      chip: '🎟️ SNR',
      badge: 'freebet SNR',
      cor: 'var(--color-primary)',
      grupo: 'freebet',
      rotuloValor: 'Valor da Freebet (R$)',
      resumo: 'A ficha NÃO volta no green (ganho = ficha × (odd − 1)); investimento real = só a cobertura.',
      dica:
        'Freebet SNR (stake not returned): no green a casa paga só o lucro, ficha × (odd − 1), e perder a ficha custa R$ 0 — ' +
        'o investimento real é apenas a cobertura. Doutrina: aqui a retenção tem PICO em odd alta (≈ √(1 + 1/margem)).',
      semCustoDaFicha: true,
    },
    FREEBET_SRR: {
      chip: '🎟️ SRR',
      badge: 'freebet SRR',
      cor: '#a78bfa',
      grupo: 'freebet',
      rotuloValor: 'Valor da Freebet (R$)',
      resumo: 'A ficha VOLTA no green (ganho = ficha × (odd − 1 + valor da ficha)); a cobertura é quase o dobro da SNR.',
      dica:
        'Freebet SRR (stake returned): no green a ficha volta junto do lucro, então o retorno é ficha × (odd − 1 + v) e a ' +
        'cobertura fica quase o dobro da SNR. ARMADILHA: o ótimo é INVERTIDO — na SRR a retenção cai com a odd (≈ 1 − m·(odd−1)), ' +
        'então busque a MENOR odd elegível; aplicar a doutrina da SNR ("estique a odd") aqui perde retenção de propósito. ' +
        'Se a ficha volta em BÔNUS, informe quanto ela vale.',
      semCustoDaFicha: true,
    },
    QUALIFYING: {
      chip: '💵 Qualificativa',
      badge: 'qualificativa',
      cor: 'var(--color-accent)',
      grupo: 'dinheiro',
      rotuloValor: 'Valor Apostado (R$)',
      resumo: 'Dinheiro real nas duas pernas; investimento = promoção + cobertura.',
      dica:
        'Aposta qualificativa: dinheiro real nas duas pernas (surebet clássica). Quase sempre fecha com CUSTO garantido — ' +
        'ele é o pedágio para liberar o bônus, e a doutrina manda trocar o par de casas quando passa de ~35% do bônus.',
      semCustoDaFicha: false,
    },
    PROTECAO: {
      chip: '🛡️ Proteção',
      badge: 'proteção',
      cor: '#3b82f6',
      grupo: 'dinheiro',
      rotuloValor: 'Valor Apostado (R$)',
      resumo: 'A casa devolve X% se a aposta PERDER: a cobertura recupera o principal e a devolução é o lucro.',
      dica:
        'Proteção / cashback de aposta perdida: dinheiro real nas duas pernas + devolução de X% se a perna da promoção PERDER. ' +
        'ARMADILHA: a devolução cai no cenário do RED (ramo oposto ao do boost) e é ela que paga o lucro — sem o % informado ' +
        'isso é uma qualificativa com prejuízo garantido. Devolução em bônus vale menos que a face.',
      semCustoDaFicha: false,
    },
    SUPERODD: {
      chip: '🚀 Super odd',
      badge: 'super odd',
      cor: '#f59e0b',
      grupo: 'turbinada',
      rotuloValor: 'Valor da Promoção (R$)',
      resumo: 'Odd turbinada com dinheiro real; informe a odd PADRÃO do mercado para medir o boost e a margem.',
      dica:
        'Super odd / odd turbinada: dinheiro real, mas a odd está acima do mercado. Se o excedente é pago em DINHEIRO, a odd ' +
        'turbinada já o contém (retorno = stake × odd). Se é pago em BÔNUS, a casa paga só a odd PADRÃO em caixa e credita a ' +
        'diferença como bônus — aí a odd padrão é obrigatória, senão a conta trata bônus como dinheiro. Costuma ter teto de stake.',
      semCustoDaFicha: false,
    },
    LUCRO_EXTRA: {
      chip: '📈 Lucro extra',
      badge: 'lucro extra',
      cor: '#ec4899',
      grupo: 'turbinada',
      rotuloValor: 'Valor da Promoção (R$)',
      resumo: 'Dinheiro real + X% de lucro extra por cima do retorno normal da odd.',
      dica:
        'Lucro extra / profit boost: dinheiro real e a casa paga +X% POR CIMA do retorno normal. ARMADILHAS: o % costuma incidir ' +
        'sobre o LUCRO (em odd 2,00 vale metade do que incidir sobre o valor apostado); o teto corta a FACE do extra, e a partir ' +
        'do teto aumentar a stake só aumenta o pedágio da cobertura (o ROI CAI). Sem o % informado é uma qualificativa crua.',
      semCustoDaFicha: false,
    },
  };
  const PROMO_GRUPO_TITULO: Record<PromoGrupo, string> = {
    freebet: 'Freebet (ficha grátis)',
    dinheiro: 'Dinheiro real',
    turbinada: 'Turbinada',
  };
  // Chips de um grupo saem do próprio PROMO_META (não de uma lista paralela): tipo novo
  // aparece na tela só declarando seu `grupo`, e não existe segunda lista para esquecer.
  const promoTiposDoGrupo = (g: PromoGrupo): PromoTipo[] =>
    (Object.keys(PROMO_META) as PromoTipo[]).filter((t) => PROMO_META[t].grupo === g);
  // promo_type que esta tela não conhece (linha antiga, tipo novo do banco): badge de AVISO.
  // Cair no rótulo "freebet" aqui era o bug — e ele mentia sobre o dinheiro investido.
  const PROMO_META_DESCONHECIDO: PromoMeta = {
    chip: '❓ desconhecido',
    badge: '❓ tipo desconhecido',
    cor: 'var(--color-warning)',
    grupo: 'dinheiro',
    rotuloValor: 'Valor da Promoção (R$)',
    resumo: 'Tipo não reconhecido por esta tela.',
    dica:
      'Esta tela não reconhece o promo_type desta linha — a matemática dela pode não ser a que o rótulo sugere. ' +
      'Confira o registro antes de confiar no lucro/ROI (a linha conta como DINHEIRO REAL no card "Investido", por prudência).',
    semCustoDaFicha: false,
  };
  const metaPromo = (promoType: any): PromoMeta => {
    const t = `${promoType ?? ''}`.toUpperCase();
    // 'QUALIFICATIVA' é o nome do core e 'QUALIFYING' o do banco: normalizo só esse apelido
    // para o badge/rótulo. Nenhuma outra conversão de tipo acontece nesta tela.
    const chave = (t === 'QUALIFICATIVA' ? 'QUALIFYING' : t) as PromoTipo;
    return PROMO_META[chave] ?? PROMO_META_DESCONHECIDO;
  };
  // A ficha da promoção sai do bolso? UMA função para toda a tela (card "Investido", rótulos).
  // Espelha ehFreebetSemCusto() do core na MESMA polaridade (whitelist de freebet) — o
  // frontend não pode importar o core (build separado), e a regra existia duplicada com
  // polaridade oposta nas duas pontas. Tipo desconhecido conta como dinheiro real: errar por
  // excesso de prudência é melhor que declarar que a operação foi de graça.
  const promoSemCustoDaFicha = (promoType: any): boolean => metaPromo(promoType).semCustoDaFicha;

  const PROMO_FORM_VAZIO = {
    promoTipo: 'FREEBET_SNR' as PromoTipo,
    casaPromocao: '', valorPromocao: '', oddPromocao: '', evento: '', mercado: '',
    casaCobertura: '', valorCobertura: '', oddCobertura: '', roiPct: '', lucro: '',
    // PROTEÇÃO — devolução da aposta perdida
    cashbackPct: '', cashbackTeto: '', cashbackEhBonus: false, valorBonusPct: '70',
    // FREEBET_SRR — 100 = a ficha volta em DINHEIRO; menos que isso, volta em bônus
    valorFichaPct: '100',
    // SUPERODD / LUCRO_EXTRA
    oddPadrao: '', tetoStake: '', boostPct: '', boostSobreStake: false, tetoExtra: '',
    extraEmBonus: false, valorExtraPct: '70',
    // Regulamento (qualquer tipo)
    tetoGanho: '', tetoIncideSobre: 'GANHO' as 'GANHO' | 'RETORNO',
  };
  const [promoHistory, setPromoHistory] = useState<any[]>([]);
  const [promoForm, setPromoForm] = useState({ ...PROMO_FORM_VAZIO });
  const [promoRoiEditado, setPromoRoiEditado] = useState(false);
  const [promoLucroEditado, setPromoLucroEditado] = useState(false);
  const [promoSalvando, setPromoSalvando] = useState(false);
  // Guia das modalidades (modal do "i"): null = fechado; senão, o verbete aberto.
  const [promoGuiaTipo, setPromoGuiaTipo] = useState<PromoTipo | null>(null);

  // Espelho SÓ DE TIPO do ResultadoPromocao de backend/src/core/promocoes.ts (os campos que
  // esta tela exibe). Nenhuma conta acontece aqui: todo número abaixo vem do endpoint.
  interface PromoCalculo {
    tipo: string;
    promoStake: number;
    promoOddEfetiva: number;
    coverOddEfetiva: number;
    coverStake: number;
    coverStakeEqualizado: number;
    investimentoReal: number;
    stakeElegivel: number;
    retornoBrutoPromo: number;
    oddEfetivaPromo: number;
    extraNominal: number;
    extraEfetivo: number;
    extraEmBonus: boolean;
    extraParaZerar: number | null;
    bonusSePromoGanha: number;
    bonusSePromoPerde: number;
    cashbackNominal: number;
    cashbackEfetivo: number;
    cashbackEhBonus: boolean;
    lucroSePromoGanha: number;
    lucroSeCoberturaGanha: number;
    lucroEmCaixaSePromoGanha: number;
    lucroEmCaixaSeCoberturaGanha: number;
    lucroGarantido: number;
    roiPct: number | null;
    retencaoPct: number | null;
    equalizado: boolean;
    avisos: string[];
  }
  const [promoCalculo, setPromoCalculo] = useState<PromoCalculo | null>(null);
  const [promoCalcEstado, setPromoCalcEstado] = useState<'idle' | 'calculando' | 'ok' | 'erro'>('idle');
  const [promoCalcErro, setPromoCalcErro] = useState('');
  // Sequência dos pedidos: resposta lenta de um corpo ANTIGO não pode sobrescrever o
  // cálculo do corpo atual (o usuário digita mais rápido que a rede responde).
  const promoCalcSeqRef = useRef(0);

  // Fetch health status from backend on mount
  useEffect(() => {
    fetch('/api/health')
      .then(res => res.json())
      .then(data => setSystemStatus(data))
      .catch(() => {
        console.warn("Backend offline.");
      });
    
    fetchOpportunities();
    fetchOperations();
    fetchPromocoes();

    // Banca ativa: o banco é a ÚNICA fonte da verdade — busca no mount e aplica,
    // a menos que o usuário já tenha editado neste pageload (um GET tardio não
    // pode sobrescrever edição). Alimenta também o padrão da planilha.
    fetch('/api/banca')
      .then((r) => r.json())
      .then((d) => {
        if (bancaTocadaRef.current) return; // usuário já mexeu — não sobrescreve
        if (d && typeof d.banca === 'number' && Number.isFinite(d.banca) && d.banca > 0) {
          const v = d.banca.toFixed(2);
          userBancaRef.current = v;
          setUserBanca(v);
          setProjBancaInicial(v);
        }
      })
      .catch(() => {
        console.warn('Não foi possível carregar a banca do banco (exibindo o padrão até recarregar).');
      });

    const interval = setInterval(fetchOpportunities, 8000);
    return () => clearInterval(interval);
  }, []);

  // Carrega os saldos por casa salvos no banco (fonte da verdade), a menos que o
  // usuário já tenha editado nesta sessão (não sobrescreve edição por GET tardio).
  useEffect(() => {
    fetch('/api/saldos')
      .then((r) => r.json())
      .then((d) => {
        if (saldosTocadoRef.current) return;
        if (d && Array.isArray(d.saldos) && d.saldos.length) {
          const arr: SaldoCasa[] = d.saldos.map((s: any) => ({
            casa: String(s.casa ?? ''),
            valor: Number.isFinite(Number(s.valor)) && Number(s.valor) > 0 ? Number(s.valor).toFixed(2) : '',
          }));
          setSaldosCasas(arr);
          localStorage.setItem('jotinhabet_saldos_casas', JSON.stringify(arr));
        }
      })
      .catch(() => console.warn('Não foi possível carregar os saldos por casa (usando localStorage).'));
  }, []);

  // Fetch operations from backend
  const fetchOperations = () => {
    fetch('/api/operations')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setOperationsHistory(data);
        }
      })
      .catch(err => {
        console.error('Erro ao buscar operacoes:', err);
      });
  };

  const fetchPromocoes = () => {
    fetch('/api/promocoes')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setPromoHistory(data);
      })
      .catch((err) => {
        console.error('Erro ao buscar promoções:', err);
      });
  };

  // ── Sincronia com o SureRadar (faixa no topo do radar) ───────────────────────────────
  // Estado null = faixa escondida (backend antigo sem o endpoint, ou offline): a tela nunca
  // deve inventar "sincronizado" quando não sabe.
  const [sync, setSync] = useState<SyncSnapshot | null>(null);
  // Desvio entre o relógio do NAVEGADOR e o do backend, medido no último poll. Os instantes do
  // snapshot são do servidor; sem descontar isso, um PC com relógio atrasado mostra "vida
  // restante" negativa (e um adiantado, dado vencido) com a operação perfeitamente em ordem.
  const syncSkewRef = useRef(0);
  const [syncTick, setSyncTick] = useState(() => Date.now());
  const fetchSync = () => {
    fetch('/api/sureradar/sync')
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.deles || !d.sincronia) return; // payload estranho: mantém o que havia
        const gerado = Date.parse(d.geradoEm);
        syncSkewRef.current = Number.isFinite(gerado) ? Date.now() - gerado : 0;
        setSync(d as SyncSnapshot);
      })
      .catch(() => {
        /* endpoint ausente/offline: a faixa simplesmente não aparece */
      });
  };
  // Poll de 15s + tique de 5s só enquanto o radar está aberto: o countdown precisa andar entre
  // polls, mas um tique de 1s re-renderizaria a árvore inteira do dashboard sem necessidade
  // (a cadência medida é de minutos).
  useEffect(() => {
    if (activeTab !== 'dashboard' || dashboardSubTab !== 'radar') return;
    fetchSync();
    const poll = setInterval(fetchSync, 15000);
    const tique = setInterval(() => setSyncTick(Date.now()), 5000);
    return () => {
      clearInterval(poll);
      clearInterval(tique);
    };
  }, [activeTab, dashboardSubTab]);

  // Campo de texto → número do corpo da API. Vazio é AUSENTE (o core aplica o default do
  // regulamento), mas '0' é um valor VÁLIDO e tem de chegar como 0: "bônus que não vale
  // nada" (valor_extra_pct: 0) virando null seria o core assumindo 70% em silêncio.
  const numCampo = (bruto: string): number | null => {
    const t = bruto.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const txtCampo = (bruto: string): string | null => (bruto.trim() ? bruto.trim() : null);

  // Corpo canônico da promoção: o MESMO objeto vai para /api/promocoes/calcular (preview) e
  // para /api/promocoes (registro, que ainda soma lucro/roi digitados à mão). Um builder só
  // porque preview e gravado montados em dois lugares divergem no primeiro campo novo — e aí
  // a tela mostra uma conta e o banco guarda outra.
  //
  // Só vão os campos do TIPO ATIVO (degradação): campo de tipo que não é este viraria coluna
  // nova no INSERT e quebraria os tipos que já funcionam em banco sem a migration nova.
  //
  // Contrato de nomes (snake_case do corpo ↔ EntradaPromocao do core):
  //   valor_ficha_pct↔valorFichaPct, odd_padrao↔oddPadrao, teto_stake↔tetoStake,
  //   boost_pct↔boostPct, boost_sobre_stake↔boostSobreStake, teto_extra↔tetoExtra,
  //   extra_em_bonus↔extraEmBonus, valor_extra_pct↔valorExtraPct,
  //   teto_ganho↔tetoGanho, teto_incide_sobre↔tetoIncideSobre.
  const corpoPromocao = () => {
    const f = promoForm;
    const ehSuperOdd = f.promoTipo === 'SUPERODD';
    const ehLucroExtra = f.promoTipo === 'LUCRO_EXTRA';
    const comBoost = ehSuperOdd || ehLucroExtra;
    return {
      promo_type: f.promoTipo,
      casa_promocao: txtCampo(f.casaPromocao),
      valor_promocao: numCampo(f.valorPromocao),
      evento: txtCampo(f.evento),
      mercado: txtCampo(f.mercado),
      casa_cobertura: txtCampo(f.casaCobertura),
      // Vazio → o backend deriva a cobertura EQUALIZADA (core). Não derivo aqui.
      valor_cobertura: numCampo(f.valorCobertura),
      odd_promocao: numCampo(f.oddPromocao),
      odd_cobertura: numCampo(f.oddCobertura),
      ...(f.promoTipo === 'PROTECAO'
        ? {
            cashback_pct: numCampo(f.cashbackPct),
            cashback_teto: numCampo(f.cashbackTeto),
            cashback_eh_bonus: f.cashbackEhBonus,
            valor_bonus_pct: f.cashbackEhBonus ? numCampo(f.valorBonusPct) : null,
          }
        : {}),
      ...(f.promoTipo === 'FREEBET_SRR' ? { valor_ficha_pct: numCampo(f.valorFichaPct) } : {}),
      ...(ehSuperOdd ? { odd_padrao: numCampo(f.oddPadrao) } : {}),
      ...(ehLucroExtra ? { boost_pct: numCampo(f.boostPct), boost_sobre_stake: f.boostSobreStake } : {}),
      // teto_extra vale nos DOIS tipos com boost: ele corta a face do extra do lucro extra e
      // também a do excedente da super odd paga em bônus.
      ...(comBoost
        ? {
            teto_extra: numCampo(f.tetoExtra),
            extra_em_bonus: f.extraEmBonus,
            valor_extra_pct: f.extraEmBonus ? numCampo(f.valorExtraPct) : null,
          }
        : {}),
      // Tetos do REGULAMENTO valem para qualquer tipo (existe "aposta protegida até R$ 50 de
      // stake" e freebet com stake elegível limitada), e o core aplica stakeElegivel em todos.
      // Só entram no corpo quando preenchidos — assim tipo antigo só passa a exigir a 022 se
      // o usuário de fato usar o campo.
      ...(numCampo(f.tetoStake) !== null ? { teto_stake: numCampo(f.tetoStake) } : {}),
      ...(numCampo(f.tetoGanho) !== null
        ? { teto_ganho: numCampo(f.tetoGanho), teto_incide_sobre: f.tetoIncideSobre }
        : {}),
    };
  };

  // Há dados suficientes para o servidor calcular? É a MESMA pré-condição do core (stake > 0,
  // odds > 1, onde ele devolve null) — checar aqui evita um POST que só pode falhar. Não é
  // fórmula: nenhum número de resultado sai daqui.
  const promoTemDadosParaCalcular = (() => {
    const s = Number(promoForm.valorPromocao);
    const op = Number(promoForm.oddPromocao);
    const oc = Number(promoForm.oddCobertura);
    return Number.isFinite(s) && s > 0 && Number.isFinite(op) && op > 1 && Number.isFinite(oc) && oc > 1;
  })();

  // O corpo serializado É a chave do efeito: assim o que dispara o recálculo e o que é
  // enviado NÃO PODEM divergir. Inclui campo que não muda a conta (evento/mercado) de
  // propósito — um POST a mais custa nada, e esquecer um campo que MUDA a conta deixaria o
  // preview velho na tela com cara de atual.
  const promoCorpoChave = JSON.stringify(corpoPromocao());

  // Só aceita payload com cara de ResultadoPromocao. Campo numérico ausente viraria
  // `undefined.toFixed(...)` e derrubaria a aba inteira no primeiro render — pior ainda,
  // um payload meio preenchido exibiria número parcial como se fosse o cálculo.
  const pareceCalculoPromocao = (c: any): c is PromoCalculo =>
    !!c &&
    Array.isArray(c.avisos) &&
    ['lucroSePromoGanha', 'lucroSeCoberturaGanha', 'lucroGarantido', 'coverStake', 'coverStakeEqualizado', 'stakeElegivel', 'promoStake', 'oddEfetivaPromo', 'extraNominal', 'extraEfetivo', 'cashbackNominal', 'cashbackEfetivo', 'bonusSePromoGanha', 'bonusSePromoPerde', 'lucroEmCaixaSePromoGanha', 'lucroEmCaixaSeCoberturaGanha'].every(
      // `typeof === 'number'` e não Number(x): "12.30" passaria na coerção e quebraria no
      // .toFixed() lá na tela.
      (k) => typeof c[k] === 'number' && Number.isFinite(c[k])
    );

  // Preview do cálculo: sempre do servidor (core/promocoes.ts é a fonte única da matemática).
  // Debounce de 350ms porque cada tecla muda a chave; enquanto a resposta nova não chega, o
  // último resultado FICA na tela (piscar o painel a cada dígito é pior que 350ms de atraso).
  useEffect(() => {
    if (!promoTemDadosParaCalcular) {
      // Sem stake/odds válidas não existe cálculo — limpa em vez de deixar na tela o
      // resultado de OUTROS valores. Invalida também o pedido em voo.
      promoCalcSeqRef.current += 1;
      setPromoCalculo(null);
      setPromoCalcEstado('idle');
      setPromoCalcErro('');
      return;
    }
    const seq = ++promoCalcSeqRef.current;
    setPromoCalcEstado('calculando');
    const timer = setTimeout(() => {
      fetch('/api/promocoes/calcular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: promoCorpoChave,
      })
        .then((r) => r.json().then((d: any) => ({ ok: r.ok, d })).catch(() => ({ ok: false, d: null as any })))
        .then(({ ok, d }) => {
          if (seq !== promoCalcSeqRef.current) return; // resposta de um corpo já superado
          if (ok && d?.ok && pareceCalculoPromocao(d.calculo)) {
            setPromoCalculo(d.calculo);
            setPromoCalcEstado('ok');
            setPromoCalcErro('');
            return;
          }
          // Falhou: o resultado que estava na tela é de OUTRO conjunto de campos, então sai.
          // Lucro e ROI continuam editáveis à mão — inventar número aqui seria gravar ficção.
          setPromoCalculo(null);
          setPromoCalcEstado('erro');
          setPromoCalcErro(
            d?.error || (d?.ok ? 'resposta sem os campos do cálculo' : 'o servidor não devolveu o cálculo')
          );
        })
        .catch(() => {
          if (seq !== promoCalcSeqRef.current) return;
          setPromoCalculo(null);
          setPromoCalcEstado('erro');
          setPromoCalcErro('sem resposta do backend');
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [promoCorpoChave, promoTemDadosParaCalcular]);

  // Formatação (só isto: R$ com sinal e a cor do sinal).
  const promoReais = (v: number) => `${v >= 0 ? '+' : '−'}R$ ${Math.abs(v).toFixed(2)}`;
  const promoCorValor = (v: number) => (v >= 0 ? 'var(--color-success)' : 'var(--color-danger)');
  const promoMetaAtiva = PROMO_META[promoForm.promoTipo];
  // Quais linhas do painel fazem sentido (decisão de EXIBIÇÃO, não de conta). A odd efetiva
  // só informa algo quando o retorno foi mexido — nos tipos sem boost nem teto ela repete a
  // odd digitada, e na SNR ela é odd−1, o que confunde mais do que ajuda.
  const promoMostrarOddEfetiva = promoMetaAtiva.grupo === 'turbinada' || numCampo(promoForm.tetoGanho) !== null;
  const promoAporteEmBranco = !promoForm.valorCobertura.trim();

  // Aparência dos controles do formulário de promoção (nada de matemática daqui para baixo).
  const promoChipStyle = (ativo: boolean): CSSProperties => ({
    padding: '6px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    border: ativo ? '1px solid var(--color-primary)' : '1px solid var(--panel-border)',
    background: ativo ? 'var(--color-primary)' : 'rgba(255,255,255,0.03)',
    color: ativo ? '#fff' : 'var(--text-secondary)',
    transition: 'all 0.15s ease',
  });
  const promoBlocoStyle = (cor: string): CSSProperties => ({
    padding: '10px 12px',
    marginBottom: '12px',
    background: `rgba(${cor}, 0.06)`,
    border: `1px solid rgba(${cor}, 0.25)`,
    borderRadius: '8px',
  });
  const promoBlocoTituloStyle: CSSProperties = {
    fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px',
  };
  // Toggle de duas opções (dinheiro|bônus, ganho|retorno, lucro|valor apostado). O mesmo
  // controle aparece 4 vezes no formulário: uma função só, e cada opção carrega no title a
  // armadilha da escolha (as duas leituras do regulamento NÃO são a mesma fórmula).
  const promoToggle = <T,>(valor: T, opcoes: Array<[T, string, string]>, aplicar: (v: T) => void) => (
    <div style={{ display: 'flex', gap: '6px' }}>
      {opcoes.map(([v, rotulo, dica]) => (
        <button
          key={rotulo}
          onClick={() => aplicar(v)}
          title={dica}
          style={{
            flex: 1, padding: '7px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            border: valor === v ? '1px solid var(--color-primary)' : '1px solid var(--panel-border)',
            background: valor === v ? 'var(--color-primary)' : 'rgba(255,255,255,0.03)',
            color: valor === v ? '#fff' : 'var(--text-secondary)',
          }}
        >
          {rotulo}
        </button>
      ))}
    </div>
  );

  const salvarPromocao = () => {
    const lucroDigitado = !!(promoLucroEditado && promoForm.lucro.trim());
    const obrigatorios: Array<[string, string]> = [
      [promoForm.casaPromocao, 'Casa da promoção'], [promoForm.valorPromocao, 'Valor da promoção'],
      [promoForm.evento, 'Evento'], [promoForm.casaCobertura, 'Casa de cobertura'],
    ];
    const faltando = obrigatorios.filter(([v]) => !String(v).trim()).map(([, nome]) => nome);
    if (faltando.length) {
      alert(`Preencha os campos obrigatórios: ${faltando.join(', ')}.`);
      return;
    }
    // Aporte em branco = o BACKEND deriva a cobertura equalizada (core), e para isso precisa
    // das duas odds. Esta tela não deriva mais nada.
    if (!promoForm.valorCobertura.trim() && !promoTemDadosParaCalcular) {
      alert('Informe o valor de cobertura OU o valor/odds das duas pernas (valor > 0, odds > 1) para o backend derivar a cobertura equalizada.');
      return;
    }
    if (!lucroDigitado && !promoCalculo) {
      alert(
        promoCalcEstado === 'erro'
          ? `O cálculo automático não respondeu (${promoCalcErro}). Tente de novo ou digite o lucro à mão.`
          : promoCalcEstado === 'calculando'
            ? 'O cálculo automático ainda está rodando — aguarde um instante e salve de novo.'
            : 'Informe valor e odds das duas pernas (para o cálculo automático) OU digite o lucro manualmente.'
      );
      return;
    }
    // Campo de que o LUCRO do tipo DEPENDE: sem ele, o que fica gravado é uma qualificativa
    // com prejuízo garantido usando o rótulo do tipo escolhido. O core avisa; aqui a gravação
    // para, porque depois de gravado o número já entrou na banca.
    // Testo o VALOR (> 0), não só o preenchimento: "0" preenche o campo e continua sendo
    // "promoção que não paga nada".
    const exigencia =
      promoForm.promoTipo === 'PROTECAO' && !(Number(promoForm.cashbackPct) > 0)
        ? 'o percentual de devolução da proteção (ex.: 50) — é ele que paga o lucro dessa operação'
        : promoForm.promoTipo === 'LUCRO_EXTRA' && !(Number(promoForm.boostPct) > 0)
          ? 'o percentual do lucro extra (ex.: 30) — é ele que paga a operação nesse tipo'
          : promoForm.promoTipo === 'SUPERODD' && promoForm.extraEmBonus && !(Number(promoForm.oddPadrao) > 1)
            ? 'a odd PADRÃO do mercado (maior que 1) — com o excedente em bônus, sem ela a conta trata bônus como dinheiro sacável'
            : null;
    if (exigencia && !lucroDigitado) {
      alert(`Informe ${exigencia}.`);
      return;
    }
    setPromoSalvando(true);
    fetch('/api/promocoes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // MESMO corpo do preview + lucro/ROI digitados à mão (vazios, o backend deriva do core).
      body: JSON.stringify({
        ...corpoPromocao(),
        lucro: lucroDigitado ? promoForm.lucro : null,
        roi_pct: (promoRoiEditado && promoForm.roiPct.trim()) ? promoForm.roiPct : null,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          // Banca ativa considera o lucro da promoção lançada (mesma regra das
          // entradas de surebet; excluir estorna). Usa o lucro FINAL salvo —
          // pode ter sido derivado das odds no backend.
          const lucroPromo = Number(data.promocao?.lucro) || 0;
          const novaBanca = (parseFloat(userBancaRef.current) + lucroPromo).toFixed(2);
          aplicarBanca(novaBanca, true); // ref + state + localStorage + banco
          // O lucro garantido do core INCLUI bônus valorizado (ficha da SRR que volta em
          // bônus, extra do boost, devolução da proteção). Creditar isso na banca sem dizer
          // qual parte ainda não é caixa faz o painel prometer dinheiro que só existe depois
          // de converter o bônus — então a diferença vai explícita no aviso.
          const bonusGanha = Number(promoCalculo?.bonusSePromoGanha) || 0;
          const bonusPerde = Number(promoCalculo?.bonusSePromoPerde) || 0;
          const bonusNaLinha = Math.max(bonusGanha, bonusPerde);
          const avisosDoCore: string[] = Array.isArray(data.avisos) ? data.avisos : [];
          alert(
            `Promoção registrada! Lucro de R$ ${lucroPromo.toFixed(2)} aplicado à banca ativa (R$ ${novaBanca}).` +
              (bonusNaLinha > 0
                ? `\n\n⚠️ Desse total, R$ ${bonusNaLinha.toFixed(2)} é BÔNUS a converter — o caixa do dia no cenário com bônus é ` +
                  `R$ ${(lucroPromo - bonusNaLinha).toFixed(2)}.`
                : '') +
              (avisosDoCore.length ? `\n\n${avisosDoCore.map((a) => `• ${a}`).join('\n')}` : '')
          );
          setPromoForm({ ...PROMO_FORM_VAZIO });
          setPromoRoiEditado(false);
          setPromoLucroEditado(false);
          fetchPromocoes();
        } else {
          alert(data.error || 'Erro ao salvar promoção.');
        }
      })
      .catch(() => alert('Erro de conexão ao salvar promoção.'))
      .finally(() => setPromoSalvando(false));
  };

  const excluirPromocao = (p: any) => {
    const lucro = Number(p.lucro) || 0;
    if (!confirm(
      `Excluir a promoção "${p.evento}" (${p.casa_promocao}) do histórico?\n\n` +
      `O lucro de R$ ${lucro.toFixed(2)} será estornado da sua banca ativa (R$ ${parseFloat(userBancaRef.current).toFixed(2)}).`
    )) return;
    setPromoHistory((list) => list.filter((x) => x.id !== p.id));
    // Estorna o lucro aplicado no registro (inverso exato do lançamento). Lê da
    // REF (síncrona) — mesma proteção contra stale closure das operações.
    aplicarBanca((parseFloat(userBancaRef.current) - lucro).toFixed(2), true);
    fetch(`/api/promocoes/${p.id}`, { method: 'DELETE' }).catch(() => { /* já removi localmente */ });
  };

  // Métricas dos cards do histórico. Investido = dinheiro REAL que saiu do bolso: a cobertura
  // sempre conta e a perna da promoção conta em TODO tipo que não é freebet (qualificativa,
  // proteção, super odd, lucro extra). Quem decide é promoSemCustoDaFicha — a whitelist de
  // tipos "com dinheiro real" que existia aqui zerava a perna dos tipos novos, declarando de
  // graça uma operação que custou o valor apostado.
  // A stake que foi à MESA é a elegível, não a digitada: com "super odd até R$ 30" o usuário
  // digita 100 e só 30 entram. O backend grava stake_elegivel (migration 022); para linhas
  // antigas/sem a coluna, min(valor, teto) é a mesma regra do fallback do endpoint. Somar a
  // digitada inflava o card em R$ 70 e o ROI implícito do total não fechava com o roi_pct
  // gravado na própria linha.
  const promoStakeNaMesa = (p: any): number => {
    const elegivel = Number(p.stake_elegivel);
    if (Number.isFinite(elegivel) && elegivel > 0) return elegivel;
    const valor = Number(p.valor_promocao) || 0;
    const teto = Number(p.teto_stake);
    return Number.isFinite(teto) && teto > 0 ? Math.min(valor, teto) : valor;
  };
  const promoInvestido = promoHistory.reduce(
    (s, p) => s + (promoSemCustoDaFicha(p.promo_type) ? 0 : promoStakeNaMesa(p)) + (Number(p.valor_cobertura) || 0),
    0
  );
  const promoLucroTotal = promoHistory.reduce((s, p) => s + (Number(p.lucro) || 0), 0);
  const promoRoisValidos = promoHistory.map((p) => Number(p.roi_pct)).filter((v) => Number.isFinite(v));
  const promoRoiMedio = promoRoisValidos.length ? promoRoisValidos.reduce((a, b) => a + b, 0) / promoRoisValidos.length : 0;

  // Fetch live logs from server
  const fetchLogs = () => {
    fetch('/api/logs')
      .then(res => res.json())
      .then(data => {
        if (data.logs) {
          setSystemLogs(data.logs);
        }
      })
      .catch(() => {
        setSystemLogs('Aguardando logs do sistema / Backend offline...');
      });
  };

  // Polling logs every 3 seconds for instant monitoring
  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, []);

  // Fetch opportunities from Supabase
  const fetchOpportunities = () => {
    fetch('/api/opportunities')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setOpportunities(data);
          if (data.length > 0) {
            setSimulationMode(false); // Auto disable simulation mode if real data exists
          }
        }
      })
      .catch(err => {
        console.error('Erro ao buscar oportunidades:', err);
      });
  };

  const opportunitiesToShow = simulationMode ? mockOpportunities : opportunities;

  // Helper to normalize and match sport values
  const getNormalizedSport = (opp: OpportunityItem): string => {
    const sport = opp.esporte || '';
    const normalized = sport
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    
    if (normalized.includes('futebol')) return 'Futebol';
    if (normalized.includes('basquete') || normalized.includes('basketball')) return 'Basquete';
    // Mesa ANTES de tênis: "tenis de mesa" contém "tenis".
    if (normalized.includes('mesa') || normalized.includes('table tennis')) return 'Tênis de Mesa';
    if (normalized.includes('tenis') || normalized.includes('tennis')) return 'Tênis';
    if (normalized.includes('esports') || normalized.includes('eletronicos') || normalized.includes('esport')) return 'Esports';
    if (normalized.includes('volei') || normalized.includes('volley')) return 'Vôlei';
    if (normalized.includes('beisebol') || normalized.includes('baseball')) return 'Beisebol';

    // Fallbacks based on typical text/names
    const eventLower = opp.evento.toLowerCase();
    if (eventLower.includes('alcaraz') || eventLower.includes('djokovic') || eventLower.includes('federer') || eventLower.includes('nadal')) return 'Tênis';
    if (eventLower.includes('loud') || eventLower.includes('pain gaming') || eventLower.includes('gaming') || eventLower.includes('esports')) return 'Esports';
    if (eventLower.includes('lakers') || eventLower.includes('celtics') || eventLower.includes('nba')) return 'Basquete';
    if (opp.evento.includes('×')) return 'Futebol';

    return 'Outros';
  };

  // Extract all unique sports present in current opportunities
  const availableSports = Array.from(new Set(
    opportunitiesToShow.map(opp => getNormalizedSport(opp))
  )).sort();

  // Extract all unique bookmakers present in current opportunities
  const availableBookmakers = Array.from(new Set(
    opportunitiesToShow.flatMap(opp => [opp.casa_a_nome, opp.casa_b_nome].filter(Boolean) as string[])
  )).sort();

  // Filter opportunities based on selected bookmakers (at least one side must be selected, or no filter if empty)
  const filteredOpportunities = opportunitiesToShow.filter(opp => {
    // Filter out already launched opportunities
    const key = `${opp.evento}_${opp.mercado || 'Resultado Final'}_${opp.casa_a_nome || 'Casa A'}_${opp.casa_b_nome || 'Casa B'}`;
    if (launchedKeys.includes(key)) return false;

    // Filter out if it already exists in operationsHistory (synced from DB)
    const alreadyEntered = operationsHistory.some(op => {
      const d = op.detalhes || {};
      return d.evento === opp.evento && (d.mercado || 'Resultado Final') === (opp.mercado || 'Resultado Final');
    });
    if (alreadyEntered) return false;

    // Filtro "só VIP" (oportunidades ocultas no painel do SureRadar, capturadas via API)
    if (vipOnly && !isVipOpportunity(opp)) return false;

    // Filtro por fonte (SureRadar vs pré-match/motor próprio vs Telegram)
    if (fonteFiltro !== 'todas' && fonteOportunidade(opp) !== fonteFiltro) return false;

    // Filtro "só salvas" (⭐ — imunes à limpeza automática, migration 009)
    if (soSalvas && !opp.salva) return false;

    // Filter by event date
    if (filterDate) {
      const [year, month, day] = filterDate.split('-');
      const formattedDateFull = `${day}/${month}/${year}`;
      const formattedDateShort = `${day}/${month}`;
      if (!opp.evento.includes(formattedDateFull) && !opp.evento.includes(formattedDateShort)) {
        return false;
      }
    }

    // Filter by selected sports (if any are selected)
    if (selectedSports.length > 0) {
      const oppSport = getNormalizedSport(opp);
      if (!selectedSports.includes(oppSport)) {
        return false;
      }
    }
 
    if (selectedBookmakers.length === 0) return true;
    const casaA = opp.casa_a_nome || '';
    const casaB = opp.casa_b_nome || '';
    return selectedBookmakers.includes(casaA) || selectedBookmakers.includes(casaB);
  });

  // Helper to extract timestamp from event name (e.g. "Grêmio vs Inter (12/07/2026 16:00)" or "Grêmio vs Inter (12/07 16:00)")
  const getEventDateTimeValue = (eventoStr: string): number => {
    const match = eventoStr.match(/\((\d{2})\/(\d{2})(?:\/(\d{4}))?\s+(\d{2}):(\d{2})\)$/);
    if (!match) return 0;
    const day = parseInt(match[1]);
    const month = parseInt(match[2]) - 1;
    const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
    const hour = parseInt(match[4]);
    const minute = parseInt(match[5]);
    return new Date(year, month, day, hour, minute).getTime();
  };

  // Sort opportunities based on selected option
  const sortedOpportunities = [...filteredOpportunities].sort((a, b) => {
    if (sortBy === 'roi') {
      return b.roi_pct - a.roi_pct; // Descending ROI
    } else {
      const timeA = getEventDateTimeValue(a.evento);
      const timeB = getEventDateTimeValue(b.evento);
      return timeA - timeB; // Ascending Time
    }
  });

  // Trigger manual odds scanning
  const handleRunScan = (sureradarOnly = false) => {
    setLoadingScan(true);
    fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sureradarOnly,
        apenasApi: true // varredura GERAL rápida (SureRadar + pré-match via API), sem Playwright
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          // Scan roda em background (fire-and-forget). Mantém o spinner via polling do
          // status até concluir; o radar atualiza sozinho pelo fetchOpportunities de 8s.
          if (data.started === false) { setLoadingScan(false); return; }
          const poll = setInterval(() => {
            fetch('/api/scan/status')
              .then(r => r.json())
              .then(s => {
                if (!s.running) {
                  clearInterval(poll);
                  setLoadingScan(false);
                  fetchOpportunities();
                }
              })
              .catch(() => { clearInterval(poll); setLoadingScan(false); });
          }, 4000);
          // trava de segurança: nunca deixa o spinner preso além de 2 min
          setTimeout(() => { clearInterval(poll); setLoadingScan(false); }, 120000);
        } else if (data.error) {
          alert(`Erro na varredura: ${data.error}`);
          setLoadingScan(false);
        }
      })
      .catch(err => {
        console.error('Scan failed:', err);
        setLoadingScan(false);
      });
  };

  // Clear all opportunities history
  const handleClearHistory = () => {
    if (confirm('Tem certeza que deseja limpar todo o histórico de surebets encontradas?')) {
      fetch('/api/opportunities', { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setOpportunities([]);
          }
        })
        .catch(err => {
          console.error('Erro ao limpar histórico:', err);
        });
    }
  };

  // Excluir oportunidade individualmente do radar
  const handleExcludeOpp = (oppId: string) => {
    if (confirm('Tem certeza que deseja excluir esta oportunidade do radar?')) {
      if (oppId.includes('mock-')) {
        // Se for mock, oculta localmente simulando o lancamento
        const mockOpp = mockOpportunities.find(o => o.id === oppId);
        if (mockOpp) {
          const key = `${mockOpp.evento}_${mockOpp.mercado || 'Resultado Final'}_${mockOpp.casa_a_nome || 'Casa A'}_${mockOpp.casa_b_nome || 'Casa B'}`;
          const nextKeys = [...launchedKeys, key];
          setLaunchedKeys(nextKeys);
          localStorage.setItem('jotinhabet_launched_keys', JSON.stringify(nextKeys));
        }
        return;
      }
      
      fetch(`/api/opportunities/${oppId}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setOpportunities(opportunities.filter(o => o.id !== oppId));
          } else {
            alert(`Erro ao excluir: ${data.error}`);
          }
        })
        .catch(err => {
          console.error('Erro ao excluir oportunidade:', err);
        });
    }
  };

  // Salvar/dessalvar oportunidade: salva fica IMUNE à limpeza automática do rescan
  // (>24h, reconciliação, expiradas) — p/ entrada mais tarde ou jogo de outro dia.
  const handleToggleSave = async (opp: OpportunityItem) => {
    if (!opp.id || opp.id.includes('mock-')) return;
    const salva = !opp.salva;
    // otimista: reflete já na UI; reverte se a API falhar
    setOpportunities(prev => prev.map(o => (o.id === opp.id ? { ...o, salva } : o)));
    setSelectedOpp(prev => (prev && prev.id === opp.id ? { ...prev, salva } : prev));
    try {
      const r = await fetch(`/api/opportunities/${opp.id}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salva }),
      });
      const data = await r.json();
      if (!data.success) throw new Error(data.error || 'falha');
    } catch (err) {
      console.error('Erro ao salvar oportunidade:', err);
      setOpportunities(prev => prev.map(o => (o.id === opp.id ? { ...o, salva: !salva } : o)));
      setSelectedOpp(prev => (prev && prev.id === opp.id ? { ...prev, salva: !salva } : prev));
    }
  };

  // Analisa o risco por IA SOB DEMANDA (só a oportunidade escolhida) — poupa tokens/cota
  const handleAnalyzeIA = async (oppId: string) => {
    if (!oppId || oppId.includes('mock-') || analyzingIds.has(oppId)) return;
    setAnalyzingIds(prev => new Set(prev).add(oppId));
    try {
      const r = await fetch(`/api/opportunities/${oppId}/enrich`, { method: 'POST' });
      const data = await r.json();
      if (data.success && data.veredito) {
        const patch = { ia_status: 'concluido' as const, ia_risco: data.veredito.nivel_risco, ia_veredito: data.veredito };
        setOpportunities(prev => prev.map(o => (o.id === oppId ? { ...o, ...patch } : o)));
        setSelectedOpp(prev => (prev && prev.id === oppId ? { ...prev, ...patch } : prev));
      } else {
        setOpportunities(prev => prev.map(o => (o.id === oppId ? { ...o, ia_status: 'erro' } : o)));
      }
    } catch {
      setOpportunities(prev => prev.map(o => (o.id === oppId ? { ...o, ia_status: 'erro' } : o)));
    } finally {
      setAnalyzingIds(prev => { const n = new Set(prev); n.delete(oppId); return n; });
    }
  };

  // Revalidar a odd atual (§6) — reconsulta a cotação e classifica o movimento
  const handleRevalidate = async () => {
    if (!selectedOpp || selectedOpp.id.includes('mock-')) return;
    setRevalLoading(true);
    try {
      const r = await fetch(`/api/opportunities/${selectedOpp.id}/revalidate`, { method: 'POST' });
      const data = await r.json();
      if (data.success && data.revalidacao) {
        setRevalResult(data.revalidacao);
        // Atualiza as odds do modal com os valores frescos, se válidos
        if (typeof data.revalidacao.odd_a === 'number' && data.revalidacao.odd_a > 1) setModalOdd1(String(data.revalidacao.odd_a));
        if (typeof data.revalidacao.odd_b === 'number' && data.revalidacao.odd_b > 1) setModalOdd2(String(data.revalidacao.odd_b));
      } else {
        setRevalResult({ checado_em: new Date().toISOString(), odd_a: null, odd_b: null, roi_atual: null, status: 'erro', movimento: { tipo: 'erro', explicacao: data.error || 'Falha ao revalidar' } });
      }
    } catch (e: any) {
      setRevalResult({ checado_em: new Date().toISOString(), odd_a: null, odd_b: null, roi_atual: null, status: 'erro', movimento: { tipo: 'erro', explicacao: e.message || 'Falha de conexão' } });
    } finally {
      setRevalLoading(false);
    }
  };

  // Revalidação POR CARD (direto na lista do radar, sem abrir o modal) — reconsulta as
  // odds ao vivo e mostra o ROI atual + status inline. Atualiza as odds/idade do card.
  const [revalPorCard, setRevalPorCard] = useState<Record<string, any>>({});
  const revalidarCard = async (id: string) => {
    if (!id || id.includes('mock-')) return;
    setRevalPorCard((m) => ({ ...m, [id]: { loading: true } }));
    try {
      const r = await fetch(`/api/opportunities/${id}/revalidate`, { method: 'POST' });
      const data = await r.json();
      const rv = data?.revalidacao;
      if (data.success && rv) {
        setRevalPorCard((m) => ({ ...m, [id]: { ...rv, loading: false } }));
        setOpportunities((prev) => prev.map((o) => (o.id === id ? {
          ...o,
          odd_casa_1: typeof rv.odd_a === 'number' && rv.odd_a > 1 ? rv.odd_a : o.odd_casa_1,
          odd_casa_2: typeof rv.odd_b === 'number' && rv.odd_b > 1 ? rv.odd_b : o.odd_casa_2,
          roi_pct: typeof rv.roi_atual === 'number' ? rv.roi_atual : o.roi_pct,
          revalidado_em: rv.checado_em,
        } : o)));
      } else {
        setRevalPorCard((m) => ({ ...m, [id]: { loading: false, status: 'erro', movimento: { tipo: 'erro', explicacao: data.error || 'Falha ao revalidar' } } }));
      }
    } catch (e: any) {
      setRevalPorCard((m) => ({ ...m, [id]: { loading: false, status: 'erro', movimento: { tipo: 'erro', explicacao: e.message || 'Falha de conexão' } } }));
    }
  };

  // Record bet operation (Lançar na banca)
  const handleRecordOperation = () => {
    if (!selectedOpp || !modalCalc) return;
    setLoadingOperation(true);

    const payload = {
      oportunidade_id: selectedOpp.id.includes('mock-') ? null : selectedOpp.id,
      stake_real_1: modalCalc.stake1,
      stake_real_2: modalCalc.stake2,
      lucro_real: modalCalc.lucro,
      detalhes: {
        evento: selectedOpp.evento,
        esporte: selectedOpp.esporte || undefined,
        mercado: selectedOpp.mercado || 'Resultado Final',
        opcaoA: selectedOpp.opcao_a || 'Opção A',
        opcaoB: selectedOpp.opcao_b || 'Opção B',
        casaA: selectedOpp.casa_a_nome || 'Casa A',
        casaB: selectedOpp.casa_b_nome || 'Casa B',
        oddA: modalCalc.o1,
        oddB: modalCalc.o2,
        roi: modalCalc.roi
      }
    };

    fetch('/api/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          // Update user balance!
          const profit = modalCalc.lucro;
          // Lê da REF (síncrona) — o state do closure pode estar defasado se outra
          // operação mexeu na banca entre o clique e esta resposta.
          const currentBanca = parseFloat(userBancaRef.current);
          const newBanca = (currentBanca + profit).toFixed(2);
          aplicarBanca(newBanca, true); // ref + state + localStorage + banco

          // Add to launched keys to filter out from dashboard!
          const launchedKey = `${selectedOpp.evento}_${selectedOpp.mercado || 'Resultado Final'}_${selectedOpp.casa_a_nome || 'Casa A'}_${selectedOpp.casa_b_nome || 'Casa B'}`;
          const nextKeys = [...launchedKeys, launchedKey];
          setLaunchedKeys(nextKeys);
          localStorage.setItem('jotinhabet_launched_keys', JSON.stringify(nextKeys));
          
          alert(`Entrada lançada com sucesso! Sua banca foi atualizada para R$ ${newBanca}`);
          setSelectedOpp(null); // Close modal
          fetchOperations();    // Reload history
        } else {
          alert(`Erro ao lançar: ${data.error}`);
        }
      })
      .catch(err => {
        alert('Erro ao registrar operação.');
        console.error(err);
      })
      .finally(() => {
        setLoadingOperation(false);
      });
  };

  // Cálculo da entrada manual. No modo automático distribui o total pelas odds
  // (mesma matemática de getModalCalculations); com stakes editadas, o total é a
  // soma das stakes e o lucro considera o PIOR cenário entre as duas pernas
  // (stakes desbalanceadas pagam diferente conforme quem vence).
  const getManualCalc = () => {
    const oA = parseFloat(manualForm.oddA);
    const oB = parseFloat(manualForm.oddB);
    if (!(oA > 1) || !(oB > 1)) return null;

    let stakeA: number, stakeB: number, total: number;
    if (manualStakesEditadas) {
      stakeA = parseFloat(manualStakeA) || 0;
      stakeB = parseFloat(manualStakeB) || 0;
      total = stakeA + stakeB;
    } else {
      total = parseFloat(manualTotal) || 0;
      const margem = 1 / oA + 1 / oB;
      stakeA = (total * (1 / oA)) / margem;
      stakeB = total - stakeA;
    }
    if (total <= 0) return null;

    const lucro = Math.min(stakeA * oA, stakeB * oB) - total;
    const roi = (lucro / total) * 100;
    return { stakeA, stakeB, total, lucro, roi, oA, oB };
  };

  // Editar uma stake liga o modo manual, congelando a outra perna no valor
  // auto-calculado vigente (senão ela "pularia" ao recalcular).
  const editarStakeManual = (lado: 'A' | 'B', valor: string) => {
    if (!manualStakesEditadas) {
      const calc = getManualCalc();
      setManualStakeA(calc ? calc.stakeA.toFixed(2) : '');
      setManualStakeB(calc ? calc.stakeB.toFixed(2) : '');
      setManualStakesEditadas(true);
    }
    if (lado === 'A') setManualStakeA(valor);
    else setManualStakeB(valor);
  };

  // Lançar a entrada manual na banca — mesmo endpoint do fluxo do radar,
  // porém sem oportunidade vinculada (oportunidade_id = null).
  const handleRecordManualOperation = () => {
    const calc = getManualCalc();
    if (!calc) {
      alert('Preencha as duas odds (decimais > 1) e um investimento maior que zero.');
      return;
    }
    if (!manualForm.evento.trim()) {
      alert('Informe o evento (ex.: "Time A vs Time B").');
      return;
    }
    if (calc.lucro < 0 && !confirm(
      `Atenção: com esses valores o PIOR cenário é prejuízo de R$ ${Math.abs(calc.lucro).toFixed(2)} (ROI ${calc.roi.toFixed(2)}%).\n\nLançar mesmo assim?`
    )) return;

    setLoadingOperation(true);

    const payload = {
      oportunidade_id: null,
      stake_real_1: calc.stakeA,
      stake_real_2: calc.stakeB,
      lucro_real: calc.lucro,
      detalhes: {
        evento: manualForm.evento.trim(),
        esporte: manualForm.esporte || undefined,
        mercado: manualForm.mercado.trim() || 'Resultado Final',
        opcaoA: manualForm.opcaoA.trim() || 'Opção A',
        opcaoB: manualForm.opcaoB.trim() || 'Opção B',
        casaA: manualForm.casaA.trim() || 'Casa A',
        casaB: manualForm.casaB.trim() || 'Casa B',
        oddA: calc.oA,
        oddB: calc.oB,
        roi: calc.roi,
        manual: true
      }
    };

    fetch('/api/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          // Atualiza a banca ativa com o lucro da entrada (mesma regra do fluxo do radar).
          const currentBanca = parseFloat(userBancaRef.current);
          const newBanca = (currentBanca + calc.lucro).toFixed(2);
          aplicarBanca(newBanca, true); // ref + state + localStorage + banco

          alert(`Entrada manual lançada com sucesso! Sua banca foi atualizada para R$ ${newBanca}`);
          setManualOpen(false);
          fetchOperations();
        } else {
          alert(`Erro ao lançar: ${data.error}`);
        }
      })
      .catch(err => {
        alert('Erro ao registrar operação.');
        console.error(err);
      })
      .finally(() => {
        setLoadingOperation(false);
      });
  };

  // Excluir uma entrada do histórico e REVERTER a banca ativa (estorna o lucro
  // dessa entrada — inverso exato do lançamento). Serve para desfazer entradas
  // indevidas. Também reexibe a oportunidade no radar (remove a chave que a ocultava).
  const handleDeleteOperation = (op: any) => {
    const lucro = Number(op.lucro_real) || 0;
    const d = op.detalhes || {};
    const evento = d.evento || 'esta entrada';
    if (!confirm(
      `Excluir "${evento}" do histórico?\n\n` +
      `O lucro de R$ ${lucro.toFixed(2)} será estornado da sua banca ativa (R$ ${parseFloat(userBanca).toFixed(2)}).`
    )) return;

    fetch(`/api/operations/${op.id}`, { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          // Reverte a banca: desfaz o "+ lucro" aplicado no lançamento.
          // Lê da REF (síncrona) — evita que duas exclusões em sequência estornem
          // a partir da mesma banca pré-exclusão (stale closure).
          const novaBanca = (parseFloat(userBancaRef.current) - lucro).toFixed(2);
          aplicarBanca(novaBanca, true); // ref + state + localStorage + banco

          // Reexibe a oportunidade no radar: remove a chave gerada no lançamento
          // (mesmo formato de handleRecordOperation).
          const key = `${d.evento}_${d.mercado || 'Resultado Final'}_${d.casaA || 'Casa A'}_${d.casaB || 'Casa B'}`;
          const nextKeys = launchedKeys.filter(k => k !== key);
          setLaunchedKeys(nextKeys);
          localStorage.setItem('jotinhabet_launched_keys', JSON.stringify(nextKeys));

          fetchOperations(); // recarrega o histórico
          alert(`Entrada excluída. Banca revertida para R$ ${novaBanca}.`);
        } else {
          alert(`Erro ao excluir: ${data.error}`);
        }
      })
      .catch(err => {
        console.error('Erro ao excluir operação:', err);
        alert('Erro ao excluir a entrada.');
      });
  };

  useEffect(() => {
    const odd1 = parseFloat(calcOdd1);
    const odd2 = parseFloat(calcOdd2);
    const banca1 = parseFloat(calcBanca1);
    const banca2 = parseFloat(calcBanca2);
    const maxStakePct = parseFloat(calcMaxStakePct) / 100;
    const roundStep1 = parseFloat(calcRoundStep1);
    const roundStep2 = parseFloat(calcRoundStep2);

    if (isNaN(odd1) || isNaN(odd2) || isNaN(banca1) || isNaN(banca2) || isNaN(maxStakePct) || isNaN(roundStep1) || isNaN(roundStep2)) {
      setCalcResult(null);
      setCalcError('Preencha todos os parâmetros numéricos corretamente.');
      return;
    }

    setCalcError('');
    fetch('/api/calculator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        banca1,
        banca2,
        maxStakePct,
        odd1,
        odd2,
        roundStep1,
        roundStep2,
        // Comissão de exchange (1,5% sobre o lucro) por lado quando marcado.
        comissao1: calcExchange1 ? 0.015 : 0,
        comissao2: calcExchange2 ? 0.015 : 0
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setCalcResult(null);
          setCalcError(data.error);
        } else {
          setCalcResult(data);
        }
      })
      .catch(() => {
        setCalcResult(null);
      });
  }, [calcOdd1, calcOdd2, calcBanca1, calcBanca2, calcMaxStakePct, calcRoundStep1, calcRoundStep2, calcExchange1, calcExchange2]);



  const handleSendChat = async (text?: string) => {
    const content = (text ?? chatInput).trim();
    const imagem = chatImagem;
    // Com imagem anexada, a legenda é opcional (o print já é a pergunta).
    if ((!content && !imagem) || chatLoading) return;

    const rotulo = content || (imagem ? `📎 ${imagem.nome}` : '');
    const nextMessages: ChatMsg[] = [...chatMessages, { role: 'user' as const, content: rotulo }];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatImagem(null);
    setChatLoading(true);
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Só role/content vão para o backend: o trace (passos/provider) é metadado de
        // exibição e reenviá-lo inflaria o histórico que o agente reprocessa a cada turno.
        body: JSON.stringify({
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
          ...(imagem ? { imagemBase64: imagem.dataUrl.split(',')[1], mimeType: imagem.mimeType } : {}),
        }),
      });
      const data = await response.json();
      const reply = data.reply || (data.error ? `Erro: ${data.error}` : 'Resposta vazia do servidor.');
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: reply,
        passos: Array.isArray(data.passos) ? data.passos : undefined,
        provider: data.provider,
        modelo: data.modelo,
        avisos: Array.isArray(data.avisos) && data.avisos.length ? data.avisos : undefined,
      }]);
      // Uma ação de escrita (criar oportunidade / registrar promoção) mexeu no banco:
      // recarrega o radar para o painel não ficar mostrando estado velho.
      if (data.acao) fetchOpportunities();
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Falha de conexão com o backend: ${err.message || err}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Catálogo de skills do agente (o que ele consegue fazer) — carregado ao abrir a aba.
  useEffect(() => {
    if (activeTab !== 'ai-test' || chatSkills) return;
    fetch('/api/ai/skills')
      .then(r => r.json())
      .then(d => {
        if (!d || !Array.isArray(d.skills)) return;
        // Normaliza os campos que o painel desreferencia: um backend mais antigo pode
        // responder só `skills`, e um .find()/[0] em undefined derruba a aba inteira.
        setChatSkills({
          ...d,
          provedores: Array.isArray(d.provedores) ? d.provedores : [],
          cadeia_agente: Array.isArray(d.cadeia_agente) ? d.cadeia_agente : [],
          casas_integradas: Number(d.casas_integradas) || 0,
          total: Number(d.total) || d.skills.length,
        });
      })
      .catch(() => { /* painel de skills é informativo: falha não bloqueia o chat */ });
  }, [activeTab, chatSkills]);

  // Auto-scroll da LISTA de mensagens (não da página): scrollIntoView rola todos os
  // ancestrais roláveis e, no mobile, empurrava a página inteira a cada resposta.
  useEffect(() => {
    const fim = chatFimRef.current;
    const lista = fim?.parentElement;
    if (lista) lista.scrollTop = lista.scrollHeight;
  }, [chatMessages, chatLoading]);

  const isDbConnected = systemStatus?.services?.database === 'connected';

  // Âncora da série de juros compostos: a banca ANTES da primeira entrada lançada
  // (banca atual − lucro real acumulado). A banca atual já inclui os lucros das
  // entradas; usar ela direto como banca do 1º dia real somava os lucros DUAS vezes
  // e inflava toda a projeção. Com a âncora, o último dia real fecha exatamente na
  // banca atual do painel e a projeção parte do valor verdadeiro.
  useEffect(() => {
    const lucroReal = operationsHistory.reduce((sum, op) => sum + (op.lucro_real || 0), 0);
    const base = parseFloat(userBanca) - lucroReal;
    if (Number.isFinite(base)) setProjBancaInicial(base.toFixed(2));
  }, [userBanca, operationsHistory]);

  // Planilha de juros compostos: dias REAIS (das entradas lançadas) seguidos dos
  // dias PROJETADOS, numa numeração ÚNICA e contínua (Dia 1..N reais, Dia N+1.. na
  // projeção) e com data de calendário em toda linha — a projeção começa amanhã.
  const getMergedProjection = (): any[] => {
    // 1. Agrupa as operações pelo dia LOCAL (YYYY-MM-DD: ordena como string e não
    // colide entre anos, ao contrário do dd/mm antigo).
    const opsByDate: { [ymd: string]: any[] } = {};
    operationsHistory.forEach(op => {
      const ymd = dataLocalYMD(op.confirmado_em);
      if (!opsByDate[ymd]) opsByDate[ymd] = [];
      opsByDate[ymd].push(op);
    });
    const sortedDates = Object.keys(opsByDate).sort();
    const hojeYMD = dataLocalYMD(new Date());

    const rows: any[] = [];
    let currentBanca = parseFloat(projBancaInicial);
    let diaNum = 0;

    // Dias reais (numeração 1..N na ordem do calendário)
    sortedDates.forEach(ymd => {
      const ops = opsByDate[ymd];
      const lucroTotal = ops.reduce((sum, op) => sum + (op.lucro_real || 0), 0);
      const stakeTotal = ops.reduce((sum, op) => sum + (op.stake_real_1 + op.stake_real_2), 0);

      const startBanca = currentBanca;
      const endBanca = startBanca + lucroTotal;
      currentBanca = endBanca;

      // Até 3 lucros individuais por turno; do 3º em diante agrupa em "T3+"
      const t1 = ops[0] ? ops[0].lucro_real : 0;
      const t2 = ops[1] ? ops[1].lucro_real : 0;
      const t3 = ops.length >= 3 ? ops.slice(2).reduce((sum, op) => sum + op.lucro_real, 0) : 0;

      diaNum += 1;
      rows.push({
        key: `real-${ymd}`,
        diaNum,
        data: ymdParaDDMM(ymd),
        isReal: true,
        isToday: ymd === hojeYMD,
        bancaInicial: startBanca,
        maoPorTurno: ops.length > 0 ? (stakeTotal / ops.length) : 0,
        lucroTurno1: t1,
        lucroTurno2: t2,
        lucroTurno3: t3,
        lucroTotalDia: lucroTotal,
        bancaFinal: endBanca
      });
    });

    // Dias projetados: continuam a numeração e o calendário (a partir de AMANHÃ),
    // compondo sobre a banca final do último dia real.
    const simDaysCount = parseInt(projDias) || 30;
    const maxStakePct = (parseFloat(projMaxStakePct) || 50) / 100;
    const roiMedio = (parseFloat(projRoiMedioPct) || 4) / 100;
    const turnos = parseInt(projTurnosPorDia) || 3;

    let simBanca = currentBanca;
    const hoje = new Date();

    for (let i = 1; i <= simDaysCount; i++) {
      const startBanca = simBanca;
      const stake = startBanca * maxStakePct;

      const lucroTurno = stake * roiMedio;
      const lucroTotalDia = lucroTurno * turnos;
      const endBanca = startBanca + lucroTotalDia;
      simBanca = endBanca;

      const dataProj = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i);

      diaNum += 1;
      rows.push({
        key: `proj-${i}`,
        diaNum,
        data: ymdParaDDMM(dataLocalYMD(dataProj)),
        isReal: false,
        isToday: false,
        bancaInicial: startBanca,
        maoPorTurno: stake,
        lucroTurno1: lucroTurno,
        lucroTurno2: turnos >= 2 ? lucroTurno : 0,
        // Coerente com os dias reais: turnos além do 2º agrupados em "T3+",
        // para T1 + T2 + T3+ sempre fechar com o Lucro Diário.
        lucroTurno3: turnos >= 3 ? lucroTurno * (turnos - 2) : 0,
        lucroTotalDia: lucroTotalDia,
        bancaFinal: endBanca
      });
    }

    return rows;
  };

  const mergedProjection = getMergedProjection();
  const finalProjDay = mergedProjection[mergedProjection.length - 1];
  const initialBancaSeries = mergedProjection[0] ? mergedProjection[0].bancaInicial : parseFloat(projBancaInicial);
  const projProfitTotal = finalProjDay ? Number((finalProjDay.bancaFinal - initialBancaSeries).toFixed(2)) : 0;
  const projRoiTotalPct = initialBancaSeries > 0 ? Number(((projProfitTotal / initialBancaSeries) * 100).toFixed(2)) : 0;

  // Local calculation for the modal based on total investment and current edited odds
  const getModalCalculations = () => {
    if (!selectedOpp) return null;
    const total = parseFloat(modalTotalInvestment) || 0;
    const o1 = parseFloat(modalOdd1) || selectedOpp.odd_casa_1 || 1.01;
    const o2 = parseFloat(modalOdd2) || selectedOpp.odd_casa_2 || 1.01;
    
    // Proporção de apostas
    const prob1 = 1 / o1;
    const prob2 = 1 / o2;
    const margem = prob1 + prob2;
    
    const stake1 = (total * prob1) / margem;
    const stake2 = total - stake1;
    
    const retorno = stake1 * o1; // ou stake2 * o2
    const lucro = retorno - total;
    const roi = (lucro / total) * 100;

    return { stake1, stake2, retorno, lucro, roi, o1, o2 };
  };

  const modalCalc = getModalCalculations();
  const manualCalc = manualOpen ? getManualCalc() : null;
  const totalLucroReal = operationsHistory.reduce((sum, op) => sum + (op.lucro_real || 0), 0);

  // ===== Histórico de Entradas: recorte por data/esporte + métricas do recorte =====
  const historicoFiltrado = operationsHistory.filter((op) => {
    if (histFiltroData && dataLocalYMD(op.confirmado_em) !== histFiltroData) return false;
    if (histFiltroEsporte && esporteDaEntrada(op.detalhes) !== histFiltroEsporte) return false;
    return true;
  });
  const esportesDoHistorico = Array.from(new Set(operationsHistory.map((op) => esporteDaEntrada(op.detalhes)))).sort();
  const histInvestido = historicoFiltrado.reduce((s, op) => s + (Number(op.stake_real_1) || 0) + (Number(op.stake_real_2) || 0), 0);
  const histLucro = historicoFiltrado.reduce((s, op) => s + (Number(op.lucro_real) || 0), 0);
  // ROI por entrada: usa o gravado nos detalhes; sem ele, deriva de lucro/investimento.
  const roiDaOperacao = (op: any): number => {
    const r = Number(op.detalhes?.roi);
    if (Number.isFinite(r)) return r;
    const inv = (Number(op.stake_real_1) || 0) + (Number(op.stake_real_2) || 0);
    return inv > 0 ? ((Number(op.lucro_real) || 0) / inv) * 100 : 0;
  };
  const histRoiMedio = historicoFiltrado.length
    ? historicoFiltrado.reduce((s, op) => s + roiDaOperacao(op), 0) / historicoFiltrado.length
    : 0;
  // ROI agregado do recorte (lucro total / investido total) — complementa a média simples.
  const histRoiAgregado = histInvestido > 0 ? (histLucro / histInvestido) * 100 : 0;
  const histFiltroAtivo = !!(histFiltroData || histFiltroEsporte);

  // Saldos por casa (derivados p/ os cards da aba "Saldo nas Casas").
  const totalSaldos = saldosCasas.reduce((acc, s) => acc + (parseFloat(s.valor) || 0), 0);
  const casasComSaldo = saldosCasas.filter((s) => (parseFloat(s.valor) || 0) > 0).length;

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className={`sidebar ${navOpen ? 'nav-open' : ''}`}>
        <div>
          <div className="sidebar-topbar">
            <div className="logo-container">
              <div className="logo-icon">J</div>
              <span className="logo-text">JotinhaBet</span>
            </div>
            <button
              className="nav-toggle"
              aria-label={navOpen ? 'Fechar menu' : 'Abrir menu'}
              aria-expanded={navOpen}
              onClick={() => setNavOpen((o) => !o)}
            >
              {navOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>

          <nav className="nav-list">
            <a
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => irPara('dashboard')}
            >
              <Layers size={18} />
              Radar Surebets
            </a>
            <a
              className={`nav-item ${activeTab === 'radar-cashout' ? 'active' : ''}`}
              onClick={() => irPara('radar-cashout')}
            >
              <Radar size={18} />
              Radar Cashout
            </a>
            <a
              className={`nav-item ${activeTab === 'valor' ? 'active' : ''}`}
              onClick={() => irPara('valor')}
            >
              <TrendingUp size={18} />
              Value Bets
            </a>
            <a
              className={`nav-item ${activeTab === 'calibracao' ? 'active' : ''}`}
              onClick={() => irPara('calibracao')}
            >
              <Activity size={18} />
              Calibração
            </a>
            <a
              className={`nav-item ${activeTab === 'calculadora' ? 'active' : ''}`}
              onClick={() => irPara('calculadora')}
            >
              <Calculator size={18} />
              Calculadora
            </a>
            <a
              className={`nav-item ${activeTab === 'juros-compostos' ? 'active' : ''}`}
              onClick={() => irPara('juros-compostos')}
            >
              <Percent size={18} />
              Juros Compostos
            </a>
            <a
              className={`nav-item ${activeTab === 'saldos' ? 'active' : ''}`}
              onClick={() => irPara('saldos')}
            >
              <Wallet size={18} />
              Saldo nas Casas
            </a>
            <a
              className={`nav-item ${activeTab === 'ai-test' ? 'active' : ''}`}
              onClick={() => irPara('ai-test')}
            >
              <Cpu size={18} />
              IA & Automação
            </a>
          </nav>
        </div>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className={`indicator ${isDbConnected ? 'indicator-active' : 'indicator-error'}`}></span>
            Database: {isDbConnected ? 'Conectado' : 'Offline'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <span>Versão 1.0.0 (TypeScript)</span>
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                width: '42px',
                height: '42px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                transition: 'all 0.2s ease'
              }}
              title={theme === 'dark' ? 'Ativar Modo Claro' : 'Ativar Modo Escuro'}
            >
              {theme === 'dark' ? <Sun size={15} style={{ color: '#f59e0b' }} /> : <Moon size={15} style={{ color: '#34d399' }} />}
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="header">
          <div className="header-title">
            <h1>
              {activeTab === 'dashboard' && 'Radar de Surebets'}
              {activeTab === 'radar-cashout' && 'Radar Cashout'}
              {activeTab === 'valor' && 'Value Bets (+EV)'}
              {activeTab === 'calibracao' && 'Calibração do Alerta'}
              {activeTab === 'calculadora' && 'Calculadora de Arbitragem'}
              {activeTab === 'juros-compostos' && 'Evolução Diária e Juros Compostos'}
              {activeTab === 'saldos' && 'Saldo Disponível nas Casas'}
              {activeTab === 'ai-test' && 'Laboratório de IA'}
            </h1>
            <p>
              {activeTab === 'dashboard' && 'Monitore oportunidades de lucro garantido em tempo real'}
              {activeTab === 'radar-cashout' && 'Monitore oportunidades de cashout em tempo real'}
              {activeTab === 'valor' && 'Apostas com valor esperado positivo (odd acima da justa da Pinnacle) — só radar, sem alerta'}
              {activeTab === 'calibracao' && 'Precisão do alerta: quantas surebets flagradas o scan viu que sobreviveram à revalidação ao vivo'}
              {activeTab === 'calculadora' && 'Calcule as stakes ideais e ROI para operações de arbitragem'}
              {activeTab === 'juros-compostos' && 'Simulação e projeção baseadas na planilha de Arbitragem'}
              {activeTab === 'saldos' && 'Registre quanto você tem disponível em cada casa de apostas'}
              {activeTab === 'ai-test' && 'Copiloto com acesso aos dados ao vivo: banca, histórico, radar, value bets — e pode lançar oportunidades no radar'}
            </p>
          </div>

          {/* System status pill */}
          <div className="glass-panel" style={{ padding: '8px 16px', display: 'flex', gap: '16px', fontSize: '13px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span className={`indicator ${systemStatus ? 'indicator-active' : 'indicator-error'}`}></span>
              API Backend: {systemStatus ? 'Online' : 'Offline'}
            </div>
          </div>
        </header>

        {activeTab === 'dashboard' && (
          <>
            {/* Stats Cards */}
            <div className="stats-grid">
              <div className="glass-panel stat-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="stat-header" style={{ marginBottom: 0 }}>
                  <span>Sua Banca Ativa</span>
                  <DollarSign size={16} className="stat-icon" style={{ color: 'var(--color-primary)' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '4px 0', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '20px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>R$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    value={userBanca}
                    onChange={(e) => aplicarBanca(e.target.value)}
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid var(--panel-border)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      fontSize: '22px',
                      fontWeight: 'bold',
                      width: '100%',
                      /* minWidth: sem ele o flex-shrink do container esmagava o campo
                         para ~68px e "352.65" ficava cortado dentro da própria caixa. */
                      minWidth: '92px',
                      maxWidth: '120px',
                      padding: '4px 8px',
                      outline: 'none',
                      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)'
                    }}
                  />
                  <button
                    onClick={() => salvarBancaNoBanco(userBanca)}
                    disabled={bancaSaveState === 'saving'}
                    style={{
                      background: bancaSaveState === 'saved' ? 'rgba(16,185,129,0.25)' : 'rgba(16,185,129,0.1)',
                      border: '1px solid rgba(16,185,129,0.35)',
                      borderRadius: '6px',
                      padding: '5px 10px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      cursor: bancaSaveState === 'saving' ? 'wait' : 'pointer',
                      color: bancaSaveState === 'error' ? '#ef4444' : '#10b981',
                      fontSize: '11px',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      transition: 'all 0.15s ease'
                    }}
                    title="Salvar a banca ativa no banco de dados"
                  >
                    {bancaSaveState === 'saved' ? <CheckCircle size={12} /> : <Save size={12} />}
                    {bancaSaveState === 'saving' ? 'Salvando…' : bancaSaveState === 'saved' ? 'Salvo!' : bancaSaveState === 'error' ? 'Erro' : 'Salvar'}
                  </button>
                </div>
                <div className="stat-footer">
                  Saldo utilizado nos cálculos de aposta
                </div>
              </div>

              <div className="glass-panel stat-card">
                <div className="stat-header">
                  <span>Lucro Real Acumulado</span>
                  <Percent size={16} className="stat-icon" style={{ color: 'var(--color-success)' }} />
                </div>
                <div className="stat-value" style={{ color: 'var(--color-success)' }}>
                  R$ {totalLucroReal.toFixed(2)}
                </div>
                <div className="stat-footer">
                  Soma de todos os lucros reais lançados
                </div>
              </div>

              <div className="glass-panel stat-card">
                <div className="stat-header">
                  <span>Operações Realizadas</span>
                  <CheckCircle size={16} className="stat-icon" />
                </div>
                <div className="stat-value">{operationsHistory.length}</div>
                <div className="stat-footer">
                  Total de entradas registradas na banca
                </div>
              </div>

              <div className="glass-panel stat-card">
                <div className="stat-header">
                  <span>Oportunidades Surebet</span>
                  <TrendingUp size={16} className="stat-icon" />
                </div>
                <div className="stat-value">{filteredOpportunities.length}</div>
                <div className="stat-footer">
                  Diferenças de margens ativas no radar
                </div>
              </div>
            </div>

            {/* Sub-Tabs Navigation — flexWrap: em 400px as 3 abas não cabem numa linha */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: '24px', borderBottom: '1px solid var(--panel-border)', paddingBottom: '8px' }}>
              <button
                onClick={() => setDashboardSubTab('radar')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: dashboardSubTab === 'radar' ? 'var(--color-primary)' : 'var(--text-secondary)',
                  fontSize: '15px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  borderBottom: dashboardSubTab === 'radar' ? '2.5px solid var(--color-primary)' : 'none',
                  padding: '8px 0',
                  outline: 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                Radar de Surebets
              </button>
              <button
                onClick={() => setDashboardSubTab('historico')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: dashboardSubTab === 'historico' ? 'var(--color-primary)' : 'var(--text-secondary)',
                  fontSize: '15px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  borderBottom: dashboardSubTab === 'historico' ? '2.5px solid var(--color-primary)' : 'none',
                  padding: '8px 0',
                  outline: 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                Histórico de Entradas
              </button>
              <button
                onClick={() => setDashboardSubTab('promocoes')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: dashboardSubTab === 'promocoes' ? 'var(--color-primary)' : 'var(--text-secondary)',
                  fontSize: '15px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  borderBottom: dashboardSubTab === 'promocoes' ? '2.5px solid var(--color-primary)' : 'none',
                  padding: '8px 0',
                  outline: 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                Histórico Surebet Promoções
              </button>
            </div>

            {dashboardSubTab === 'radar' && (
              /* Dashboard main layout - Two Column Layout (Sidebar filter + 3-col Cards Grid).
                 .resp-stack controla display/direção/alinhamento (coluna no mobile, linha no
                 desktop). NÃO voltar com alignItems inline: em coluna, flex-start faz os
                 filhos usarem largura de CONTEÚDO (~700px) e o radar passa a cortar 234px. */
              <div className="resp-stack" style={{ gap: '24px', width: '100%' }}>

              {/* Lateral Sidebar Filter */}
              <div className="glass-panel resp-full" style={{ width: '260px', padding: '20px', position: 'sticky', top: '24px', display: 'flex', flexDirection: 'column', gap: '16px', flexShrink: 0 }}>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                  <Layers size={16} style={{ color: 'var(--color-primary)' }} />
                  Minhas Contas
                </h3>
                
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                  Filtre as surebets ativas pelas casas onde você possui saldo disponível para apostar.
                </div>

                {selectedBookmakers.length > 0 && (
                  <button 
                    className="btn" 
                    style={{ padding: '5px 10px', minHeight: '36px', fontSize: '11px', border: 'none', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', width: '100%' }}
                    onClick={() => setSelectedBookmakers([])}
                  >
                    Limpar Filtros ({selectedBookmakers.length})
                  </button>
                )}

                {availableBookmakers.length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Aguardando carregar casas...</div>
                ) : (
                  <div className="casas-filtro">
                    {availableBookmakers.map(bookmaker => {
                      const isSelected = selectedBookmakers.includes(bookmaker);
                      
                      const getStyle = (casa: string) => {
                        const c = casa.toLowerCase();
                        if (c.includes('betano')) return { bg: '#f97316', border: '#ea580c' };
                        if (c.includes('kto')) return { bg: '#ef4444', border: '#dc2626' };
                        if (c.includes('superbet')) return { bg: '#e11d48', border: '#be123c' };
                        if (c.includes('blaze')) return { bg: '#dc2626', border: '#991b1b' };
                        if (c.includes('1xbet')) return { bg: '#2563eb', border: '#1d4ed8' };
                        if (c.includes('betnacional')) return { bg: '#0284c7', border: '#0369a1' };
                        if (c.includes('seubet')) return { bg: '#16a34a', border: '#15803d' };
                        if (c.includes('pixbet')) return { bg: '#2563eb', border: '#1d4ed8' };
                        if (c.includes('sportingbet')) return { bg: '#1e3a8a', border: '#172554' };
                        return { bg: 'rgba(255,255,255,0.1)', border: 'rgba(255,255,255,0.2)' };
                      };

                      const brand = getStyle(bookmaker);
                      return (
                        <button
                          key={bookmaker}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedBookmakers(selectedBookmakers.filter(b => b !== bookmaker));
                            } else {
                              setSelectedBookmakers([...selectedBookmakers, bookmaker]);
                            }
                          }}
                          style={{
                            /* largura/direção vêm de .casas-filtro (chips no mobile,
                               coluna no desktop) — não setar width inline aqui. */
                            textAlign: 'left',
                            padding: '8px 12px',
                            minHeight: '36px',
                            borderRadius: '8px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            border: isSelected ? `1.5px solid ${brand.border}` : '1px solid var(--panel-border)',
                            background: isSelected ? brand.bg : 'rgba(255,255,255,0.02)',
                            color: isSelected ? '#fff' : 'var(--text-secondary)',
                            opacity: isSelected ? 1 : 0.7,
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <span>{bookmaker}</span>
                          {isSelected && <span style={{ fontSize: '9px' }}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

              </div>

              {/* Main Content Grid Column */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '24px', minWidth: 0 }}>
                {/* Header Controls Bar */}
                <div className="glass-panel" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                  <h3 className="card-title" style={{ margin: 0, fontSize: '15px' }}>
                    <Activity size={16} style={{ color: 'var(--color-primary)' }} />
                    Radar de Surebets Multiesportes
                  </h3>
                  
                  {/* Filter Toolbar */}
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {/* Simulation Mode Toggle */}
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', padding: '5px 10px', borderRadius: '8px', border: '1px solid var(--panel-border)', userSelect: 'none' }}>
                      <input 
                        type="checkbox" 
                        checked={simulationMode} 
                        onChange={(e) => setSimulationMode(e.target.checked)} 
                        style={{ accentColor: 'var(--color-primary)', cursor: 'pointer' }}
                      />
                      Simulação
                    </label>

                    {/* Date Filter Input */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.03)', padding: '5px 10px', borderRadius: '8px', border: '1px solid var(--panel-border)' }}>
                      <span>Filtrar por Data:</span>
                      <input 
                        type="date"
                        value={filterDate}
                        onChange={(e) => setFilterDate(e.target.value)}
                        style={{
                          background: 'rgba(0,0,0,0.2)',
                          border: '1px solid var(--panel-border)',
                          borderRadius: '6px',
                          padding: '2px 6px',
                          color: 'var(--text-primary)',
                          fontSize: '11px',
                          outline: 'none',
                          cursor: 'pointer'
                        }}
                      />
                      {filterDate && (
                        <button 
                          onClick={() => setFilterDate('')}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--color-danger)',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            padding: '8px',
                            margin: '-6px -4px',
                            minWidth: '28px',
                            minHeight: '28px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          title="Limpar data"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Sort Selector */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.03)', padding: '5px 10px', borderRadius: '8px', border: '1px solid var(--panel-border)' }}>
                      <span>Ordenar por:</span>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as 'roi' | 'horario')}
                        style={{
                          background: 'rgba(0,0,0,0.2)',
                          border: '1px solid var(--panel-border)',
                          borderRadius: '6px',
                          padding: '2px 6px',
                          color: 'var(--text-primary)',
                          fontSize: '11px',
                          outline: 'none',
                          cursor: 'pointer'
                        }}
                      >
                        <option value="roi" style={{ background: '#1e293b' }}>Maior Retorno (%)</option>
                        <option value="horario" style={{ background: '#1e293b' }}>Horário do Evento</option>
                      </select>
                    </div>
 
                    {/* Clear History Button */}
                    <button className="btn btn-secondary" onClick={handleClearHistory} style={{ padding: '6px', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center' }} title="Limpar Histórico">
                      <Trash2 size={13} style={{ color: 'var(--color-danger)' }} />
                    </button>

                    {/* Entrada Manual: lançar na banca uma surebet feita fora do radar */}
                    <button
                      className="btn"
                      onClick={abrirEntradaManual}
                      title="Lançar na banca uma surebet feita manualmente (fora das oportunidades do radar)"
                      style={{
                        padding: '5px 10px',
                        fontSize: '11px',
                        display: 'flex',
                        gap: '4px',
                        alignItems: 'center',
                        background: 'var(--color-primary)',
                        color: '#fff',
                        border: 'none',
                        fontWeight: 'bold'
                      }}
                    >
                      <Plus size={11} />
                      Entrada Manual
                    </button>

                    {/* Scan Trigger Buttons */}
                    <button
                      className="btn"
                      onClick={() => handleRunScan(false)}
                      disabled={loadingScan}
                      title="Varredura geral: SureRadar + pré-match (cruzamento entre casas via API)"
                      style={{
                        padding: '5px 10px',
                        fontSize: '11px',
                        display: 'flex',
                        gap: '4px',
                        alignItems: 'center',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: '#000',
                        border: 'none',
                        fontWeight: 'bold',
                        boxShadow: '0 0 10px rgba(16, 185, 129, 0.3)'
                      }}
                    >
                      <RefreshCw size={11} className={loadingScan ? 'spin-anim' : ''} />
                      {loadingScan ? 'Escaneando...' : 'Escanear Tudo'}
                    </button>
                  </div>
                </div>

                {/* Sincronia com o SureRadar: eles recalculam a cada ~10 min e a nossa varredura
                    roda a cada 5. Esta faixa mostra quanto de vida resta ao que está na tela e
                    se as duas varreduras estão em fase (medição em core/sureradarSync.ts). */}
                {sync && (
                  <SincroniaSureRadar
                    sync={sync}
                    agoraServidorMs={syncTick - syncSkewRef.current}
                    onEscanear={() => handleRunScan(false)}
                  />
                )}

                {/* Filtro rápido por esporte (chips) na barra de filtros */}
                {availableSports.length > 0 && (
                  <div className="glass-panel" style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '2px' }}>Esporte</span>
                    {(() => {
                      const chip = (active: boolean) => ({
                        padding: '5px 12px',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        border: active ? '1px solid var(--color-primary)' : '1px solid var(--panel-border)',
                        background: active ? 'var(--color-primary)' : 'rgba(255,255,255,0.03)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                        transition: 'all 0.15s ease'
                      });
                      const emoji = (s: string) => (s === 'Futebol' ? '⚽' : s === 'Basquete' ? '🏀' : s === 'Tênis de Mesa' ? '🏓' : s === 'Tênis' ? '🎾' : s === 'Esports' ? '🎮' : s === 'Vôlei' ? '🏐' : s === 'Beisebol' ? '⚾' : '🏆');
                      const vipCount = opportunitiesToShow.filter(isVipOpportunity).length;
                      return (
                        <>
                          <button style={chip(selectedSports.length === 0)} onClick={() => setSelectedSports([])}>Todos</button>
                          {availableSports.map((sport) => {
                            const active = selectedSports.includes(sport);
                            return (
                              <button
                                key={sport}
                                style={chip(active)}
                                onClick={() => (active ? setSelectedSports(selectedSports.filter((s) => s !== sport)) : setSelectedSports([...selectedSports, sport]))}
                              >
                                {emoji(sport)} {sport}
                              </button>
                            );
                          })}
                          {(vipCount > 0 || vipOnly) && (
                            <>
                              <span className="sep-v" style={{ width: '1px', alignSelf: 'stretch', background: 'var(--panel-border)', margin: '0 4px' }} />
                              <button
                                title="Mostrar apenas surebets VIP (ocultas no painel do SureRadar, capturadas via API)"
                                onClick={() => setVipOnly((v) => !v)}
                                style={{
                                  ...chip(vipOnly),
                                  ...(vipOnly
                                    ? { background: 'rgba(234, 179, 8, 0.9)', border: '1px solid rgba(234, 179, 8, 0.9)', color: '#1a1a1a' }
                                    : { background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.45)', color: '#fbbf24' }),
                                }}
                              >
                                👑 Só VIP{vipCount ? ` (${vipCount})` : ''}
                              </button>
                            </>
                          )}
                          {/* Filtro por FONTE: SureRadar (agregador) vs Pré-match (motor próprio) vs Telegram (sinais) + só salvas */}
                          {(() => {
                            const nSR = opportunitiesToShow.filter((o) => fonteOportunidade(o) === 'sureradar').length;
                            const nPM = opportunitiesToShow.filter((o) => fonteOportunidade(o) === 'prematch').length;
                            const nTG = opportunitiesToShow.filter((o) => fonteOportunidade(o) === 'telegram').length;
                            const nSalvas = opportunitiesToShow.filter((o) => o.salva).length;
                            const toggle = (f: 'sureradar' | 'prematch' | 'telegram') => setFonteFiltro((cur) => (cur === f ? 'todas' : f));
                            const chipFonte = (ativo: boolean, cor: string) =>
                              ativo
                                ? { ...chip(true), background: cor, border: `1px solid ${cor}`, color: '#0b0b0b' }
                                : { ...chip(false), color: cor, border: `1px solid ${cor}80` };
                            return (
                              <>
                                <span className="sep-v" style={{ width: '1px', alignSelf: 'stretch', background: 'var(--panel-border)', margin: '0 4px' }} />
                                <button title="Só oportunidades do SureRadar (agregador)" onClick={() => toggle('sureradar')} style={chipFonte(fonteFiltro === 'sureradar', '#60a5fa')}>
                                  📡 SureRadar{nSR ? ` (${nSR})` : ''}
                                </button>
                                <button title="Só oportunidades da análise pré-match (cruzamento entre casas)" onClick={() => toggle('prematch')} style={chipFonte(fonteFiltro === 'prematch', '#34d399')}>
                                  🎯 Pré-match{nPM ? ` (${nPM})` : ''}
                                </button>
                                <button title="Só sinais do grupo do Telegram (extraídos por IA de visão)" onClick={() => toggle('telegram')} style={chipFonte(fonteFiltro === 'telegram', '#c084fc')}>
                                  📲 Telegram{nTG ? ` (${nTG})` : ''}
                                </button>
                                <button title="Só oportunidades salvas por você (imunes à limpeza automática)" onClick={() => setSoSalvas((v) => !v)} style={chipFonte(soSalvas, '#fbbf24')}>
                                  ⭐ Salvas{nSalvas ? ` (${nSalvas})` : ''}
                                </button>
                              </>
                            );
                          })()}
                        </>
                      );
                    })()}
                  </div>
                )}

                <div style={{ flex: 1, minHeight: '300px' }}>
                  {filteredOpportunities.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-secondary)' }}>
                      <AlertCircle size={32} style={{ margin: '0 auto 12px auto', display: 'block', color: 'var(--text-muted)' }} />
                      Nenhuma surebet encontrada. Clique em "Escanear" no topo direito para buscar oportunidades!
                    </div>
                  ) : (
                    <div className="surebets-cards">
                      {sortedOpportunities.map(opp => {
                        const isV2 = !!opp.casa_a_nome;
                        const casaA = opp.casa_a_nome || 'Casa 1';
                        const casaB = opp.casa_b_nome || 'Casa 2';
                        const opcaoA = opp.opcao_a || 'Opção 1';
                        const opcaoB = opp.opcao_b || 'Opção 2';
                        const mercado = opp.mercado || 'Mercado Principal';
                        
                        // Regex fallback to parse V2 segments if DB missing columns
                        let displayEvent = opp.evento;
                        if (!isV2 && opp.evento.includes('|')) {
                           const parts = opp.evento.split('|');
                           displayEvent = parts[0].trim();
                        }

                        // Determine sport details
                        const getSportBadge = (esporte?: string) => {
                          const normalizeText = (txt: string) => {
                             return txt.normalize('NFD').replace(/[\u0300-\u036f]/g, "").toLowerCase();
                          };
                          const esp = normalizeText(esporte || '');
                          // 1) Confia no campo `esporte` (os scrapers preenchem corretamente).
                          if (esp) {
                            if (esp.includes('futebol') || esp.includes('football') || esp.includes('soccer')) return '⚽ Futebol';
                            if (esp.includes('basquete') || esp.includes('basket')) return '🏀 Basquete';
                            // Mesa ANTES de tênis: "tenis de mesa" contém "tenis".
                            if (esp.includes('mesa') || esp.includes('table tennis')) return '🏓 Tênis de Mesa';
                            if (esp.includes('tenis') || esp.includes('tennis')) return '🎾 Tênis';
                            if (esp.includes('esport')) return '🎮 Esports';
                            if (esp.includes('volei') || esp.includes('volley')) return '🏐 Vôlei';
                            if (esp.includes('beisebol') || esp.includes('baseball')) return '⚾ Beisebol';
                            if (esp.includes('hoquei') || esp.includes('hockey')) return '🏒 Hóquei';
                          }
                          // 2) Fallback por nome do evento (só quando `esporte` não veio).
                          const ev = opp.evento.toLowerCase();
                          if (ev.includes('lakers') || ev.includes('celtics') || ev.includes('nba')) return '🏀 Basquete';
                          if (ev.includes('djokovic') || ev.includes('alcaraz') || ev.includes('federer') || ev.includes('nadal')) return '🎾 Tênis';
                          if (ev.includes('loud') || ev.includes('pain') || ev.includes('gaming')) return '🎮 Esports';
                          if (opp.evento.includes('×') || ev.includes(' vs ')) return '⚽ Futebol';
                          return '🏆 Esporte';
                        };

                        const getHouseBadgeStyle = (casa: string) => {
                          const c = casa.toLowerCase();
                          if (c.includes('betano')) return { background: 'rgba(249, 115, 22, 0.1)', color: '#f97316', border: '1px solid rgba(249, 115, 22, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' };
                          if (c.includes('kto')) return { background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' };
                          if (c.includes('superbet')) return { background: 'rgba(225, 29, 72, 0.1)', color: '#e11d48', border: '1px solid rgba(225, 29, 72, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' };
                          if (c.includes('blaze')) return { background: 'rgba(244, 63, 94, 0.1)', color: '#f43f5e', border: '1px solid rgba(244, 63, 94, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' };
                          if (c.includes('1xbet')) return { background: 'rgba(37, 99, 235, 0.1)', color: '#3b82f6', border: '1px solid rgba(37, 99, 235, 0.3)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' };
                          return { background: 'rgba(255,255,255,0.05)', color: '#fff', border: '1px solid var(--panel-border)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' };
                        };

                        // Badge de risco da IA (análise MANUAL sob demanda)
                        const getRiskBadge = (): { label: string; color: string; bg: string; border: string; title: string } | null => {
                          const baseTitle = opp.ia_veredito?.motivo || '';
                          if (opp.ia_status === 'erro') {
                            return { label: '🤖 IA: erro (clique p/ tentar)', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.1)', border: '1px solid rgba(148, 163, 184, 0.3)', title: 'Falha na análise — clique para tentar de novo' };
                          }
                          const risco = opp.ia_risco || opp.ia_veredito?.nivel_risco;
                          if (risco === 'ok') return { label: '🟢 IA: OK', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)', border: '1px solid #10b981', title: baseTitle };
                          if (risco === 'atencao') return { label: '🟡 IA: Atenção', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '1px solid #f59e0b', title: baseTitle };
                          if (risco === 'critico') return { label: '🔴 IA: Risco', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', title: baseTitle };
                          return null;
                        };
                        const riskBadge = getRiskBadge();
                        const iaAnalisando = analyzingIds.has(opp.id) || opp.ia_status === 'processando';
                        const iaAnalisado = !!(opp.ia_risco || opp.ia_veredito);
                        const isVip = isVipOpportunity(opp);
                        const fonte = fonteOportunidade(opp);
                        const oddAge = oddAgeInfo(latestOddTs(opp));
                        const ageColor = oddAge?.level === 'stale'
                          ? { c: '#ef4444', bg: 'rgba(239,68,68,0.12)', b: 'rgba(239,68,68,0.3)' }
                          : oddAge?.level === 'warn'
                          ? { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', b: 'rgba(245,158,11,0.3)' }
                          : { c: '#94a3b8', bg: 'rgba(148,163,184,0.12)', b: 'rgba(148,163,184,0.25)' };

                        return (
                        <div key={opp.id} className="surebet-card" style={{ border: isVip ? '1px solid rgba(234, 179, 8, 0.5)' : opp.roi_pct > 2.5 ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid #1e293b' }}>
                          <div className="surebet-header">
                            <span>{getSportBadge(opp.esporte)} • {new Date(opp.detectada_em).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                            {/* flexWrap: com 3 colunas no desktop o card fica ~280px e a fileira de
                                badges estourava — o overflow:hidden do card CORTAVA as últimas. */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: '6px' }}>
                              {oddAge && (
                                <span
                                  title={`Odd coletada ${oddAge.label}${oddAge.level !== 'fresh' ? ' — revalide antes de apostar' : ''}`}
                                  style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap', background: ageColor.bg, color: ageColor.c, border: `1px solid ${ageColor.b}` }}
                                >
                                  ⏱️ {oddAge.label}
                                </span>
                              )}
                              {iaAnalisando ? (
                                <span style={{ fontSize: '11px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap', background: 'rgba(148,163,184,0.1)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.3)' }}>
                                  🤖 analisando…
                                </span>
                              ) : riskBadge ? (
                                <span
                                  onClick={(e) => { e.stopPropagation(); if (opp.ia_status === 'erro') handleAnalyzeIA(opp.id); }}
                                  title={riskBadge.title}
                                  style={{ background: riskBadge.bg, color: riskBadge.color, border: riskBadge.border, padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap', cursor: opp.ia_status === 'erro' ? 'pointer' : 'default' }}
                                >
                                  {riskBadge.label}
                                </span>
                              ) : !iaAnalisado && !opp.id.includes('mock-') ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleAnalyzeIA(opp.id); }}
                                  title="Analisar risco desta oportunidade com IA"
                                  style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399', border: '1px solid rgba(16,185,129,0.35)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap', cursor: 'pointer' }}
                                >
                                  🤖 Analisar IA
                                </button>
                              ) : null}
                              {/* Origem da oportunidade */}
                              <span
                                title={
                                  fonte === 'sureradar'
                                    ? 'Fonte: SureRadar (agregador de surebets)'
                                    : fonte === 'telegram'
                                      ? 'Fonte: sinal do grupo do Telegram, extraído por IA de visão — revalide as odds antes de apostar'
                                      : 'Fonte: análise pré-match do JotinhaBet (cruzamento entre casas)'
                                }
                                style={
                                  fonte === 'sureradar'
                                    ? { background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.45)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }
                                    : fonte === 'telegram'
                                      ? { background: 'rgba(192, 132, 252, 0.15)', color: '#c084fc', border: '1px solid rgba(192, 132, 252, 0.45)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }
                                      : { background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.45)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }
                                }
                              >
                                {fonte === 'sureradar' ? '📡 SureRadar' : fonte === 'telegram' ? '📲 Telegram (IA)' : '🎯 Pré-match'}
                              </span>
                              {isVip && (
                                <span
                                  title="Oportunidade VIP: oculta no painel do SureRadar e capturada via API. Sem link direto — busque o evento manualmente nas casas."
                                  style={{ background: 'rgba(234, 179, 8, 0.18)', color: '#fbbf24', border: '1px solid rgba(234, 179, 8, 0.55)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                                >
                                  👑 VIP
                                </span>
                              )}
                              <span className="surebet-badge" style={{ background: opp.roi_pct > 2.5 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(148, 163, 184, 0.12)', color: opp.roi_pct > 2.5 ? '#34d399' : '#cbd5e1', border: opp.roi_pct > 2.5 ? '1px solid #10b981' : '1px solid rgba(148, 163, 184, 0.3)' }}>
                                {opp.roi_pct > 2.5 ? '🔥 ALTO RETORNO' : 'SUREBET'}
                              </span>
                              {opp.salva && (
                                <span
                                  title="Oportunidade salva: o rescan automático não a remove nem sobrescreve"
                                  style={{ background: 'rgba(96, 165, 250, 0.18)', color: '#60a5fa', border: '1px solid rgba(96, 165, 250, 0.5)', padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                                >
                                  📌 SALVA
                                </span>
                              )}
                              {!opp.id.includes('mock-') && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleToggleSave(opp); }}
                                  style={{
                                    background: opp.salva ? 'rgba(96, 165, 250, 0.2)' : 'rgba(96, 165, 250, 0.08)',
                                    border: opp.salva ? '1px solid rgba(96, 165, 250, 0.6)' : '1px solid rgba(96, 165, 250, 0.25)',
                                    borderRadius: '6px',
                                    width: '24px',
                                    height: '24px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    color: '#60a5fa',
                                    transition: 'all 0.15s ease'
                                  }}
                                  title={opp.salva ? 'Remover dos salvos (volta a ser limpa pelo rescan)' : 'Salvar: o rescan de 5 min não remove esta oportunidade'}
                                >
                                  {opp.salva ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
                                </button>
                              )}
                              <button
                                onClick={() => handleExcludeOpp(opp.id)}
                                style={{
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  border: '1px solid rgba(239, 68, 68, 0.2)',
                                  borderRadius: '6px',
                                  width: '24px',
                                  height: '24px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  color: '#ef4444',
                                  transition: 'all 0.15s ease'
                                }}
                                title="Excluir Oportunidade"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                          
                          <div className="surebet-content">
                            <div className="surebet-title">{displayEvent}</div>
                            <div className="surebet-market">{mercado}</div>
                            
                            <div 
                              className="odd-box clickable-odd-box"
                            >
                              <div className="odd-info">
                                <span className="odd-outcome">{opcaoA}</span>
                                <span style={{ marginTop: '4px' }}>
                                  <span style={getHouseBadgeStyle(casaA)}>{casaA}</span>
                                </span>
                              </div>
                              <span className="odd-value">{opp.odd_casa_1.toFixed(2)}</span>
                            </div>

                            <div 
                              className="odd-box clickable-odd-box"
                            >
                              <div className="odd-info">
                                <span className="odd-outcome">{opcaoB}</span>
                                <span style={{ marginTop: '4px' }}>
                                  <span style={getHouseBadgeStyle(casaB)}>{casaB}</span>
                                </span>
                              </div>
                              <span className="odd-value">{opp.odd_casa_2.toFixed(2)}</span>
                            </div>
                          </div>

                          <div className="surebet-footer" style={{ flexDirection: 'column', gap: '12px' }}>
                            {/* flexWrap: em card estreito o CALCULAR desce p/ baixo do chip de ROI
                                (que aí fica em 1 linha) em vez de espremê-lo em 3 linhas. */}
                            <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', gap: '12px', width: '100%', flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                                <div className="roi-badge" style={{ justifyContent: 'flex-start' }}>
                                  📈 {opp.roi_pct}% RETORNO CERTO
                                </div>
                                {/* Projeção sobre a BANCA ATIVA (era fixa em R$ 1.000, que não
                                    dizia nada de útil com banca de outra ordem de grandeza).
                                    Formata em pt-BR (vírgula decimal, ponto de milhar). */}
                                <div className="roi-example">
                                  {(() => {
                                    const banca = parseFloat(userBanca);
                                    const base = Number.isFinite(banca) && banca > 0 ? banca : 0;
                                    const brl = (v: number) =>
                                      v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                    if (base <= 0) return <>Defina sua banca ativa para ver o lucro</>;
                                    return (
                                      <>
                                        R$ {brl(base)} → Lucro: <strong>R$ {brl((opp.roi_pct / 100) * base)}</strong>
                                      </>
                                    );
                                  })()}
                                </div>
                              </div>
                              
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignSelf: 'flex-start' }}>
                                <button
                                  className="btn"
                                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--panel-border)', color: 'var(--text-primary)' }}
                                  onClick={() => setSelectedOpp(opp)}
                                >
                                  CALCULAR <ChevronRight size={14} />
                                </button>
                                {!opp.id.includes('mock-') && (
                                  <button
                                    className="btn"
                                    disabled={revalPorCard[opp.id]?.loading}
                                    onClick={() => revalidarCard(opp.id)}
                                    style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.35)', color: '#34d399', fontSize: '12px', justifyContent: 'center' }}
                                    title="Reconsultar as odds ao vivo nas casas (evita apostar em odd defasada)"
                                  >
                                    {revalPorCard[opp.id]?.loading ? <><RefreshCw size={13} className="spin-anim" /> Revalidando…</> : <><RefreshCw size={13} /> Revalidar</>}
                                  </button>
                                )}
                              </div>
                            </div>

                            {(() => {
                              const rv = revalPorCard[opp.id];
                              if (!rv || rv.loading) return null;
                              const mapa: Record<string, { t: string; c: string }> = {
                                ok: { t: '✅ Ainda vale', c: '#10b981' },
                                melhorou: { t: '📈 Melhorou', c: '#10b981' },
                                reduzida: { t: '⚠️ Caiu', c: '#f59e0b' },
                                expirada: { t: '❌ Expirou', c: '#ef4444' },
                                nao_suportado: { t: 'ℹ️ Não revalidável nesta fonte', c: '#94a3b8' },
                                erro: { t: '⚠️ Erro ao revalidar', c: '#f59e0b' },
                              };
                              const s = mapa[rv.status as string] || mapa.erro;
                              const roi = typeof rv.roi_atual === 'number' ? ` · ROI ${rv.roi_atual.toFixed(2)}%` : '';
                              const odds = typeof rv.odd_a === 'number' && typeof rv.odd_b === 'number' ? ` · ${rv.odd_a.toFixed(2)}/${rv.odd_b.toFixed(2)}` : '';
                              const exp = (rv.status === 'erro' || rv.status === 'nao_suportado') && rv.movimento?.explicacao ? ` — ${rv.movimento.explicacao}` : '';
                              return (
                                <div style={{ fontSize: '12px', fontWeight: 700, color: s.c, padding: '6px 10px', background: 'rgba(148,163,184,0.06)', borderRadius: '8px' }}>
                                  {s.t}{roi}{odds}{exp}
                                </div>
                              );
                            })()}

                            {opp.analise_ia && (
                              <div style={{ marginTop: '8px', padding: '12px', background: 'rgba(148, 163, 184, 0.08)', border: '1px solid rgba(148, 163, 184, 0.18)', borderRadius: '10px', fontSize: '12px', color: '#cbd5e1' }}>
                                <strong>🤖 Análise de Risco (IA):</strong><br/>
                                {opp.analise_ia}
                              </div>
                            )}
                          </div>
                        </div>
                      )})}
                    </div>
                  )}
                </div>
              </div>

            </div>
          )}

          {/* Histórico de Operações Lançadas (Banca) */}
          {dashboardSubTab === 'historico' && (
            <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', border: '1px solid rgba(16, 185, 129, 0.2)', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 className="card-title" style={{ margin: 0, fontSize: '15px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <TrendingUp size={16} style={{ color: '#10b981' }} />
                  Histórico de Entradas Lançadas na Banca
                </h3>
                <button
                  className="btn"
                  onClick={abrirEntradaManual}
                  title="Lançar na banca uma surebet feita manualmente (fora das oportunidades do radar)"
                  style={{
                    padding: '5px 10px',
                    fontSize: '11px',
                    display: 'flex',
                    gap: '4px',
                    alignItems: 'center',
                    background: 'var(--color-primary)',
                    color: '#fff',
                    border: 'none',
                    fontWeight: 'bold'
                  }}
                >
                  <Plus size={11} />
                  Entrada Manual
                </button>
              </div>

              {/* Filtros do histórico: data do lançamento + esporte (chips, mesmo padrão do radar) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px 12px', marginBottom: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', borderRadius: '10px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Data</span>
                <input
                  type="date"
                  value={histFiltroData}
                  onChange={(e) => setHistFiltroData(e.target.value)}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--panel-border)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                    fontSize: '12px',
                    padding: '5px 10px',
                    outline: 'none',
                    colorScheme: theme === 'light' ? 'light' : 'dark'
                  }}
                />
                {(() => {
                  const chip = (active: boolean) => ({
                    padding: '5px 12px',
                    borderRadius: '999px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: active ? '1px solid var(--color-primary)' : '1px solid var(--panel-border)',
                    background: active ? 'var(--color-primary)' : 'rgba(255,255,255,0.03)',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    transition: 'all 0.15s ease'
                  });
                  return (
                    <>
                      <span className="sep-v" style={{ width: '1px', alignSelf: 'stretch', background: 'var(--panel-border)', margin: '0 4px' }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Esporte</span>
                      <button style={chip(!histFiltroEsporte)} onClick={() => setHistFiltroEsporte('')}>Todos</button>
                      {esportesDoHistorico.map((sport) => (
                        <button
                          key={sport}
                          style={chip(histFiltroEsporte === sport)}
                          onClick={() => setHistFiltroEsporte(histFiltroEsporte === sport ? '' : sport)}
                        >
                          {ESPORTE_EMOJI[sport] || '🏆'} {sport}
                        </button>
                      ))}
                      {histFiltroAtivo && (
                        <button
                          style={{ ...chip(false), color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)' }}
                          onClick={() => { setHistFiltroData(''); setHistFiltroEsporte(''); }}
                          title="Limpar filtros de data e esporte"
                        >
                          ✕ Limpar filtros
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Métricas do recorte filtrado — lucro e ROI acompanham os filtros acima */}
              <div className="stats-grid" style={{ marginBottom: '16px' }}>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Entradas{histFiltroAtivo ? ' (filtro)' : ''}</span>
                    <CheckCircle size={16} className="stat-icon" />
                  </div>
                  <div className="stat-value">{historicoFiltrado.length}</div>
                  <div className="stat-footer">
                    {histFiltroAtivo ? `De ${operationsHistory.length} entradas no total` : 'Total de entradas lançadas na banca'}
                  </div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Investido{histFiltroAtivo ? ' (filtro)' : ''}</span>
                    <Layers size={16} className="stat-icon" />
                  </div>
                  <div className="stat-value">R$ {histInvestido.toFixed(2)}</div>
                  <div className="stat-footer">
                    Soma das stakes das entradas do recorte
                  </div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Lucro{histFiltroAtivo ? ' (filtro)' : ' Total'}</span>
                    <TrendingUp size={16} className="stat-icon" style={{ color: histLucro >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }} />
                  </div>
                  <div className="stat-value" style={{ color: histLucro >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {histLucro < 0 ? '−' : ''}R$ {Math.abs(histLucro).toFixed(2)}
                  </div>
                  <div className="stat-footer">
                    {histFiltroData
                      ? `Lucro líquido em ${histFiltroData.split('-').reverse().join('/')}`
                      : 'Lucro líquido das entradas do recorte'}
                  </div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>ROI Médio{histFiltroAtivo ? ' (filtro)' : ''}</span>
                    <Percent size={16} className="stat-icon" style={{ color: 'var(--color-accent)' }} />
                  </div>
                  <div className="stat-value" style={{ color: 'var(--color-accent)' }}>
                    {histRoiMedio.toFixed(2)}%
                  </div>
                  <div className="stat-footer">
                    Média simples por entrada • agregado {histRoiAgregado.toFixed(2)}% (lucro/investido)
                  </div>
                </div>
              </div>

              <div className="table-container" style={{ width: '100%' }}>
                {historicoFiltrado.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    {operationsHistory.length === 0
                      ? 'Nenhuma aposta lançada na banca ainda. Abra a calculadora de uma surebet e clique em "Confirmar Entrada", ou use "Entrada Manual" para registrar uma surebet feita fora do radar!'
                      : 'Nenhuma entrada encontrada para os filtros selecionados. Ajuste a data/esporte ou limpe os filtros.'}
                  </div>
                ) : (
                  <table className="custom-table" style={{ fontSize: '12px' }}>
                    <thead>
                      <tr>
                        {/* hide-mobile: colunas de detalhe somem no celular p/ encurtar o
                            scroll horizontal (o investimento sai da soma das stakes ao lado). */}
                        <th>Data</th>
                        <th>Evento</th>
                        <th className="hide-mobile">Mercado</th>
                        <th>Casas & Odds</th>
                        <th className="hide-mobile">Investimento</th>
                        <th>Lucro Líquido</th>
                        <th>ROI</th>
                        <th style={{ textAlign: 'center' }}>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicoFiltrado.map((op) => {
                        const d = op.detalhes || {};
                        const esporteOp = esporteDaEntrada(d);
                        return (
                          <tr key={op.id}>
                            <td style={{ color: 'var(--text-secondary)' }}>
                              {new Date(op.confirmado_em).toLocaleDateString()} {new Date(op.confirmado_em).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td style={{ fontWeight: 'bold' }}>
                              {d.evento || 'Evento'}
                              {d.manual && (
                                <span title="Entrada lançada manualmente (fora do radar)" style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: '999px', padding: '1px 6px', verticalAlign: 'middle' }}>
                                  manual
                                </span>
                              )}
                              <div style={{ fontSize: '10px', fontWeight: 'normal', color: 'var(--text-muted)', marginTop: '2px' }}>
                                {ESPORTE_EMOJI[esporteOp] || '🏆'} {esporteOp}
                              </div>
                            </td>
                            <td className="hide-mobile">{d.mercado || 'Mercado'}</td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <span>{d.casaA}: <strong>R$ {op.stake_real_1.toFixed(2)}</strong> @ {d.oddA?.toFixed(2)}</span>
                                <span>{d.casaB}: <strong>R$ {op.stake_real_2.toFixed(2)}</strong> @ {d.oddB?.toFixed(2)}</span>
                              </div>
                            </td>
                            <td className="hide-mobile">R$ {(op.stake_real_1 + op.stake_real_2).toFixed(2)}</td>
                            <td style={{ color: op.lucro_real >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 'bold' }}>
                              {op.lucro_real >= 0 ? '+' : '−'} R$ {Math.abs(op.lucro_real).toFixed(2)}
                            </td>
                            <td style={{ color: 'var(--color-accent)', fontWeight: 'bold' }}>{d.roi?.toFixed(2)}%</td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                onClick={() => handleDeleteOperation(op)}
                                style={{
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  border: '1px solid rgba(239, 68, 68, 0.2)',
                                  borderRadius: '6px',
                                  width: '26px',
                                  height: '26px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  color: '#ef4444',
                                  transition: 'all 0.15s ease'
                                }}
                                title="Excluir entrada e reverter a banca"
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* Histórico de Surebets de PROMOÇÃO (inserção manual) */}
          {dashboardSubTab === 'promocoes' && (
            <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', border: '1px solid rgba(16, 185, 129, 0.2)', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 className="card-title" style={{ margin: 0, fontSize: '15px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Gift size={16} style={{ color: '#10b981' }} />
                  Histórico Surebet Promoções
                </h3>
              </div>

              {/* Formulário de inserção manual */}
              <div style={{ padding: '14px 16px', marginBottom: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)', borderRadius: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Registrar surebet de promoção
                  </span>
                  {/* "i": guia das 6 modalidades (o que é, fórmula, exemplo com números e a
                      armadilha de cada uma). Abre no tipo que está selecionado — é ali que a
                      dúvida aparece — e o modal deixa trocar de verbete. */}
                  <button
                    className="promo-guia-btn"
                    onClick={() => setPromoGuiaTipo(promoForm.promoTipo)}
                    title="Guia das modalidades: o que é cada promoção, com fórmula e exemplo numérico"
                    aria-label="Abrir o guia das modalidades de promoção"
                  >
                    <Info size={12} />
                  </button>
                </div>
                {/* Tipo da promoção — cada tipo é uma fórmula diferente no core (retorno bruto e
                    custo real). Os 6 chips vão AGRUPADOS (freebet / dinheiro real / turbinada):
                    numa linha só eles não caberiam em ~480px de viewport. O empilhamento é da
                    classe .promo-tipos (CSS, mobile-first) — o JSX não define display aqui. */}
                <div style={{ marginBottom: '12px' }}>
                  <div className="promo-tipos">
                    {(Object.keys(PROMO_GRUPO_TITULO) as PromoGrupo[]).map((grupo) => (
                      <div key={grupo} className="promo-tipo-grupo">
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {PROMO_GRUPO_TITULO[grupo]}
                        </span>
                        <div className="promo-tipo-chips">
                          {promoTiposDoGrupo(grupo).map((tipo) => (
                            <button
                              key={tipo}
                              style={promoChipStyle(promoForm.promoTipo === tipo)}
                              onClick={() => setPromoForm((f) => ({ ...f, promoTipo: tipo }))}
                              title={PROMO_META[tipo].dica}
                            >
                              {PROMO_META[tipo].chip}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }} title={promoMetaAtiva.dica}>
                    {promoMetaAtiva.resumo}{' '}
                    {/* Atalho no ponto da dúvida: o resumo é uma linha, o verbete tem fórmula,
                        exemplo com números do core e "não confunda com". */}
                    <button className="promo-guia-link" onClick={() => setPromoGuiaTipo(promoForm.promoTipo)}>
                      <Info size={11} /> entender esta modalidade
                    </button>
                  </div>
                </div>
                {/* Termos da devolução — só na proteção, é o que paga o lucro da operação */}
                {promoForm.promoTipo === 'PROTECAO' && (
                  <div style={promoBlocoStyle('59,130,246')}>
                    <div style={promoBlocoTituloStyle}>Devolução da aposta perdida</div>
                    <div className="resp-grid-form">
                      <div className="form-group">
                        <label>Devolução (%)</label>
                        <input
                          className="form-control" type="number" step="1" placeholder="50"
                          value={promoForm.cashbackPct}
                          onChange={(e) => setPromoForm((f) => ({ ...f, cashbackPct: e.target.value }))}
                          title="Percentual da aposta que a casa devolve SE ELA PERDER (ex.: 50 = metade de volta)"
                        />
                      </div>
                      <div className="form-group">
                        <label>Teto da Devolução (R$)</label>
                        <input
                          className="form-control" type="number" step="0.01" placeholder="opcional — ex.: 50.00"
                          value={promoForm.cashbackTeto}
                          onChange={(e) => setPromoForm((f) => ({ ...f, cashbackTeto: e.target.value }))}
                          title='Limite do regulamento ("50% até R$ 50"). Acima da stake que consome o teto, cada real entra SEM proteção.'
                        />
                      </div>
                      <div className="form-group">
                        <label>Cai como</label>
                        {promoToggle(
                          promoForm.cashbackEhBonus,
                          [
                            [false, '💵 Dinheiro', 'Dinheiro real, sacável'],
                            [true, '🎟️ Bônus', 'Bônus/freebet: NÃO é dinheiro sacável — vale o que você consegue extrair convertendo'],
                          ],
                          (v) => setPromoForm((f) => ({ ...f, cashbackEhBonus: v }))
                        )}
                      </div>
                      {promoForm.cashbackEhBonus && (
                        <div className="form-group">
                          <label>Valor do Bônus (%)</label>
                          <input
                            className="form-control" type="number" step="1" placeholder="70"
                            value={promoForm.valorBonusPct}
                            onChange={(e) => setPromoForm((f) => ({ ...f, valorBonusPct: e.target.value }))}
                            title="Quanto vale R$ 1 desse bônus na prática (retenção da conversão da freebet). 70% é o padrão da doutrina; 0 é resposta válida."
                          />
                        </div>
                      )}
                    </div>
                    {/* Face (com o teto do regulamento já aplicado) e valor efetivo vêm do CORE —
                        não são recalculados aqui. O aviso do teto (com a stake que o consome) sai
                        no painel de cálculo, junto dos outros avisos. */}
                    {promoCalculo && promoCalculo.cashbackNominal > 0 && (
                      <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--text-secondary)', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                        <span>
                          Devolução: <strong>R$ {promoCalculo.cashbackNominal.toFixed(2)}</strong>{' '}
                          <span style={{ color: 'var(--text-muted)' }}>(face, teto já aplicado)</span>
                        </span>
                        {promoCalculo.cashbackEhBonus && (
                          <span>Valor efetivo: <strong style={{ color: 'var(--color-accent)' }}>R$ {promoCalculo.cashbackEfetivo.toFixed(2)}</strong></span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* Ficha devolvida — só na SRR. É o `v` de R = S·(odd − 1 + v), a única coisa que
                    separa SRR de SNR: em odd 2,00, tratar uma como a outra sub-hedgeia metade do
                    aporte. */}
                {promoForm.promoTipo === 'FREEBET_SRR' && (
                  <div style={promoBlocoStyle('167,139,250')}>
                    <div style={promoBlocoTituloStyle}>Ficha devolvida (SRR)</div>
                    <div className="resp-grid-form">
                      <div className="form-group">
                        <label>Valor da ficha devolvida (%)</label>
                        <input
                          className="form-control" type="number" step="1" placeholder="100"
                          value={promoForm.valorFichaPct}
                          onChange={(e) => setPromoForm((f) => ({ ...f, valorFichaPct: e.target.value }))}
                          title="100 = a ficha volta em DINHEIRO sacável. Menos que isso = ela volta como BÔNUS e vale só o que der para converter (70 é o padrão da doutrina); 0 faz a SRR degenerar em SNR. Lembre que na SRR o ótimo é a MENOR odd elegível."
                        />
                      </div>
                    </div>
                  </div>
                )}
                {/* Termos do boost — super odd e lucro extra. É o excedente/extra que paga a
                    operação nesses tipos, e ele cai no cenário em que a promoção GANHA: ramo
                    OPOSTO ao da devolução da proteção. */}
                {(promoForm.promoTipo === 'SUPERODD' || promoForm.promoTipo === 'LUCRO_EXTRA') && (
                  <div style={promoBlocoStyle('245,158,11')}>
                    <div style={promoBlocoTituloStyle}>
                      {promoForm.promoTipo === 'SUPERODD' ? 'Termos da super odd' : 'Termos do lucro extra'}
                    </div>
                    <div className="resp-grid-form">
                      {promoForm.promoTipo === 'SUPERODD' && (
                        <div className="form-group">
                          <label>Odd padrão (sem boost)</label>
                          <input
                            className="form-control" type="number" step="0.01" placeholder="1.80"
                            value={promoForm.oddPadrao}
                            onChange={(e) => setPromoForm((f) => ({ ...f, oddPadrao: e.target.value }))}
                            title="Odd NORMAL do mesmo mercado, sem a promoção. Mede o excedente e a margem real do mercado de cobertura (medir a margem pela odd turbinada dá negativo, clampa em zero e esconde o pedágio). Se o excedente cai como BÔNUS ela é obrigatória: sem ela a conta trata bônus como dinheiro."
                          />
                        </div>
                      )}
                      {promoForm.promoTipo === 'LUCRO_EXTRA' && (
                        <>
                          <div className="form-group">
                            <label>Lucro extra (%)</label>
                            <input
                              className="form-control" type="number" step="1" placeholder="30"
                              value={promoForm.boostPct}
                              onChange={(e) => setPromoForm((f) => ({ ...f, boostPct: e.target.value }))}
                              title="Percentual que a casa paga POR CIMA do retorno normal da odd (ex.: 30). Sem ele a operação é uma qualificativa crua, com prejuízo garantido."
                            />
                          </div>
                          <div className="form-group">
                            <label>Incide sobre</label>
                            {promoToggle(
                              promoForm.boostSobreStake,
                              [
                                [false, '📈 Lucro', 'Leitura padrão do regulamento: "+X% de LUCRO extra" — a base é stake × (odd − 1)'],
                                [true, '💵 Valor apostado', 'Regulamento alternativo: o % incide sobre o VALOR APOSTADO. Em odd 2,00 isso vale o DOBRO da outra leitura — confirme no regulamento'],
                              ],
                              (v) => setPromoForm((f) => ({ ...f, boostSobreStake: v }))
                            )}
                          </div>
                        </>
                      )}
                      <div className="form-group">
                        <label>{promoForm.promoTipo === 'SUPERODD' ? 'Teto do excedente (R$)' : 'Teto do extra (R$)'}</label>
                        <input
                          className="form-control" type="number" step="0.01" placeholder="opcional — ex.: 50.00"
                          value={promoForm.tetoExtra}
                          onChange={(e) => setPromoForm((f) => ({ ...f, tetoExtra: e.target.value }))}
                          title='Limite do extra/excedente em reais ("+30% até R$ 50"). O teto corta a FACE, ANTES de valorizar bônus; passando dele, aumentar a stake não aumenta o prêmio — só o pedágio da cobertura (o ROI cai).'
                        />
                      </div>
                      <div className="form-group">
                        <label>{promoForm.promoTipo === 'SUPERODD' ? 'Excedente cai como' : 'Extra cai como'}</label>
                        {promoToggle(
                          promoForm.extraEmBonus,
                          [
                            [false, '💵 Dinheiro', 'Pago em caixa. Na super odd a odd turbinada JÁ contém o excedente — ele não soma duas vezes'],
                            [true, '🎟️ Bônus', 'Pago em bônus/freebet: a casa paga a odd PADRÃO em caixa e credita a diferença como bônus, que vale menos que a face'],
                          ],
                          (v) => setPromoForm((f) => ({ ...f, extraEmBonus: v }))
                        )}
                      </div>
                      {promoForm.extraEmBonus && (
                        <div className="form-group">
                          <label>Valor do bônus (%)</label>
                          <input
                            className="form-control" type="number" step="1" placeholder="70"
                            value={promoForm.valorExtraPct}
                            onChange={(e) => setPromoForm((f) => ({ ...f, valorExtraPct: e.target.value }))}
                            title="Quanto vale R$ 1 desse bônus na prática (70% é o padrão da doutrina). ZERO é resposta válida — bônus que não dá para converter; aí essa promoção não paga a operação."
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="resp-grid-form">
                  <div className="form-group">
                    <label>Casa da Promoção</label>
                    <input className="form-control" placeholder="Ex.: Betano" value={promoForm.casaPromocao} onChange={(e) => setPromoForm((f) => ({ ...f, casaPromocao: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    {/* Rótulo por tipo vem do PROMO_META (ficha grátis ≠ dinheiro apostado): a
                        escada de ternários que ficava aqui rotulava tipo novo de "Promoção". */}
                    <label>{promoMetaAtiva.rotuloValor}</label>
                    <input className="form-control" type="number" step="0.01" placeholder="50.00" value={promoForm.valorPromocao} onChange={(e) => setPromoForm((f) => ({ ...f, valorPromocao: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Odd da Promoção</label>
                    <input className="form-control" type="number" step="0.01" placeholder="2.10" value={promoForm.oddPromocao} onChange={(e) => setPromoForm((f) => ({ ...f, oddPromocao: e.target.value }))} />
                  </div>
                  <div className="form-group" style={{ gridColumn: 'span 2', minWidth: '200px' }}>
                    <label>Evento</label>
                    <input className="form-control" placeholder="Ex.: Flamengo vs Palmeiras" value={promoForm.evento} onChange={(e) => setPromoForm((f) => ({ ...f, evento: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Mercado</label>
                    <input className="form-control" placeholder="Ex.: Resultado Final" value={promoForm.mercado} onChange={(e) => setPromoForm((f) => ({ ...f, mercado: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Casa de Cobertura</label>
                    <input className="form-control" placeholder="Ex.: KTO" value={promoForm.casaCobertura} onChange={(e) => setPromoForm((f) => ({ ...f, casaCobertura: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Valor de Cobertura (R$)</label>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      placeholder={promoCalculo ? `${promoCalculo.coverStakeEqualizado.toFixed(2)} (auto)` : '45.00'}
                      value={promoForm.valorCobertura}
                      onChange={(e) => setPromoForm((f) => ({ ...f, valorCobertura: e.target.value }))}
                      title="Deixe em branco para usar a cobertura equalizada que o backend calcula (core) — o aporte que iguala o lucro dos dois cenários. Digite para sobrescrever."
                    />
                  </div>
                  <div className="form-group">
                    <label>Odd de Cobertura</label>
                    <input className="form-control" type="number" step="0.01" placeholder="1.95" value={promoForm.oddCobertura} onChange={(e) => setPromoForm((f) => ({ ...f, oddCobertura: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Lucro (R$)</label>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      placeholder={
                        promoCalculo
                          ? `${promoCalculo.lucroGarantido.toFixed(2)} (auto)`
                          : promoCalcEstado === 'erro'
                            ? 'digite à mão (cálculo indisponível)'
                            : 'auto pelas odds'
                      }
                      value={promoForm.lucro}
                      onChange={(e) => { setPromoLucroEditado(true); setPromoForm((f) => ({ ...f, lucro: e.target.value })); }}
                      title="Em branco = o lucro garantido calculado pelo core (pior cenário entre as duas pernas). Digite para sobrescrever."
                    />
                  </div>
                  <div className="form-group">
                    <label>ROI (%)</label>
                    <input
                      className="form-control"
                      type="number"
                      step="0.01"
                      placeholder={
                        typeof promoCalculo?.roiPct === 'number'
                          ? `${promoCalculo.roiPct.toFixed(2)} (auto)`
                          : promoCalcEstado === 'erro'
                            ? 'digite à mão (cálculo indisponível)'
                            : 'auto: lucro/investido'
                      }
                      value={promoForm.roiPct}
                      onChange={(e) => { setPromoRoiEditado(true); setPromoForm((f) => ({ ...f, roiPct: e.target.value })); }}
                      title="Em branco = lucro garantido ÷ dinheiro REAL investido (na freebet a ficha não conta). Digite para sobrescrever."
                    />
                  </div>
                </div>
                {/* Teto de ganho/retorno — cláusula que aparece em QUALQUER tipo, por isso fica
                    fora dos blocos condicionais (e DEPOIS dos campos principais: é opcional e não
                    pode empurrar casa/valor/odd para baixo). As duas leituras não são a mesma
                    fórmula, e é o title de cada opção que explica a diferença. */}
                <div style={promoBlocoStyle('148,163,184')}>
                  <div style={promoBlocoTituloStyle}>Teto do regulamento (opcional)</div>
                  <div className="resp-grid-form">
                    {/* Teto de STAKE também é cláusula de regulamento, não de tipo: existe
                        "aposta protegida até R$ 50 de stake" e freebet com stake elegível
                        limitada. Ficava só no bloco do boost, e nesses casos o usuário digitava
                        a stake cheia e a conta rodava sobre dinheiro que não era elegível. */}
                    <div className="form-group">
                      <label>Teto de stake (R$)</label>
                      <input
                        className="form-control" type="number" step="0.01" placeholder="em branco = sem teto"
                        value={promoForm.tetoStake}
                        onChange={(e) => setPromoForm((f) => ({ ...f, tetoStake: e.target.value }))}
                        title='Stake máxima que a promoção aceita ("super odd até R$ 30", "protegida até R$ 50"). A conta roda só na parte elegível: apostar acima disso cola uma qualificativa com prejuízo na operação e muda o aporte da cobertura.'
                      />
                    </div>
                    <div className="form-group">
                      <label>Teto de ganho (R$)</label>
                      <input
                        className="form-control" type="number" step="0.01" placeholder="em branco = sem teto"
                        value={promoForm.tetoGanho}
                        onChange={(e) => setPromoForm((f) => ({ ...f, tetoGanho: e.target.value }))}
                        title='Limite de ganho/retorno do regulamento, em reais. Em branco = sem teto. Confira no regulamento QUAL das duas cláusulas é a sua (o toggle ao lado).'
                      />
                    </div>
                    <div className="form-group">
                      <label>Incide sobre</label>
                      {/* Genérico explícito: sem ele o TS alarga os rótulos para `string` e o
                          setPromoForm deixa de aceitar o valor. */}
                      {promoToggle<'GANHO' | 'RETORNO'>(
                        promoForm.tetoIncideSobre,
                        [
                          ['GANHO', '🏆 Ganho', '"Ganhe até R$ X": o teto limita só o LUCRO — o retorno ainda devolve a stake por cima disso'],
                          ['RETORNO', '💰 Retorno', '"Retorno máximo R$ X": o teto limita o PAGAMENTO INTEIRO. Ler "ganho" onde é "retorno" faz o app mandar aportar mais do que a casa paga, e o green fecha negativo'],
                        ],
                        (v) => setPromoForm((f) => ({ ...f, tetoIncideSobre: v }))
                      )}
                    </div>
                  </div>
                </div>
                {/* Painel do cálculo. TODO número daqui vem de /api/promocoes/calcular (core) —
                    inclusive os AVISOS, que antes eram produzidos no backend e nunca chegavam à
                    tela. São eles que explicam teto mordendo, bônus que não é caixa, cobertura
                    que queima retenção e boost insuficiente: é o produto, não decoração.
                    Enquanto um cálculo novo não volta, o último fica na tela (não pisca). */}
                {(promoCalculo || promoCalcEstado !== 'idle') && (
                  <div style={{ marginTop: '10px', padding: '10px 12px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                        Cálculo do core (servidor)
                      </span>
                      <span style={{ fontSize: '10.5px', color: promoCalcEstado === 'erro' ? 'var(--color-warning)' : 'var(--text-muted)' }}>
                        {promoCalcEstado === 'calculando'
                          ? 'calculando…'
                          : promoCalcEstado === 'erro'
                            ? '⚠️ indisponível'
                            : promoCalcEstado === 'ok'
                              ? '✓ atualizado'
                              : ''}
                      </span>
                    </div>
                    {/* Falhou o endpoint: nada de número estimado localmente (a tela não tem mais
                        fórmula). O usuário registra digitando lucro/ROI à mão. */}
                    {promoCalcEstado === 'erro' && (
                      <span style={{ width: '100%', color: 'var(--color-warning)', lineHeight: 1.45 }}>
                        ⚠️ Não deu para calcular no servidor ({promoCalcErro}). Nada foi estimado aqui — digite o lucro (e o ROI, se quiser) à mão para registrar.
                      </span>
                    )}
                    {promoCalculo && (
                      <>
                        <span>
                          Se a <strong>promoção</strong> ganhar:{' '}
                          <strong style={{ color: promoCorValor(promoCalculo.lucroSePromoGanha) }}>{promoReais(promoCalculo.lucroSePromoGanha)}</strong>
                        </span>
                        <span>
                          Se a <strong>cobertura</strong> ganhar{promoCalculo.cashbackNominal > 0 ? ' (com a devolução)' : ''}:{' '}
                          <strong style={{ color: promoCorValor(promoCalculo.lucroSeCoberturaGanha) }}>{promoReais(promoCalculo.lucroSeCoberturaGanha)}</strong>
                        </span>
                        <span>
                          Garantido (pior caso):{' '}
                          <strong style={{ color: promoCorValor(promoCalculo.lucroGarantido) }}>{promoReais(promoCalculo.lucroGarantido)}</strong>
                        </span>
                        <span title="ROI sobre o dinheiro REAL investido (na freebet a ficha não conta como custo).">
                          ROI:{' '}
                          <strong style={{ color: 'var(--color-accent)' }}>
                            {typeof promoCalculo.roiPct === 'number' ? `${promoCalculo.roiPct.toFixed(2)}%` : '—'}
                          </strong>
                          {typeof promoCalculo.roiPct !== 'number' && <span style={{ color: 'var(--text-muted)' }}> (sem dinheiro real investido)</span>}
                        </span>
                        {/* Retenção é a métrica das DUAS freebets. Na SRR passa de 100% e está certo:
                            a ficha volta, então o lucro pode superar o valor dela. */}
                        {typeof promoCalculo.retencaoPct === 'number' && (
                          <span title="Lucro garantido ÷ valor da ficha. Na SRR pode passar de 100% (a ficha volta), na SNR não.">
                            Retenção da freebet:{' '}
                            <strong style={{ color: promoCorValor(promoCalculo.retencaoPct) }}>{promoCalculo.retencaoPct.toFixed(1)}%</strong>
                          </span>
                        )}
                        <span title="Aporte usado na conta. Em branco no formulário, é o aporte EQUALIZADO que o core calcula (iguala o lucro dos dois cenários).">
                          Cobertura: <strong>R$ {promoCalculo.coverStake.toFixed(2)}</strong>
                          {promoAporteEmBranco && <span style={{ color: 'var(--text-muted)' }}> (equalizada)</span>}
                        </span>
                        {/* Teto de stake mordendo: a conta é a da parte ELEGÍVEL, não a do valor
                            digitado — apostar o resto cola uma qualificativa com prejuízo. */}
                        {promoCalculo.stakeElegivel < promoCalculo.promoStake && (
                          <span style={{ color: 'var(--color-warning)' }} title="A promoção só aceita esta stake (teto do regulamento). Aposte só ela nessa perna.">
                            Stake elegível: <strong>R$ {promoCalculo.stakeElegivel.toFixed(2)}</strong> de R$ {promoCalculo.promoStake.toFixed(2)}
                          </span>
                        )}
                        {promoMostrarOddEfetiva && (
                          <span title="Retorno bruto ÷ stake elegível, já com boost e tetos aplicados. É a odd que a promoção REALMENTE paga.">
                            Odd efetiva da promoção: <strong>{promoCalculo.oddEfetivaPromo.toFixed(3)}</strong>
                          </span>
                        )}
                        {promoCalculo.extraNominal > 0 && (
                          <span title="Face do excedente/extra e, quando é bônus, o valor efetivo. O teto corta a FACE, antes da valorização do bônus.">
                            {promoCalculo.extraEmBonus ? 'Extra (bônus)' : 'Excedente do boost'}:{' '}
                            <strong>R$ {promoCalculo.extraNominal.toFixed(2)}</strong>
                            {promoCalculo.extraEmBonus && (
                              <>
                                {' → efetivo '}
                                <strong style={{ color: 'var(--color-accent)' }}>R$ {promoCalculo.extraEfetivo.toFixed(2)}</strong>
                              </>
                            )}
                          </span>
                        )}
                        {/* Piso do boost: abaixo dele o extra não paga o par de odds. Vem do core
                            (extraParaZerar) — não é estimado aqui. */}
                        {typeof promoCalculo.extraParaZerar === 'number' && (
                          <span style={{ width: '100%', color: 'var(--text-muted)' }}>
                            {promoCalculo.extraParaZerar <= 0
                              ? '✅ Esse par de odds já paga o pedágio sem o boost — o extra é lucro em cima de lucro.'
                              : `Piso do extra com essas odds: R$ ${promoCalculo.extraParaZerar.toFixed(2)} efetivos (o atual é R$ ${promoCalculo.extraEfetivo.toFixed(2)}).`}
                          </span>
                        )}
                        {/* Bônus não é caixa. Os dois avisos abaixo vivem em ramos OPOSTOS: ficha da
                            SRR e extra do boost caem quando a promoção GANHA; a devolução da
                            proteção cai quando ela PERDE. Por isso são condições independentes. */}
                        {promoCalculo.bonusSePromoGanha > 0 && (
                          <span style={{ width: '100%', color: 'var(--text-muted)' }}>
                            🎟️ Se a <strong>promoção</strong> ganhar, o caixa do dia é{' '}
                            <strong style={{ color: promoCorValor(promoCalculo.lucroEmCaixaSePromoGanha) }}>
                              {promoReais(promoCalculo.lucroEmCaixaSePromoGanha)}
                            </strong>{' '}
                            — R$ {promoCalculo.bonusSePromoGanha.toFixed(2)} do resultado é bônus (ficha devolvida/extra) e só vira dinheiro depois de convertido.
                          </span>
                        )}
                        {promoCalculo.bonusSePromoPerde > 0 && (
                          <span style={{ width: '100%', color: 'var(--text-muted)' }}>
                            🎟️ Se a <strong>cobertura</strong> ganhar, o caixa do dia é{' '}
                            <strong style={{ color: promoCorValor(promoCalculo.lucroEmCaixaSeCoberturaGanha) }}>
                              {promoReais(promoCalculo.lucroEmCaixaSeCoberturaGanha)}
                            </strong>{' '}
                            — R$ {promoCalculo.bonusSePromoPerde.toFixed(2)} é devolução em bônus, que só vira dinheiro depois de convertida.
                          </span>
                        )}
                        {promoCalculo.avisos.length > 0 && (
                          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '8px', borderTop: '1px solid var(--panel-border)' }}>
                            {promoCalculo.avisos.map((aviso, i) => (
                              <span key={i} style={{ fontSize: '11.5px', color: 'var(--color-warning)', lineHeight: 1.45 }}>⚠️ {aviso}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                  <button
                    className="btn"
                    onClick={salvarPromocao}
                    disabled={promoSalvando}
                    style={{ padding: '7px 14px', fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center', background: 'var(--color-primary)', color: '#fff', border: 'none', fontWeight: 'bold', opacity: promoSalvando ? 0.6 : 1 }}
                  >
                    <Plus size={12} />
                    {promoSalvando ? 'Salvando...' : 'Registrar Promoção'}
                  </button>
                </div>
              </div>

              {/* Métricas do histórico de promoções */}
              <div className="stats-grid" style={{ marginBottom: '16px' }}>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Promoções</span>
                    <Gift size={16} className="stat-icon" />
                  </div>
                  <div className="stat-value">{promoHistory.length}</div>
                  <div className="stat-footer">Surebets de promoção registradas</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Investido</span>
                    <Layers size={16} className="stat-icon" />
                  </div>
                  <div className="stat-value">R$ {promoInvestido.toFixed(2)}</div>
                  <div className="stat-footer" title="Cobertura de todas as linhas + a perna da promoção nos tipos com dinheiro real (qualificativa, proteção, super odd, lucro extra). Só as duas freebets não contam a ficha.">
                    Dinheiro real (a ficha das freebets não conta)
                  </div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>Lucro Total</span>
                    <TrendingUp size={16} className="stat-icon" style={{ color: promoLucroTotal >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }} />
                  </div>
                  <div className="stat-value" style={{ color: promoLucroTotal >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {promoLucroTotal < 0 ? '−' : ''}R$ {Math.abs(promoLucroTotal).toFixed(2)}
                  </div>
                  <div className="stat-footer">Lucro líquido extraído das promoções</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header">
                    <span>ROI Médio</span>
                    <Percent size={16} className="stat-icon" style={{ color: 'var(--color-accent)' }} />
                  </div>
                  <div className="stat-value" style={{ color: 'var(--color-accent)' }}>{promoRoiMedio.toFixed(2)}%</div>
                  <div className="stat-footer">Média simples por promoção</div>
                </div>
              </div>

              <div className="table-container" style={{ width: '100%' }}>
                {promoHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Nenhuma surebet de promoção registrada ainda. Preencha o formulário acima para registrar a primeira!
                  </div>
                ) : (
                  <table className="custom-table" style={{ fontSize: '12px' }}>
                    <thead>
                      <tr>
                        {/* hide-mobile: 10 colunas não cabem no celular. Sobram as de decisão
                            (promoção, evento, ROI, lucro); o detalhe da cobertura fica no desktop. */}
                        <th>Data</th>
                        <th>Casa Promoção</th>
                        <th>Valor Promoção</th>
                        <th>Evento</th>
                        <th className="hide-mobile">Mercado</th>
                        <th className="hide-mobile">Casa Cobertura</th>
                        <th className="hide-mobile">Valor Cobertura</th>
                        <th>ROI</th>
                        <th>Lucro</th>
                        <th style={{ textAlign: 'center' }}>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {promoHistory.map((p) => {
                        const lucroP = Number(p.lucro) || 0;
                        const roiP = Number(p.roi_pct);
                        return (
                          <tr key={p.id}>
                            <td style={{ color: 'var(--text-secondary)' }}>
                              {new Date(p.criado_em).toLocaleDateString()} {new Date(p.criado_em).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td style={{ fontWeight: 'bold' }}>
                              {p.casa_promocao}
                              {/* Badge do tipo: rótulo, cor e tooltip vêm do PROMO_META (os 6 tipos
                                  + o caso desconhecido). A escada com `else` que existia aqui
                                  chamava TODO tipo não previsto de "freebet" e ainda afirmava no
                                  tooltip que a ficha não retorna — mentira na SRR e na super odd,
                                  e mentira sobre o dinheiro investido na linha. */}
                              {(() => {
                                const meta = metaPromo(p.promo_type);
                                return (
                                  <span
                                    title={meta.dica}
                                    style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: meta.cor, border: `1px solid ${meta.cor}`, borderRadius: '999px', padding: '1px 6px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}
                                  >
                                    {meta.badge}
                                  </span>
                                );
                              })()}
                            </td>
                            <td>
                              R$ {(Number(p.valor_promocao) || 0).toFixed(2)}
                              {Number.isFinite(Number(p.odd_promocao)) && p.odd_promocao !== null && <span style={{ color: 'var(--text-muted)' }}> @ {Number(p.odd_promocao).toFixed(2)}</span>}
                              {/* Devolução/extra da linha: sem eles a linha não se explica (é de onde
                                  o lucro vem). Cada trecho só aparece se o valor VEIO do banco — o
                                  registro grava apenas as colunas que o tipo usa, e coluna ausente
                                  simplesmente não renderiza (nada é inferido do tipo). */}
                              {/* No tooltip do bônus: Number.isFinite e não `|| 70`, porque 0 é
                                  valorização VÁLIDA (bônus que não dá para converter) e o core
                                  calculou a linha com 0% — o texto afirmava 70% sobre um lucro
                                  que não usou 70%. */}
                              {Number(p.cashback) > 0 && (
                                <span
                                  style={{ color: '#3b82f6', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  title={p.cashback_eh_bonus ? `Devolução de R$ ${Number(p.cashback).toFixed(2)} em BÔNUS (valorizada a ${Number.isFinite(Number(p.valor_bonus_pct)) ? Number(p.valor_bonus_pct) : 70}% no cálculo)` : `Devolução de R$ ${Number(p.cashback).toFixed(2)} em dinheiro`}
                                >
                                  {' '}🛡️ +R$ {Number(p.cashback).toFixed(2)}{p.cashback_eh_bonus ? ' bônus' : ''}
                                </span>
                              )}
                              {Number(p.valor_ficha_pct) > 0 && Number(p.valor_ficha_pct) < 100 && (
                                <span
                                  style={{ color: '#a78bfa', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  title={`Freebet SRR: a ficha voltou como BÔNUS valendo ${Number(p.valor_ficha_pct).toFixed(0)}% — parte do lucro só virou dinheiro depois de convertida.`}
                                >
                                  {' '}🎟️ ficha volta {Number(p.valor_ficha_pct).toFixed(0)}%
                                </span>
                              )}
                              {Number(p.odd_padrao) > 1 && (
                                <span
                                  style={{ color: '#f59e0b', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  title={`Super odd: a odd padrão do mercado era ${Number(p.odd_padrao).toFixed(2)} — o excedente é o boost.`}
                                >
                                  {' '}🚀 padrão @ {Number(p.odd_padrao).toFixed(2)}
                                </span>
                              )}
                              {/* Extra do boost em REAIS vem gravado (extra_nominal/extra_efetivo,
                                  derivados do core no registro) — a UI não recalcula boost. Só se
                                  a linha não tiver esses valores é que sobra o percentual. */}
                              {Number(p.extra_nominal) > 0 ? (
                                <span
                                  style={{ color: '#ec4899', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  title={
                                    `Extra do boost: R$ ${Number(p.extra_nominal).toFixed(2)} de face` +
                                    (Number.isFinite(Number(p.extra_efetivo)) ? ` valendo R$ ${Number(p.extra_efetivo).toFixed(2)}` : '') +
                                    (p.extra_em_bonus ? ' (pago em BÔNUS — só virou dinheiro depois de convertido)' : ' (pago em dinheiro)') +
                                    (Number(p.boost_pct) > 0 ? `. Boost de ${Number(p.boost_pct).toFixed(0)}% sobre ${p.boost_sobre_stake ? 'o VALOR APOSTADO' : 'o lucro'}` : '') +
                                    (Number(p.teto_extra) > 0 ? `, teto de R$ ${Number(p.teto_extra).toFixed(2)}` : '') + '.'
                                  }
                                >
                                  {' '}📈 +R$ {Number(p.extra_nominal).toFixed(2)}{p.extra_em_bonus ? ' bônus' : ''}
                                </span>
                              ) : Number(p.boost_pct) > 0 ? (
                                <span
                                  style={{ color: '#ec4899', fontSize: '11px', whiteSpace: 'nowrap' }}
                                  title={`Lucro extra de ${Number(p.boost_pct).toFixed(0)}% sobre ${p.boost_sobre_stake ? 'o VALOR APOSTADO' : 'o lucro'}${Number(p.teto_extra) > 0 ? `, com teto de R$ ${Number(p.teto_extra).toFixed(2)}` : ''}.`}
                                >
                                  {' '}📈 +{Number(p.boost_pct).toFixed(0)}% extra
                                </span>
                              ) : null}
                            </td>
                            <td style={{ fontWeight: 'bold' }}>{p.evento}</td>
                            <td className="hide-mobile">{p.mercado || '—'}</td>
                            <td className="hide-mobile">{p.casa_cobertura}</td>
                            <td className="hide-mobile">
                              R$ {(Number(p.valor_cobertura) || 0).toFixed(2)}
                              {Number.isFinite(Number(p.odd_cobertura)) && p.odd_cobertura !== null && <span style={{ color: 'var(--text-muted)' }}> @ {Number(p.odd_cobertura).toFixed(2)}</span>}
                            </td>
                            <td style={{ color: 'var(--color-accent)', fontWeight: 'bold' }}>{Number.isFinite(roiP) ? `${roiP.toFixed(2)}%` : '—'}</td>
                            <td style={{ color: lucroP >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 'bold' }}>
                              {lucroP >= 0 ? '+' : '−'} R$ {Math.abs(lucroP).toFixed(2)}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                onClick={() => excluirPromocao(p)}
                                style={{
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  border: '1px solid rgba(239, 68, 68, 0.2)',
                                  borderRadius: '6px',
                                  width: '26px',
                                  height: '26px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  color: '#ef4444',
                                  transition: 'all 0.15s ease'
                                }}
                                title="Excluir promoção do histórico"
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

            {/* Live Terminal Logs */}
            <div className="glass-panel" style={{ marginTop: '32px', padding: '20px', display: 'flex', flexDirection: 'column', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                <h3 className="card-title" style={{ margin: 0, fontSize: '14px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Activity size={16} className={loadingScan ? 'spin-anim' : ''} style={{ color: '#10b981' }} />
                  Console de Auditoria e Logs do Scraper em Tempo Real
                </h3>
                <button 
                  className="btn" 
                  style={{ padding: '4px 10px', fontSize: '11px', border: 'none', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}
                  onClick={() => setLogsExpanded(!logsExpanded)}
                >
                  {logsExpanded ? 'Recolher Terminal' : 'Expandir Terminal'}
                </button>
              </div>

              {logsExpanded && (
                <div 
                  style={{ 
                    background: '#020617', 
                    borderRadius: '8px', 
                    padding: '12px 16px', 
                    fontFamily: 'Consolas, Monaco, monospace', 
                    fontSize: '11px', 
                    color: '#38bdf8', 
                    height: '180px', 
                    overflowY: 'auto', 
                    whiteSpace: 'pre-wrap', 
                    border: '1px solid #1e293b',
                    boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)',
                    lineHeight: '1.5'
                  }}
                  ref={(el) => {
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                >
                  {systemLogs}
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'radar-cashout' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Barra de status do worker */}
            <div className="glass-panel" style={{ padding: '14px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '18px', fontSize: '13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: 'var(--text-primary)' }}>
                <span className={`indicator ${cashoutStatus?.running ? 'indicator-active' : 'indicator-error'}`}></span>
                Captura {cashoutStatus?.running ? 'ativa' : (cashoutStatus?.enabled === false ? 'desligada' : 'iniciando…')}
              </div>
              {cashoutStatus && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>Bússola: <strong style={{ color: 'var(--text-secondary)' }}>{cashoutStatus.compass}</strong></span>
                  <span style={{ color: 'var(--text-muted)' }}>Alvos: <strong style={{ color: 'var(--text-secondary)' }}>{cashoutStatus.targets.join(', ')}</strong></span>
                  <span style={{ color: 'var(--text-muted)' }}>Ciclo: <strong style={{ color: 'var(--text-secondary)' }}>{cashoutStatus.intervalSeconds}s</strong></span>
                  <span style={{ color: 'var(--text-muted)' }}>Séries: <strong style={{ color: 'var(--text-secondary)' }}>{cashoutStatus.trackedSeries}</strong></span>
                  {cashoutStatus.lastCycle?.compassOdds === 0 && (
                    <span style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <AlertCircle size={13} /> bússola sem odds (túnel?)
                    </span>
                  )}
                </>
              )}
            </div>

            {/* ===================== MINHAS APOSTAS (cashout ao vivo) ===================== */}
            <div className="glass-panel" style={{ padding: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary)' }}>💰 Minhas Apostas</h3>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>rastreio AO VIVO — quanto vale e quando sacar</span>
              </div>

              <form onSubmit={criarBet} className="resp-grid-form">
                <div className="form-group">
                  <label>Casa</label>
                  <select className="form-control" value={betForm.casa} onChange={(e) => setBetForm((f) => ({ ...f, casa: e.target.value }))}>
                    {CASAS_PADRAO.map((c) => (
                      <option key={c} value={c}>{c}{casasLive.includes(c) ? ' • ao vivo' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Esporte</label>
                  <select className="form-control" value={betForm.sport} onChange={(e) => setBetForm((f) => ({ ...f, sport: e.target.value }))}>
                    {['Futebol', 'Basquete', 'Tenis', 'Esports'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn: 'span 2', minWidth: '220px' }}>
                  <label>Confronto (Time A vs Time B)</label>
                  <input className="form-control" placeholder="Ex.: Flamengo vs Palmeiras" value={betForm.event_label} onChange={(e) => setBetForm((f) => ({ ...f, event_label: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Mercado</label>
                  <select className="form-control" value={betForm.mercado} onChange={(e) => { const m = e.target.value; setBetForm((f) => ({ ...f, mercado: m, selection: m === 'Total' ? 'over' : 'home' })); }}>
                    <option value="Resultado Final">Resultado Final (2 vias)</option>
                    <option value="Total">Total (Over/Under)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Seleção</label>
                  <select className="form-control" value={betForm.selection} onChange={(e) => setBetForm((f) => ({ ...f, selection: e.target.value }))}>
                    {betForm.mercado === 'Total' ? (
                      <>
                        <option value="over">Mais (Over)</option>
                        <option value="under">Menos (Under)</option>
                      </>
                    ) : (
                      <>
                        <option value="home">Time A (mandante)</option>
                        <option value="away">Time B (visitante)</option>
                      </>
                    )}
                  </select>
                </div>
                {betForm.mercado === 'Total' && (
                  <div className="form-group">
                    <label>Linha</label>
                    <input className="form-control" type="number" step="0.5" placeholder="2.5" value={betForm.line} onChange={(e) => setBetForm((f) => ({ ...f, line: e.target.value }))} />
                  </div>
                )}
                <div className="form-group">
                  <label>Odd de entrada</label>
                  <input className="form-control" type="number" step="0.01" placeholder="2.75" value={betForm.odd_entrada} onChange={(e) => setBetForm((f) => ({ ...f, odd_entrada: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Stake R$ (opcional)</label>
                  <input className="form-control" type="number" step="0.01" placeholder="100" value={betForm.stake} onChange={(e) => setBetForm((f) => ({ ...f, stake: e.target.value }))} />
                </div>
                <button type="submit" className="btn btn-primary" disabled={betSubmitting} style={{ justifyContent: 'center' }}>
                  {betSubmitting ? <><RefreshCw size={14} className="spin-anim" /> Salvando…</> : '+ Adicionar aposta'}
                </button>
              </form>

              {betError && <p style={{ color: '#ef4444', fontSize: '13px', margin: '10px 0 0' }}>{betError}</p>}
              <p style={{ color: 'var(--text-muted)', fontSize: '11px', margin: '10px 0 0' }}>
                O <strong>Valor (justo)</strong> é calculado pela linha AFIADA (Pinnacle), não pela odd da casa — é o valor real da sua posição. A odd/oferta da casa aparece como referência (e avisa quando a casa paga <em>abaixo do justo</em>).
                Odd ao vivo da casa integrada: <strong>{casasLive.length ? casasLive.join(', ') : '—'}</strong> (nas demais só o valor justo).
                Futebol 1X2 (3 vias) não tem cálculo — use 2 vias (tênis/basquete/e-sports) ou Total.
              </p>

              {/* Cards das apostas. min(300px,100%) no minmax: sem o min() a trilha fica maior
                  que a viewport em telas estreitas e a página ganha scroll horizontal. */}
              {cashoutBets.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: '14px', marginTop: '16px' }}>
                  {cashoutBets.map((bet) => {
                    const oddEnt = num(bet.odd_entrada);
                    const stake = num(bet.stake);
                    const fairOdd = num(bet.last_fair_odd);
                    const drop = num(bet.last_drop_pct);
                    const saque = num(bet.last_cashout_value);   // valor JUSTO (Pinnacle)
                    const profit = num(bet.last_profit);
                    const houseOdd = num(bet.last_house_odd);
                    // Oferta estimada da própria casa (referência): stake × odd_entrada / odd_casa × (1 - margem 6%).
                    const houseCash = houseOdd != null && oddEnt != null && stake != null ? (stake * oddEnt / houseOdd) * 0.94 : null;
                    const sinal = bet.last_signal === true;
                    const idade = bet.last_eval_at ? `${Math.max(0, Math.round((Date.now() - Date.parse(bet.last_eval_at)) / 1000))}s` : null;
                    const loadingMon = betMonitorLoading[bet.id];
                    return (
                      <div key={bet.id} className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', border: sinal ? '1px solid var(--color-success)' : undefined }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '14px' }}>{bet.event_label}</p>
                              {ehAoVivo(bet.starts_at) && <AoVivoBadge />}
                            </div>
                            <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                              {bet.sport} · {bet.market_label} · <strong style={{ color: 'var(--text-secondary)' }}>{bet.selection_label || bet.selection}</strong> · {bet.casa}
                            </p>
                          </div>
                          <button onClick={() => excluirBet(bet.id)} title="Excluir aposta" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px', display: 'flex' }}>
                            <Trash2 size={16} />
                          </button>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                          <div style={{ background: 'rgba(148,163,184,0.08)', borderRadius: '8px', padding: '8px' }}>
                            <p style={{ margin: 0, fontSize: '9px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Entrada</p>
                            <p style={{ margin: '2px 0 0', fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>{oddEnt?.toFixed(2) ?? '—'}</p>
                            {stake != null && <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-muted)' }}>R$ {stake.toFixed(2)}</p>}
                          </div>
                          <div style={{ background: 'rgba(52,211,153,0.10)', borderRadius: '8px', padding: '8px' }}>
                            <p style={{ margin: 0, fontSize: '9px', textTransform: 'uppercase', color: 'var(--color-primary)' }}>Justa agora</p>
                            <p style={{ margin: '2px 0 0', fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>{fairOdd?.toFixed(2) ?? '—'}</p>
                            {drop != null && <p style={{ margin: 0, fontSize: '10px', color: drop > 0 ? 'var(--color-success)' : '#ef4444' }}>{drop > 0 ? '↓' : '↑'} {(Math.abs(drop) * 100).toFixed(1)}%</p>}
                          </div>
                          <div style={{ background: 'rgba(245,158,11,0.10)', borderRadius: '8px', padding: '8px' }}>
                            <p style={{ margin: 0, fontSize: '9px', textTransform: 'uppercase', color: '#f59e0b' }} title="Valor da posição pela linha JUSTA (Pinnacle)">Valor (justo)</p>
                            <p style={{ margin: '2px 0 0', fontSize: '17px', fontWeight: 700, color: '#fbbf24' }}>{saque != null ? `R$ ${saque.toFixed(2)}` : '—'}</p>
                            {profit != null && <p style={{ margin: 0, fontSize: '10px', color: profit >= 0 ? 'var(--color-success)' : '#ef4444' }}>{profit >= 0 ? '+' : ''}R$ {profit.toFixed(2)}</p>}
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 700, color: sinal ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {sinal ? '🟢 SACAR AGORA' : '⚪ segurar'}
                          </span>
                          {houseOdd != null && (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                              casa @ {houseOdd.toFixed(2)}{houseCash != null ? ` · saque ~R$ ${houseCash.toFixed(2)}` : ''}
                              {houseCash != null && saque != null && houseCash < saque - 0.01 && (
                                <span style={{ color: '#f59e0b' }}> ⚠️ abaixo do justo</span>
                              )}
                            </span>
                          )}
                          {idade && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>há {idade}</span>}
                        </div>

                        {bet.last_note && <p style={{ margin: 0, fontSize: '11px', color: '#f59e0b' }}>{bet.last_note}</p>}

                        <button className="btn btn-secondary" onClick={() => monitorarBet(bet.id)} disabled={loadingMon} style={{ width: '100%', justifyContent: 'center', fontSize: '12px' }}>
                          {loadingMon ? <><RefreshCw size={13} className="spin-anim" /> Consultando ao vivo…</> : <><RefreshCw size={13} /> Monitorar agora</>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Grade de oportunidades / estados vazios */}
            {cashoutLoading ? (
              <div className="glass-panel" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
                <RefreshCw size={20} className="spin-anim" /> Carregando oportunidades…
              </div>
            ) : cashoutOpps.length === 0 ? (
              <div className="glass-panel" style={{ padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', textAlign: 'center', minHeight: '260px', justifyContent: 'center' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(52, 211, 153, 0.12)', color: 'var(--color-primary)' }}>
                  <Radar size={32} />
                </div>
                <h2 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>Nenhuma oportunidade ativa</h2>
                <p style={{ margin: 0, maxWidth: '440px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                  O radar segue monitorando a linha das bússolas. Oportunidades aparecem quando uma casa alvo demora a ajustar uma odd que já caiu na linha afiada.
                </p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: '16px' }}>
                {[...cashoutOpps]
                  .sort((a, b) => b.gap_pct - a.gap_pct)
                  .map((opp) => {
                  const v = cashoutVerif[opp.id];
                  return (
                  <div key={opp.id} className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '15px' }}>{opp.event_label}</p>
                          {ehAoVivo(opp.starts_at) && <AoVivoBadge />}
                        </div>
                        <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                          {opp.sport} · {opp.market_label} · <strong style={{ color: 'var(--text-secondary)' }}>{opp.selection_label}</strong>
                        </p>
                        <p style={{ margin: '3px 0 0', color: 'var(--text-muted)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          🕒 {fmtDataHora(opp.starts_at) ?? 'horário não informado'}
                          {ehAoVivo(opp.starts_at) && <span style={{ color: '#ef4444', fontWeight: 700 }}>· em andamento</span>}
                        </p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <CashoutGapBadge gapPct={opp.gap_pct} />
                        <button
                          onClick={() => excluirCashout(opp.id)}
                          title="Excluir oportunidade"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px', display: 'flex' }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div style={{ background: 'rgba(148,163,184,0.08)', borderRadius: '10px', padding: '10px 12px' }}>
                        <p style={{ margin: 0, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>Odd Bússola (justa)</p>
                        <p style={{ margin: '2px 0 0', fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{opp.compass_fair_odd?.toFixed(2)}</p>
                      </div>
                      <div style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '10px', padding: '10px 12px' }}>
                        <p style={{ margin: 0, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#f59e0b' }}>Odd Desregulada</p>
                        <p style={{ margin: '2px 0 0', fontSize: '20px', fontWeight: 700, color: '#fbbf24' }}>{opp.target_odd_value?.toFixed(2)}</p>
                        <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'rgba(245,158,11,0.9)' }}>{opp.target_name}</p>
                      </div>
                    </div>

                    {opp.drop_pct != null && (
                      <div style={{ fontSize: '12px', color: 'var(--color-primary)' }}>
                        📉 Odd afiada caiu <strong>{(opp.drop_pct * 100).toFixed(1)}%</strong> na janela
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <TrendingUp size={14} style={{ color: 'var(--color-primary)' }} />
                        {opp.confirming_sources?.join(', ')}
                      </span>
                    </div>

                    {/* Ações: monitorar ao vivo (promove p/ Minhas Apostas) + validar odd */}
                    <div style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {cashoutPromo[opp.id] === 'form' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: '10px', padding: '10px' }}>
                          <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-muted)' }}>Confirme a odd que <strong>você pegou</strong> e o valor apostado:</p>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <div className="form-group" style={{ flex: 1, margin: 0 }}>
                              <label style={{ fontSize: '10px' }}>Odd de entrada</label>
                              <input className="form-control" type="number" step="0.01" value={promoInputs[opp.id]?.odd ?? ''}
                                onChange={(e) => setPromoInputs((p) => ({ ...p, [opp.id]: { odd: e.target.value, stake: p[opp.id]?.stake ?? '' } }))} />
                            </div>
                            <div className="form-group" style={{ flex: 1, margin: 0 }}>
                              <label style={{ fontSize: '10px' }}>Stake R$</label>
                              <input className="form-control" type="number" step="0.01" placeholder="opcional" value={promoInputs[opp.id]?.stake ?? ''}
                                onChange={(e) => setPromoInputs((p) => ({ ...p, [opp.id]: { odd: p[opp.id]?.odd ?? '', stake: e.target.value } }))} />
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button className="btn btn-primary" onClick={() => confirmarPromo(opp.id)} style={{ flex: 1, justifyContent: 'center', fontSize: '12px' }}>Confirmar</button>
                            <button className="btn btn-secondary" onClick={() => setCashoutPromo((p) => ({ ...p, [opp.id]: 'idle' }))} style={{ flex: 1, justifyContent: 'center', fontSize: '12px' }}>Cancelar</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={() => abrirPromo(opp)}
                          disabled={cashoutPromo[opp.id] === 'loading' || cashoutPromo[opp.id] === 'done'}
                          style={{ width: '100%', justifyContent: 'center', fontSize: '13px' }}
                        >
                          {cashoutPromo[opp.id] === 'loading'
                            ? <><RefreshCw size={14} className="spin-anim" /> Adicionando…</>
                            : cashoutPromo[opp.id] === 'done'
                              ? <>✓ Monitorando em Minhas Apostas</>
                              : <><Radar size={14} /> Monitorar ao vivo</>}
                        </button>
                      )}
                      {cashoutPromo[opp.id] === 'error' && (
                        <span style={{ fontSize: '11px', color: '#ef4444', textAlign: 'center' }}>Falha ao adicionar — tente de novo.</span>
                      )}
                      <button
                        className="btn btn-secondary"
                        onClick={() => validarCashout(opp.id)}
                        disabled={v?.loading}
                        style={{ width: '100%', justifyContent: 'center', fontSize: '13px' }}
                      >
                        {v?.loading ? <><RefreshCw size={14} className="spin-anim" /> Consultando a casa ao vivo…</> : <><RefreshCw size={14} /> Validar odd na casa</>}
                      </button>
                      {v && !v.loading && (
                        <div style={{ marginTop: '8px', fontSize: '12px', textAlign: 'center' }}>
                          {v.disponivel === false ? (
                            <span style={{ color: 'var(--text-muted)' }}>{v.mensagem}</span>
                          ) : (
                            <div style={{ color: 'var(--text-secondary)' }}>
                              <div>
                                Casa agora: <strong style={{ color: '#fbbf24' }}>{v.oddAtual?.toFixed(2)}</strong>
                                {' '}(era {v.oddOriginal?.toFixed(2)}{v.direcao === 'subiu' ? ' ↑' : v.direcao === 'caiu' ? ' ↓' : ' =' })
                                {' · '}{v.ageSeconds != null ? `há ${v.ageSeconds}s` : 'ao vivo'}
                              </div>
                              {v.fairOddAtual != null && (
                                <div>Justa bússola agora: <strong>{v.fairOddAtual.toFixed(2)}</strong>{v.fairOddOriginal != null ? ` (era ${v.fairOddOriginal.toFixed(2)})` : ''}</div>
                              )}
                              {v.fairDefasada && <div style={{ color: '#f59e0b', fontSize: '11px' }}>⚠️ bússola indisponível — comparado com a justa da detecção</div>}
                              <div style={{ marginTop: '3px', fontWeight: 700, color: v.aindaVale ? 'var(--color-success)' : '#ef4444' }}>
                                {v.aindaVale ? `✅ ainda vale (gap ${v.gapAtualPct}%)` : `❌ fechou (gap ${v.gapAtualPct}%)`}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'valor' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="glass-panel" style={{ padding: '14px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
              <TrendingUp size={16} style={{ color: '#34d399' }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                Odd da casa <strong>acima da justa sem-margem da Pinnacle</strong>. É estimativa de <strong>valor esperado (EV)</strong> — não é lucro garantido como a surebet. Radar-only: nada aqui dispara alerta.
              </span>
            </div>

            {valorLoading && valorOpps.length === 0 ? (
              <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Carregando…</div>
            ) : valorOpps.length === 0 ? (
              <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                Nenhuma aposta de valor no momento. O radar atualiza a cada varredura.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: '16px' }}>
                {valorOpps.map((o) => (
                  <div key={o.id} className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}>
                    <button onClick={() => excluirValor(o.id)} title="Excluir do radar"
                      style={{ position: 'absolute', top: '12px', right: '12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                      <Trash2 size={15} />
                    </button>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                      <span style={{ fontSize: '22px', fontWeight: 700, color: '#34d399' }}>+{o.edge_pct.toFixed(2)}%</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>EV</span>
                    </div>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', paddingRight: '20px' }}>{o.evento}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {[o.esporte, o.mercado, o.linha != null ? `linha ${o.linha}` : null].filter(Boolean).join(' • ')}
                    </div>
                    <div style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{o.casa} — {o.opcao}</span>
                        <strong style={{ color: '#34d399' }}>{o.odd_casa.toFixed(2)}</strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                        <span>Justa ({o.referencia})</span>
                        <span>{o.fair_odd.toFixed(2)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                      <span>{o.starts_at ? new Date(o.starts_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                      {o.confianca != null && <span>conf. {Math.round(o.confianca * 100)}%</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Seção Middles: totais com linhas diferentes (ex.: Over 2.5 × Under 3.5). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                🎯 Middles
                <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)' }}>
                  linhas diferentes entre casas — o total no meio ganha as duas pernas
                </span>
              </h3>
              {middlesOpps.length === 0 ? (
                <div className="glass-panel" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                  Nenhum middle no momento.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: '16px' }}>
                  {middlesOpps.map((m) => {
                    const garantido = m.pior_caso_roi_pct >= 0;
                    return (
                      <div key={m.id} className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}>
                        <button onClick={() => excluirMiddle(m.id)} title="Excluir do radar"
                          style={{ position: 'absolute', top: '12px', right: '12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                          <Trash2 size={15} />
                        </button>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                          <span style={{ fontSize: '15px', fontWeight: 700, color: garantido ? '#34d399' : '#f59e0b' }}>
                            {garantido ? `+${m.pior_caso_roi_pct.toFixed(2)}% garantido` : `${m.pior_caso_roi_pct.toFixed(2)}% (pior caso)`}
                          </span>
                        </div>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', paddingRight: '20px' }}>{m.evento}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {[m.esporte, m.mercado].filter(Boolean).join(' • ')} · janela {m.over_linha}–{m.under_linha} (largura {m.largura})
                        </div>
                        <div style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{m.over_casa} — Mais de {m.over_linha}</span>
                            <strong style={{ color: 'var(--text-primary)' }}>{m.over_odd.toFixed(2)}</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{m.under_casa} — Menos de {m.under_linha}</span>
                            <strong style={{ color: 'var(--text-primary)' }}>{m.under_odd.toFixed(2)}</strong>
                          </div>
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {m.starts_at ? new Date(m.starts_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'calibracao' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="glass-panel" style={{ padding: '14px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
              <Activity size={16} style={{ color: '#34d399' }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                <strong>Taxa de sobrevivência</strong> = dos alertas que o scan flagrou, quantos % a revalidação AO VIVO confirmou (o resto foi suprimido = falso positivo do scan). Falhas de infra ficam de fora.
              </span>
            </div>

            {calibLoading && !calibResumo ? (
              <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Carregando…</div>
            ) : !calibResumo || calibResumo.total === 0 ? (
              <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                Sem dados ainda. A calibração começa a preencher quando o scan tomar decisões de alerta.
              </div>
            ) : (
              <>
                {/* Stat tiles */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: '16px' }}>
                  <div className="glass-panel" style={{ padding: '18px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sobrevivência (geral)</div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: '#34d399' }}>
                      {calibResumo.geral.taxaSobrevivencia != null ? `${calibResumo.geral.taxaSobrevivencia}%` : '—'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>últimos {calibResumo.dias} dias</div>
                  </div>
                  <div className="glass-panel" style={{ padding: '18px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Drift médio de ROI</div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: (calibResumo.driftMedioPp ?? 0) >= 0 ? '#34d399' : '#f59e0b' }}>
                      {calibResumo.driftMedioPp != null ? `${calibResumo.driftMedioPp > 0 ? '+' : ''}${calibResumo.driftMedioPp} pp` : '—'}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>scan → revalidado</div>
                  </div>
                  <div className="glass-panel" style={{ padding: '18px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Decisões</div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>{calibResumo.total}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {calibResumo.geral.enviados} enviados · {calibResumo.geral.suprimidos} suprimidos · {calibResumo.geral.naoVerificados} infra
                    </div>
                  </div>
                </div>

                {/* Quebra por Pinnacle e por fonte */}
                <div className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Sobrevivência por segmento</h3>
                  {([
                    ['Com Pinnacle', calibResumo.comPinnacle],
                    ['Sem Pinnacle (2 softs)', calibResumo.semPinnacle],
                    ...Object.entries(calibResumo.porFonte).map(([f, v]) => [`Fonte: ${f}`, v] as [string, CalibFaixa]),
                  ] as [string, CalibFaixa][]).map(([rotulo, fx]) => (
                    <div key={rotulo} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderTop: '1px solid var(--panel-border)', paddingTop: '8px' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{rotulo}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{fx.taxaSobrevivencia != null ? `${fx.taxaSobrevivencia}%` : '—'}</strong>
                        {' '}({fx.enviados}✓ / {fx.suprimidos}✕)
                      </span>
                    </div>
                  ))}
                </div>

                {/* Alertas recentes */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Alertas recentes</h3>
                  {calibAlertas.length === 0 ? (
                    <div className="glass-panel" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Nenhum registro ainda.</div>
                  ) : (
                    calibAlertas.map((a) => {
                      const cor = a.resultado === 'enviado' ? '#34d399' : a.resultado === 'suprimido' ? '#f59e0b' : 'var(--text-muted)';
                      const rot = a.resultado === 'enviado' ? 'ENVIADO' : a.resultado === 'suprimido' ? 'SUPRIMIDO' : 'INFRA';
                      return (
                        <div key={a.id} className="glass-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '13px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: cor, minWidth: '78px' }}>{rot}</span>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 600, flex: 1, minWidth: '160px' }}>{a.evento}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{[a.casa_a, a.casa_b].filter(Boolean).join(' × ')}</span>
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {a.roi_scan != null ? `${a.roi_scan.toFixed(1)}%` : '—'} → {a.roi_revalidado != null ? `${a.roi_revalidado.toFixed(1)}%` : '—'}
                          </span>
                          {a.envolve_pinnacle && <span style={{ fontSize: '11px', color: '#60a5fa' }}>Pinnacle</span>}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'calculadora' && (
          <div style={{ maxWidth: '700px', margin: '0 auto', width: '100%' }}>
            <div className="glass-panel" style={{ padding: '32px' }}>
              <h3 className="card-title" style={{ fontSize: '20px', marginBottom: '24px' }}>
                <Calculator size={22} style={{ color: 'var(--color-primary)' }} />
                Calculadora de Arbitragem (Surebet)
              </h3>
              
              <div className="resp-grid-2" style={{ gap: '16px', marginBottom: '20px' }}>
                <div className="form-group">
                  <label>Odd Casa 1 (O1)</label>
                  <input className="form-control" type="number" step="0.01" value={calcOdd1} onChange={(e) => setCalcOdd1(e.target.value)} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={calcExchange1} onChange={(e) => setCalcExchange1(e.target.checked)} />
                    Exchange (Bolsa de Aposta) · comissão 1,5%
                  </label>
                </div>
                <div className="form-group">
                  <label>Odd Casa 2 (O2)</label>
                  <input className="form-control" type="number" step="0.01" value={calcOdd2} onChange={(e) => setCalcOdd2(e.target.value)} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', fontSize: '12px', fontWeight: 400, color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={calcExchange2} onChange={(e) => setCalcExchange2(e.target.checked)} />
                    Exchange (Bolsa de Aposta) · comissão 1,5%
                  </label>
                </div>
                <div className="form-group">
                  <label>Banca Casa 1 (R$)</label>
                  <input className="form-control" type="number" value={calcBanca1} onChange={(e) => setCalcBanca1(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Banca Casa 2 (R$)</label>
                  <input className="form-control" type="number" value={calcBanca2} onChange={(e) => setCalcBanca2(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Arredondamento Casa 1</label>
                  <select className="form-control" value={calcRoundStep1} onChange={(e) => setCalcRoundStep1(e.target.value)}>
                    <option value="0.01">Centavos (0.01)</option>
                    <option value="0.5">Meio Real (0.50)</option>
                    <option value="1">Inteiro (1.00)</option>
                    <option value="5">Múltiplo de 5.00</option>
                    <option value="10">Múltiplo de 10.00</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Arredondamento Casa 2</label>
                  <select className="form-control" value={calcRoundStep2} onChange={(e) => setCalcRoundStep2(e.target.value)}>
                    <option value="0.01">Centavos (0.01)</option>
                    <option value="0.5">Meio Real (0.50)</option>
                    <option value="1">Inteiro (1.00)</option>
                    <option value="5">Múltiplo de 5.00</option>
                    <option value="10">Múltiplo de 10.00</option>
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label>Porcentagem Máxima da Banca a Arriscar (%): {calcMaxStakePct}%</label>
                  <input type="range" min="5" max="100" step="5" value={calcMaxStakePct} onChange={(e) => setCalcMaxStakePct(e.target.value)} style={{ width: '100%', accentColor: 'var(--color-primary)' }} />
                </div>
              </div>

              {calcError && <div style={{ color: 'var(--color-danger)', fontSize: '13px', marginBottom: '12px' }}>{calcError}</div>}

              {calcResult && (
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid var(--panel-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '14px', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>Corte Mínimo: {calcResult.oddMinimaExigida}</span>
                    <span className={`badge ${calcResult.isArbitrage ? 'badge-success' : 'badge-danger'}`}>
                      {calcResult.isArbitrage ? `SUREBET (${calcResult.margemTeoricaPct}%)` : 'SEM ARBITRAGEM'}
                    </span>
                  </div>

                  <div className="resp-grid-2" style={{ gap: '14px', fontSize: '14px' }}>
                    <div>
                      <div style={{ color: 'var(--text-secondary)' }}>Aposta Casa 1:</div>
                      <div style={{ fontSize: '18px', fontWeight: 'bold' }}>R$ {calcResult.stake1.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)' }}>Aposta Casa 2:</div>
                      <div style={{ fontSize: '18px', fontWeight: 'bold' }}>R$ {calcResult.stake2.toFixed(2)}</div>
                    </div>
                    <div style={{ gridColumn: 'span 2', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px' }}></div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)' }}>Investimento do Turno:</div>
                      <div style={{ fontWeight: 600 }}>R$ {calcResult.investimentoTotal.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)' }}>ROI do Turno (Pior Caso):</div>
                      <div style={{ fontWeight: 700, color: calcResult.piorLucro > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                        {calcResult.piorRoiPct}% ({calcResult.piorLucro > 0 ? '+' : ''}R$ {calcResult.piorLucro.toFixed(2)})
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'juros-compostos' && (
          <div className="resp-grid-08">
            {/* Control Form */}
            <div className="glass-panel" style={{ padding: '24px', height: 'fit-content' }}>
              <h3 className="card-title">
                <Percent size={18} style={{ color: 'var(--color-primary)' }} />
                Parâmetros de Projeção
              </h3>
              
              <div className="test-panel">
                <div className="form-group">
                  <label>Banca Inicial da Série (R$)</label>
                  <input className="form-control" type="number" value={projBancaInicial} onChange={(e) => setProjBancaInicial(e.target.value)} />
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                    Preenchida automaticamente com a banca ANTES das entradas lançadas (banca atual − lucro acumulado) — assim o último dia real fecha na sua banca atual.
                  </div>
                </div>
                <div className="form-group">
                  <label>Dias a Projetar</label>
                  <input className="form-control" type="number" value={projDias} onChange={(e) => setProjDias(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Mão / Aposta por Turno (%)</label>
                  <input className="form-control" type="number" value={projMaxStakePct} onChange={(e) => setProjMaxStakePct(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>ROI Médio do Turno (%)</label>
                  <input className="form-control" type="number" step="0.1" value={projRoiMedioPct} onChange={(e) => setProjRoiMedioPct(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Turnos Operados / Dia</label>
                  <input className="form-control" type="number" value={projTurnosPorDia} onChange={(e) => setProjTurnosPorDia(e.target.value)} />
                </div>

                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '12px', padding: '6px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px dashed var(--panel-border)' }}>
                  ⚡ Planilha atualizada automaticamente em tempo real
                </div>
              </div>
            </div>

            {/* Projection Grid & Table */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* Projection Highlights */}
              <div className="stats-grid" style={{ marginBottom: 0 }}>
                <div className="glass-panel stat-card">
                  <div className="stat-header"><span>Banca Final Projetada</span></div>
                  <div className="stat-value">R$ {finalProjDay ? finalProjDay.bancaFinal.toFixed(2) : projBancaInicial}</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header"><span>Lucro Líquido Acumulado</span></div>
                  <div className="stat-value" style={{ color: 'var(--color-success)' }}>R$ {projProfitTotal.toFixed(2)}</div>
                </div>
                <div className="glass-panel stat-card">
                  <div className="stat-header"><span>Rentabilidade Total</span></div>
                  <div className="stat-value" style={{ color: 'var(--color-accent)' }}>{projRoiTotalPct}%</div>
                </div>
              </div>

              {/* Data Table */}
              <div className="glass-panel" style={{ padding: '24px' }}>
                <h3 className="card-title">
                  <Layers size={18} style={{ color: 'var(--color-accent)' }} />
                  Tabela de Acompanhamento Diário (Juros Compostos)
                </h3>
                
                <div className="table-container" style={{ maxHeight: '500px', overflowY: 'auto' }}>
                  <table className="custom-table">
                    <thead>
                      <tr>
                        <th>Dia</th>
                        {/* hide-xs: em tela <=430px a tabela ainda pedia arrasto lateral;
                            a banca inicial do dia sai (dá pra inferir da banca final do dia anterior). */}
                        <th className="hide-xs">Banca Inicial</th>
                        <th>Mão / Turno ({parseFloat(projMaxStakePct) || 50}%)</th>
                        {/* hide-mobile: o detalhe por turno some no celular; fica o lucro do dia. */}
                        <th className="hide-mobile">Lucro T1</th>
                        <th className="hide-mobile">Lucro T2</th>
                        <th className="hide-mobile">Lucro T3+</th>
                        <th>Lucro Diário</th>
                        <th>Banca Final</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mergedProjection.map(day => (
                        <tr key={day.key} style={day.isToday ? { background: 'rgba(16, 185, 129, 0.08)' } : undefined}>
                          <td style={{ fontWeight: 'bold', color: day.isReal ? 'var(--color-success)' : 'var(--color-primary)', whiteSpace: 'nowrap' }}>
                            Dia {day.diaNum} <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>• {day.data}</span>
                            <span style={{
                              marginLeft: '6px', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                              padding: '1px 6px', borderRadius: '999px', verticalAlign: 'middle',
                              color: day.isReal ? 'var(--color-success)' : 'var(--color-primary)',
                              border: `1px solid ${day.isReal ? 'var(--color-success)' : 'var(--color-primary)'}`,
                              opacity: 0.85
                            }}>
                              {day.isToday ? 'hoje' : day.isReal ? 'real' : 'proj'}
                            </span>
                          </td>
                          <td className="hide-xs">R$ {day.bancaInicial.toFixed(2)}</td>
                          <td>R$ {day.maoPorTurno.toFixed(2)}</td>
                          <td className="hide-mobile" style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno1.toFixed(2)}</td>
                          <td className="hide-mobile" style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno2.toFixed(2)}</td>
                          <td className="hide-mobile" style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno3.toFixed(2)}</td>
                          <td style={{ color: 'var(--color-success)', fontWeight: 600 }}>R$ {day.lucroTotalDia.toFixed(2)}</td>
                          <td style={{ fontWeight: 'bold' }}>R$ {day.bancaFinal.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'saldos' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Cards de resumo */}
            <div className="stats-grid" style={{ marginBottom: 0 }}>
              <div className="glass-panel stat-card">
                <div className="stat-header">
                  <span>Total Disponível</span>
                  <Wallet size={16} className="stat-icon" style={{ color: 'var(--color-primary)' }} />
                </div>
                <div className="stat-value" style={{ color: 'var(--color-success)' }}>
                  R$ {totalSaldos.toFixed(2)}
                </div>
              </div>
              <div className="glass-panel stat-card">
                <div className="stat-header"><span>Casas com Saldo</span></div>
                <div className="stat-value">{casasComSaldo}<span style={{ fontSize: '14px', color: 'var(--text-muted)' }}> / {saldosCasas.length}</span></div>
              </div>
            </div>

            {/* Lista de casas + valores */}
            <div className="glass-panel" style={{ padding: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
                <h3 className="card-title" style={{ margin: 0 }}>
                  <Wallet size={18} style={{ color: 'var(--color-primary)' }} />
                  Valor Disponível por Casa
                </h3>
                <button
                  className="btn btn-primary"
                  onClick={salvarSaldosNoBanco}
                  disabled={saldosSaveState === 'saving'}
                  style={{ minWidth: '150px', justifyContent: 'center' }}
                >
                  {saldosSaveState === 'saving' && <><RefreshCw size={16} className="spin-anim" /> Salvando…</>}
                  {saldosSaveState === 'saved' && <><CheckCircle size={16} /> Salvo!</>}
                  {saldosSaveState === 'error' && <><AlertCircle size={16} /> Erro — repetir</>}
                  {saldosSaveState === 'idle' && <><Save size={16} /> Salvar</>}
                </button>
              </div>

              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: 0, marginBottom: '20px' }}>
                Informe quanto você tem de saldo em cada casa. O valor fica salvo e serve de referência para dividir as stakes das surebets.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {saldosCasas.map((s, i) => (
                  <div key={`${s.casa}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 140px', minWidth: '120px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {s.casa}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 180px' }}>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>R$</span>
                      <input
                        className="form-control"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0,00"
                        value={s.valor}
                        onChange={(e) => atualizarSaldoCasa(i, e.target.value)}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <button
                      className="btn btn-secondary"
                      onClick={() => removerCasa(i)}
                      title={`Remover ${s.casa}`}
                      style={{ padding: '8px' }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                {saldosCasas.length === 0 && (
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center', padding: '12px' }}>
                    Nenhuma casa na lista. Adicione uma abaixo.
                  </div>
                )}
              </div>

              {/* Adicionar casa */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--panel-border)', flexWrap: 'wrap' }}>
                <input
                  className="form-control"
                  type="text"
                  placeholder="Adicionar outra casa (ex.: EstrelaBet)"
                  value={novaCasa}
                  onChange={(e) => setNovaCasa(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') adicionarCasa(); }}
                  style={{ flex: '1 1 220px' }}
                />
                <button className="btn btn-secondary" onClick={adicionarCasa} style={{ justifyContent: 'center' }}>
                  <Plus size={16} /> Adicionar
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ai-test' && (
          <div className="glass-panel chat-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column' }}>
            <h3 className="card-title" style={{ marginBottom: '4px' }}>
              <Cpu size={18} style={{ color: 'var(--color-primary)' }} />
              Agente de Arbitragem (IA)
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              O agente consulta odds ao vivo nas casas, o radar, sua banca, as regras e as calculadoras antes de responder.
              A decisão e a aposta continuam sendo suas.
            </p>

            {/* Skills do agente + motor ativo */}
            {chatSkills && (
              <div style={{ marginBottom: '14px', border: '1px solid var(--panel-border)', borderRadius: '10px', background: 'rgba(255,255,255,0.03)' }}>
                <button
                  onClick={() => setChatSkillsAbertas(v => !v)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                    background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer',
                    fontSize: '12px', textAlign: 'left'
                  }}
                >
                  <Wrench size={14} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700 }}>{chatSkills.total} skills</span>
                  <span style={{ color: 'var(--text-muted)' }}>· {chatSkills.casas_integradas} casas integradas</span>
                  {(() => {
                    const ativo = (chatSkills.provedores || []).find(p => p.provider === (chatSkills.cadeia_agente || [])[0]);
                    return ativo ? (
                      <span style={{ color: ativo.configurado && !ativo.em_cooldown ? 'var(--color-success)' : 'var(--color-warning)', marginLeft: 'auto', marginRight: '4px' }}>
                        {ativo.provider}{chatSkills.modelo_agente || ativo.modelo ? ` · ${chatSkills.modelo_agente || ativo.modelo}` : ''}{ativo.em_cooldown ? ' (cota)' : ''}
                      </span>
                    ) : null;
                  })()}
                  <ChevronDown size={14} style={{ transform: chatSkillsAbertas ? 'rotate(180deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }} />
                </button>
                {chatSkillsAbertas && (
                  // maxHeight + scroll próprio: sem isso o accordion aberto roubava toda a
                  // altura do .chat-panel (que é fixa) e a lista de mensagens colapsava no mobile.
                  <div style={{ padding: '0 12px 12px 12px', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '38vh', overflowY: 'auto' }}>
                    {(chatSkills.provedores || []).some(p => !p.configurado || p.em_cooldown) && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Provedores: {(chatSkills.provedores || []).map(p =>
                          `${p.provider}${p.configurado ? '' : ' (sem chave)'}${p.em_cooldown ? ' (cota esgotada)' : ''}`
                        ).join(' · ')}
                      </div>
                    )}
                    {Array.from(new Set(chatSkills.skills.map(s => s.grupo))).map(grupo => (
                      <div key={grupo}>
                        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '5px' }}>{grupo}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {chatSkills.skills.filter(s => s.grupo === grupo).map(s => (
                            <span
                              key={s.nome}
                              title={s.descricao}
                              style={{
                                fontSize: '11px', padding: '3px 8px', borderRadius: '999px',
                                border: '1px solid var(--panel-border)',
                                background: s.escrita ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)',
                                color: 'var(--text-secondary)', cursor: 'help'
                              }}
                            >
                              {s.nome}{s.custosa ? ' ⏳' : ''}{s.escrita ? ' ✍️' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>⏳ consulta lenta (busca odds na casa) · ✍️ altera dados (só com pedido explícito)</div>
                  </div>
                )}
              </div>
            )}

            {/* Área de mensagens */}
            <div style={{ flex: 1, minHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '6px' }}>
              {chatMessages.length === 0 ? (
                <div style={{ margin: 'auto', textAlign: 'center', maxWidth: '540px' }}>
                  <div style={{ fontSize: '16px', color: 'var(--text-primary)', fontWeight: 700, marginBottom: '6px' }}>Como posso ajudar?</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px' }}>Comece com uma dessas perguntas:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center' }}>
                    {chatQuickPrompts.map((q, i) => (
                      <button key={i} className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={() => handleSendChat(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                chatMessages.map((m, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    {/* A bolha saiu do estilo inline para CLASSE (.chat-bubble) porque o
                        markdown renderizado precisa de estilo descendente (lista, tabela,
                        código) — e regra em CSS ainda respeita o tema claro. */}
                    <div className={`chat-bubble ${m.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`}>
                      {m.role === 'assistant' ? (
                        // Fallback = texto cru: a resposta NUNCA desaparece enquanto o
                        // chunk do markdown carrega (nem se ele falhar — ver MarkdownBoundary).
                        <MarkdownBoundary texto={m.content}>
                          <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>}>
                            <Markdown>{m.content}</Markdown>
                          </Suspense>
                        </MarkdownBoundary>
                      ) : (
                        m.content
                      )}
                    </div>

                    {/* TRACE: quais skills o agente usou para produzir esta resposta. */}
                    {m.role === 'assistant' && (m.passos?.length || m.avisos?.length) && (
                      <div style={{ maxWidth: '78%', marginTop: '5px' }}>
                        <button
                          onClick={() => setChatTraceAberto(prev => ({ ...prev, [i]: !prev[i] }))}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '5px', padding: '2px 0',
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--text-muted)', fontSize: '11px'
                          }}
                        >
                          <Wrench size={11} />
                          {m.passos?.length
                            ? `${m.passos.length} skill${m.passos.length > 1 ? 's' : ''}: ${m.passos.map(p => p.skill).join(', ').slice(0, 60)}`
                            : 'detalhes'}
                          {m.provider ? ` · ${m.provider}` : ''}
                          <ChevronDown size={11} style={{ transform: chatTraceAberto[i] ? 'rotate(180deg)' : 'none' }} />
                        </button>
                        {chatTraceAberto[i] && (
                          <div style={{ marginTop: '4px', padding: '8px 10px', border: '1px solid var(--panel-border)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', fontSize: '11px', color: 'var(--text-secondary)' }}>
                            {(m.passos || []).map((p, j) => (
                              <div key={j} style={{ display: 'flex', gap: '6px', marginBottom: '3px' }}>
                                <span style={{ color: p.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{p.ok ? '✓' : '✕'}</span>
                                <span style={{ fontWeight: 600 }}>{p.skill}</span>
                                <span style={{ color: 'var(--text-muted)' }}>({(p.ms / 1000).toFixed(1)}s)</span>
                                <span style={{ flex: 1 }}>{p.resumo}</span>
                              </div>
                            ))}
                            {m.modelo && <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>motor: {m.provider} · {m.modelo}</div>}
                            {m.avisos?.map((a, j) => (
                              <div key={`a${j}`} style={{ color: 'var(--color-warning)', marginTop: '3px' }}>⚠️ {a}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
              {chatLoading && (
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{ padding: '10px 14px', borderRadius: '14px 14px 14px 4px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--panel-border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Consultando skills…
                  </div>
                </div>
              )}
              <div ref={chatFimRef} />
            </div>

            {/* Imagem anexada (print de promoção/cupom): miniatura + remover */}
            {chatImagem && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', padding: '8px 10px', border: '1px solid var(--panel-border)', borderRadius: '10px', background: 'rgba(255,255,255,0.03)' }}>
                <img src={chatImagem.dataUrl} alt={chatImagem.nome} style={{ width: '44px', height: '44px', objectFit: 'cover', borderRadius: '6px' }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {chatImagem.nome} — vai junto da próxima mensagem
                </div>
                <button className="btn btn-secondary" style={{ fontSize: '11px' }} onClick={() => setChatImagem(null)}>Remover</button>
              </div>
            )}

            {/* Entrada */}
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <input
                ref={chatFileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const f = e.target.files?.[0];
                  e.target.value = ''; // permite reanexar o MESMO arquivo depois de remover
                  if (!f) return;
                  // 8 MB é o teto do parser do backend; acima disso o 413 viraria "erro de conexão".
                  if (f.size > 7_500_000) {
                    alert('Imagem muito grande (máx. ~7 MB). Manda um print menor.');
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => setChatImagem({ nome: f.name, dataUrl: String(reader.result), mimeType: f.type || 'image/jpeg' });
                  reader.readAsDataURL(f);
                }}
              />
              <button
                className="btn btn-secondary"
                title="Anexar print (promoção, cupom, tela de odds)"
                onClick={() => chatFileRef.current?.click()}
                disabled={chatLoading}
                style={{ paddingLeft: '10px', paddingRight: '10px' }}
              >
                <ImageIcon size={15} />
              </button>
              <input
                className="form-control"
                style={{ flex: 1 }}
                placeholder="Pergunte sobre surebets, banca, regras das casas…"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
              />
              <button className="btn btn-primary" onClick={() => handleSendChat()} disabled={chatLoading || !chatInput.trim()}>
                <Send size={16} /> Enviar
              </button>
            </div>
            <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <AlertCircle size={12} /> A IA pode errar. Confirme regras e odds antes de apostar — o sistema nunca aposta sozinho.
            </div>
          </div>
        )}
      </main>

      {/* Guia das modalidades de promoção (botão "i" da aba Promoções).
          Só CONTEÚDO: nenhum número é calculado aqui — os exemplos são valores fixos gerados
          rodando o core (backend/src/core/promocoes.ts), e cada verbete diz as entradas que
          os produzem, para dar para reconferir no preview da própria tela. */}
      {promoGuiaTipo && (() => {
        const guia = PROMO_GUIA[promoGuiaTipo];
        const meta = PROMO_META[promoGuiaTipo];
        const fechar = () => setPromoGuiaTipo(null);
        const blocoExemplo = (ex: { titulo: string; linhas: GuiaLinha[]; leitura: string }) => (
          <div className="promo-guia-exemplo">
            <div className="promo-guia-exemplo-titulo">{ex.titulo}</div>
            {ex.linhas.map((l, i) => (
              <div key={i} className={`promo-guia-linha${l.forte ? ' forte' : ''}`}>
                <span>{l.rotulo}</span>
                <strong>{l.valor}</strong>
              </div>
            ))}
            <div className="promo-guia-leitura">{ex.leitura}</div>
          </div>
        );
        return (
          <div className="modal-overlay" onClick={fechar}>
            <div className="modal-content promo-guia-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Info size={18} style={{ color: '#10b981' }} />
                  Modalidades de promoção
                </h2>
                <button className="modal-close" onClick={fechar}>
                  <X size={20} />
                </button>
              </div>
              <div className="modal-body">
                {/* 1) Qual é o tipo? A árvore vem PRIMEIRO: o erro caro não é errar a conta,
                       é aplicar a doutrina de um tipo em outro (SNR × SRR, super odd × lucro extra). */}
                <details className="promo-guia-arvore">
                  <summary>Na dúvida, comece aqui: qual modalidade é a minha?</summary>
                  {PROMO_GUIA_ARVORE.map((n, i) => (
                    <div key={i} className="promo-guia-no">
                      <div className="promo-guia-pergunta">{i + 1}. {n.pergunta}</div>
                      <div className="promo-guia-resposta"><span className="sim">SIM</span> {n.sim}</div>
                      <div className="promo-guia-resposta"><span className="nao">NÃO</span> {n.nao}</div>
                    </div>
                  ))}
                </details>

                {/* 2) Chips: trocam o VERBETE, não o formulário (o botão "usar este tipo" faz isso). */}
                <div className="promo-guia-chips">
                  {(Object.keys(PROMO_GUIA) as PromoTipo[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setPromoGuiaTipo(t)}
                      className={`promo-guia-chip${t === promoGuiaTipo ? ' ativo' : ''}`}
                      style={t === promoGuiaTipo ? { borderColor: PROMO_META[t].cor, color: PROMO_META[t].cor } : undefined}
                    >
                      {PROMO_META[t].chip}
                    </button>
                  ))}
                </div>

                <div className="promo-guia-verbete">
                  <div className="promo-guia-titulo" style={{ color: meta.cor }}>{guia.titulo}</div>
                  <p className="promo-guia-texto">{guia.oQueE}</p>

                  <div className="promo-guia-secao">Como a casa anuncia</div>
                  <ul className="promo-guia-lista">
                    {guia.anuncio.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>

                  <div className="promo-guia-secao">Fórmula (a mesma do cálculo desta tela)</div>
                  <pre className="promo-guia-formula">{guia.formula.join('\n')}</pre>

                  <div className="promo-guia-secao">Exemplo</div>
                  {blocoExemplo(guia.exemplo)}
                  {guia.exemplo2 && blocoExemplo(guia.exemplo2)}

                  <div className="promo-guia-secao">Armadilhas</div>
                  <ul className="promo-guia-lista">
                    {guia.armadilhas.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>

                  <div className="promo-guia-nao-confunda">
                    <strong>Não confunda com:</strong> {guia.naoConfundaCom}
                  </div>

                  <button
                    className="btn"
                    onClick={() => { setPromoForm((f) => ({ ...f, promoTipo: promoGuiaTipo })); fechar(); }}
                    style={{ marginTop: '14px', padding: '6px 12px', fontSize: '11.5px', fontWeight: 700, background: meta.cor, color: '#0b1220', border: 'none' }}
                  >
                    Usar {meta.chip} no formulário
                  </button>
                </div>

                {/* 3) Vale para TODAS: é o que mais queima promoção (Apêndice C do Promocoes.md). */}
                <details className="promo-guia-arvore">
                  <summary>Regulamento: o que conferir em qualquer promoção</summary>
                  <ul className="promo-guia-lista">
                    <li><strong>OPT-IN</strong> na oferta ANTES de montar o bilhete — é o que mais queima promoção.</li>
                    <li>Tipo de bilhete aceito (simples? múltipla com N seleções?) e mercado/competição elegível.</li>
                    <li>Odd mínima por seleção e odd total mínima.</li>
                    <li>Valor mínimo e os <strong>tetos</strong>: de stake, de devolução e de ganho (ganho ≠ retorno).</li>
                    <li>Janela da promoção e prazo de creditação (costuma ser "até 24h após o FIM da campanha").</li>
                    <li>O bônus recebido é SNR ou SRR? Tem odd mínima, validade, rollover?</li>
                    <li>Uma aposta por evento/CPF/dia? A oferta é repetível?</li>
                  </ul>
                </details>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Calculator Modal */}
      {selectedOpp && modalCalc && (
        <div className="modal-overlay" onClick={() => setSelectedOpp(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedOpp.evento}</h2>
              <button className="modal-close" onClick={() => setSelectedOpp(null)}>
                <X size={20} />
              </button>
            </div>
            
            <div className="modal-body">
              <div className="form-group" style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--panel-border)' }}>
                <label style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Valor Total a Apostar (R$)</label>
                <input 
                  type="number" 
                  className="form-control" 
                  value={modalTotalInvestment} 
                  onChange={e => setModalTotalInvestment(e.target.value)}
                  style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '8px' }}
                />
              </div>

              {/* Editable Odds inputs */}
              <div className="resp-grid-2" style={{ gap: '16px', marginTop: '-8px', marginBottom: '8px' }}>
                <div className="form-group" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: '8px', border: '1px dashed var(--panel-border)' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Odd {selectedOpp.casa_a_nome || 'Casa 1'}</label>
                  <input 
                    type="number" 
                    step="0.01"
                    className="form-control" 
                    value={modalOdd1} 
                    onChange={e => setModalOdd1(e.target.value)}
                    style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '4px', padding: '6px 10px' }}
                  />
                </div>
                <div className="form-group" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: '8px', border: '1px dashed var(--panel-border)' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Odd {selectedOpp.casa_b_nome || 'Casa 2'}</label>
                  <input 
                    type="number" 
                    step="0.01"
                    className="form-control" 
                    value={modalOdd2} 
                    onChange={e => setModalOdd2(e.target.value)}
                    style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '4px', padding: '6px 10px' }}
                  />
                </div>
              </div>

              <div className="resp-grid-2" style={{ gap: '16px' }}>
                <div 
                  className="odd-box clickable-odd-box" 
                  style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '12px' }}
                  onClick={() => window.open(selectedOpp.url_casa_1 || getHouseUrl(selectedOpp.casa_a_nome || ''), '_blank')}
                  title={selectedOpp.url_casa_1 ? `Abrir o link direto do grupo na ${selectedOpp.casa_a_nome || 'Casa 1'}` : `Abrir jogo na ${selectedOpp.casa_a_nome || 'Casa 1'}`}
                >
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
                    <span className="odd-outcome">{selectedOpp.opcao_a || 'Opção A'}</span>
                    <span className="odd-value">{(parseFloat(modalOdd1) || selectedOpp.odd_casa_1).toFixed(2)}</span>
                  </div>
                  <div style={{ width: '100%' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', textTransform: 'uppercase' }}>
                      APOSTAR NA {selectedOpp.casa_a_nome || 'CASA 1'} <ExternalLink size={10} />
                    </div>
                    <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981' }}>R$ {modalCalc.stake1.toFixed(2)}</div>
                  </div>
                </div>

                <div 
                  className="odd-box clickable-odd-box" 
                  style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '12px' }}
                  onClick={() => window.open(selectedOpp.url_casa_2 || getHouseUrl(selectedOpp.casa_b_nome || ''), '_blank')}
                  title={selectedOpp.url_casa_2 ? `Abrir o link direto do grupo na ${selectedOpp.casa_b_nome || 'Casa 2'}` : `Abrir jogo na ${selectedOpp.casa_b_nome || 'Casa 2'}`}
                >
                  <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
                    <span className="odd-outcome">{selectedOpp.opcao_b || 'Opção B'}</span>
                    <span className="odd-value">{(parseFloat(modalOdd2) || selectedOpp.odd_casa_2).toFixed(2)}</span>
                  </div>
                  <div style={{ width: '100%' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', textTransform: 'uppercase' }}>
                      APOSTAR NA {selectedOpp.casa_b_nome || 'CASA 2'} <ExternalLink size={10} />
                    </div>
                    <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981' }}>R$ {modalCalc.stake2.toFixed(2)}</div>
                  </div>
                </div>
              </div>

              {/* Links colhidos do grupo do Telegram (migration 017) — todos, inclusive os
                  que não casaram com uma perna (o rótulo é a casa ou o domínio do link). */}
              {selectedOpp.links_grupo && selectedOpp.links_grupo.length > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'center', border: '1px dashed var(--panel-border)', borderRadius: '8px', padding: '8px 12px' }}>
                  <span style={{ fontWeight: 700 }}>🔗 Links do grupo:</span>
                  {selectedOpp.links_grupo.map((l, i) => {
                    let rotulo = l.casa || '';
                    if (!rotulo) {
                      try { rotulo = new URL(l.url).hostname.replace(/^www\./, ''); } catch { rotulo = l.url.slice(0, 40); }
                    }
                    return (
                      <a key={i} href={l.url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        {rotulo} <ExternalLink size={9} />
                      </a>
                    );
                  })}
                </div>
              )}

              <div style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '8px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 'bold' }}>LUCRO GARANTIDO</div>
                  <div style={{ fontSize: '24px', fontWeight: '800', color: '#fff' }}>+ R$ {modalCalc.lucro.toFixed(2)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>RETORNO TOTAL</div>
                  <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#f8fafc' }}>R$ {modalCalc.retorno.toFixed(2)}</div>
                </div>
              </div>

              {/* Parecer do Auditor de Risco (IA) — análise MANUAL sob demanda */}
              {(() => {
                const v = selectedOpp.ia_veredito;
                const analisando = analyzingIds.has(selectedOpp.id) || selectedOpp.ia_status === 'processando';
                if (analisando) {
                  return (
                    <div style={{ background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.3)', borderRadius: '8px', padding: '12px', fontSize: '13px', color: '#94a3b8' }}>
                      🤖 Analisando risco com IA…
                    </div>
                  );
                }
                const risco = selectedOpp.ia_risco || v?.nivel_risco;
                if (!risco) {
                  // Ainda não analisado por IA (ia_veredito) → análise manual (poupa tokens/cota).
                  // Obs.: ignoramos o analise_ia "enlatado" do SureRadar de propósito.
                  if (selectedOpp.id.includes('mock-')) return null;
                  return (
                    <button
                      className="btn btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', gap: '6px' }}
                      onClick={() => handleAnalyzeIA(selectedOpp.id)}
                    >
                      <Cpu size={14} /> Analisar risco com IA
                    </button>
                  );
                }
                const cfg = risco === 'critico'
                  ? { c: '#ef4444', bg: 'rgba(239,68,68,0.1)', b: '1px solid rgba(239,68,68,0.3)', emoji: '🔴', titulo: 'Risco Crítico' }
                  : risco === 'atencao'
                  ? { c: '#f59e0b', bg: 'rgba(245,158,11,0.1)', b: '1px solid rgba(245,158,11,0.3)', emoji: '🟡', titulo: 'Atenção' }
                  : { c: '#10b981', bg: 'rgba(16,185,129,0.1)', b: '1px solid rgba(16,185,129,0.3)', emoji: '🟢', titulo: 'Risco Baixo' };
                return (
                  <div style={{ background: cfg.bg, border: cfg.b, borderRadius: '8px', padding: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 'bold', color: cfg.c }}>
                        {cfg.emoji} Auditor de Risco (IA): {cfg.titulo}
                        {typeof v?.confianca === 'number' && v.confianca > 0 ? ` • ${v.confianca}% de confiança` : ''}
                      </span>
                      {!selectedOpp.id.includes('mock-') && (
                        <button
                          onClick={() => handleAnalyzeIA(selectedOpp.id)}
                          title="Analisar novamente"
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px', padding: 0 }}
                        >
                          <RefreshCw size={11} /> reanalisar
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{v?.motivo || selectedOpp.analise_ia}</div>
                  </div>
                );
              })()}

              {/* Revalidação de odd (§6): reconsulta a cotação atual e classifica o movimento */}
              {!selectedOpp.id.includes('mock-') && (() => {
                const st = revalResult?.status;
                const stCfg = st === 'ok'
                  ? { c: '#34d399', bg: 'rgba(16,185,129,0.1)', b: 'rgba(16,185,129,0.3)', label: '✅ Surebet mantida' }
                  : st === 'melhorou'
                  ? { c: '#34d399', bg: 'rgba(16,185,129,0.1)', b: 'rgba(16,185,129,0.3)', label: '📈 ROI melhorou' }
                  : st === 'reduzida'
                  ? { c: '#f59e0b', bg: 'rgba(245,158,11,0.1)', b: 'rgba(245,158,11,0.3)', label: '⚠️ ROI reduziu' }
                  : st === 'expirada'
                  ? { c: '#ef4444', bg: 'rgba(239,68,68,0.1)', b: 'rgba(239,68,68,0.3)', label: '❌ Expirou' }
                  : st === 'nao_suportado'
                  ? { c: '#94a3b8', bg: 'rgba(148,163,184,0.1)', b: 'rgba(148,163,184,0.25)', label: 'ℹ️ Fonte não suportada' }
                  : { c: '#94a3b8', bg: 'rgba(148,163,184,0.1)', b: 'rgba(148,163,184,0.25)', label: 'Não foi possível revalidar' };
                const ag = oddAgeInfo(latestOddTs(selectedOpp));
                return (
                  <div style={{ border: '1px solid var(--panel-border)', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {ag ? `Odd coletada ${ag.label}` : 'Odd do último scan'}
                      </div>
                      <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={handleRevalidate} disabled={revalLoading}>
                        <RefreshCw size={14} className={revalLoading ? 'spin-anim' : ''} /> {revalLoading ? 'Revalidando…' : 'Revalidar odd'}
                      </button>
                    </div>
                    {revalResult && (
                      <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: '8px', background: stCfg.bg, border: `1px solid ${stCfg.b}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                          <span style={{ fontSize: '12px', fontWeight: 700, color: stCfg.c }}>
                            {stCfg.label}
                            {typeof revalResult.roi_atual === 'number' ? ` • ROI ${revalResult.roi_atual.toFixed(2)}%` : ''}
                          </span>
                          {revalResult.checado_em && (
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                              conferido {oddAgeInfo(revalResult.checado_em)?.label || 'agora'}
                            </span>
                          )}
                        </div>

                        {typeof revalResult.odd_a === 'number' && typeof revalResult.odd_b === 'number' && (
                          <div className="resp-grid-2" style={{ gap: '8px', marginBottom: revalResult.movimento?.explicacao ? '8px' : 0 }}>
                            {[
                              { casa: selectedOpp.casa_a_nome, opc: selectedOpp.opcao_a, old: selectedOpp.odd_casa_1, novo: revalResult.odd_a as number, link: selectedOpp.url_casa_1 },
                              { casa: selectedOpp.casa_b_nome, opc: selectedOpp.opcao_b, old: selectedOpp.odd_casa_2, novo: revalResult.odd_b as number, link: selectedOpp.url_casa_2 }
                            ].map((leg, i) => {
                              const diff = leg.novo - leg.old;
                              const arrow = Math.abs(diff) < 0.005 ? '=' : diff > 0 ? '▲' : '▼';
                              const dcol = Math.abs(diff) < 0.005 ? 'var(--text-muted)' : diff > 0 ? '#34d399' : '#ef4444';
                              return (
                                <div key={i} style={{ background: 'rgba(0,0,0,0.18)', borderRadius: '6px', padding: '8px' }}>
                                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 700 }}>{leg.casa || `Casa ${i + 1}`}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-primary)', margin: '2px 0' }}>{leg.opc || '—'}</div>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', textDecoration: 'line-through' }}>{leg.old.toFixed(2)}</span>
                                    <span style={{ fontSize: '16px', fontWeight: 800, color: '#fff' }}>{leg.novo.toFixed(2)}</span>
                                    <span style={{ fontSize: '12px', fontWeight: 700, color: dcol }}>{arrow}</span>
                                  </div>
                                  <button
                                    onClick={() => window.open(leg.link || getHouseUrl(leg.casa || ''), '_blank')}
                                    style={{ marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 700, color: 'var(--color-primary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                                    title={`Abrir ${leg.casa || 'casa'} para conferir a odd`}
                                  >
                                    Abrir {leg.casa || 'casa'} <ExternalLink size={10} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {revalResult.movimento?.explicacao && (
                          <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{revalResult.movimento.explicacao}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: '14px', fontSize: '16px' }}
                onClick={handleRecordOperation}
                disabled={loadingOperation}
              >
                {loadingOperation ? 'Lançando...' : '+ Confirmar Entrada (Lançar na Banca)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de ENTRADA MANUAL: registrar na banca uma surebet feita fora do radar */}
      {manualOpen && (
        <div className="modal-overlay" onClick={() => setManualOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Entrada Manual de Surebet</h2>
              <button className="modal-close" onClick={() => setManualOpen(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              <datalist id="casas-conhecidas">
                {Array.from(new Set([...CASAS_PADRAO, ...availableBookmakers])).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>

              <div className="resp-grid-2" style={{ gap: '12px' }}>
                <div className="form-group">
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Evento *</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Ex.: Flamengo vs Palmeiras"
                    value={manualForm.evento}
                    onChange={e => setManualForm({ ...manualForm, evento: e.target.value })}
                    style={{ marginTop: '4px', padding: '8px 10px' }}
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Esporte</label>
                  <select
                    className="form-control"
                    value={manualForm.esporte}
                    onChange={e => setManualForm({ ...manualForm, esporte: e.target.value })}
                    style={{ marginTop: '4px', padding: '8px 10px' }}
                  >
                    <option value="">— selecione —</option>
                    {Object.keys(ESPORTE_EMOJI).map((s) => (
                      <option key={s} value={s}>{ESPORTE_EMOJI[s]} {s}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Mercado</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Ex.: Resultado Final"
                    value={manualForm.mercado}
                    onChange={e => setManualForm({ ...manualForm, mercado: e.target.value })}
                    style={{ marginTop: '4px', padding: '8px 10px' }}
                  />
                </div>
              </div>

              {/* Pernas A e B */}
              <div className="resp-grid-2" style={{ gap: '16px' }}>
                {([
                  { lado: 'A' as const, casa: 'casaA' as const, opcao: 'opcaoA' as const, odd: 'oddA' as const },
                  { lado: 'B' as const, casa: 'casaB' as const, opcao: 'opcaoB' as const, odd: 'oddB' as const }
                ]).map((p) => (
                  <div key={p.lado} className="form-group" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '12px', borderRadius: '8px', border: '1px dashed var(--panel-border)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Perna {p.lado}</div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Casa</label>
                      <input
                        type="text"
                        className="form-control"
                        list="casas-conhecidas"
                        placeholder={`Ex.: ${p.lado === 'A' ? 'Betano' : 'KTO'}`}
                        value={manualForm[p.casa]}
                        onChange={e => setManualForm({ ...manualForm, [p.casa]: e.target.value })}
                        style={{ marginTop: '4px', padding: '6px 10px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Opção / Seleção</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder={`Ex.: ${p.lado === 'A' ? 'Casa vence' : 'Empate ou Fora (X2)'}`}
                        value={manualForm[p.opcao]}
                        onChange={e => setManualForm({ ...manualForm, [p.opcao]: e.target.value })}
                        style={{ marginTop: '4px', padding: '6px 10px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Odd *</label>
                      <input
                        type="number"
                        step="0.01"
                        min="1.01"
                        className="form-control"
                        placeholder="Ex.: 2.10"
                        value={manualForm[p.odd]}
                        onChange={e => setManualForm({ ...manualForm, [p.odd]: e.target.value })}
                        style={{ marginTop: '4px', padding: '6px 10px', fontWeight: 'bold' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Stake (R$)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="form-control"
                        placeholder="auto"
                        value={manualStakesEditadas
                          ? (p.lado === 'A' ? manualStakeA : manualStakeB)
                          : (manualCalc ? (p.lado === 'A' ? manualCalc.stakeA : manualCalc.stakeB).toFixed(2) : '')}
                        onChange={e => editarStakeManual(p.lado, e.target.value)}
                        style={{ marginTop: '4px', padding: '6px 10px', fontWeight: 'bold', color: '#10b981' }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="form-group" style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--panel-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Valor Total a Apostar (R$)</label>
                  {manualStakesEditadas && (
                    <button
                      onClick={() => setManualStakesEditadas(false)}
                      title="Voltar a distribuir o total automaticamente pelas odds"
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, padding: 0 }}
                    >
                      ↺ redistribuir stakes automaticamente
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  className="form-control"
                  value={manualStakesEditadas && manualCalc ? manualCalc.total.toFixed(2) : manualTotal}
                  disabled={manualStakesEditadas}
                  title={manualStakesEditadas ? 'Total = soma das stakes digitadas' : undefined}
                  onChange={e => setManualTotal(e.target.value)}
                  style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '8px' }}
                />
              </div>

              {manualCalc ? (
                <div style={{
                  background: manualCalc.lucro >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                  border: manualCalc.lucro >= 0 ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '8px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ fontSize: '12px', color: manualCalc.lucro >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                      {manualCalc.lucro >= 0 ? 'LUCRO GARANTIDO' : 'PIOR CENÁRIO (PREJUÍZO)'}
                    </div>
                    <div style={{ fontSize: '24px', fontWeight: '800', color: manualCalc.lucro >= 0 ? '#fff' : '#ef4444' }}>
                      {manualCalc.lucro >= 0 ? '+' : '−'} R$ {Math.abs(manualCalc.lucro).toFixed(2)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>ROI</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: manualCalc.roi >= 0 ? '#f8fafc' : '#ef4444' }}>
                      {manualCalc.roi.toFixed(2)}%
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: '8px', padding: '12px', fontSize: '13px', color: '#94a3b8' }}>
                  Preencha as duas odds (decimais &gt; 1) e o investimento para calcular stakes, lucro e ROI.
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: '14px', fontSize: '16px' }}
                onClick={handleRecordManualOperation}
                disabled={loadingOperation}
              >
                {loadingOperation ? 'Lançando...' : '+ Confirmar Entrada Manual (Lançar na Banca)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
