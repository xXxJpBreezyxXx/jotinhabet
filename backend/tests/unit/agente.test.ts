import { describe, it, expect } from 'vitest';
import { compararOfertas } from '../../src/IA/agent/comparadorOdds';
import { catalogoCasas, acharCasa, resumoCasasParaPrompt } from '../../src/IA/agent/catalogoCasas';
import { SKILLS, acharSkill, ferramentasParaModelo, skillsParaUI } from '../../src/IA/agent/registry';
import { buscarConhecimento, obterConhecimento, listarConhecimento } from '../../src/IA/conhecimento';
import { pediuEscritaExplicita } from '../../src/IA/agent/agentLoop';
import { agruparPorJogo, cruzarFeeds, ehAoVivo, filtrarSituacao, lerSituacao, normalizarEsporte, resumirJogo, resumirSurebet } from '../../src/IA/agent/varredura';
import { acharSkill as buscarSkill } from '../../src/IA/agent/registry';
import { casasComScraper } from '../../src/core/revalidationService';
import { ScrapedOdd } from '../../src/scraping/scraper_base';

const odd = (o: Partial<ScrapedOdd>): ScrapedOdd => ({
  esporte: 'Futebol',
  evento: 'Time A vs Time B',
  dataHora: '2026-07-31T20:00:00Z',
  mercado: 'Total de gols',
  linha: 2.5,
  opcaoA: 'Mais de 2.5',
  opcaoB: 'Menos de 2.5',
  oddA: 2,
  oddB: 2,
  ...o,
});

