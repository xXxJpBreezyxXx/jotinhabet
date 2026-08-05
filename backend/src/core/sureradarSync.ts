/**
 * Monitor de SINCRONIA com o SureRadar.
 *
 * O problema que ele resolve: o painel deles recalcula as surebets a cada ~10 min e a nossa
 * varredura roda a cada 5. Se a nossa cai pouco antes do recálculo deles, a oportunidade que
 * gravamos no banco (e que o usuário vai clicar) nasce com a vida quase toda gasta — já foi
 * substituída no site quando alguém abre o card. Não é erro de matemática, é erro de FASE.
 *
 * Duas coisas acontecem aqui:
 *  1. CONTAGEM/medição: quando eles atualizaram, de quanto em quanto tempo atualizam, quanto
 *     tempo depois disso a nossa varredura capturou, quantas atualizações deles passaram sem
 *     nenhuma varredura nossa no meio, e quanto de vida resta ao dado que está no banco.
 *  2. FASE: `ajusteDeFaseSeg()` diz ao scheduler quantos segundos adiantar/atrasar a próxima
 *     varredura para ela cair ALVO_APOS_SEG depois do recálculo deles. O intervalo médio não
 *     muda — só o instante dentro do ciclo.
 *
 * A fonte dos números é a própria API deles, que entrega o relógio de graça:
 *     status: { total, ultima_atualizacao: "2026-08-05 12:51:43 UTC (conta)",
 *               updated_ts: 1785934303.08, conectado, online, idade_seg: 235 }
 * e um `updated_at` POR SUREBET (que pode ser bem mais velho que o `ultima_atualizacao`
 * global: numa amostra de 05/08 a linha mais nova era de 12:40 com o painel marcando 12:51 —
 * ou seja, "painel fresco" não implica "odd fresca").
 *
 * DOIS RELÓGIOS: `updated_ts` é o relógio DELES; comparar com o nosso `Date.now()` embute o
 * desvio entre as máquinas. Por isso toda previsão/contagem usa a atualização convertida para
 * o NOSSO relógio (`fim da requisição − idade_seg`, ambos medidos deste lado), e o desvio fica
 * exposto em `relogioSkewSeg` só para diagnóstico.
 *
 * Estado em MEMÓRIA de propósito (sem tabela): é medição de fase, não histórico contábil.
 * Um restart zera a estimativa de CADÊNCIA: ela exige 3 intervalos, ou seja 4 recálculos deles
 * observados, e a ~10 min cada isso leva ~30 min. O estado do momento (quando eles atualizaram,
 * idade do dado, defasagem da captura) volta já na PRIMEIRA varredura, porque vem pronto na
 * resposta deles (`idade_seg`). Enquanto a cadência não fecha, `snapshot()` diz quantas amostras
 * tem e marca `cadenciaConfiavel: false` — a UI nunca finge confiança que não existe, e o
 * alinhamento de fase fica suspenso em vez de chutar.
 */

/** Quanto DEPOIS do recálculo deles queremos varrer (folga p/ o dado assentar no painel). */
const ALVO_APOS_SEG = Number(process.env.SURERADAR_ALVO_APOS_SEG || 45);
/** Alinhamento de fase do scheduler. 0/false desliga e volta ao intervalo fixo. */
const FASE_HABILITADA = !['0', 'false', 'no'].includes(String(process.env.SURERADAR_SYNC_FASE || '1').toLowerCase());
/** Só mexe na fase com cadência medida; abaixo disso o "alvo" seria chute. */
const MIN_AMOSTRAS_CADENCIA = 3;
/** Nudge sem histerese fica corrigindo ±2s para sempre. */
const DEADBAND_AJUSTE_SEG = 20;
/** Fração do intervalo que um único ciclo pode ser deslocado (converge em 2–3 ciclos). */
const FRACAO_MAX_AJUSTE = 0.35;
const MAX_OBSERVACOES = 60;
const MAX_ATUALIZACOES = 60;

