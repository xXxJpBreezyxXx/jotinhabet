/**
 * Túnel residencial (Tailscale) com FALLBACK entre exit nodes.
 *
 * Casas que bloqueiam o ASN do datacenter (Pinnacle → 403) ou o comportamento do IP
 * (Stake/Betsul → Cloudflare) só respondem quando o egress sai por um IP residencial.
 * O egress vem de sidecars `tailscale` em userspace, cada um preso a um exit node:
 *
 *   http://jotinhabet_tsproxy:1055   → exit node = celular  (S21, 100.97.159.64)
 *   http://jotinhabet_tsproxy2:1055  → exit node = desktop  (DESKTOP-SH8BVOR, 100.115.26.17)
 *
 * O celular cai da tailnet com frequência (Android matando a VPN) — em 03/08/2026 ficou
 * 21h fora e a Pinnacle foi a 0 odds. Este módulo escolhe, em runtime, um túnel que
 * ESTEJA REALMENTE FUNCIONANDO, na ordem de preferência de TSPROXY_URLS.
 *
 * ⚠️ POR QUE "RESPONDEU" NÃO BASTA: quando o exit node não está anunciado/aprovado, o
 * tailscaled IGNORA o pref e manda o tráfego DIRETO — o proxy responde 200 mas o IP de
 * saída é o da VPS (212.85.11.105), justamente o que a casa bloqueia. Medido em 03/08:
 * tsproxy2 respondia em 268ms com o IP do datacenter. Por isso o probe compara o IP de
 * saída do túnel com o IP de saída DIRETO e só aceita o túnel se forem diferentes.
 *
 * Estratégia: pega no túnel escolhido (evita flapping), re-confirma a cada TTL_OK,
 * castiga por COOLDOWN_MS quem falhou e, no caminho sensível a latência (gate de
 * revalidação), responde só com o que já está em cache — sem probe.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

export interface TunelAtivo {
  /** URL do proxy HTTP do sidecar (ex.: http://jotinhabet_tsproxy:1055). */
  url: string;
  /** IP de saída medido no último probe (o residencial). */
  ip: string;
  /** Dispatcher pronto para o `fetch` do undici (reusado — não crie um por request). */
  dispatcher: ProxyAgent;
}

/** Mede o IP de saída. `url` nulo = medir a saída DIRETA da VPS. */
export type Prober = (url: string | null, timeoutMs: number) => Promise<string | null>;

const TTL_OK_MS = 5 * 60 * 1000; // re-confirma um túnel saudável a cada 5min (1 varredura)
const COOLDOWN_MS = 3 * 60 * 1000; // túnel que falhou fica de castigo
const TTL_IP_DIRETO_MS = 30 * 60 * 1000; // IP do datacenter é estável; medir de raro em raro
const TIMEOUT_PROBE_MS = 8000;

interface EstadoTunel {
  url: string;
  dispatcher: ProxyAgent;
  ip: string | null;
  /** Até quando o "está bom" vale sem novo probe. */
  okAte: number;
  /** Até quando fica de castigo depois de falhar. */
  castigoAte: number;
  ultimoMotivo: string;
}

/**
 * Probe padrão: mede o IP de saída via api.ipify.org (resposta minúscula, texto puro).
 * Devolve null em qualquer falha — inclusive timeout, que é o sintoma de exit node
 * offline (com o exit node pinado o tailscaled NÃO cai pra direto: o tráfego morre).
 */
