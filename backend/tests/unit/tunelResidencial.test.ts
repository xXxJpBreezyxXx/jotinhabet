import { describe, it, expect } from 'vitest';
import { SeletorTuneis, urlsDosTuneis, Prober } from '../../src/utils/tunelResidencial';

/**
 * O celular ficou 21h fora da tailnet em 03/08/2026 e a Pinnacle foi a 0 odds sem
 * fallback. O desktop entrou como 2º exit node — e o probe tem de ser DESCONFIADO: um
 * sidecar com exit node não aprovado responde 200 saindo pelo IP da VPS (medido: 268ms,
 * 212.85.11.105), que é exatamente o IP que a casa bloqueia.
 */
const CEL = 'http://jotinhabet_tsproxy:1055';
const DESK = 'http://jotinhabet_tsproxy2:1055';
const IP_VPS = '212.85.11.105';

/** Prober falso: mapa url→IP (null = não respondeu). Conta as chamadas. */
const fakeProbe = (mapa: Record<string, string | null>, chamadas: string[] = []): Prober =>
  async (url) => {
    chamadas.push(url ?? 'direto');
    return url === null ? IP_VPS : (mapa[url] ?? null);
  };

/** Relógio controlável (o seletor tem TTL/cooldown). */
const relogio = (t = 1_000_000) => {
  const ref = { t };
  return { agora: () => ref.t, avancar: (ms: number) => (ref.t += ms), ref };
};

describe('seleção do túnel residencial', () => {
  it('usa o 1º túnel da lista quando ele está saindo por IP residencial', async () => {
    const c = relogio();
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228', [DESK]: '177.78.42.79' }), c.agora);
    const t = await s.resolver();
    expect(t?.url).toBe(CEL);
    expect(t?.ip).toBe('179.94.138.228');
  });

  it('cai no desktop quando o celular não responde (exit node offline)', async () => {
    const c = relogio();
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: null, [DESK]: '177.78.42.79' }), c.agora);
    const t = await s.resolver();
    expect(t?.url).toBe(DESK);
  });

  it('DESCARTA túnel que responde mas sai pelo IP da VPS (exit node não aprovado)', async () => {
    const c = relogio();
    // Cenário real de 03/08: celular offline e desktop ainda sem exit node aprovado.
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: null, [DESK]: IP_VPS }), c.agora);
    expect(await s.resolver()).toBeNull();
    expect(s.status().find((x) => x.url === DESK)?.motivo).toContain('IP da VPS');
  });

  it('não sonda de novo enquanto o túnel escolhido está fresco, e re-sonda depois do TTL', async () => {
    const c = relogio();
    const chamadas: string[] = [];
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228' }, chamadas), c.agora);
    await s.resolver();
    const apos1 = chamadas.length;
    await s.resolver();
    await s.resolver();
    expect(chamadas.length).toBe(apos1); // cache: nada de rede
    c.avancar(6 * 60 * 1000);
    await s.resolver();
    expect(chamadas.length).toBeGreaterThan(apos1);
  });

  it('marcarFalha troca de exit node, PEGA no novo e só volta ao preferido depois', async () => {
    const c = relogio();
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228', [DESK]: '177.78.42.79' }), c.agora);
    expect((await s.resolver())?.url).toBe(CEL);
    s.marcarFalha(CEL, 'timeout no meio da varredura');
    expect((await s.resolver())?.url).toBe(DESK);
    // Aderência: enquanto o desktop está bom, NÃO fica pulando de exit node só porque
    // o castigo do celular venceu — trocar de túnel a cada varredura é flapping.
    c.avancar(4 * 60 * 1000);
    expect((await s.resolver())?.url).toBe(DESK);
    // Vencida a validade do desktop, a ordem de preferência volta a valer.
    c.avancar(2 * 60 * 1000);
    expect((await s.resolver())?.url).toBe(CEL);
  });

  it('com TODOS de castigo, tenta de novo em vez de devolver nada (fonte viva > castigo)', async () => {
    const c = relogio();
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228', [DESK]: '177.78.42.79' }), c.agora);
    await s.resolver();
    s.marcarFalha(CEL);
    s.marcarFalha(DESK);
    expect((await s.resolver())?.url).toBe(CEL);
  });

  it('com os DOIS fora, sonda cada túnel só UMA vez por resolução (senão trava a varredura)', async () => {
    const c = relogio();
    const chamadas: string[] = [];
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: null, [DESK]: null }, chamadas), c.agora);
    expect(await s.resolver()).toBeNull();
    expect(chamadas.filter((x) => x === CEL)).toHaveLength(1);
    expect(chamadas.filter((x) => x === DESK)).toHaveLength(1);
  });

  it('sem probe (gate de revalidação) devolve o último conhecido e NÃO toca na rede', async () => {
    const c = relogio();
    const chamadas: string[] = [];
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228' }, chamadas), c.agora);
    await s.resolver();
    const apos1 = chamadas.length;
    c.avancar(10 * 60 * 1000); // validade vencida
    const t = await s.resolver(false);
    expect(t?.url).toBe(CEL);
    expect(chamadas.length).toBe(apos1);
  });

  it('resoluções concorrentes compartilham UM probe (6 scrapers na mesma varredura)', async () => {
    const c = relogio();
    const chamadas: string[] = [];
    const s = new SeletorTuneis([CEL, DESK], fakeProbe({ [CEL]: '179.94.138.228' }, chamadas), c.agora);
    const [a, b, d] = await Promise.all([s.resolver(), s.resolver(), s.resolver()]);
    expect([a?.url, b?.url, d?.url]).toEqual([CEL, CEL, CEL]);
    expect(chamadas.filter((x) => x === CEL)).toHaveLength(1);
  });

  it('sem nenhuma env configurada, resolver devolve null (não quebra quem roda fora do container)', async () => {
    const s = new SeletorTuneis([]);
    expect(s.configurado).toBe(false);
    expect(await s.resolver()).toBeNull();
  });
});

describe('urlsDosTuneis', () => {
  it('lê TSPROXY_URLS em ordem, sem duplicar', () => {
    expect(urlsDosTuneis({ TSPROXY_URLS: `${CEL}, ${DESK} ,${CEL}` } as any)).toEqual([CEL, DESK]);
  });

  it('cai no legado PINNACLE_PROXY/TSPROXY_URL quando TSPROXY_URLS não existe', () => {
    expect(urlsDosTuneis({ PINNACLE_PROXY: CEL } as any)).toEqual([CEL]);
    expect(urlsDosTuneis({ TSPROXY_URL: DESK } as any)).toEqual([DESK]);
    expect(urlsDosTuneis({} as any)).toEqual([]);
  });
});
