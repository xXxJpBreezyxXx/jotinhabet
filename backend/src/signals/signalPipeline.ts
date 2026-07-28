import { ArbitrageEngine, ArbitrageOpportunity } from '../arbitrage/engine';
import { regraPermiteOportunidade } from '../arbitrage/regras';
import { ehLinhaQuarter } from '../arbitrage/markets';
import { supabase } from '../db/client';
import { WhatsAppNotifier } from '../notify/whatsapp';
import { alertAlreadySent, markAlertAsSent } from '../notify/alertCache';
import { ehPreJogo, dentroDaJanelaDeAlerta } from '../core/scanner_v2';
import { RevalidationService, casaTemScraper } from '../core/revalidationService';
import { SinalExtraido, ContextoCasa } from '../IA/extractors/telegramSignalExtractor';
import { canonizarCasa } from './casasAliases';
import { isoParaBrasilia, dataHoraViaLink } from './dataHoraResolver';
import { bancaParaAlertas } from '../core/bancaAtiva';

export type AcaoPipeline =
  | 'alertada'                 // inserida + alerta WhatsApp revalidado ao vivo
  | 'alertada_nao_revalidada'  // inserida + alerta com tag ⚠️ (casa sem scraper)
  | 'inserida_sem_alerta'      // inserida mas o gate de alerta não passou
  | 'duplicada'                // já existia no banco (visto_em atualizado)
  | 'bloqueada_regras'         // vetada pelos gates de risco (W.O./KTO/mercado)
  | 'suprimida_revalidacao'    // inserida mas a revalidação matou o alerta
  | 'erro';

export interface ResultadoPipeline {
  acao: AcaoPipeline;
  id?: string;
  motivo?: string;
}

/** Link colhido das mensagens de contexto do grupo (caption dos prints etc.). */
export interface LinkSinal {
  url: string;
  /** Casa associada (pelo print que acompanhava o link), quando conhecida. */
  casa?: string | null;
}

/** Enriquecimento vindo da correlação de mensagens do grupo. */
export interface ExtrasSinal {
  links?: LinkSinal[];
  /** Origem do sinal: 'telegram' (default, grupo de sinais) ou 'copiloto' (chat da IA). */
  fonte?: 'telegram' | 'copiloto';
}

const ROI_MIN_ALERTA = 1.5;

/**
 * Pipeline pós-extração dos sinais do Telegram: aplica os MESMOS gates de
 * risco do motor, deduplica contra o que o scanner já achou, persiste com
 * fonte='telegram' e passa pelo gate de revalidação pré-alerta antes do
 * WhatsApp. Espelha o fluxo de alerta do scanner_v2 (linhas ~283-490) para
 * uma oportunidade que chega de fora do ciclo de varredura.
 */
export class SignalPipeline {
  private engine = new ArbitrageEngine();

  constructor(private revalidador: RevalidationService = new RevalidationService()) {}

