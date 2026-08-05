import { describe, it, expect, beforeEach } from 'vitest';
import { sureradarSync, parseHorarioSureRadar, StatusSureRadarObservado } from '../../src/core/sureradarSync';

/**
 * Sincronia com o SureRadar. O que estes testes protegem:
 *  - a cadência tem de sair do relógio DELES (`idade_seg`), não do nosso `Date.now()`;
 *  - varredura que falha (e pula um recálculo) não pode estragar a estimativa: o delta vem
 *    2× o período e precisa ser dobrado de volta, contando a atualização perdida;
 *  - o ajuste de fase tem de mover a varredura para DEPOIS do recálculo — e ficar quieto
 *    quando já está no alvo (sem banda morta, o scheduler corrige ±2s para sempre).
 */

const T0 = Date.UTC(2026, 7, 5, 12, 0, 0); // 05/08/2026 12:00:00Z
const CADENCIA = 600; // 10 min, o que o painel deles pratica
const ALVO = 45; // SURERADAR_ALVO_APOS_SEG (default)

/** Status como o scraper monta a partir do `status` da API deles. */
const status = (atualizadoEmMs: number, fimMs: number, extra: Partial<StatusSureRadarObservado> = {}): StatusSureRadarObservado => ({
  atualizadoEmMs,
  idadeSegDeles: (fimMs - atualizadoEmMs) / 1000,
  textoAtualizacao: new Date(atualizadoEmMs).toISOString(),
  totalDeles: 199,
  conectado: true,
  legIdadeMinSeg: 60,
  legIdadeMedianaSeg: 120,
  legIdadeMaxSeg: 300,
  eventoMaisAntigo: 'AC Horsens – Brøndby IF',
  ...extra,
});

/** Uma varredura nossa que terminou em `fimMs`, tendo visto o recálculo `atualizacaoMs`. */
const varrer = (fimMs: number, atualizacaoMs: number, importadas = 25) =>
  sureradarSync.registrarVarredura({
    inicioMs: fimMs - 20_000,
    fimMs,
    fonte: 'api',
    importadas,
    status: status(atualizacaoMs, fimMs),
  });

describe('parseHorarioSureRadar', () => {
  it('lê o formato do painel, com e sem o sufixo "(conta)"', () => {
    expect(parseHorarioSureRadar('2026-08-05 12:40:20 UTC')).toBe(Date.UTC(2026, 7, 5, 12, 40, 20));
    expect(parseHorarioSureRadar('2026-08-05 12:51:43 UTC (conta)')).toBe(Date.UTC(2026, 7, 5, 12, 51, 43));
  });

  it('devolve null para vazio/lixo (não epoch 0, que viraria "1970" e idade astronômica)', () => {
    expect(parseHorarioSureRadar('')).toBeNull();
    expect(parseHorarioSureRadar(null)).toBeNull();
    expect(parseHorarioSureRadar('agora mesmo')).toBeNull();
  });
});

