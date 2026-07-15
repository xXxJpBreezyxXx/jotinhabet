import { ArbitrageEngine, ArbitrageOpportunity } from '../arbitrage/engine';
import { OddsScraper } from '../scraping/scraper_base';
import { BetanoScraper } from '../scraping/casa_a';
import { KtoScraper } from '../scraping/casa_kambi';
import { SuperbetScraper } from '../scraping/casa_superbet';
import { BlazeScraper } from '../scraping/casa_blaze';
import { OneXBetScraper } from '../scraping/casa_1xbet';
import { PinnacleScraper } from '../scraping/casa_pinnacle';
import { SureRadarScraper } from '../scraping/casa_sureradar';
import { supabase } from '../db/client';
import { WhatsAppNotifier } from '../notify/whatsapp';
import * as fs from 'fs';
import * as path from 'path';

// Cache helpers to prevent duplicate WhatsApp alerts
function alertAlreadySent(key: string): boolean {
  const cachePath = path.resolve(__dirname, '../../logs/sent_alerts.json');
  try {
    if (!fs.existsSync(path.dirname(cachePath))) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    }
    if (!fs.existsSync(cachePath)) {
      fs.writeFileSync(cachePath, JSON.stringify([]));
      return false;
    }
    const content = fs.readFileSync(cachePath, 'utf8');
    const sentList: string[] = JSON.parse(content);
    return sentList.includes(key);
  } catch (err) {
    console.error('⚠️ [Tracker] Erro ao ler cache de alertas enviados:', err);
    return false;
  }
}

function markAlertAsSent(key: string) {
  const cachePath = path.resolve(__dirname, '../../logs/sent_alerts.json');
  try {
    const content = fs.readFileSync(cachePath, 'utf8');
    const sentList: string[] = JSON.parse(content);
    sentList.push(key);
    if (sentList.length > 1000) {
      sentList.shift(); // Evita crescimento infinito
    }
    fs.writeFileSync(cachePath, JSON.stringify(sentList, null, 2));
  } catch (err) {
    console.error('⚠️ [Tracker] Erro ao salvar cache de alertas enviados:', err);
  }
}

// Verifica se o evento ocorre hoje ou amanhã
function isTodayOrTomorrow(eventoStr: string): boolean {
  const lower = eventoStr.toLowerCase();
  
  // Se contiver explicitamente "(Hoje" ou "(Amanhã"
  if (lower.includes('(hoje') || lower.includes('(amanha')) {
    return true;
  }

  // Tenta extrair a data no formato (DD/MM/AAAA HH:MM) ou (DD/MM HH:MM)
  const match = eventoStr.match(/\((\d{2})\/(\d{2})(?:\/(\d{4}))?\s+(\d{2}):(\d{2})\)$/);
  if (!match) {
    // Se não tiver data formatada de forma clara, por segurança retornamos true
    return true;
  }

  const day = parseInt(match[1]);
  const month = parseInt(match[2]) - 1; // 0-indexed month
  const currentYear = new Date().getFullYear();
  const year = match[3] ? parseInt(match[3]) : currentYear;

  const eventDate = new Date(year, month, day);
  
  // Zera as horas para comparar apenas os dias
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const eventTime = eventDate.getTime();
  const todayTime = today.getTime();
  const tomorrowTime = tomorrow.getTime();

  return eventTime === todayTime || eventTime === tomorrowTime;
}

