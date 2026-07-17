import { describe, it, expect } from 'vitest';
import { areTeamsSame, areEventsSame, normalizeTeamName } from '../../src/arbitrage/matcher';
import { normalizarMercado, mesmaOferta } from '../../src/arbitrage/markets';

describe('matcher.normalizeTeamName', () => {
  it('vira "Nome Sobrenome" quando o nome vem com vírgula (Kambi/Altenar)', () => {
    expect(normalizeTeamName('Alcaraz, Carlos')).toBe('carlos alcaraz');
    expect(normalizeTeamName('Prochazka, Michal')).toBe('michal prochazka');
  });
  it('remove código de país entre parênteses', () => {
    expect(normalizeTeamName('João Fonseca (BRA)')).toBe('joao fonseca');
  });
  it('marca feminino como token canônico', () => {
    expect(normalizeTeamName('Chile (F)')).toBe('chile fem');
    expect(normalizeTeamName('Corinthians Feminino')).toBe('corinthians fem');
  });
});

describe('matcher.areTeamsSame — ganhos de cobertura', () => {
  it('vírgula: "Alcaraz, Carlos" × "Carlos Alcaraz"', () => {
    expect(areTeamsSame('Alcaraz, Carlos', 'Carlos Alcaraz')).toBe(true);
  });
  it('sobrenome-primeiro sem vírgula: "Zuzanek Jiri" × "Jiri Zuzanek"', () => {
    expect(areTeamsSame('Zuzanek Jiri', 'Jiri Zuzanek')).toBe(true);
  });
  it('sobrenome + inicial: "Alcaraz C." × "Carlos Alcaraz"', () => {
    expect(areTeamsSame('Alcaraz C.', 'Carlos Alcaraz')).toBe(true);
  });
  it('inicial incompatível NÃO casa: "Zverev M." × "Alexander Zverev"', () => {
    expect(areTeamsSame('Zverev M.', 'Alexander Zverev')).toBe(false);
  });
  it('código de país: "Irã" × "Iran" e "Japão (JPN)" × "Japan"', () => {
    expect(areTeamsSame('Irã', 'Iran')).toBe(true);
    expect(areTeamsSame('Japão (JPN)', 'Japan')).toBe(true);
  });
  it('aliases VNL/MLB: "Eslovênia" × "Slovenia"; "LA Dodgers" × "Los Angeles Dodgers"', () => {
    expect(areTeamsSame('Eslovênia', 'Slovenia')).toBe(true);
    expect(areTeamsSame('LA Dodgers', 'Los Angeles Dodgers')).toBe(true);
  });
});

describe('matcher.areTeamsSame — guardas duras (anti falso positivo)', () => {
  it('feminino × masculino NUNCA casa (antes o substring rule casava)', () => {
    expect(areTeamsSame('Barcelona', 'Barcelona Feminino')).toBe(false);
    expect(areTeamsSame('Chile', 'Chile (F)')).toBe(false);
  });
  it('feminino × feminino casa normalmente', () => {
    expect(areTeamsSame('Chile (F)', 'Chile Feminino')).toBe(true);
    expect(areTeamsSame('Venezuela (W)', 'Venezuela Feminino')).toBe(true);
  });
  it('Sub-20 × principal NUNCA casa; Sub-20 × U20 casa', () => {
    expect(areTeamsSame('Brasil Sub-20', 'Brasil')).toBe(false);
    expect(areTeamsSame('Brasil Sub-20', 'Brazil U20')).toBe(true);
    expect(areTeamsSame('Brasil Sub-20', 'Brasil Sub-17')).toBe(false);
  });
  it('time B/II × principal NUNCA casa; B × II casa', () => {
    expect(areTeamsSame('Barcelona B', 'Barcelona')).toBe(false);
    expect(areTeamsSame('Sporting II', 'Sporting B')).toBe(true);
  });
});

describe('matcher.areEventsSame — eventos completos', () => {
  it('VNL: "China - Bulgária" (KTO) × "China vs Bulgaria" (Pinnacle)', () => {
    expect(areEventsSame('China vs Bulgária', 'China vs Bulgaria')).toBe(true);
  });
  it('mesa: "Ondrej Fiklik vs Prochazka, Michal" × "Ondrej Fiklik vs Michal Prochazka"', () => {
    expect(areEventsSame('Ondrej Fiklik vs Prochazka, Michal', 'Ondrej Fiklik vs Michal Prochazka')).toBe(true);
  });
  it('masculino × feminino do mesmo confronto NÃO casa', () => {
    expect(areEventsSame('Brasil vs Chile', 'Brasil (F) vs Chile (F)')).toBe(false);
  });
});

describe('markets.normalizarMercado — esportes novos', () => {
  it('vôlei: sets e pontos não colidem', () => {
    expect(normalizarMercado('Total de Sets')).toBe(normalizarMercado('Total de sets'));
    expect(normalizarMercado('Total de Sets')).not.toBe(normalizarMercado('Total de Pontos'));
    expect(normalizarMercado('Handicap de Sets')).toBe(normalizarMercado('Handicap de Set'));
    expect(normalizarMercado('Handicap de Sets')).not.toBe(normalizarMercado('Handicap de Pontos'));
  });
  it('"Set 3" (dígito depois) e "1° Set" (símbolo de grau) viram período próprio', () => {
    expect(normalizarMercado('Handicap de Pontos - Set 3')).toBe('HANDICAP_PONTOS_S3');
    expect(normalizarMercado('1° Set - Total de Pontos')).toBe('TOTAIS_PONTOS_S1');
    expect(normalizarMercado('Handicap de Pontos - Set 3')).not.toBe(normalizarMercado('Handicap de pontos'));
  });
  it('beisebol: corridas têm assunto próprio e entradas viram período', () => {
    expect(normalizarMercado('Total de Corridas (incl. entradas extras)')).toBe('TOTAIS_CORRIDAS_FT');
    expect(normalizarMercado('Total de corridas')).toBe('TOTAIS_CORRIDAS_FT');
    expect(normalizarMercado('Total de Corridas Após 5 Entradas')).toBe('TOTAIS_CORRIDAS_E5');
    // "Entrada 1 - Handicap" não menciona corridas → assunto GERAL, mas o período I1
    // já o separa do handicap do jogo completo (o que importa p/ não cruzar errado).
    expect(normalizarMercado('Entrada 1 - Handicap')).toBe('HANDICAP_GERAL_I1');
    expect(normalizarMercado('Handicap (incl. entradas extras)')).toBe('HANDICAP_GERAL_FT');
  });
  it('mesmaOferta exige mesmo assunto+período+linha', () => {
    expect(mesmaOferta('Total de Sets', 4.5, 'Total de sets', 4.5)).toBe(true);
    expect(mesmaOferta('Total de Sets', 4.5, 'Total de Pontos', 4.5)).toBe(false);
    expect(mesmaOferta('Total de Corridas (incl. entradas extras)', 8.5, 'Total de corridas', 8.5)).toBe(true);
  });
});