describe('comparadorOdds', () => {
  it('cruza o mesmo mercado entre casas e acha a melhor odd de cada lado', () => {
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ oddA: 2.1, oddB: 1.75 })] },
      { nome: 'Superbet', odds: [odd({ oddA: 1.9, oddB: 2.05 })] },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].melhorA).toEqual({ casa: 'KTO', odd: 2.1 });
    expect(r[0].melhorB).toEqual({ casa: 'Superbet', odd: 2.05 });
    expect(r[0].somaProb).toBeCloseTo(1 / 2.1 + 1 / 2.05, 4);
    expect(r[0].roiPct).not.toBeNull();
    expect(r[0].roiPct!).toBeGreaterThan(0);
  });

  it('quando não fecha, informa quanto falta em vez de ROI', () => {
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ oddA: 1.8, oddB: 1.7 })] },
      { nome: 'BetBoom', odds: [odd({ oddA: 1.75, oddB: 1.85 })] },
    ]);
    expect(r[0].roiPct).toBeNull();
    expect(r[0].faltaPct!).toBeGreaterThan(0);
  });

  it('alinha lados invertidos entre casas (opcaoA de uma = opcaoB da outra)', () => {
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ opcaoA: 'Mais de 2.5', opcaoB: 'Menos de 2.5', oddA: 2.2, oddB: 1.7 })] },
      { nome: 'Vbet', odds: [odd({ opcaoA: 'Menos de 2.5', opcaoB: 'Mais de 2.5', oddA: 2.0, oddB: 1.75 })] },
    ]);
    expect(r).toHaveLength(1);
    // O lado "Mais de 2.5" da Vbet é o oddB dela (1.75) — o alinhamento tem que enxergar isso.
    const vbet = r[0].casas.find((c) => c.casa === 'Vbet')!;
    expect(vbet.oddA).toBeCloseTo(1.75, 2);
    expect(vbet.oddB).toBeCloseTo(2.0, 2);
  });

  it('NÃO cruza handicap espelhado (mesmo |linha|, âncora no time oposto)', () => {
    // Caso real que fabricou 2 alertas falsos no WhatsApp: Phantom(-1.5)/K27(+1.5) numa
    // casa e K27(-1.5)/Phantom(+1.5) na outra — |linha| e times iguais, oferta espelhada.
    const a = odd({
      evento: 'Phantom vs K27', mercado: 'Handicap Asiático', linha: -1.5,
      opcaoA: 'Phantom (-1.5)', opcaoB: 'K27 (+1.5)', oddA: 2.0, oddB: 1.9,
    });
    const espelhado = odd({
      evento: 'Phantom vs K27', mercado: 'Handicap Asiático', linha: -1.5,
      opcaoA: 'K27 (-1.5)', opcaoB: 'Phantom (+1.5)', oddA: 2.0, oddB: 1.9,
    });
    const r = compararOfertas([
      { nome: 'KTO', odds: [a] },
      { nome: 'Superbet', odds: [espelhado] },
    ]);
    // Dois clusters distintos (nenhum par fabricado) — o bug que gerava ROI fantasma.
    expect(r).toHaveLength(2);
    for (const m of r) expect(m.casas).toHaveLength(1);
  });

  it('linha quarter usa o PISO do lucro (metade do nominal)', () => {
    const quarter = (o: Partial<ScrapedOdd>) =>
      odd({ mercado: 'Handicap Asiático', linha: -1.25, opcaoA: 'Time A (-1.25)', opcaoB: 'Time B (+1.25)', ...o });
    const meia = (o: Partial<ScrapedOdd>) =>
      odd({ mercado: 'Handicap Asiático', linha: -1.5, opcaoA: 'Time A (-1.5)', opcaoB: 'Time B (+1.5)', ...o });
    const rq = compararOfertas([
      { nome: 'KTO', odds: [quarter({ oddA: 2.2, oddB: 1.7 })] },
      { nome: 'Superbet', odds: [quarter({ oddA: 1.9, oddB: 2.1 })] },
    ]);
    const rm = compararOfertas([
      { nome: 'KTO', odds: [meia({ oddA: 2.2, oddB: 1.7 })] },
      { nome: 'Superbet', odds: [meia({ oddA: 1.9, oddB: 2.1 })] },
    ]);
    expect(rq[0].quarter).toBe(true);
    expect(rm[0].quarter).toBe(false);
    expect(rq[0].roiPct!).toBeCloseTo(rm[0].roiPct! / 2, 2);
  });

  it('desconta comissão de exchange na odd efetiva', () => {
    const r = compararOfertas([
      { nome: 'Bolsa de Aposta', odds: [odd({ oddA: 2.1, oddB: 1.8 })] },
      { nome: 'KTO', odds: [odd({ oddA: 1.9, oddB: 2.05 })] },
    ]);
    const bolsa = r[0].casas.find((c) => c.casa === 'Bolsa de Aposta')!;
    expect(bolsa.oddA).toBeCloseTo(2.1, 2);
    expect(bolsa.oddAEfetiva).toBeLessThan(2.1);
  });

  it('uma casa só não vira surebet (arbitragem exige duas casas)', () => {
    const r = compararOfertas([{ nome: 'KTO', odds: [odd({ oddA: 2.2, oddB: 2.2 })] }]);
    expect(r[0].umaCasaSo).toBe(true);
    expect(r[0].roiPct).toBeNull();
    // Não pode sugerir "falta X%" nem prometer ROI: as duas pernas são da mesma casa.
    expect(r[0].faltaPct).toBeNull();
  });

  it('NÃO cruza jogos diferentes com o mesmo mercado (trava de evento e horário)', () => {
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ evento: 'Flamengo vs Palmeiras', oddA: 2.2, oddB: 1.7 })] },
      { nome: 'Superbet', odds: [odd({ evento: 'Corinthians vs Santos', oddA: 2.3, oddB: 2.3 })] },
    ]);
    expect(r).toHaveLength(2);
    for (const m of r) expect(m.umaCasaSo).toBe(true);
  });

  it('NÃO cruza o MESMO confronto em datas diferentes', () => {
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ dataHora: '2026-07-31T20:00:00Z', oddA: 2.2, oddB: 1.7 })] },
      { nome: 'Superbet', odds: [odd({ dataHora: '2026-08-07T20:00:00Z', oddA: 2.3, oddB: 2.3 })] },
    ]);
    expect(r).toHaveLength(2);
  });

  it('NÃO mistura os dois recortes 2-vias do 1X2 (irmão não-complementar)', () => {
    // Os parsers emitem "Casa vence"/"Fora ou empate" E "Fora vence"/"Casa ou empate"
    // sob o MESMO mercado canônico — cruzá-los publica a odd de um lado como do outro.
    const recorteCasa = odd({
      evento: 'Flamengo vs Palmeiras', mercado: 'Resultado Final', linha: undefined,
      opcaoA: 'Flamengo vence', opcaoB: 'Palmeiras ou empate', oddA: 2.1, oddB: 1.8,
    });
    const recorteFora = odd({
      evento: 'Flamengo vs Palmeiras', mercado: 'Resultado Final', linha: undefined,
      opcaoA: 'Palmeiras vence', opcaoB: 'Flamengo ou empate', oddA: 3.4, oddB: 1.35,
    });
    const r = compararOfertas([
      { nome: 'KTO', odds: [recorteCasa, recorteFora] },
      { nome: 'Superbet', odds: [recorteCasa, recorteFora] },
    ]);
    // Dois clusters (um por recorte), cada um com as DUAS casas — e nenhum par cruzado.
    expect(r).toHaveLength(2);
    for (const m of r) {
      expect(m.casas).toHaveLength(2);
      expect(m.opcaoA.toLowerCase()).toContain('vence');
    }
  });


  it('rótulos REAIS do 1X2 (Vitória X / X ou Empate) não se misturam entre recortes', () => {
    // Rótulos exatamente como os scrapers emitem (casa_a.ts, casa_blaze.ts, casa_1xbet.ts).
    // areTeamsSame('Vitória Vasco','Vitória Flamengo') é TRUE (0,88 por causa do "Vitória"),
    // então comparar o rótulo cheio publicava a odd do Vasco como odd do Flamengo.
    const base = { esporte: 'Futebol', evento: 'Vasco vs Flamengo', dataHora: 'Hoje', mercado: 'Resultado Final' };
    const recorte1 = (oddA: number, oddB: number): ScrapedOdd =>
      ({ ...base, opcaoA: 'Vitória Vasco', opcaoB: 'Flamengo ou Empate', oddA, oddB });
    const recorte2 = (oddA: number, oddB: number): ScrapedOdd =>
      ({ ...base, opcaoA: 'Vitória Flamengo', opcaoB: 'Vasco ou Empate', oddA, oddB });
    const r = compararOfertas([
      { nome: 'Betano', odds: [recorte1(3.2, 1.45), recorte2(2.1, 1.75)] },
      { nome: 'Blaze', odds: [recorte1(3.0, 1.5), recorte2(2.2, 1.7)] },
    ]);
    expect(r).toHaveLength(2);
    for (const m of r) {
      expect(m.casas).toHaveLength(2);
      const esperados = m.opcaoA === 'Vitória Vasco' ? [3.2, 3.0] : [2.1, 2.2];
      for (const c of m.casas) expect(esperados).toContain(c.oddA);
    }
  });

  it('DNB com times em ordem trocada entre casas CONTINUA cruzando', () => {
    const dnb = (t1: string, t2: string, oddA: number, oddB: number): ScrapedOdd =>
      odd({ evento: 'Vasco vs Flamengo', mercado: 'Empate Anula', linha: undefined, opcaoA: t1, opcaoB: t2, oddA, oddB });
    const r = compararOfertas([
      { nome: 'KTO', odds: [dnb('Vasco', 'Flamengo', 2.3, 1.6)] },
      { nome: 'Superbet', odds: [dnb('Flamengo', 'Vasco', 1.65, 2.25)] },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].casas).toHaveLength(2);
    // A odd do Vasco na Superbet é o oddB dela (2.25) — o alinhamento tem que trocar.
    expect(r[0].casas.find((c) => c.casa === 'Superbet')!.oddA).toBeCloseTo(2.25, 2);
  });

  it('acha o MELHOR PAR entre casas, não o guloso (casa que lidera os dois lados)', () => {
    // KTO tem a maior odd dos dois lados; o par ótimo é Superbet(A) × KTO(B).
    const r = compararOfertas([
      { nome: 'KTO', odds: [odd({ oddA: 3.0, oddB: 2.5 })] },
      { nome: 'Superbet', odds: [odd({ oddA: 2.0, oddB: 1.2 })] },
    ]);
    expect(r[0].umaCasaSo).toBe(false);
    // guloso: A=KTO 3.0 × B=Superbet 1.2 → soma 1.1667 (não fecha)
    // ótimo:  A=KTO 3.0 × B=KTO? não (mesma casa) → Superbet 2.0 × KTO 2.5 = 0.9 (fecha)
    expect(r[0].somaProb).toBeCloseTo(0.9, 3);
    expect(r[0].roiPct).toBeCloseTo(10, 2); // base do motor: (1 − soma)·100
    expect(r[0].lucroSobreInvestidoPct).toBeCloseTo(11.11, 1); // base do calculator
  });

  it('marca bloqueio das Diretrizes (1X2 de futebol é proibido)', () => {
    const rf = odd({ mercado: 'Resultado Final', linha: undefined, opcaoA: 'Time A', opcaoB: 'Time B', oddA: 2.2, oddB: 2.2 });
    const r = compararOfertas([
      { nome: 'KTO', odds: [rf] },
      { nome: 'Superbet', odds: [rf] },
    ]);
    expect(r[0].bloqueio).toMatch(/bloqueado/i);
  });

  it('filtra por mercado quando pedido', () => {
    const fontes = [
      { nome: 'KTO', odds: [odd({}), odd({ mercado: 'Ambas equipes marcam', linha: undefined, opcaoA: 'Sim', opcaoB: 'Não' })] },
      { nome: 'Vbet', odds: [odd({}), odd({ mercado: 'Ambas equipes marcam', linha: undefined, opcaoA: 'Sim', opcaoB: 'Não' })] },
    ];
    expect(compararOfertas(fontes)).toHaveLength(2);
    expect(compararOfertas(fontes, 'Ambas')).toHaveLength(1);
    expect(compararOfertas(fontes, 'Ambas')[0].mercado).toMatch(/Ambas/);
  });
});