  /**
   * Análogo de converterSurebet (casa_sureradar.ts): monta a ArbitrageOpportunity
   * a partir do sinal extraído, derivando o ROI das odds (nunca do print).
   */
  construirOportunidade(sinal: SinalExtraido, fonte: 'telegram' | 'copiloto' = 'telegram'): ArbitrageOpportunity | null {
    const casaA = canonizarCasa(sinal.casaA);
    const casaB = canonizarCasa(sinal.casaB);

    const totalPerc = 1 / sinal.oddA + 1 / sinal.oddB;
    if (!Number.isFinite(totalPerc) || totalPerc >= 1) return null;
    const roi = Number(((1 / totalPerc - 1) * 100).toFixed(2));

    // Formato canônico "(DD/MM/AAAA HH:MM)" — o mesmo do SureRadar: liga de
    // graça kickoffMs/ehPreJogo, dentroDaJanelaDeAlerta, expiração e dataPartida.
    const quando = sinal.dataHora || 'Hoje';

    // dataHora ISO derivada do horário de Brasília (UTC-3) impresso no sinal.
    let dataHoraIso: string | undefined;
    const m = quando.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (m) dataHoraIso = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5])).toISOString();

    return {
      evento: `${sinal.evento} (${quando})`,
      mercado: sinal.mercado,
      opcaoA: sinal.opcaoA,
      opcaoB: sinal.opcaoB,
      oddA: sinal.oddA,
      oddB: sinal.oddB,
      casaA,
      casaB,
      lucroGarantidoPerc: roi,
      oddCombinadaA: 1 / sinal.oddA / totalPerc,
      oddCombinadaB: 1 / sinal.oddB / totalPerc,
      totalPerc: parseFloat(totalPerc.toFixed(4)),
      esporte: sinal.esporte,
      url: undefined,
      linha: sinal.linha ?? undefined,
      dataHora: dataHoraIso,
      analiseIA: fonte === 'copiloto'
        ? '🤖 Oportunidade lançada pelo Copiloto (chat da aba IA & Automação) a pedido do usuário. ROI derivado das odds informadas — revalide nas casas antes de apostar.'
        : `📲 Sinal importado do grupo do Telegram e extraído por IA de visão (confiança ${sinal.confianca}%). ROI derivado das odds do print — revalide nas casas antes de apostar.`,
    };
  }

  /** Banca dos alertas: banca ativa do painel (app_config), com fallback no
   *  legado 50 + Σ lucro_real — ver bancaParaAlertas(). */
  private async bancaAtual(): Promise<number> {
    return bancaParaAlertas();
  }

  /**
   * Dedup no padrão do scanner_v2 (~30 linhas replicadas de propósito — o
   * insert do scanner está entrelaçado com fallback de colunas legadas), com
   * uma diferença: checa as casas NAS DUAS ORDENS, porque o SureRadar/motor
   * pode ter inserido o mesmo par invertido.
   */
  private async acharDuplicata(opp: ArbitrageOpportunity): Promise<string | null> {
    for (const [c1, c2] of [[opp.casaA, opp.casaB], [opp.casaB, opp.casaA]]) {
      try {
        const { data } = await supabase
          .from('oportunidades')
          .select('id')
          .eq('evento', opp.evento)
          .eq('status', 'detectada')
          .eq('casa_a_nome', c1)
          .eq('casa_b_nome', c2)
          .eq('mercado', opp.mercado || '')
          .limit(1);
        if (data && data.length > 0) return data[0].id;
      } catch (err) {
        console.error('⚠️ [Telegram] Erro ao checar duplicata no banco:', err);
      }
    }
    return null;
  }

  /** Associa cada link do grupo a uma casa da oportunidade: pelo campo `casa`
   *  do contexto ou pelo hostname da URL (ex.: novibet.bet.br → Novibet). */
  private linksPorCasa(links: LinkSinal[], casaA: string, casaB: string): { link1?: string; link2?: string; soltos: string[] } {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nA = norm(canonizarCasa(casaA));
    const nB = norm(canonizarCasa(casaB));
    let link1: string | undefined;
    let link2: string | undefined;
    const soltos: string[] = [];
    for (const l of links) {
      let host = '';
      try { host = norm(new URL(l.url).hostname); } catch { /* url inválida vira "solta" */ }
      const nCasa = l.casa ? norm(canonizarCasa(l.casa)) : '';
      if (!link1 && nA && (nCasa === nA || (host && host.includes(nA)))) link1 = l.url;
      else if (!link2 && nB && (nCasa === nB || (host && host.includes(nB)))) link2 = l.url;
      else soltos.push(l.url);
    }
    return { link1, link2, soltos };
  }

  /**
   * Cascata de data/horário quando os prints não trouxeram: (1) feed de uma
   * casa com scraper; (2) abrir o link direto colhido do grupo (fetch →
   * Playwright → LLM). Nunca lança — sem horário o sinal segue como "(Hoje)".
   */
  private async resolverDataHora(sinal: SinalExtraido, extras?: ExtrasSinal): Promise<void> {
    if (sinal.dataHora) return;

    try {
      const iso = await this.revalidador.dataHoraDoEvento(
        [canonizarCasa(sinal.casaA), canonizarCasa(sinal.casaB)],
        sinal.evento,
        sinal.esporte
      );
      const viaScraper = iso ? isoParaBrasilia(iso) : null;
      if (viaScraper) {
        sinal.dataHora = viaScraper;
        console.log(`🕒 [Telegram] dataHora resolvida via feed de casa: ${viaScraper} (${sinal.evento}).`);
        return;
      }
    } catch { /* cascata segue */ }

    for (const l of (extras?.links || []).slice(0, 2)) {
      const viaLink = await dataHoraViaLink(l.url, sinal.evento);
      if (viaLink) {
        sinal.dataHora = viaLink;
        console.log(`🕒 [Telegram] dataHora resolvida via link do grupo: ${viaLink} (${l.url}).`);
        return;
      }
    }
    console.log(`🕒 [Telegram] dataHora NÃO resolvida (${sinal.evento}) — segue como "(Hoje)".`);
  }

  /** Tokens significativos de um evento p/ matching tolerante (sem acento/caixa
   *  e sem o sufixo "(data)"). "Fluminense RJ x EC Bahia BA" ≈ "Fluminense x Bahia". */
  private tokensEvento(evento: string): Set<string> {
    const semSufixo = (evento || '').replace(/\s*\([^)]*\)\s*$/, '');
    const norm = semSufixo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return new Set(norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  }

  private eventosBatem(a: string, b: string): boolean {
    const ta = this.tokensEvento(a);
    const tb = this.tokensEvento(b);
    let comuns = 0;
    for (const t of ta) if (tb.has(t)) comuns++;
    return comuns >= 2;
  }

  /**
   * LATE-BINDING de contexto órfão: print de casa/links que chegam DEPOIS da
   * janela de contexto (23% dos prints, medido em 27/07) eram jogados fora.
   * Agora tentam casar com uma oportunidade telegram RECENTE (30 min) e
   * completam retroativamente o que faltar: a data no evento ("(Hoje)" →
   * "(DD/MM/AAAA HH:MM)"), url_casa_1/2 e links_grupo. Conservador: sem evento
   * legível no print, só aplica se houver UMA única candidata na janela.
   * Nunca lança; retorna true se algo foi aplicado.
   */
  async anexarContextoTardio(contexto: ContextoCasa | null, links: LinkSinal[] = []): Promise<boolean> {
    if (!contexto?.dataHora && links.length === 0) return false;
    try {
      const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      // any[]: o shape muda entre o select completo e o fallback sem migration 017.
      let { data: recentes, error: selErr }: { data: any[] | null; error: any } = await supabase
        .from('oportunidades')
        .select('id, evento, casa_a_nome, casa_b_nome, url_casa_1, url_casa_2, links_grupo')
        .eq('fonte', 'telegram')
        .eq('status', 'detectada')
        .gte('detectada_em', desde)
        .order('detectada_em', { ascending: false })
        .limit(5);
      // Migration 017 ausente: repete o select sem as colunas de link.
      if (selErr && (selErr.code === 'PGRST204' || /column|schema cache/i.test(selErr.message || ''))) {
        ({ data: recentes } = await supabase
          .from('oportunidades')
          .select('id, evento, casa_a_nome, casa_b_nome')
          .eq('fonte', 'telegram')
          .eq('status', 'detectada')
          .gte('detectada_em', desde)
          .order('detectada_em', { ascending: false })
          .limit(5));
      }
      if (!recentes || recentes.length === 0) return false;

      const alvo: any = contexto?.evento
        ? recentes.find((o: any) => this.eventosBatem(o.evento, contexto.evento!))
        : (recentes.length === 1 ? recentes[0] : null);
      if (!alvo) return false;

      const patch: any = {};
      if (contexto?.dataHora && /\(Hoje\)\s*$/i.test(alvo.evento)) {
        patch.evento = alvo.evento.replace(/\(Hoje\)\s*$/i, `(${contexto.dataHora})`);
      }
      if (links.length > 0) {
        const comCasa = links.map((l) => ({ url: l.url, casa: l.casa ?? contexto?.casa ?? null }));
        const { link1, link2 } = this.linksPorCasa(comCasa, alvo.casa_a_nome || '', alvo.casa_b_nome || '');
        if (link1 && !alvo.url_casa_1) patch.url_casa_1 = link1;
        if (link2 && !alvo.url_casa_2) patch.url_casa_2 = link2;
        const existentes: any[] = Array.isArray(alvo.links_grupo) ? alvo.links_grupo : [];
        const urlsExistentes = new Set(existentes.map((l: any) => l?.url));
        const novos = comCasa.filter((l) => !urlsExistentes.has(l.url));
        if (novos.length > 0) patch.links_grupo = [...existentes, ...novos];
      }
      if (Object.keys(patch).length === 0) return false;

      let { error } = await supabase.from('oportunidades').update(patch).eq('id', alvo.id);
      if (error && (error.code === 'PGRST204' || /column|schema cache/i.test(error.message || ''))) {
        if (!patch.evento) return false;
        ({ error } = await supabase.from('oportunidades').update({ evento: patch.evento }).eq('id', alvo.id));
      }
      if (error) {
        console.error('⚠️ [Telegram] Falha no late-binding de contexto:', error.message || error);
        return false;
      }
      console.log(
        `🧷 [Telegram] Contexto TARDIO aplicado a "${alvo.evento}":` +
        `${patch.evento ? ` dataHora ${contexto!.dataHora};` : ''}` +
        `${patch.url_casa_1 ? ' link casa A;' : ''}${patch.url_casa_2 ? ' link casa B;' : ''}` +
        `${patch.links_grupo ? ` +${links.length} link(s) no links_grupo` : ''}`
      );
      return true;
    } catch (e: any) {
      console.error(`⚠️ [Telegram] Erro no late-binding: ${e?.message || e}`);
      return false;
    }
  }

  async processarSinal(sinal: SinalExtraido, extras?: ExtrasSinal): Promise<ResultadoPipeline> {
    const fonteDb = extras?.fonte || 'telegram';
    const rotuloAlerta = fonteDb === 'copiloto' ? 'Copiloto (IA)' : 'Telegram (IA)';
    await this.resolverDataHora(sinal, extras);
    const opp = this.construirOportunidade(sinal, fonteDb);
    if (!opp) {
      return { acao: 'erro', motivo: 'oportunidade inválida (break-even falhou na construção)' };
    }

    // Mesmos gates de risco do motor: mercado permitido + grupos W.O. do
    // tênis + KTO bloqueada em Handicap/Totais. Bloqueada NÃO é inserida
    // (mesmo tratamento dos sinais SureRadar vetados no scanner).
    const regra = regraPermiteOportunidade({
      esporte: opp.esporte,
      mercado: opp.mercado,
      casaA: opp.casaA,
      casaB: opp.casaB,
    });
    if (!regra.ok) {
      console.log(`🚫 [Telegram] Sinal bloqueado pelas regras: ${opp.evento} | ${opp.mercado} — ${regra.motivo}`);
      return { acao: 'bloqueada_regras', motivo: regra.motivo };
    }

    // Dedup contra o que o scanner/SureRadar já registrou.
    const duplicataId = await this.acharDuplicata(opp);
    if (duplicataId) {
      try {
        await supabase.from('oportunidades').update({ visto_em: new Date().toISOString() }).eq('id', duplicataId);
      } catch { /* coluna visto_em pode faltar; sem impacto */ }
      console.log(`ℹ️ [Telegram] Sinal já ativo no radar (visto_em atualizado): ${opp.evento}`);
      return { acao: 'duplicada', id: duplicataId };
    }

    const banca = await this.bancaAtual();
    const distr = this.engine.calcularDistribuicaoStake(opp, banca);

    // Links diretos colhidos do grupo, casados por casa: PERSISTEM na oportunidade
    // (url_casa_1/2 + links_grupo, migration 017) e alimentam o alerta do WhatsApp.
    // Antes eram usados só no alerta e descartados — o frontend nunca via link.
    const linksGrupo = extras?.links || [];
    const { link1, link2, soltos } = this.linksPorCasa(linksGrupo, opp.casaA, opp.casaB);

    const payload: any = {
      evento: opp.evento,
      odd_casa_1: opp.oddA,
      odd_casa_2: opp.oddB,
      margem_mercado: 100 - 100 / opp.lucroGarantidoPerc, // mesma convenção do scanner_v2
      stake_casa_1: distr.apostaA,
      stake_casa_2: distr.apostaB,
      lucro_esperado: distr.lucroR$,
      roi_pct: opp.lucroGarantidoPerc,
      status: 'detectada',
      casa_a_nome: opp.casaA,
      casa_b_nome: opp.casaB,
      opcao_a: opp.opcaoA,
      opcao_b: opp.opcaoB,
      mercado: opp.mercado,
      analise_ia: opp.analiseIA || null,
      esporte: opp.esporte || null,
      url: null,
      fonte: fonteDb, // ia_status fica no DEFAULT 'pendente' → EnrichmentService cobre
      url_casa_1: link1 || null,
      url_casa_2: link2 || null,
      links_grupo: linksGrupo.length ? linksGrupo.map((l) => ({ url: l.url, casa: l.casa ?? null })) : null,
    };

    let { data: novaOpp, error: insertError } = await supabase
      .from('oportunidades')
      .insert(payload)
      .select()
      .single();
    // Fallback: colunas de link ausentes (migration 017 não aplicada) → grava sem elas.
    if (insertError && (insertError.code === 'PGRST204' || /column|schema cache/i.test(insertError.message || ''))) {
      console.warn('⚠️ [Telegram] Colunas de links ausentes em "oportunidades" (aplique a migration 017) — gravando sem os links.');
      const { url_casa_1: _1, url_casa_2: _2, links_grupo: _3, ...semLinks } = payload;
      ({ data: novaOpp, error: insertError } = await supabase.from('oportunidades').insert(semLinks).select().single());
    }
    if (insertError || !novaOpp) {
      console.error('⚠️ [Telegram] Erro ao salvar sinal:', insertError);
      return { acao: 'erro', motivo: insertError?.message || 'insert falhou' };
    }

    // ------- Gate de alerta (espelho do scanner_v2) -------
    const roi = opp.lucroGarantidoPerc;

    let alreadyEntered = false;
    try {
      const { data: opCheck } = await supabase.from('operacoes').select('id').eq('evento', opp.evento).limit(1);
      alreadyEntered = !!(opCheck && opCheck.length > 0);
    } catch (err) {
      console.error('⚠️ [Telegram] Erro ao checar se evento já possui aposta confirmada:', err);
    }

    if (alreadyEntered || !ehPreJogo(opp) || !dentroDaJanelaDeAlerta(opp.evento) || roi < ROI_MIN_ALERTA) {
      return { acao: 'inserida_sem_alerta', id: novaOpp.id, motivo: alreadyEntered ? 'evento já apostado' : 'fora do gate (pré-jogo/janela do dia/ROI)' };
    }

    const alertKey = `Telegram_${opp.evento.trim()}_${opp.mercado.trim()}_${opp.casaA.trim()}_${opp.casaB.trim()}_${roi.toFixed(1)}`;
    if (alertAlreadySent(alertKey)) {
      console.log(`ℹ️ [Telegram] Alerta ignorado (já enviado): ${opp.evento} (${roi}%)`);
      return { acao: 'inserida_sem_alerta', id: novaOpp.id, motivo: 'alerta já enviado' };
    }

    const notaQuarter =
      opp.linha != null && ehLinhaQuarter(opp.linha)
        ? ` · ⚠️ Linha asiática ${opp.linha} (.25/.75): o lucro informado é o PISO garantido — no cenário do meio metade de cada aposta é devolvida; nos demais cenários o lucro é o dobro`
        : '';

    // Links do grupo não casados com perna vão na nota (melhor mostrar do que perder);
    // link1/link2 (casados por casa) já foram calculados antes do insert.
    const notaLinks = soltos.length ? ` · 🔗 Links do grupo: ${soltos.join(' | ')}` : '';

    const revalidavel = casaTemScraper(opp.casaA) && casaTemScraper(opp.casaB);

    if (revalidavel) {
      // REVALIDAÇÃO PRÉ-ALERTA: sinal de grupo chega ATRASADO por natureza —
      // re-busca as duas pernas ao vivo e só alerta se a arb segue de pé.
      const reval = await this.revalidador.checarPernasAoVivo({ ...opp, fonte: fonteDb });
      if (!reval.ok || (reval.roiAtual ?? 0) < ROI_MIN_ALERTA) {
        console.log(
          `🛡️ [Telegram] Alerta SUPRIMIDO pela revalidação: ${opp.evento} | ${opp.mercado} ` +
          `(sinal ${roi}% → agora ${reval.roiAtual ?? '?'}%) — ${reval.motivo}`
        );
        // Falha de INFRA (casa/túnel fora): remove a linha p/ não fossilizar um
        // sinal inconfirmado no radar (o sinal não se re-insere sozinho como o scan).
        if (/falha ao|indisponível/i.test(reval.motivo)) {
          try {
            await supabase.from('oportunidades').delete().eq('id', novaOpp.id);
            console.log('   ↳ linha removida (falha de infra na revalidação do sinal).');
          } catch { /* segue */ }
        }
        return { acao: 'suprimida_revalidacao', id: novaOpp.id, motivo: reval.motivo };
      }

      const totalPercFresco = 1 / reval.oddA! + 1 / reval.oddB!;
      const oppFresca: ArbitrageOpportunity = {
        ...opp,
        oddA: reval.oddA!,
        oddB: reval.oddB!,
        lucroGarantidoPerc: reval.roiAtual!,
        totalPerc: totalPercFresco,
        oddCombinadaA: (1 / reval.oddA!) / totalPercFresco,
        oddCombinadaB: (1 / reval.oddB!) / totalPercFresco,
      };
      const distrFresca = this.engine.calcularDistribuicaoStake(oppFresca, banca);

      console.log(`✉️ [Telegram] Disparando alerta (sinal ${roi}% → revalidado ${reval.roiAtual}%) para: ${opp.evento}`);
      const success = await new WhatsAppNotifier().enviarAlerta({
        evento: opp.evento,
        mercado: opp.mercado,
        opcao1: opp.opcaoA,
        opcao2: opp.opcaoB,
        odd1: reval.oddA!,
        odd2: reval.oddB!,
        stake1: parseFloat(distrFresca.apostaA),
        stake2: parseFloat(distrFresca.apostaB),
        investimento: banca,
        lucro: parseFloat(distrFresca.lucroR$),
        roi: reval.roiAtual!,
        casa1: opp.casaA,
        casa2: opp.casaB,
        esporte: opp.esporte,
        dataPartida: (opp.evento.match(/\((\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})\)\s*$/) || [])[1],
        fonte: rotuloAlerta,
        link1,
        link2,
        nota: `✅ Revalidada agora nas casas (odds ao vivo)${notaQuarter}${notaLinks}`,
      });
      if (success) markAlertAsSent(alertKey);
      return { acao: 'alertada', id: novaOpp.id };
    }

    // Casa(s) sem scraper: inconfirmável — alerta com as odds DO PRINT e tag ⚠️
    // (decisão do usuário: não descartar; ele confere manualmente).
    const semScraper = [
      !casaTemScraper(opp.casaA) ? opp.casaA : null,
      !casaTemScraper(opp.casaB) ? opp.casaB : null,
    ].filter(Boolean).join(', ');

    console.log(`✉️ [Telegram] Disparando alerta NÃO REVALIDADO (${semScraper} sem scraper) para: ${opp.evento}`);
    const success = await new WhatsAppNotifier().enviarAlerta({
      evento: opp.evento,
      mercado: opp.mercado,
      opcao1: opp.opcaoA,
      opcao2: opp.opcaoB,
      odd1: opp.oddA,
      odd2: opp.oddB,
      stake1: parseFloat(distr.apostaA),
      stake2: parseFloat(distr.apostaB),
      investimento: banca,
      lucro: parseFloat(distr.lucroR$),
      roi,
      casa1: opp.casaA,
      casa2: opp.casaB,
      esporte: opp.esporte,
      dataPartida: (opp.evento.match(/\((\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})\)\s*$/) || [])[1],
      fonte: rotuloAlerta,
      link1,
      link2,
      nota: `⚠️ NÃO REVALIDADO — casa(s) sem verificação automática (${semScraper}). Confirme as odds nas casas antes de apostar.${notaQuarter}${notaLinks}`,
    });
    if (success) markAlertAsSent(alertKey);
    return { acao: 'alertada_nao_revalidada', id: novaOpp.id };
  }
}