describe('monitor de sincronia', () => {
  beforeEach(() => sureradarSync.resetar());

  it('mede a cadência deles pelo idade_seg e a defasagem da nossa captura', () => {
    // Eles recalculam a cada 600s; a gente varre 300s depois de cada recálculo.
    for (let k = 0; k < 5; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + 300_000, atualizacao);
    }
    const agora = T0 + 4 * CADENCIA * 1000 + 310_000;
    const s = sureradarSync.snapshot(agora);

    expect(s.deles.cadenciaSeg).toBe(CADENCIA);
    expect(s.deles.cadenciaConfiavel).toBe(true);
    expect(s.deles.cadenciaAmostras).toBe(4);
    expect(s.sincronia.defasagemUltimaSeg).toBe(300);
    expect(s.sincronia.defasagemMedianaSeg).toBe(300);
    expect(s.sincronia.atualizacoesPerdidas).toBe(0);
    // Capturamos 300s depois do recálculo: sobra pouco mais de metade do ciclo.
    expect(s.deles.vidaRestanteSeg).toBeCloseTo(290, 0);
    expect(s.sincronia.estado).toBe('desalinhado'); // 300s > alvo (45s) + 120s de tolerância
    expect(s.sincronia.recomendacao).toContain('depois do recálculo');
  });

  it('captura logo depois do recálculo = sincronizado', () => {
    for (let k = 0; k < 4; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + ALVO * 1000, atualizacao);
    }
    const s = sureradarSync.snapshot(T0 + 3 * CADENCIA * 1000 + ALVO * 1000 + 5_000);
    expect(s.sincronia.estado).toBe('sincronizado');
    expect(s.sincronia.defasagemMedianaSeg).toBe(ALVO);
    expect(s.sincronia.recomendacao).toBeNull();
  });

  it('varredura que pulou um ciclo: cadência segue 600s e conta a atualização perdida', () => {
    const ks = [0, 1, 3, 4, 5]; // o recálculo k=2 passou sem varredura nossa
    for (const k of ks) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + 60_000, atualizacao);
    }
    const s = sureradarSync.snapshot(T0 + 5 * CADENCIA * 1000 + 70_000);
    expect(s.deles.cadenciaSeg).toBe(CADENCIA); // o delta de 1200s foi dobrado de volta
    expect(s.deles.cadenciaConfiavel).toBe(true);
    expect(s.sincronia.atualizacoesPerdidas).toBe(1);
    expect(s.avisos.join(' ')).toContain('passaram sem varredura nossa');
  });

  it('recálculo já ocorrido e não capturado = desatualizado (o dado do banco venceu)', () => {
    for (let k = 0; k < 4; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + 60_000, atualizacao);
    }
    // 1,5 ciclo depois da última atualização vista, sem varredura nova no meio.
    const s = sureradarSync.snapshot(T0 + 3 * CADENCIA * 1000 + 900_000);
    expect(s.sincronia.atualizacoesPendentes).toBe(1);
    expect(s.sincronia.estado).toBe('desatualizado');
    expect(s.sincronia.recomendacao).toContain('Escanear Tudo');
  });

  it('ajuste de fase: adianta a varredura marcada para logo ANTES do recálculo deles', () => {
    for (let k = 0; k < 4; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + 570_000, atualizacao); // 30s ANTES do próximo recálculo
    }
    const ultimaAtualizacao = T0 + 3 * CADENCIA * 1000;
    // Varredura marcada para 30s antes do recálculo seguinte: o alvo é 45s DEPOIS dele.
    const alvoRuim = ultimaAtualizacao + CADENCIA * 1000 - 30_000;
    const ajuste = sureradarSync.ajusteDeFaseSeg(alvoRuim, 300);
    expect(ajuste).toBeGreaterThan(0); // atrasa para cair depois do recálculo
    expect(ajuste).toBeLessThanOrEqual(105); // teto de 35% do intervalo de 300s
  });

  it('ajuste de fase: zero quando já está no alvo (banda morta) e zero sem cadência confiável', () => {
    for (let k = 0; k < 4; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      varrer(atualizacao + ALVO * 1000, atualizacao);
    }
    const ultimaAtualizacao = T0 + 3 * CADENCIA * 1000;
    const alvoBom = ultimaAtualizacao + CADENCIA * 1000 + ALVO * 1000;
    expect(sureradarSync.ajusteDeFaseSeg(alvoBom, 300)).toBe(0);
    expect(sureradarSync.ajusteDeFaseSeg(alvoBom + 8_000, 300)).toBe(0); // 8s < banda morta

    sureradarSync.resetar();
    varrer(T0 + 60_000, T0); // 1 amostra: sem cadência, sem mexer na fase
    expect(sureradarSync.ajusteDeFaseSeg(T0 + 360_000, 300)).toBe(0);
    expect(sureradarSync.snapshot(T0 + 70_000).nosso.alinhamentoAtivo).toBe(false);
  });

  it('leitura sem status (cookies expirados) não inventa sincronia — e avisa', () => {
    sureradarSync.registrarVarredura({ inicioMs: T0, fimMs: T0 + 5_000, fonte: 'none', importadas: 0, status: null });
    const s = sureradarSync.snapshot(T0 + 10_000);
    expect(s.sincronia.estado).toBe('sem-dados');
    expect(s.deles.cadenciaSeg).toBeNull();
    expect(s.deles.vidaRestanteSeg).toBeNull();
    expect(s.avisos.join(' ')).toContain('não conseguiu ler o SureRadar');
  });

  it('linha muito mais velha que o painel vira aviso (painel fresco ≠ odd fresca)', () => {
    for (let k = 0; k < 4; k++) {
      const atualizacao = T0 + k * CADENCIA * 1000;
      const fim = atualizacao + 60_000;
      sureradarSync.registrarVarredura({
        inicioMs: fim - 20_000,
        fimMs: fim,
        fonte: 'api',
        importadas: 25,
        // Painel recalculado há 60s, mas a linha mais velha da lista tem 20 min.
        status: status(atualizacao, fim, { legIdadeMaxSeg: 1200, eventoMaisAntigo: 'Jogo rançoso FC' }),
      });
    }
    const s = sureradarSync.snapshot(T0 + 3 * CADENCIA * 1000 + 70_000);
    expect(s.dados.legIdadeMaxSeg).toBe(1200);
    expect(s.avisos.join(' ')).toContain('Nem toda linha é fresca');
    expect(s.avisos.join(' ')).toContain('Jogo rançoso FC');
  });

  it('painel "fresco" com as linhas velhas vira aviso (o carimbo do painel não é a odd)', () => {
    const fim = T0 + 60_000;
    sureradarSync.registrarVarredura({
      inicioMs: fim - 5_000,
      fimMs: fim,
      fonte: 'api',
      importadas: 31,
      // Caso real de 05/08: painel dizendo 59s, todas as 31 linhas com 204s.
      status: status(T0, fim, { legIdadeMinSeg: 204, legIdadeMedianaSeg: 204, legIdadeMaxSeg: 204 }),
    });
    const s = sureradarSync.snapshot(fim + 1_000);
    expect(s.dados.legIdadeMinSeg).toBe(204);
    expect(s.avisos.join(' ')).toContain('a idade que vale para as odds é a das linhas');
  });

  it('duas varreduras no MESMO ciclo deles não inflam a contagem de atualizações', () => {
    varrer(T0 + 60_000, T0);
    varrer(T0 + 360_000, T0); // ainda o mesmo recálculo
    const s = sureradarSync.snapshot(T0 + 370_000);
    expect(s.sincronia.ciclosObservados).toBe(2);
    expect(s.sincronia.atualizacoesObservadas).toBe(1);
    expect(s.deles.cadenciaAmostras).toBe(0);
  });
});