describe('catálogo de casas', () => {
  it('cobre TODAS as casas com busca dirigida (nada some por esquecimento)', () => {
    const chaves = catalogoCasas().map((c) => c.chave).sort();
    expect(chaves).toEqual(casasComScraper().sort());
  });

  it('marca fonte do scanner, grupo de W.O. e limitações conhecidas', () => {
    const kto = acharCasa('KTO (BR)')!;
    expect(kto.chave).toBe('kto');
    expect(kto.grupo_wo_tenis).toBe('B');
    expect(kto.fonte_scanner).toBe(true);
    expect(kto.limitacoes).toMatch(/Handicap e Totais de tênis/i);

    const betano = acharCasa('Betano')!;
    expect(betano.grupo_wo_tenis).toBe('A');
    expect(betano.transporte).toBe('browser');

    // Casas não classificadas no tênis ficam com null (tênis bloqueado por fail-safe).
    expect(acharCasa('Brazino777')!.grupo_wo_tenis).toBeNull();
  });

  it('resolve aliases e nomes com sufixo (BR)', () => {
    expect(acharCasa('SuperBet (BR)')!.chave).toBe('superbet');
    expect(acharCasa('esporte da sorte')?.chave ?? acharCasa('EsportesDaSorte')!.chave).toBe('esportesdasorte');
    expect(acharCasa('CasaQueNaoExiste')).toBeNull();
  });

  it('resumo do prompt é compacto e sem flag ambígua (cota de tokens/minuto da Groq)', () => {
    const resumo = resumoCasasParaPrompt();
    expect(resumo.length).toBeLessThan(3200);
    expect(resumo).toMatch(/CASAS INTEGRADAS: \d+/);
    // Contagem tem que vir PRONTA (o modelo erra ao contar flags numa linha densa).
    expect(resumo).toMatch(/odd AO VIVO \(in-play\): .*KTO/);
    expect(resumo).toMatch(/exigem browser/);
    expect(resumo).toMatch(/t[êe]nis BLOQUEADO/);
    expect(resumo).toContain('KTO[kto |');
    // "browser" e o grupo de W.O. "B" não podem se confundir (antes era "SVB").
    expect(resumo).toContain('wo:B');
    expect(resumo).toMatch(/1xbet\[1xbet \| scan browser wo:B\]/);
  });

  it('fonte_scanner é a INTERSEÇÃO real (casa só de revalidação não é fonte)', () => {
    const porChave = new Map(catalogoCasas().map((c) => [c.chave, c]));
    // Estão na allowlist da varredura, mas NÃO são instanciadas no scanner.
    expect(porChave.get('betpix365')!.fonte_scanner).toBe(false);
    expect(porChave.get('mcgames')!.fonte_scanner).toBe(false);
    expect(porChave.get('stake')!.fonte_scanner).toBe(false);
    // Fontes de verdade seguem marcadas.
    expect(porChave.get('kto')!.fonte_scanner).toBe(true);
    expect(porChave.get('betano')!.fonte_scanner).toBe(true);
  });

  it('casa com grupo de W.O. desconhecido ganha limitação explícita de tênis', () => {
    const brazino = acharCasa('Brazino777')!;
    expect(brazino.grupo_wo_tenis).toBeNull();
    expect(brazino.esportes.join(' ')).toMatch(/T[êe]nis/);
    expect(brazino.limitacoes).toMatch(/t[êe]nis BLOQUEADAS|BLOQUEAD/i);
  });
});