export interface StatusSureRadarObservado {
  /** epoch ms da última atualização do painel, no relógio DELES (`updated_ts` × 1000). */
  atualizadoEmMs: number | null;
  /** Idade do dado em segundos que ELES reportam na resposta (`idade_seg`). */
  idadeSegDeles: number | null;
  /** `ultima_atualizacao` cru (auditoria: o texto traz sufixos como "(conta)"). */
  textoAtualizacao: string | null;
  /** `status.total` — quantas surebets o sistema deles diz ter no total. */
  totalDeles: number | null;
  conectado: boolean | null;
  /**
   * Idade (em s, no fechamento da resposta) do `updated_at` das surebets recebidas.
   *
   * `legIdadeMinSeg` é a idade da linha MAIS NOVA — a idade real das odds que importamos, e
   * não a do painel: numa amostra de 05/08 o painel se dizia atualizado há 59s enquanto TODAS
   * as 31 linhas tinham 204s. O relógio do painel serve para prever o próximo recálculo; a
   * idade das linhas é o que diz se a odd na tela ainda é a odd da casa.
   */
  legIdadeMinSeg: number | null;
  legIdadeMedianaSeg: number | null;
  legIdadeMaxSeg: number | null;
  /** Evento da surebet com `updated_at` mais velho — a odd mais rançosa que importamos. */
  eventoMaisAntigo: string | null;
}

interface Observacao {
  inicioMs: number;
  fimMs: number;
  /** Atualização deles convertida para o NOSSO relógio (fimMs − idade_seg). */
  atualizadoLocalMs: number | null;
  /** Quanto tempo de vida o dado já tinha quando terminamos de capturar (s). */
  defasagemSeg: number | null;
  importadas: number;
  fonte: 'api' | 'browser' | 'none';
  status: StatusSureRadarObservado | null;
}

export interface EntradaVarredura {
  inicioMs: number;
  fimMs: number;
  fonte: 'api' | 'browser' | 'none';
  /** Quantas surebets entraram na varredura (já filtradas pelas Diretrizes). */
  importadas: number;
  status: StatusSureRadarObservado | null;
}

const mediana = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentil = (v: number[], p: number): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * "2026-08-05 12:51:43 UTC (conta)" / "2026-08-05 12:40:20 UTC" → epoch ms.
 * O sufixo entre parênteses e o " UTC" solto quebram o parser em runtimes menos tolerantes
 * que o V8, então normaliza para ISO antes. Devolve null para qualquer coisa não-datável.
 */
