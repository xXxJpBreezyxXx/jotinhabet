import { useState, useEffect, useRef } from 'react';
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
  Radar
} from 'lucide-react';

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

/** Countdown do TTL estimado — reinicia quando o valor de segundos muda (refresh). */
function CashoutTTL({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    const id = setInterval(() => setRemaining((r) => Math.max(r - 1, 0)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  const urgente = remaining <= 15;
  return (
    <span style={{ color: urgente ? '#ef4444' : 'var(--text-muted)', fontWeight: 600, fontSize: '13px' }}>
      ⏳ {remaining}s
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'radar-cashout' | 'calculadora' | 'juros-compostos' | 'saldos' | 'ai-test'>('dashboard');
  const [systemStatus, setSystemStatus] = useState<HealthStatus | null>(null);

  // Radar Cashout: oportunidades ativas + status do worker (polling só quando a aba está aberta).
  const [cashoutOpps, setCashoutOpps] = useState<CashoutOpportunity[]>([]);
  const [cashoutStatus, setCashoutStatus] = useState<CashoutStatus | null>(null);
  const [cashoutLoading, setCashoutLoading] = useState(true);
  // Resultado do "Verificar" por oportunidade (id → estado).
  const [cashoutVerif, setCashoutVerif] = useState<Record<string, CashoutVerificacao>>({});

  const validarCashout = (id: string) => {
    setCashoutVerif((v) => ({ ...v, [id]: { loading: true } }));
    fetch(`/api/cashout/opportunities/${id}/validar`)
      .then((r) => r.json())
      .then((d) => setCashoutVerif((v) => ({ ...v, [id]: { ...d, loading: false } })))
      .catch(() => setCashoutVerif((v) => ({ ...v, [id]: { loading: false, disponivel: false, mensagem: 'Falha ao validar.' } })));
  };

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
  const [calcResult, setCalcResult] = useState<CalculatorResult | null>(null);
  const [calcError, setCalcError] = useState('');

  // Daily Evolution Projections State (Planilha)
  const [userBanca, setUserBanca] = useState(() => {
    return localStorage.getItem('jotinhabet_user_banca') || '50.00';
  });
  const [projBancaInicial, setProjBancaInicial] = useState(localStorage.getItem('jotinhabet_user_banca') || '50.00');

  // Persistência da banca no BANCO (app_config) — o localStorage vira cache local.
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

  // Escrita canônica da banca: ref (síncrono) + state + localStorage; opcionalmente
  // persiste no banco (silencioso). Todos os fluxos que mudam a banca passam aqui.
  const aplicarBanca = (v: string, persistirNoBanco = false) => {
    userBancaRef.current = v;
    bancaTocadaRef.current = true;
    setUserBanca(v);
    localStorage.setItem('jotinhabet_user_banca', v);
    if (persistirNoBanco) salvarBancaNoBanco(v, true);
  };

  const agendarResetBotao = () => {
    if (bancaSaveTimerRef.current) clearTimeout(bancaSaveTimerRef.current);
    bancaSaveTimerRef.current = setTimeout(() => setBancaSaveState('idle'), 2500);
  };

  // Salva a banca no banco. `silencioso` = sem feedback visual (usado nos salvamentos
  // automáticos após lançar/excluir entrada, que já têm alert próprio). Em falha,
  // marca 'jotinhabet_banca_dirty' — o próximo mount re-sincroniza em vez de
  // deixar o valor antigo do banco sobrescrever o local mais novo.
  const salvarBancaNoBanco = (valor: string | number, silencioso = false) => {
    const banca = parseFloat(String(valor));
    if (!Number.isFinite(banca) || banca <= 0) {
      console.warn('[banca] Valor inválido, não sincronizado com o banco:', valor);
      localStorage.setItem('jotinhabet_banca_dirty', '1'); // local é mais novo que o banco
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
    fetch('/api/banca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banca }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) localStorage.removeItem('jotinhabet_banca_dirty');
        else {
          localStorage.setItem('jotinhabet_banca_dirty', '1');
          console.warn('Falha ao salvar banca no banco:', d.error);
        }
        if (!silencioso) {
          setBancaSaveState(d.success ? 'saved' : 'error');
          agendarResetBotao();
        }
      })
      .catch((err) => {
        localStorage.setItem('jotinhabet_banca_dirty', '1');
        console.error('Erro ao salvar banca no banco:', err);
        if (!silencioso) {
          setBancaSaveState('error');
          agendarResetBotao();
        }
      });
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
  // Chat do Copiloto de IA (aba "IA & Automação")
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatQuickPrompts = [
    'O que é uma surebet e o que pode dar errado?',
    'Como dividir minha banca entre as duas casas?',
    'Quais regras de tênis quebram uma arbitragem?',
    'O que é um "erro palpável" (palpable error)?'
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
  const [modalTotalInvestment, setModalTotalInvestment] = useState(() => {
    return localStorage.getItem('jotinhabet_user_banca') || '50.00';
  });
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

  const [dashboardSubTab, setDashboardSubTab] = useState<'radar' | 'historico'>('radar');
  const [filterDate, setFilterDate] = useState<string>(''); // YYYY-MM-DD
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
  }, [theme]);

  // Live System Logs State
  const [systemLogs, setSystemLogs] = useState('Carregando console do JotinhaBet...');
  const [logsExpanded, setLogsExpanded] = useState(true);

  // Operations history state
  const [operationsHistory, setOperationsHistory] = useState<any[]>([]);
  const [loadingOperation, setLoadingOperation] = useState(false);

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

    // Sincronização inicial da banca com o banco:
    //  - Se um save anterior falhou (flag dirty), o valor LOCAL é o mais novo →
    //    re-envia pro banco em vez de deixar o banco sobrescrever o local.
    //  - Senão o banco é a fonte da verdade, mas só aplica se o usuário ainda não
    //    editou nada neste pageload (um GET tardio não pode sobrescrever edição).
    if (localStorage.getItem('jotinhabet_banca_dirty') === '1') {
      salvarBancaNoBanco(localStorage.getItem('jotinhabet_user_banca') || '', true);
    } else {
      fetch('/api/banca')
        .then((r) => r.json())
        .then((d) => {
          if (bancaTocadaRef.current) return; // usuário já mexeu — não sobrescreve
          if (d && typeof d.banca === 'number' && Number.isFinite(d.banca) && d.banca > 0) {
            const v = d.banca.toFixed(2);
            userBancaRef.current = v;
            setUserBanca(v);
            localStorage.setItem('jotinhabet_user_banca', v);
          }
        })
        .catch(() => {
          console.warn('Não foi possível carregar a banca salva do banco (usando localStorage).');
        });
    }

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
        roundStep2
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
  }, [calcOdd1, calcOdd2, calcBanca1, calcBanca2, calcMaxStakePct, calcRoundStep1, calcRoundStep2]);



  const handleSendChat = async (text?: string) => {
    const content = (text ?? chatInput).trim();
    if (!content || chatLoading) return;

    const nextMessages = [...chatMessages, { role: 'user' as const, content }];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatLoading(true);
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await response.json();
      const reply = data.reply || (data.error ? `Erro: ${data.error}` : 'Resposta vazia do servidor.');
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Falha de conexão com o backend: ${err.message || err}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  const isDbConnected = systemStatus?.services?.database === 'connected';

  // Sync projBancaInicial with userBanca when userBanca changes
  useEffect(() => {
    setProjBancaInicial(userBanca);
  }, [userBanca]);

  // Group operations by date and merge them with future projection results
  const getMergedProjection = (): any[] => {
    // 1. Group operations by date string
    const opsByDate: { [dateStr: string]: any[] } = {};
    operationsHistory.forEach(op => {
      const date = new Date(op.confirmado_em);
      const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      if (!opsByDate[dateStr]) {
        opsByDate[dateStr] = [];
      }
      opsByDate[dateStr].push(op);
    });

    // 2. Sort dates chronologically
    const sortedDates = Object.keys(opsByDate).sort((a, b) => {
      const aTime = new Date(opsByDate[a][0].confirmado_em).getTime();
      const bTime = new Date(opsByDate[b][0].confirmado_em).getTime();
      return aTime - bTime;
    });

    const rows: any[] = [];
    let currentBanca = parseFloat(projBancaInicial);

    // Add historical real days
    sortedDates.forEach(dateStr => {
      const ops = opsByDate[dateStr];
      const lucroTotal = ops.reduce((sum, op) => sum + (op.lucro_real || 0), 0);
      const stakeTotal = ops.reduce((sum, op) => sum + (op.stake_real_1 + op.stake_real_2), 0);
      
      const startBanca = currentBanca;
      const endBanca = startBanca + lucroTotal;
      currentBanca = endBanca;

      // Map up to 3 individual turn profits, fold remaining into turn 3
      const t1 = ops[0] ? ops[0].lucro_real : 0;
      const t2 = ops[1] ? ops[1].lucro_real : 0;
      let t3 = 0;
      if (ops.length === 3) {
        t3 = ops[2].lucro_real;
      } else if (ops.length > 3) {
        t3 = ops.slice(2).reduce((sum, op) => sum + op.lucro_real, 0);
      }

      rows.push({
        dia: `${dateStr} (Real)`,
        bancaInicial: startBanca,
        maoPorTurno: ops.length > 0 ? (stakeTotal / ops.length) : 0,
        lucroTurno1: t1,
        lucroTurno2: t2,
        lucroTurno3: t3,
        lucroTotalDia: lucroTotal,
        bancaFinal: endBanca,
        isReal: true
      });
    });

    // Add simulated projection days starting from the latest real bankroll
    const simDaysCount = parseInt(projDias) || 30;
    const maxStakePct = (parseFloat(projMaxStakePct) || 50) / 100;
    const roiMedio = (parseFloat(projRoiMedioPct) || 4) / 100;
    const turnos = parseInt(projTurnosPorDia) || 3;

    let simBanca = currentBanca;

    for (let i = 1; i <= simDaysCount; i++) {
      const startBanca = simBanca;
      const stake = startBanca * maxStakePct;
      
      const lucroTurno = stake * roiMedio;
      const lucroTotalDia = lucroTurno * turnos;
      const endBanca = startBanca + lucroTotalDia;
      simBanca = endBanca;

      rows.push({
        dia: `Dia ${i}`,
        bancaInicial: startBanca,
        maoPorTurno: stake,
        lucroTurno1: lucroTurno,
        lucroTurno2: turnos >= 2 ? lucroTurno : 0,
        lucroTurno3: turnos >= 3 ? lucroTurno : 0,
        lucroTotalDia: lucroTotalDia,
        bancaFinal: endBanca,
        isReal: false
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
  const totalLucroReal = operationsHistory.reduce((sum, op) => sum + (op.lucro_real || 0), 0);

  // Saldos por casa (derivados p/ os cards da aba "Saldo nas Casas").
  const totalSaldos = saldosCasas.reduce((acc, s) => acc + (parseFloat(s.valor) || 0), 0);
  const casasComSaldo = saldosCasas.filter((s) => (parseFloat(s.valor) || 0) > 0).length;

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div>
          <div className="logo-container">
            <div className="logo-icon">J</div>
            <span className="logo-text">JotinhaBet</span>
          </div>

          <nav className="nav-list">
            <a
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <Layers size={18} />
              Radar Surebets
            </a>
            <a
              className={`nav-item ${activeTab === 'radar-cashout' ? 'active' : ''}`}
              onClick={() => setActiveTab('radar-cashout')}
            >
              <Radar size={18} />
              Radar Cashout
            </a>
            <a
              className={`nav-item ${activeTab === 'calculadora' ? 'active' : ''}`}
              onClick={() => setActiveTab('calculadora')}
            >
              <Calculator size={18} />
              Calculadora
            </a>
            <a
              className={`nav-item ${activeTab === 'juros-compostos' ? 'active' : ''}`}
              onClick={() => setActiveTab('juros-compostos')}
            >
              <Percent size={18} />
              Juros Compostos
            </a>
            <a
              className={`nav-item ${activeTab === 'saldos' ? 'active' : ''}`}
              onClick={() => setActiveTab('saldos')}
            >
              <Wallet size={18} />
              Saldo nas Casas
            </a>
            <a
              className={`nav-item ${activeTab === 'ai-test' ? 'active' : ''}`}
              onClick={() => setActiveTab('ai-test')}
            >
              <Cpu size={18} />
              IA & Automação
            </a>
          </nav>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className={`indicator ${isDbConnected ? 'indicator-active' : 'indicator-error'}`}></span>
            Database: {isDbConnected ? 'Conectado' : 'Offline'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Versão 1.0.0 (TypeScript)</span>
            <button 
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                transition: 'all 0.2s ease'
              }}
              title={theme === 'dark' ? 'Ativar Modo Claro' : 'Ativar Modo Escuro'}
            >
              {theme === 'dark' ? <Sun size={14} style={{ color: '#f59e0b' }} /> : <Moon size={14} style={{ color: '#34d399' }} />}
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
              {activeTab === 'calculadora' && 'Calculadora de Arbitragem'}
              {activeTab === 'juros-compostos' && 'Evolução Diária e Juros Compostos'}
              {activeTab === 'saldos' && 'Saldo Disponível nas Casas'}
              {activeTab === 'ai-test' && 'Laboratório de IA'}
            </h1>
            <p>
              {activeTab === 'dashboard' && 'Monitore oportunidades de lucro garantido em tempo real'}
              {activeTab === 'radar-cashout' && 'Monitore oportunidades de cashout em tempo real'}
              {activeTab === 'calculadora' && 'Calcule as stakes ideais e ROI para operações de arbitragem'}
              {activeTab === 'juros-compostos' && 'Simulação e projeção baseadas na planilha de Arbitragem'}
              {activeTab === 'saldos' && 'Registre quanto você tem disponível em cada casa de apostas'}
              {activeTab === 'ai-test' && 'Configure e teste os provedores de modelos de linguagem'}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '4px 0' }}>
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

            {/* Sub-Tabs Navigation */}
            <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', borderBottom: '1px solid var(--panel-border)', paddingBottom: '12px' }}>
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
                  paddingBottom: '8px',
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
                  paddingBottom: '8px',
                  outline: 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                Histórico de Entradas
              </button>
            </div>

            {dashboardSubTab === 'radar' && (
              /* Dashboard main layout - Two Column Layout (Sidebar filter + 3-col Cards Grid) */
              <div className="resp-stack" style={{ display: 'flex', gap: '24px', width: '100%', alignItems: 'flex-start' }}>

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
                    style={{ padding: '5px 10px', fontSize: '11px', border: 'none', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', width: '100%' }}
                    onClick={() => setSelectedBookmakers([])}
                  >
                    Limpar Filtros ({selectedBookmakers.length})
                  </button>
                )}

                {availableBookmakers.length === 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Aguardando carregar casas...</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 12px',
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
                            padding: '0 4px',
                            display: 'flex',
                            alignItems: 'center'
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
                              <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--panel-border)', margin: '0 4px' }} />
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
                                <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--panel-border)', margin: '0 4px' }} />
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
                                <div className="roi-example">
                                  R$ 1.000 → lucro de <strong>R$ {((opp.roi_pct / 100) * 1000).toFixed(2)}</strong>
                                </div>
                              </div>
                              
                              <button 
                                className="btn" 
                                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--panel-border)', color: 'var(--text-primary)', alignSelf: 'flex-start' }}
                                onClick={() => setSelectedOpp(opp)}
                              >
                                CALCULAR <ChevronRight size={14} />
                              </button>
                            </div>
                            
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
              </div>

              <div className="table-container" style={{ width: '100%' }}>
                {operationsHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Nenhuma aposta lançada na banca ainda. Abra a calculadora de uma surebet e clique em "Confirmar Entrada" para registrar!
                  </div>
                ) : (
                  <table className="custom-table" style={{ fontSize: '12px' }}>
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Evento</th>
                        <th>Mercado</th>
                        <th>Casas & Odds</th>
                        <th>Investimento</th>
                        <th>Lucro Líquido</th>
                        <th>ROI</th>
                        <th style={{ textAlign: 'center' }}>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {operationsHistory.map((op) => {
                        const d = op.detalhes || {};
                        return (
                          <tr key={op.id}>
                            <td style={{ color: 'var(--text-secondary)' }}>
                              {new Date(op.confirmado_em).toLocaleDateString()} {new Date(op.confirmado_em).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td style={{ fontWeight: 'bold' }}>{d.evento || 'Evento'}</td>
                            <td>{d.mercado || 'Mercado'}</td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <span>{d.casaA}: <strong>R$ {op.stake_real_1.toFixed(2)}</strong> @ {d.oddA?.toFixed(2)}</span>
                                <span>{d.casaB}: <strong>R$ {op.stake_real_2.toFixed(2)}</strong> @ {d.oddB?.toFixed(2)}</span>
                              </div>
                            </td>
                            <td>R$ {(op.stake_real_1 + op.stake_real_2).toFixed(2)}</td>
                            <td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>+ R$ {op.lucro_real.toFixed(2)}</td>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
                {[...cashoutOpps]
                  .sort((a, b) => (Number(b.ativa) - Number(a.ativa)) || (b.gap_pct - a.gap_pct))
                  .map((opp) => {
                  const v = cashoutVerif[opp.id];
                  return (
                  <div key={opp.id} className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', opacity: opp.ativa ? 1 : 0.62 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                      <div>
                        <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: '15px' }}>{opp.event_label}</p>
                        <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: '12px' }}>
                          {opp.sport} · {opp.market_label} · <strong style={{ color: 'var(--text-secondary)' }}>{opp.selection_label}</strong>
                        </p>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        <CashoutGapBadge gapPct={opp.gap_pct} />
                        <span style={{ fontSize: '10px', fontWeight: 700, color: opp.ativa ? 'var(--color-success)' : 'var(--text-muted)' }}>
                          {opp.ativa ? '● AO VIVO' : '○ expirada'}
                        </span>
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

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <TrendingUp size={14} style={{ color: 'var(--color-primary)' }} />
                        {opp.confirming_sources?.join(', ')}
                      </span>
                      {opp.ativa && <CashoutTTL seconds={Math.max(opp.ttl_estimated_seconds ?? 0, 0)} />}
                    </div>

                    {/* Verificar: rebusca a odd atual da casa desregulada */}
                    <div style={{ borderTop: '1px solid var(--panel-border)', paddingTop: '10px' }}>
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
                              Agora: <strong style={{ color: '#fbbf24' }}>{v.oddAtual?.toFixed(2)}</strong>
                              {' '}(era {v.oddOriginal?.toFixed(2)}{v.direcao === 'subiu' ? ' ↑' : v.direcao === 'caiu' ? ' ↓' : ' =' })
                              {' · '}{v.ageSeconds != null ? `há ${v.ageSeconds}s` : 'ao vivo'}
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
                </div>
                <div className="form-group">
                  <label>Odd Casa 2 (O2)</label>
                  <input className="form-control" type="number" step="0.01" value={calcOdd2} onChange={(e) => setCalcOdd2(e.target.value)} />
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
                  <label>Banca Inicial (R$)</label>
                  <input className="form-control" type="number" value={projBancaInicial} onChange={(e) => setProjBancaInicial(e.target.value)} />
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
                        <th>Banca Inicial</th>
                        <th>Mão / Turno (50%)</th>
                        <th>Lucro T1</th>
                        <th>Lucro T2</th>
                        <th>Lucro T3</th>
                        <th>Lucro Diário</th>
                        <th>Banca Final</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mergedProjection.map(day => (
                        <tr key={day.dia}>
                          <td style={{ fontWeight: 'bold', color: day.isReal ? 'var(--color-success)' : 'var(--color-primary)' }}>{day.dia}</td>
                          <td>R$ {day.bancaInicial.toFixed(2)}</td>
                          <td>R$ {day.maoPorTurno.toFixed(2)}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno1.toFixed(2)}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno2.toFixed(2)}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>R$ {day.lucroTurno3.toFixed(2)}</td>
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
          <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)', minHeight: '480px' }}>
            <h3 className="card-title" style={{ marginBottom: '4px' }}>
              <Cpu size={18} style={{ color: 'var(--color-primary)' }} />
              Copiloto de Arbitragem (IA)
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Tire dúvidas sobre surebets, gestão de banca e regras das casas. As respostas são assistivas — a decisão e a aposta são sempre suas.
            </p>

            {/* Área de mensagens */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '6px' }}>
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
                  <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{
                      maxWidth: '78%',
                      padding: '10px 14px',
                      borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                      fontSize: '14px',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      background: m.role === 'user' ? 'linear-gradient(135deg, var(--color-primary), var(--color-accent))' : 'rgba(255,255,255,0.05)',
                      color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
                      border: m.role === 'user' ? 'none' : '1px solid var(--panel-border)'
                    }}>
                      {m.content}
                    </div>
                  </div>
                ))
              )}
              {chatLoading && (
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{ padding: '10px 14px', borderRadius: '14px 14px 14px 4px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--panel-border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                    Digitando…
                  </div>
                </div>
              )}
            </div>

            {/* Entrada */}
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
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
                  onClick={() => window.open(getHouseUrl(selectedOpp.casa_a_nome || ''), '_blank')}
                  title={`Abrir jogo na ${selectedOpp.casa_a_nome || 'Casa 1'}`}
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
                  onClick={() => window.open(getHouseUrl(selectedOpp.casa_b_nome || ''), '_blank')}
                  title={`Abrir jogo na ${selectedOpp.casa_b_nome || 'Casa 2'}`}
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
                              { casa: selectedOpp.casa_a_nome, opc: selectedOpp.opcao_a, old: selectedOpp.odd_casa_1, novo: revalResult.odd_a as number },
                              { casa: selectedOpp.casa_b_nome, opc: selectedOpp.opcao_b, old: selectedOpp.odd_casa_2, novo: revalResult.odd_b as number }
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
                                    onClick={() => window.open(getHouseUrl(leg.casa || ''), '_blank')}
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
    </div>
  );
}