describe('registro de skills', () => {
  it('nomes únicos e schema válido em todas', () => {
    const nomes = SKILLS.map((s) => s.nome);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const s of SKILLS) {
      expect(s.parametros.type).toBe('object');
      expect(typeof s.descricao).toBe('string');
      expect(s.descricao.length).toBeGreaterThan(30);
      for (const obrig of s.parametros.required || []) {
        expect(Object.keys(s.parametros.properties)).toContain(obrig);
      }
    }
  });

  it('tem as skills de scraper/odds, cálculo de promoção e conhecimento', () => {
    for (const nome of [
      'listar_casas',
      'consultar_odds_casa',
      'comparar_odds_casas',
      'revalidar_surebet',
      'calcular_surebet',
      'calcular_cobertura_promocao',
      'otimizar_odd_freebet',
      'calcular_multipla_qualificadora',
      'buscar_conhecimento',
      'checar_regras_do_par',
      'criar_oportunidade_no_radar',
    ]) {
      expect(acharSkill(nome), nome).toBeDefined();
    }
  });

  it('projeção para o modelo é enxuta (payload de tools cabe na cota)', () => {
    const tools = ferramentasParaModelo();
    expect(tools).toHaveLength(SKILLS.length);
    const json = JSON.stringify(tools);
    expect(json.length).toBeLessThan(14000);
    for (const t of tools) {
      expect(t.descricao.length).toBeLessThan(220);
      for (const p of Object.values<any>(t.parametros.properties || {})) {
        if (typeof p.description === 'string') expect(p.description.length).toBeLessThanOrEqual(90);
      }
    }
  });

  it('UI recebe a descrição LONGA e as flags de custo/escrita', () => {
    const ui = skillsParaUI();
    const escrita = ui.filter((s) => s.escrita).map((s) => s.nome);
    expect(escrita).toContain('criar_oportunidade_no_radar');
    expect(escrita).toContain('registrar_promocao');
    expect(ui.find((s) => s.nome === 'comparar_odds_casas')!.custosa).toBe(true);
    expect(ui.find((s) => s.nome === 'calcular_surebet')!.custosa).toBe(false);
  });
});