// Converte a string de data/hora do evento em um objeto Date do JavaScript
function parseEventDateTime(eventoStr: string): Date | null {
  const lower = eventoStr.toLowerCase();
  
  // Tenta extrair a hora (HH:MM)
  const timeMatch = eventoStr.match(/(\d{2}):(\d{2})/);
  if (!timeMatch) return null;
  const hours = parseInt(timeMatch[1]);
  const minutes = parseInt(timeMatch[2]);

  const date = new Date();
  
  // 1. Caso: "(Hoje 15:30)" ou "(Hoje)"
  if (lower.includes('(hoje')) {
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  // 2. Caso: "(Amanhã 18:00)" ou "(Amanha"
  if (lower.includes('(amanha')) {
    date.setDate(date.getDate() + 1);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  // 3. Caso: "(DD/MM HH:MM)" ou "(DD/MM/AAAA HH:MM)"
  const dateMatch = eventoStr.match(/\((\d{2})\/(\d{2})(?:\/(\d{4}))?/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]) - 1; // 0-indexed month
    const year = dateMatch[3] ? parseInt(dateMatch[3]) : date.getFullYear();
    return new Date(year, month, day, hours, minutes, 0, 0);
  }

  return null;
}

export class ArbitrageScannerV2 {
  private scrapers: OddsScraper[] = [
    new BetanoScraper(),
    new KtoScraper(),
    new SuperbetScraper(),
    new PinnacleScraper(),
    new BlazeScraper(),
    new OneXBetScraper()
  ];
  private engine = new ArbitrageEngine();

  /** Nomes dos scrapers que usam API direta (rápidos, sem browser) — usados no modo apenasApi. */
  private static readonly SCRAPERS_API = new Set(['KTO', 'Superbet', 'BetWarrior', 'Aposta1', 'BetBoom', 'BetPix365', 'EsportesDaSorte', 'Pinnacle']);

  /**
   * @param apenasApi quando true, o cruzamento entre casas usa SÓ os scrapers de API
   *   (rápidos, sem Playwright) — permite rodar de forma frequente no scheduler.
   */
  async executarVarredura(dataFiltro?: string, aoVivo?: boolean, sureradarOnly?: boolean, apenasApi?: boolean): Promise<any[]> {
    // 🧹 Limpeza de banco: deletar todas as oportunidades do banco com mais de 24 horas
    try {
      const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { error: deleteError } = await supabase
        .from('oportunidades')
        .delete()
        .lt('detectada_em', limite24h);

      if (deleteError) {
        console.error('⚠️ [Scanner V2] Erro ao limpar oportunidades antigas (>24h):', deleteError);
      } else {
        console.log(`🧹 [Scanner V2] Limpeza de banco concluída (oportunidades >24h removidas).`);
      }
    } catch (cleanErr) {
      console.error('⚠️ [Scanner V2] Erro na limpeza de dados antigos:', cleanErr);
    }

    const oportunidadesGerais: ArbitrageOpportunity[] = [];

    if (sureradarOnly) {
      console.log(`\n🔍 [Scanner V2] Iniciando varredura RÁPIDA (Apenas SureRadar)...`);
    } else {
      const scrapersUsados = apenasApi
        ? this.scrapers.filter((s) => ArbitrageScannerV2.SCRAPERS_API.has(s.getNome()))
        : this.scrapers;
      console.log(
        `\n🔍 [Scanner V2] Iniciando varredura ${apenasApi ? 'API' : 'COMPLETA'} (${scrapersUsados.map((s) => s.getNome()).join(', ')} + SureRadar)...`
      );
      const esportes = ['Futebol', 'Basquete', 'Tenis'];
      const datas = [dataFiltro || 'Hoje'];

      const todasOdds: any[] = [];

      // Coleta sequencial para evitar estouro de memória no modo Headless
      for (const scraper of scrapersUsados) {
        try {
          const odds = await scraper.executarCrawler(esportes, datas, true);
          todasOdds.push({ nome: scraper.getNome(), odds });
        } catch (err: any) {
          console.error(`❌ Erro no scraper ${scraper.getNome()}: ${err.message}`);
        }
      }

      console.log('⚡ [Scanner V2] Cruzando mercados e buscando Surebets...');
      // Compara todas contra todas (Combinatória)
      for (let i = 0; i < todasOdds.length; i++) {
        for (let j = i + 1; j < todasOdds.length; j++) {
          const casa1 = todasOdds[i];
          const casa2 = todasOdds[j];
          
          if (casa1.odds.length > 0 && casa2.odds.length > 0) {
            const ops = await this.engine.encontrarOportunidades(casa1.nome, casa1.odds, casa2.nome, casa2.odds);
            oportunidadesGerais.push(...ops);
          }
        }
      }
    }

    // ⚡ [Scanner V2] Extrai oportunidades consolidadas do SureRadar
    const sureradarScraper = new SureRadarScraper();
    let srOps: ArbitrageOpportunity[] = [];
    try {
      srOps = await sureradarScraper.extrairOportunidades();
      if (srOps.length > 0) {
        console.log(`⚡ [Scanner V2] Importando ${srOps.length} surebets diretas do SureRadar!`);
        oportunidadesGerais.push(...srOps);
      }
    } catch (err: any) {
      console.error(`❌ Erro ao extrair dados do SureRadar:`, err.message);
    }

    // Obter o saldo atual da banca com base no histórico de lucros reais (banca inicial = 50.00)
    let bancaAtual = 50.00;
    try {
      const { data: operations } = await supabase
        .from('operacoes')
        .select('lucro_real');
      
      if (operations && operations.length > 0) {
        const lucroAcumulado = operations.reduce((sum, op) => sum + (Number(op.lucro_real) || 0), 0);
        bancaAtual = 50.00 + lucroAcumulado;
      }
    } catch (err) {
      console.error('⚠️ [Scanner V2] Erro ao obter lucro acumulado do banco para a banca atual:', err);
    }
    if (bancaAtual < 1.0) {
      bancaAtual = 50.00;
    }

    // Persiste no Supabase
    const oportunidadesSalvas = [];
    for (const opp of oportunidadesGerais) {
      const stake = bancaAtual;
      const distr = this.engine.calcularDistribuicaoStake(opp, stake);

      try {
        const payload: any = {
          evento: opp.evento,
          odd_casa_1: opp.oddA,
          odd_casa_2: opp.oddB,
          margem_mercado: 100 - (100 / opp.lucroGarantidoPerc), // Valor aproximado da margem
          stake_casa_1: distr.apostaA,
          stake_casa_2: distr.apostaB,
          lucro_esperado: distr.lucroR$,
          roi_pct: opp.lucroGarantidoPerc,
          status: 'detectada'
        };

        // Usa fallback se as colunas não existirem (trata erro e insere sem elas)
        const { error: testError } = await supabase.from('oportunidades').select('casa_a_nome').limit(1);
        const { error: testSportError } = await supabase.from('oportunidades').select('esporte').limit(1);
        
        if (!testError || testError.code !== 'PGRST204') {
            payload.casa_a_nome = opp.casaA;
            payload.casa_b_nome = opp.casaB;
            payload.opcao_a = opp.opcaoA;
            payload.opcao_b = opp.opcaoB;
            payload.mercado = opp.mercado;
            payload.analise_ia = opp.analiseIA || null;
            
            if (!testSportError) {
                payload.esporte = opp.esporte || null;
                payload.url = opp.url || null;
            }
        } else {
            // Fallback (serializa no nome)
            payload.evento = `${opp.evento} | ${opp.casaA}(${opp.opcaoA}) vs ${opp.casaB}(${opp.opcaoB})`;
        }

        // Evita duplicatas no banco de dados para a mesma surebet ativa
        let existingId: string | null = null;
        try {
          const checkQuery = supabase
            .from('oportunidades')
            .select('id')
            .eq('evento', payload.evento)
            .eq('status', 'detectada');

          if (payload.casa_a_nome) {
            checkQuery.eq('casa_a_nome', payload.casa_a_nome)
                      .eq('casa_b_nome', payload.casa_b_nome)
                      .eq('mercado', payload.mercado || '');
          }

          const { data: existingOpps } = await checkQuery.limit(1);
          if (existingOpps && existingOpps.length > 0) {
            existingId = existingOpps[0].id;
          }
        } catch (checkErr) {
          console.error(`⚠️ Erro ao checar duplicata no banco:`, checkErr);
        }

        if (existingId) {
          // Reconfirma: a surebet ainda está no SureRadar → atualiza "visto_em" para que a
          // idade da odd reflita a última vez vista (o SureRadar atualiza a cada ~10 min),
          // e não a primeira detecção. (Coluna vem da migration 007.)
          try {
            await supabase.from('oportunidades').update({ visto_em: new Date().toISOString() }).eq('id', existingId);
          } catch {
            /* coluna visto_em pode não existir ainda; sem impacto */
          }
          console.log(`ℹ️ [Scanner V2] Surebet já ativa (visto_em atualizado): ${opp.evento}`);
          continue;
        }

        const { data: novaOpp, error: insertError } = await supabase
          .from('oportunidades')
          .insert(payload)
          .select()
          .single();

        if (insertError) {
           console.error(`⚠️ Erro ao salvar surebet:`, insertError);
        } else if (novaOpp) {
           oportunidadesSalvas.push(novaOpp);

            // Ignora se o usuário já tiver feito a entrada desta oportunidade
            let alreadyEntered = false;
            try {
              const { data: opCheck } = await supabase
                .from('operacoes')
                .select('id')
                .eq('evento', opp.evento)
                .limit(1);
              if (opCheck && opCheck.length > 0) {
                alreadyEntered = true;
              }
            } catch (err) {
              console.error('⚠️ [Scanner V2] Erro ao checar se evento já possui aposta confirmada:', err);
            }
            
            // Decide se alerta no WhatsApp. Duas fontes:
            //  - SureRadar (curado): ROI >= 5%.
            //  - Motor próprio (cruzamento entre casas): exige alta CONFIANÇA e ROI numa
            //    faixa sã (2-15%) e sem alerta de precisão — evita spam de falso positivo
            //    (ROI absurdo = odd travada/erro; horário/time incerto já foram sinalizados).
            const ehSureRadar = !!opp.url?.includes('sureradar');
            const roi = opp.lucroGarantidoPerc;
            const alertarSureRadar = ehSureRadar && roi >= 5.0;
            const alertarMotor =
              !ehSureRadar && (opp.confianca ?? 0) >= 0.9 && roi >= 2.0 && roi <= 15.0 && !opp.alertaPrecisao;

            if (!alreadyEntered && isTodayOrTomorrow(opp.evento) && (alertarSureRadar || alertarMotor)) {
             const fonte = ehSureRadar ? 'SureRadar' : 'Motor';
             const alertKey = `${fonte}_${opp.evento.trim()}_${opp.mercado.trim()}_${opp.casaA.trim()}_${opp.casaB.trim()}_${roi.toFixed(1)}`;
             if (!alertAlreadySent(alertKey)) {
               console.log(`✉️ [WhatsApp] Disparando alerta ${fonte} (ROI ${roi}%${ehSureRadar ? '' : `, conf ${opp.confianca}`}) para: ${opp.evento}`);
               const notifier = new WhatsAppNotifier();
               const success = await notifier.enviarAlerta({
                 evento: opp.evento,
                 mercado: opp.mercado,
                 opcao1: opp.opcaoA,
                 opcao2: opp.opcaoB,
                 odd1: opp.oddA,
                 odd2: opp.oddB,
                 stake1: parseFloat(distr.apostaA),
                 stake2: parseFloat(distr.apostaB),
                 investimento: stake,
                 lucro: parseFloat(distr.lucroR$),
                 roi: roi,
                 casa1: opp.casaA,
                 casa2: opp.casaB,
                 esporte: opp.esporte,
                 dataPartida: (opp.evento.match(/\((\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})\)\s*$/) || [])[1],
                 nota: ehSureRadar
                   ? undefined
                   : `Cruzamento próprio ${opp.casaA} × ${opp.casaB} · confiança ${Math.round((opp.confianca ?? 0) * 100)}%`,
               });
               if (success) {
                 markAlertAsSent(alertKey);
               }
             } else {
               console.log(`ℹ️ [WhatsApp] Alerta ignorado (já enviado): ${opp.evento} (${roi}%)`);
             }
           }
        }
      } catch (err) {
        console.error(`⚠️ Erro silencioso no Supabase:`, err);
      }
    }

    // Reconciliação: remove do banco as surebets do SureRadar que sumiram da lista atual
    // (odd corrigida/expirada) — evita acumular oportunidades inválidas entre scans.
    // SÓ com fonte 'api' (autoritativa): o fallback via browser não enxerga as VIP/locked,
    // e reconciliar com essa lista parcial apagaria surebets válidas de alto ROI do banco.
    if (sureradarScraper.ultimaFonte === 'api') {
      await this.reconciliarSureRadar(srOps);
    } else if (srOps.length > 0) {
      console.log(`ℹ️ [Scanner V2] Reconciliação pulada (fonte: ${sureradarScraper.ultimaFonte} — lista parcial).`);
    }

    console.log(`📊 [Scanner V2] Varredura finalizada. ${oportunidadesSalvas.length} surebets salvas no banco.`);
    return oportunidadesSalvas;
  }

  /** Assinatura estável de uma surebet (evento sem sufixo de tempo + casas ordenadas + mercado). */
  private assinaturaSurebet(evento: string, casaA: string, casaB: string, mercado: string): string {
    const n = (s: any) => (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    const eventoBase = (evento || '').replace(/\s*\([^)]*\)\s*$/, ''); // remove "(DD/MM HH:MM)" no fim
    const casas = [n(casaA), n(casaB)].sort().join('|');
    return `${n(eventoBase)}||${casas}||${n(mercado)}`;
  }

  /**
   * Remove as oportunidades do SureRadar ('detectada') que não estão mais na lista fresca.
   * Guarda: se a lista fresca vier vazia (scrape falho/indisponível), NÃO remove nada.
   * Auto-corrigível: se algo for removido por engano, o próximo scan (10 min) reinsere.
   */
  private async reconciliarSureRadar(freshOps: ArbitrageOpportunity[]): Promise<void> {
    if (!freshOps || freshOps.length === 0) return;
    const validos = new Set(freshOps.map((o) => this.assinaturaSurebet(o.evento, o.casaA, o.casaB, o.mercado)));
    try {
      const { data: rows, error } = await supabase
        .from('oportunidades')
        .select('id, evento, casa_a_nome, casa_b_nome, mercado')
        .eq('status', 'detectada')
        .ilike('url', '%sureradar%');
      if (error || !rows || rows.length === 0) return;

      const idsRemover = rows
        .filter((r) => !validos.has(this.assinaturaSurebet(r.evento, r.casa_a_nome, r.casa_b_nome, r.mercado)))
        .map((r) => r.id);

      if (idsRemover.length > 0) {
        const { error: delErr } = await supabase.from('oportunidades').delete().in('id', idsRemover);
        if (delErr) {
          console.error('⚠️ [Scanner V2] Erro ao reconciliar (remover sumidas):', delErr.message);
        } else {
          console.log(`🧹 [Scanner V2] Reconciliação: ${idsRemover.length} surebet(s) que sumiram do SureRadar removida(s).`);
        }
      }
    } catch (e: any) {
      console.error('⚠️ [Scanner V2] Erro na reconciliação com SureRadar:', e?.message || e);
    }
  }

  /**
   * Limpa as oportunidades cuja data e hora do evento já passaram.
   */
  async limparOportunidadesExpiradas(): Promise<number> {
    console.log('🧹 [Scanner V2] Iniciando varredura para limpar surebets expiradas do banco...');
    try {
      // 1. Busca todas as oportunidades ativas do Supabase
      const { data: opportunities, error } = await supabase
        .from('oportunidades')
        .select('id, evento');

      if (error) {
        console.error('⚠️ [Scanner V2] Erro ao buscar oportunidades para limpeza:', error);
        return 0;
      }

      if (!opportunities || opportunities.length === 0) {
        return 0;
      }

      const idsToDelete: string[] = [];
      const now = new Date();

      for (const opp of opportunities) {
        const eventDate = parseEventDateTime(opp.evento);
        if (eventDate && eventDate < now) {
          idsToDelete.push(opp.id);
        }
      }

      if (idsToDelete.length > 0) {
        console.log(`🧹 [Scanner V2] Deletando ${idsToDelete.length} oportunidades expiradas do banco...`);
        const { error: deleteError } = await supabase
          .from('oportunidades')
          .delete()
          .in('id', idsToDelete);

        if (deleteError) {
          console.error('⚠️ [Scanner V2] Erro ao deletar oportunidades expiradas:', deleteError);
          return 0;
        }
        
        console.log(`✅ [Scanner V2] Sucesso: ${idsToDelete.length} oportunidades antigas deletadas.`);
        return idsToDelete.length;
      }
      
      console.log('🧹 [Scanner V2] Nenhuma oportunidade expirada encontrada.');
      return 0;
    } catch (err) {
      console.error('⚠️ [Scanner V2] Erro na limpeza de expiradas:', err);
      return 0;
    }
  }
}