export function parseHorarioSureRadar(bruto: any): number | null {
  if (typeof bruto !== 'string' || !bruto.trim()) return null;
  const iso = bruto
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .replace(' ', 'T')
    .replace(/\s*(UTC|GMT)$/i, 'Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface SnapshotSincronia {
  /**
   * Instante em que o snapshot foi montado, no relógio do SERVIDOR. O painel usa para medir o
   * próprio desvio de relógio e fazer os countdowns na base de tempo do backend — sem isso um
   * navegador atrasado 2 min mostraria "vida restante" negativa com tudo em ordem.
   */
  geradoEm: string;
  deles: {
    ultimaAtualizacao: string | null;
    /** Idade do dado que está no nosso banco, AGORA (s). */
    idadeSeg: number | null;
    cadenciaSeg: number | null;
    cadenciaConfiavel: boolean;
    cadenciaAmostras: number;
    cadenciaDispersaoSeg: number | null;
    proximaAtualizacaoPrevista: string | null;
    /** Vida restante do dado atual: segundos até o próximo recálculo deles. */
    vidaRestanteSeg: number | null;
    total: number | null;
    conectado: boolean | null;
    relogioSkewSeg: number | null;
    textoAtualizacao: string | null;
  };
  nosso: {
    ultimaVarredura: string | null;
    /** Quanto tempo a última varredura levou (s). */
    duracaoUltimaSeg: number | null;
    intervaloSeg: number | null;
    proximaVarredura: string | null;
    segundosParaProxima: number | null;
    ajusteFaseSeg: number | null;
    alinhamentoAtivo: boolean;
    importadasUltima: number | null;
    fonteUltima: 'api' | 'browser' | 'none' | null;
  };
  sincronia: {
    estado: 'sincronizado' | 'desalinhado' | 'desatualizado' | 'sem-dados';
    alvoSeg: number;
    /** Defasagem da última captura: idade do dado quando terminamos de gravar (s). */
    defasagemUltimaSeg: number | null;
    defasagemMedianaSeg: number | null;
    /** Atualizações deles que passaram sem nenhuma varredura nossa no meio. */
    atualizacoesPerdidas: number;
    /** Recálculos deles já ocorridos e ainda não capturados (dado no banco vencido). */
    atualizacoesPendentes: number;
    ciclosObservados: number;
    atualizacoesObservadas: number;
    recomendacao: string | null;
  };
  dados: {
    /** Idade da linha mais nova: a idade REAL das odds importadas (≠ idade do painel). */
    legIdadeMinSeg: number | null;
    legIdadeMedianaSeg: number | null;
    legIdadeMaxSeg: number | null;
    eventoMaisAntigo: string | null;
  };
  avisos: string[];
}

class SureRadarSyncMonitor {
  private obs: Observacao[] = [];
  /** Atualizações DISTINTAS deles, no nosso relógio, em ordem — base da cadência. */
  private atualizacoes: number[] = [];
  private agenda: { proximaMs: number; intervaloSeg: number; ajusteSeg: number } | null = null;

  /** Chamado pelo scanner ao fim de cada varredura (agendada ou manual). */
  registrarVarredura(e: EntradaVarredura): void {
    const st = e.status;
    // Atualização no NOSSO relógio. `idade_seg` é medida por eles no instante da resposta,
    // então "fim da requisição − idade" fica na nossa base de tempo sem depender do skew.
    // Sem `idade_seg`, cai no `updated_ts` cru (aí o skew entra, e é por isso que ele é medido).
    const atualizadoLocalMs =
      st?.idadeSegDeles != null && Number.isFinite(st.idadeSegDeles)
        ? e.fimMs - st.idadeSegDeles * 1000
        : st?.atualizadoEmMs ?? null;
    const defasagemSeg = atualizadoLocalMs != null ? Math.max(0, (e.fimMs - atualizadoLocalMs) / 1000) : null;

    this.obs.push({
      inicioMs: e.inicioMs,
      fimMs: e.fimMs,
      atualizadoLocalMs,
      defasagemSeg,
      importadas: e.importadas,
      fonte: e.fonte,
      status: st,
    });
    if (this.obs.length > MAX_OBSERVACOES) this.obs.splice(0, this.obs.length - MAX_OBSERVACOES);

    // Duas varreduras dentro do mesmo ciclo deles veem a MESMA atualização: só conta quando
    // o instante muda de verdade (tolerância de 5s absorve o jitter do `idade_seg` inteiro).
    if (atualizadoLocalMs != null) {
      const ultima = this.atualizacoes[this.atualizacoes.length - 1];
      if (ultima == null || Math.abs(atualizadoLocalMs - ultima) > 5000) {
        this.atualizacoes.push(atualizadoLocalMs);
        if (this.atualizacoes.length > MAX_ATUALIZACOES) this.atualizacoes.splice(0, this.atualizacoes.length - MAX_ATUALIZACOES);
      } else {
        // Mesma atualização revista: guarda o instante mais preciso (menor idade medida).
        this.atualizacoes[this.atualizacoes.length - 1] = Math.max(ultima, atualizadoLocalMs);
      }
    }
  }

  /** Chamado pelo scheduler a cada reagendamento, para a UI ter o countdown do NOSSO lado. */
  registrarAgendamento(a: { proximaMs: number; intervaloSeg: number; ajusteSeg: number }): void {
    this.agenda = a;
  }

  /**
   * Cadência deles, em segundos.
   *
   * Varredura nossa que falha (ou SureRadar fora) faz PULAR um recálculo, e aí o delta
   * observado vem 2× (ou 3×) o período real. Por isso cada delta é dividido pelo número
   * inteiro de períodos que ele contém, usando o percentil 25 como base — a mediana crua
   * viraria 900s num histórico meio-a-meio de 600 e 1200.
   */
  private cadencia(): { seg: number | null; amostras: number; dispersao: number | null; confiavel: boolean; deltas: number[] } {
    const deltas: number[] = [];
    for (let i = 1; i < this.atualizacoes.length; i++) {
      const d = (this.atualizacoes[i] - this.atualizacoes[i - 1]) / 1000;
      if (d >= 30) deltas.push(d);
    }
    if (!deltas.length) return { seg: null, amostras: 0, dispersao: null, confiavel: false, deltas };
    const base = percentil(deltas, 0.25) as number;
    const normalizados = deltas.map((d) => d / Math.max(1, Math.round(d / base)));
    const seg = mediana(normalizados);
    const dispersao = seg == null ? null : Math.max(...normalizados) - Math.min(...normalizados);
    const confiavel =
      seg != null &&
      deltas.length >= MIN_AMOSTRAS_CADENCIA &&
      seg >= 60 &&
      seg <= 3600 &&
      dispersao != null &&
      dispersao <= Math.max(45, seg * 0.25);
    return { seg: seg == null ? null : r1(seg), amostras: deltas.length, dispersao: dispersao == null ? null : r1(dispersao), confiavel, deltas };
  }

  /** Última atualização deles no nosso relógio (a mais recente que chegamos a ver). */
  private ultimaAtualizacaoLocal(): number | null {
    return this.atualizacoes.length ? this.atualizacoes[this.atualizacoes.length - 1] : null;
  }

  /** Próximo recálculo previsto (nosso relógio), rolando o grid até passar de `agoraMs`. */
  private proximaAtualizacaoMs(agoraMs: number): number | null {
    const cad = this.cadencia();
    const ult = this.ultimaAtualizacaoLocal();
    if (!cad.seg || ult == null) return null;
    const passo = cad.seg * 1000;
    let prox = ult + passo;
    // Um `while` sem teto viraria laço infinito se a cadência viesse absurda (dado corrompido).
    for (let i = 0; prox <= agoraMs && i < 10_000; i++) prox += passo;
    return prox;
  }

  /**
   * Quantos segundos deslocar a varredura marcada para `alvoProximoMs` para ela cair
   * ALVO_APOS_SEG depois de um recálculo deles. Devolve 0 quando não há o que fazer
   * (desligado, cadência ainda sem confiança, ou já dentro da banda morta).
   */
  ajusteDeFaseSeg(alvoProximoMs: number, intervaloSeg: number): number {
    if (!FASE_HABILITADA) return 0;
    const cad = this.cadencia();
    const ult = this.ultimaAtualizacaoLocal();
    if (!cad.confiavel || !cad.seg || ult == null) return 0;

    const passo = cad.seg * 1000;
    const alvoIdealBase = ult + ALVO_APOS_SEG * 1000;
    // Instante ideal mais PRÓXIMO do horário já marcado: alinhar pela fase, não empurrar a
    // varredura para o próximo ciclo deles (isso reduziria a nossa taxa de varredura).
    const k = Math.round((alvoProximoMs - alvoIdealBase) / passo);
    const ideal = alvoIdealBase + k * passo;

    const bruto = (ideal - alvoProximoMs) / 1000;
    if (Math.abs(bruto) < DEADBAND_AJUSTE_SEG) return 0;
    const limite = Math.max(30, intervaloSeg * FRACAO_MAX_AJUSTE);
    return r1(Math.max(-limite, Math.min(limite, bruto)));
  }

  snapshot(agoraMs = Date.now()): SnapshotSincronia {
    const cad = this.cadencia();
    const ultAtual = this.ultimaAtualizacaoLocal();
    const ultima = this.obs.length ? this.obs[this.obs.length - 1] : null;
    const comStatus = [...this.obs].reverse().find((o) => o.status != null) || null;
    const st = comStatus?.status || null;
    const proxAtual = this.proximaAtualizacaoMs(agoraMs);
    const idadeSeg = ultAtual != null ? (agoraMs - ultAtual) / 1000 : null;
    const defasagens = this.obs.map((o) => o.defasagemSeg).filter((d): d is number => d != null);
    const avisos: string[] = [];

    // Atualizações deles que ocorreram entre duas varreduras nossas consecutivas e nunca
    // foram vistas: cada delta que contém N períodos deixou N−1 recálculos passar em branco.
    let perdidas = 0;
    if (cad.seg) {
      for (const d of cad.deltas) perdidas += Math.max(0, Math.round(d / cad.seg) - 1);
    }
    // Recálculos já ocorridos e ainda não capturados: o que está no banco está vencido.
    const pendentes = cad.seg && idadeSeg != null ? Math.max(0, Math.floor(idadeSeg / cad.seg)) : 0;

    let estado: SnapshotSincronia['sincronia']['estado'] = 'sem-dados';
    let recomendacao: string | null = null;
    const defasagemMediana = mediana(defasagens);
    if (ultAtual == null || !this.obs.length) {
      estado = 'sem-dados';
    } else if (pendentes >= 1) {
      estado = 'desatualizado';
    } else if (defasagemMediana != null && defasagemMediana <= ALVO_APOS_SEG + 120) {
      estado = 'sincronizado';
    } else {
      estado = 'desalinhado';
    }

    const ajusteAgora =
      this.agenda != null ? this.ajusteDeFaseSeg(this.agenda.proximaMs, this.agenda.intervaloSeg) : 0;
    if (estado === 'desalinhado' && defasagemMediana != null) {
      recomendacao =
        `A varredura cai ~${Math.round(defasagemMediana)}s depois do recálculo do SureRadar (alvo: ${ALVO_APOS_SEG}s). ` +
        (FASE_HABILITADA
          ? cad.confiavel
            ? `O alinhamento automático já está corrigindo a fase (${ajusteAgora >= 0 ? '+' : ''}${ajusteAgora}s no próximo ciclo).`
            : `O alinhamento automático espera cadência medida (${cad.amostras}/${MIN_AMOSTRAS_CADENCIA} amostras).`
          : 'Alinhamento automático DESLIGADO (SURERADAR_SYNC_FASE=0).');
    } else if (estado === 'desatualizado') {
      recomendacao =
        `O SureRadar já recalculou ${pendentes}× desde a nossa última captura — as odds no painel podem estar vencidas. ` +
        'Rode "Escanear Tudo" antes de operar.';
    }

    if (ultima?.fonte === 'none') {
      avisos.push('A última varredura não conseguiu ler o SureRadar (cookies expirados ou site fora): a sincronia está cega.');
    } else if (ultima?.fonte === 'browser') {
      avisos.push('Última leitura via fallback de browser: lista parcial (não enxerga as VIP) e sem o relógio do painel.');
    }
    if (st?.conectado === false) avisos.push('O painel do SureRadar reporta o coletor DESCONECTADO — o dado pode estar congelado do lado deles.');
    if (cad.seg != null && !cad.confiavel) {
      avisos.push(`Cadência ainda sem confiança (${cad.amostras} amostra(s), dispersão ${cad.dispersao ?? '?'}s): previsões e alinhamento ficam suspensos.`);
    }
    if (st?.legIdadeMaxSeg != null && cad.seg != null && st.legIdadeMaxSeg > cad.seg * 1.5) {
      avisos.push(
        `Nem toda linha é fresca: a mais velha da última leitura tinha ${Math.round(st.legIdadeMaxSeg / 60)} min ` +
          `(${st.eventoMaisAntigo || 'evento sem nome'}) — o painel atualiza, mas cada surebet tem o seu próprio horário.`
      );
    }
    // O painel pode se dizer fresco com as odds velhas: "ultima_atualizacao (conta)" é o
    // carimbo do painel, e as linhas têm o seu próprio `updated_at`. Divergência grande
    // significa que a idade a olhar é a das linhas, não a do painel.
    if (st?.legIdadeMinSeg != null && st.idadeSegDeles != null && st.legIdadeMinSeg > st.idadeSegDeles + 90) {
      avisos.push(
        `O painel se diz atualizado há ${Math.round(st.idadeSegDeles)}s, mas a linha MAIS NOVA da leitura tem ` +
          `${Math.round(st.legIdadeMinSeg)}s: a idade que vale para as odds é a das linhas.`
      );
    }
    if (perdidas > 0) {
      avisos.push(`${perdidas} atualização(ões) do SureRadar passaram sem varredura nossa no meio (varredura falhou ou o site ficou fora).`);
    }

    return {
      geradoEm: new Date(agoraMs).toISOString(),
      deles: {
        ultimaAtualizacao: ultAtual != null ? new Date(ultAtual).toISOString() : null,
        idadeSeg: idadeSeg != null ? r1(idadeSeg) : null,
        cadenciaSeg: cad.seg,
        cadenciaConfiavel: cad.confiavel,
        cadenciaAmostras: cad.amostras,
        cadenciaDispersaoSeg: cad.dispersao,
        proximaAtualizacaoPrevista: proxAtual != null ? new Date(proxAtual).toISOString() : null,
        vidaRestanteSeg: proxAtual != null ? r1((proxAtual - agoraMs) / 1000) : null,
        total: st?.totalDeles ?? null,
        conectado: st?.conectado ?? null,
        // Skew = quanto o relógio deles está adiantado em relação ao nosso, medido pela
        // diferença entre `updated_ts` (base deles) e a mesma atualização na nossa base.
        relogioSkewSeg:
          st?.atualizadoEmMs != null && comStatus?.atualizadoLocalMs != null
            ? r1((st.atualizadoEmMs - comStatus.atualizadoLocalMs) / 1000)
            : null,
        textoAtualizacao: st?.textoAtualizacao ?? null,
      },
      nosso: {
        ultimaVarredura: ultima ? new Date(ultima.fimMs).toISOString() : null,
        duracaoUltimaSeg: ultima ? r1((ultima.fimMs - ultima.inicioMs) / 1000) : null,
        intervaloSeg: this.agenda?.intervaloSeg ?? null,
        proximaVarredura: this.agenda ? new Date(this.agenda.proximaMs).toISOString() : null,
        segundosParaProxima: this.agenda ? r1((this.agenda.proximaMs - agoraMs) / 1000) : null,
        ajusteFaseSeg: this.agenda?.ajusteSeg ?? null,
        alinhamentoAtivo: FASE_HABILITADA && cad.confiavel,
        importadasUltima: ultima?.importadas ?? null,
        fonteUltima: ultima?.fonte ?? null,
      },
      sincronia: {
        estado,
        alvoSeg: ALVO_APOS_SEG,
        defasagemUltimaSeg: ultima?.defasagemSeg != null ? r1(ultima.defasagemSeg) : null,
        defasagemMedianaSeg: defasagemMediana != null ? r1(defasagemMediana) : null,
        atualizacoesPerdidas: perdidas,
        atualizacoesPendentes: pendentes,
        ciclosObservados: this.obs.length,
        atualizacoesObservadas: this.atualizacoes.length,
        recomendacao,
      },
      dados: {
        legIdadeMinSeg: st?.legIdadeMinSeg ?? null,
        legIdadeMedianaSeg: st?.legIdadeMedianaSeg ?? null,
        legIdadeMaxSeg: st?.legIdadeMaxSeg ?? null,
        eventoMaisAntigo: st?.eventoMaisAntigo ?? null,
      },
      avisos,
    };
  }

  /** Só para teste: devolve o monitor a um estado limpo. */
  resetar(): void {
    this.obs = [];
    this.atualizacoes = [];
    this.agenda = null;
  }
}

/** Instância única — scanner escreve, scheduler consulta, endpoint lê. */
export const sureradarSync = new SureRadarSyncMonitor();
export const SYNC_ALVO_APOS_SEG = ALVO_APOS_SEG;
export const SYNC_FASE_HABILITADA = FASE_HABILITADA;