describe('base de conhecimento (conversa do Gemini + doutrina)', () => {
  it('a conversa do PDF foi importada inteira', () => {
    const idx = listarConhecimento();
    const conversas = idx.filter((d) => d.fonte === 'conversa_gemini');
    expect(conversas.length).toBeGreaterThanOrEqual(26);
    expect(idx.filter((d) => d.fonte === 'doutrina').length).toBeGreaterThanOrEqual(12);
  });

  it('busca acha a doutrina certa por termo do domínio', () => {
    const r = buscarConhecimento('retenção da freebet odd alta', 3);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].fonte).toBe('doutrina');
    expect(r.map((x) => x.id)).toContain('odd-ideal-freebet');

    const seq = buscarConhecimento('cobrir múltipla qualificadora jogo a jogo', 3);
    expect(seq.map((x) => x.id)).toContain('cobertura-sequencial');

    const cash = buscarConhecimento('cashback', 2);
    expect(cash.map((x) => x.id)).toContain('cashback');
  });

  it('é insensível a acento e caixa', () => {
    const a = buscarConhecimento('RETENCAO FREEBET', 2).map((x) => x.id);
    const b = buscarConhecimento('retenção freebet', 2).map((x) => x.id);
    expect(a).toEqual(b);
  });

  it('consulta vazia devolve doutrina, e id inexistente devolve null', () => {
    expect(buscarConhecimento('', 2).every((r) => r.fonte === 'doutrina')).toBe(true);
    expect(obterConhecimento('cobertura-sequencial')!.titulo).toMatch(/sequencial/i);
    expect(obterConhecimento('nao-existe-isso')).toBeNull();
  });

  it('a conversa original está buscável pelos números daquele dia', () => {
    const r = buscarConhecimento('7.75 joga junto freebet 10', 5);
    expect(r.some((x) => x.fonte === 'conversa_gemini')).toBe(true);
  });
});