export const probeIpSaida: Prober = async (url, timeoutMs) => {
  try {
    const init: any = { signal: AbortSignal.timeout(timeoutMs) };
    if (url) init.dispatcher = new ProxyAgent(url);
    const r = await undiciFetch('https://api.ipify.org', init);
    if (r.status !== 200) return null;
    const ip = (await r.text()).trim();
    return /^[0-9a-fA-F.:]{7,45}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
};

export class SeletorTuneis {
  private estados: EstadoTunel[];
  private ipDireto: string | null = null;
  private ipDiretoAte = 0;
  /** Serializa resoluções concorrentes: 6 scrapers na mesma varredura = 1 probe, não 6. */
  private emAndamento: Promise<TunelAtivo | null> | null = null;
  private escolhido: string | null = null;

  constructor(
    urls: string[],
    private probe: Prober = probeIpSaida,
    private agora: () => number = Date.now
  ) {
    this.estados = urls.map((url) => ({
      url,
      dispatcher: new ProxyAgent(url),
      ip: null,
      okAte: 0,
      castigoAte: 0,
      ultimoMotivo: 'nunca testado',
    }));
  }

  get configurado(): boolean {
    return this.estados.length > 0;
  }

  /**
   * Devolve um túnel funcionando, ou null se nenhum está.
   *
   * @param permitirProbe false = responde só com o cache (caminho do gate de
   *   revalidação, que não pode ganhar +8s de latência por probe).
   */
  async resolver(permitirProbe = true): Promise<TunelAtivo | null> {
    if (!this.configurado) return null;
    const fresco = this.doCache();
    if (fresco) return fresco;
    if (!permitirProbe) return this.ultimoConhecido();
    if (this.emAndamento) return this.emAndamento; // já tem alguém sondando: pega o mesmo resultado
    this.emAndamento = this.sondar().finally(() => {
      this.emAndamento = null;
    });
    return this.emAndamento;
  }

  /**
   * Marca que o túnel falhou de verdade (request da casa morreu nele) → castigo, para
   * a próxima resolução ir no outro exit node em vez de insistir no morto.
   */
  marcarFalha(url: string, motivo = 'request falhou'): void {
    const e = this.estados.find((x) => x.url === url);
    if (!e) return;
    const t = this.agora();
    e.okAte = 0;
    e.castigoAte = t + COOLDOWN_MS;
    e.ultimoMotivo = motivo;
    if (this.escolhido === url) this.escolhido = null;
  }

  /** Diagnóstico (log de varredura, /api/health, skill do agente). */
  status(): Array<{ url: string; ip: string | null; ativo: boolean; saudavel: boolean; motivo: string }> {
    const t = this.agora();
    return this.estados.map((e) => ({
      url: e.url,
      ip: e.ip,
      ativo: this.escolhido === e.url,
      saudavel: e.okAte > t,
      motivo: e.ultimoMotivo,
    }));
  }

  /** Túnel já confirmado e dentro da validade — sem tocar na rede. */
  private doCache(): TunelAtivo | null {
    const t = this.agora();
    // Pega no escolhido enquanto ele estiver válido (evita ficar pulando de exit node).
    const ordem = this.escolhido
      ? [...this.estados].sort((a, b) => Number(b.url === this.escolhido) - Number(a.url === this.escolhido))
      : this.estados;
    for (const e of ordem) {
      if (e.okAte > t && e.ip) return { url: e.url, ip: e.ip, dispatcher: e.dispatcher };
    }
    return null;
  }

  /**
   * Último túnel que funcionou, mesmo com a validade vencida. Usado no caminho sem
   * probe: um dado de 6min atrás é MUITO melhor que desligar a fonte.
   */
  private ultimoConhecido(): TunelAtivo | null {
    const cand =
      this.estados.find((e) => e.url === this.escolhido && e.ip) ||
      this.estados.find((e) => e.ip && e.castigoAte <= this.agora());
    return cand?.ip ? { url: cand.url, ip: cand.ip, dispatcher: cand.dispatcher } : null;
  }

  private async sondar(): Promise<TunelAtivo | null> {
    const ipDireto = await this.obterIpDireto();
    // 1ª rodada respeita o castigo; se ninguém passar, a 2ª ignora (melhor um túnel
    // suspeito que fonte nenhuma — o castigo pode ser de uma falha já resolvida).
    // `sondados` garante NO MÁXIMO 1 probe por túnel por chamada: sem isso, com os dois
    // fora, cada resolução gastaria 2×8s por túnel e travaria a varredura.
    const sondados = new Set<string>();
    for (const ignorarCastigo of [false, true]) {
      for (const e of this.estados) {
        const t = this.agora();
        if (e.okAte > t && e.ip) return this.aceitar(e);
        if (!ignorarCastigo && e.castigoAte > t) continue;
        if (sondados.has(e.url)) continue;
        sondados.add(e.url);
        const ip = await this.probe(e.url, TIMEOUT_PROBE_MS);
        if (!ip) {
          e.ip = null;
          e.okAte = 0;
          e.castigoAte = this.agora() + COOLDOWN_MS;
          e.ultimoMotivo = 'sem resposta (exit node offline?)';
          continue;
        }
        if (ipDireto && ip === ipDireto) {
          // Túnel "vivo" mas vazando pelo datacenter: exit node não anunciado/aprovado.
          e.ip = null;
          e.okAte = 0;
          e.castigoAte = this.agora() + COOLDOWN_MS;
          e.ultimoMotivo = `saindo pelo IP da VPS (${ip}) — exit node não está roteando`;
          console.warn(`⚠️ [Túnel] ${e.url} respondeu mas SAIU PELO DATACENTER (${ip}) — exit node não aprovado/anunciado; descartado.`);
          continue;
        }
        e.ip = ip;
        e.okAte = this.agora() + TTL_OK_MS;
        e.castigoAte = 0;
        e.ultimoMotivo = 'ok';
        return this.aceitar(e);
      }
    }
    console.warn(
      `⚠️ [Túnel] NENHUM túnel residencial disponível (${this.estados
        .map((e) => `${e.url}: ${e.ultimoMotivo}`)
        .join(' | ')}) — fontes que dependem de IP residencial vão falhar.`
    );
    return null;
  }

  private aceitar(e: EstadoTunel): TunelAtivo {
    if (this.escolhido !== e.url) {
      console.log(`🔀 [Túnel] usando ${e.url} (IP de saída ${e.ip})${this.escolhido ? ' — FALLBACK, o anterior falhou' : ''}.`);
    }
    this.escolhido = e.url;
    return { url: e.url, ip: e.ip!, dispatcher: e.dispatcher };
  }

  /** IP de saída direto da VPS, em cache — é a referência para detectar vazamento. */
  private async obterIpDireto(): Promise<string | null> {
    const t = this.agora();
    if (this.ipDireto && this.ipDiretoAte > t) return this.ipDireto;
    const ip = await this.probe(null, TIMEOUT_PROBE_MS);
    if (ip) {
      this.ipDireto = ip;
      this.ipDiretoAte = t + TTL_IP_DIRETO_MS;
    } else if (!this.ipDireto) {
      // Sem referência não é possível detectar vazamento; segue aceitando (com aviso).
      console.warn('⚠️ [Túnel] não consegui medir o IP direto da VPS — vazamento pelo datacenter não será detectado nesta rodada.');
    }
    return this.ipDireto;
  }
}

/**
 * Lista de túneis em ordem de PREFERÊNCIA. TSPROXY_URLS é a forma nova (lista separada
 * por vírgula); TSPROXY_URL/PINNACLE_PROXY continuam valendo como legado (1 túnel só).
 */
export function urlsDosTuneis(env: NodeJS.ProcessEnv = process.env): string[] {
  const bruto = env.TSPROXY_URLS || env.TSPROXY_URL || env.PINNACLE_PROXY || '';
  const urls = bruto
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

let singleton: SeletorTuneis | null = null;

/** Seletor compartilhado por todo o backend (um só dispatcher por túnel). */
export function seletorTuneis(): SeletorTuneis {
  if (!singleton) singleton = new SeletorTuneis(urlsDosTuneis());
  return singleton;
}

/** Atalho: túnel funcionando (ou null). Ver SeletorTuneis.resolver. */
export function resolverTunel(permitirProbe = true): Promise<TunelAtivo | null> {
  return seletorTuneis().resolver(permitirProbe);
}

/** Atalho: avisa que o túnel morreu, para a próxima resolução trocar de exit node. */
export function marcarFalhaTunel(url: string | undefined, motivo?: string): void {
  if (url) seletorTuneis().marcarFalha(url, motivo);
}