describe('gate de escrita do agente', () => {
  it('abre SÓ com pedido explícito na última mensagem', () => {
    expect(pediuEscritaExplicita('crie essa oportunidade no radar')).toBe(true);
    expect(pediuEscritaExplicita('registra essa promoção no histórico')).toBe(true);
    expect(pediuEscritaExplicita('me manda no zap o resumo')).toBe(true);
  });

  it('NÃO abre com pergunta informativa nem com negação', () => {
    // Casos reais que a regex antiga liberava.
    expect(pediuEscritaExplicita('quanto rende criar uma surebet no radar?')).toBe(false);
    expect(pediuEscritaExplicita('essa promo já está registrada no histórico?')).toBe(false);
    expect(pediuEscritaExplicita('não registre nada, só me explica a promoção da Betano')).toBe(false);
    expect(pediuEscritaExplicita('só calcula a cobertura, não lança no radar')).toBe(false);
    expect(pediuEscritaExplicita('qual a melhor surebet agora?')).toBe(false);
  });

  it('exige verbo E objeto do domínio', () => {
    expect(pediuEscritaExplicita('crie um arquivo')).toBe(false);
    expect(pediuEscritaExplicita('e a promoção da Novibet?')).toBe(false);
  });

  it('aceita pedido com infinitivo quando há marcador de pedido', () => {
    expect(pediuEscritaExplicita('pode criar essa oportunidade no radar?')).toBe(true);
    expect(pediuEscritaExplicita('quero registrar essa promoção')).toBe(true);
    // Infinitivo SEM pedido (dúvida sobre valor) continua fechado.
    expect(pediuEscritaExplicita('vale a pena registrar essa promoção no histórico?')).toBe(false);
  });
});

describe('varredura de jogos (ao vivo × pré-jogo)', () => {
  const agora = Date.parse('2026-07-31T18:00:00Z');
  const emAndamento = { dataHora: '2026-07-31T17:00:00Z' };
  const daquiUmaHora = { dataHora: '2026-07-31T19:00:00Z' };

  it('data SEM fuso é lida como UTC (é a convenção do projeto, não hora local)', () => {
    // Superbet emite "2026-07-31 17:00:00". Com Date.parse isso seria 20:00Z em São Paulo
    // e um jogo em andamento apareceria como pré-jogo — foi o bug pego no probe.
    expect(ehAoVivo({ dataHora: '2026-07-31 17:00:00' }, agora)).toBe(true);
    expect(ehAoVivo({ dataHora: '2026-07-31 19:00:00' }, agora)).toBe(false);
  });

  it('classifica em andamento × pré-jogo, e horário desconhecido NÃO é ao vivo', () => {
    expect(ehAoVivo(emAndamento, agora)).toBe(true);
    expect(ehAoVivo(daquiUmaHora, agora)).toBe(false);
    // "Hoje" (Betano/Blaze/1xBet/Stake) não permite afirmar que está rolando.
    expect(ehAoVivo({ dataHora: 'Hoje' }, agora)).toBe(false);
    expect(ehAoVivo({}, agora)).toBe(false);
  });

  it('filtra o recorte pedido', () => {
    // Datas ancoradas LONGE do relógio real (o filtro usa Date.now()), para o teste não
    // depender da hora em que roda.
    const lista = [odd({ dataHora: '2020-01-01T10:00:00Z' }), odd({ dataHora: '2090-01-01T10:00:00Z' })];
    expect(filtrarSituacao(lista, 'todos')).toHaveLength(2);
    expect(filtrarSituacao(lista, 'pre_jogo')).toHaveLength(1);
    expect(filtrarSituacao(lista, 'ao_vivo')).toHaveLength(1);
    expect(filtrarSituacao(lista, 'ao_vivo')[0].dataHora).toBe('2020-01-01T10:00:00Z');
  });

  it('agrupa o MESMO jogo escrito diferente em casas diferentes', () => {
    const jogos = agruparPorJogo([
      { nome: 'KTO', odds: [odd({ evento: 'Flamengo vs Palmeiras' })] },
      { nome: 'Superbet', odds: [odd({ evento: 'Flamengo - Palmeiras' })] },
    ]);
    expect(jogos).toHaveLength(1);
    expect([...jogos[0].porCasa.keys()].sort()).toEqual(['KTO', 'Superbet']);
  });

  it('NÃO agrupa jogos de horários incompatíveis (homônimo de outro dia)', () => {
    const jogos = agruparPorJogo([
      { nome: 'KTO', odds: [odd({ evento: 'Flamengo vs Palmeiras', dataHora: '2026-07-31T20:00:00Z' })] },
      { nome: 'Superbet', odds: [odd({ evento: 'Flamengo vs Palmeiras', dataHora: '2026-08-01T20:00:00Z' })] },
    ]);
    expect(jogos).toHaveLength(2);
  });

  it('cruza os feeds e acha a surebet do jogo, com o resumo em uma linha', () => {
    const cruzadas = cruzarFeeds([
      { nome: 'KTO', odds: [odd({ evento: 'Flamengo vs Palmeiras', oddA: 2.15, oddB: 1.7 })] },
      { nome: 'Superbet', odds: [odd({ evento: 'Flamengo vs Palmeiras', oddA: 1.8, oddB: 2.2 })] },
    ]);
    expect(cruzadas).toHaveLength(1);
    expect(cruzadas[0].mercado.roiPct).toBeGreaterThan(0);
    const linha = resumirSurebet(cruzadas[0]);
    expect(linha).toContain('ROI');
    expect(linha).toContain('KTO');
    expect(linha).toContain('Superbet');
  });

  it('jogo em UMA casa só não entra no cruzamento (não existe arbitragem)', () => {
    const cruzadas = cruzarFeeds([
      { nome: 'KTO', odds: [odd({ evento: 'Flamengo vs Palmeiras', oddA: 2.15, oddB: 2.2 })] },
    ]);
    expect(cruzadas).toHaveLength(0);
  });

  it('o resumo do jogo marca AO VIVO e traz o mercado principal', () => {
    const jogos = agruparPorJogo([
      {
        nome: 'KTO',
        odds: [odd({ evento: 'Flamengo vs Palmeiras', dataHora: '2026-01-01T10:00:00Z', mercado: 'Resultado Final' })],
      },
    ]);
    const linha = resumirJogo(jogos[0], true);
    expect(linha).toContain('AO VIVO');
    expect(linha).toContain('Flamengo vs Palmeiras');
    expect(linha).toContain('Resultado Final');
    expect(linha).toContain('casas: KTO');
  });
});

describe('normalizarEsporte (o modelo escreve o esporte como quer)', () => {
  it('mapeia para o vocabulário dos scrapers', () => {
    // Caso REAL: o modelo mandou "futebol" e o mapa do Kambi (indexado por 'Futebol')
    // devolveu undefined → varredura de 0 odds → "não há jogo ao vivo" com 7 rolando.
    expect(normalizarEsporte('futebol')).toBe('Futebol');
    expect(normalizarEsporte('Futebol')).toBe('Futebol');
    expect(normalizarEsporte('soccer')).toBe('Futebol');
    expect(normalizarEsporte('tênis')).toBe('Tenis');
    expect(normalizarEsporte('tenis')).toBe('Tenis');
    expect(normalizarEsporte('Tênis de Mesa')).toBe('TenisDeMesa');
    expect(normalizarEsporte('table tennis')).toBe('TenisDeMesa');
    expect(normalizarEsporte('basquete')).toBe('Basquete');
    expect(normalizarEsporte('vôlei')).toBe('Volei');
    expect(normalizarEsporte('e-sports')).toBe('Esports');
    expect(normalizarEsporte('CS2')).toBe('Esports');
    expect(normalizarEsporte('beisebol')).toBe('Beisebol');
  });

  it('vazio cai em Futebol e desconhecido passa direto (não força default errado)', () => {
    expect(normalizarEsporte('')).toBe('Futebol');
    expect(normalizarEsporte(undefined)).toBe('Futebol');
    expect(normalizarEsporte('Handebol')).toBe('Handebol');
  });
});

describe('escopo das Diretrizes: surebet BLOQUEIA, promoção NÃO', () => {
  const skill = buscarSkill('checar_regras_do_par')!;

  it('em SUREBET, 1X2 no futebol continua bloqueado', async () => {
    const r: any = await skill.executar(
      { esporte: 'Futebol', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Superbet' },
      {} as any
    );
    expect(r.finalidade).toBe('surebet');
    expect(r.permitido).toBe(false);
    expect(r.motivo_bloqueio).toBeTruthy();
  });

  it('em PROMOÇÃO, o MESMO par passa — com o bloqueio de surebet vindo como aviso', async () => {
    const r: any = await skill.executar(
      { esporte: 'Futebol', mercado: 'Resultado Final', casaA: 'KTO', casaB: 'Superbet', finalidade: 'promocao' },
      {} as any
    );
    expect(r.finalidade).toBe('promocao');
    expect(r.permitido).toBe(true);
    expect(r.regras_de_surebet_aplicadas).toBe(false);
    expect(r.aviso).toContain('NÃO impede');
  });

  it('tênis com grupos de W.O. diferentes: bloqueia em surebet, avisa em promoção', async () => {
    const surebet: any = await skill.executar(
      { esporte: 'Tênis', mercado: 'Vencedor da Partida', casaA: 'Superbet', casaB: 'Pinnacle' },
      {} as any
    );
    expect(surebet.permitido).toBe(false);
    const promo: any = await skill.executar(
      { esporte: 'Tênis', mercado: 'Vencedor da Partida', casaA: 'Superbet', casaB: 'Pinnacle', finalidade: 'freebet' },
      {} as any
    );
    expect(promo.permitido).toBe(true);
    expect(promo.risco_residual).toContain('abandono');
  });
});

describe('lerSituacao', () => {
  it('entende como o modelo escreve', () => {
    expect(lerSituacao('ao vivo')).toBe('ao_vivo');
    expect(lerSituacao('LIVE')).toBe('ao_vivo');
    expect(lerSituacao('in-play')).toBe('ao_vivo');
    expect(lerSituacao('pré-jogo')).toBe('pre_jogo');
    expect(lerSituacao('prematch')).toBe('pre_jogo');
    expect(lerSituacao('todos')).toBe('todos');
    expect(lerSituacao(undefined)).toBe('todos');
  });
});
