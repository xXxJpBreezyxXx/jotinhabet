import dotenv from 'dotenv';
dotenv.config();

export interface WhatsAppAlert {
  evento: string;
  mercado: string;
  opcao1: string;
  opcao2: string;
  odd1: number;
  odd2: number;
  stake1: number;
  stake2: number;
  investimento: number;
  lucro: number;
  roi: number;
  casa1?: string;
  casa2?: string;
  nota?: string;        // linha extra (ex.: confiança para surebets do motor próprio)
  esporte?: string;     // ex.: "Futebol", "Tênis"
  dataPartida?: string; // ex.: "15/07/2026 10:00"
  fonte?: string;       // origem da oportunidade: "SureRadar" | "Pré-match (motor próprio)"
  link1?: string;       // link DIRETO da aposta na casa 1 (ex.: vindo do grupo do Telegram)
  link2?: string;       // link DIRETO da aposta na casa 2 — sem eles, cai no link genérico da casa
}

export class WhatsAppNotifier {
  private apiUrl: string;
  private apiKey: string;
  private instanceName: string;
  private recipient: string;

  /**
   * @param recipientOverride destino alternativo (grupo/contato/número). Quando
   * informado e não-vazio, substitui EVOLUTION_RECIPIENT — permite mandar alertas de
   * módulos diferentes (ex.: Radar Cashout) para grupos distintos. Sem ele, mantém o
   * comportamento antigo (EVOLUTION_RECIPIENT).
   */
  constructor(recipientOverride?: string) {
    this.apiUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); // Remove barra no final
    this.apiKey = process.env.EVOLUTION_API_KEY || '';
    this.instanceName = process.env.EVOLUTION_INSTANCE || '';
    this.recipient = (recipientOverride && recipientOverride.trim()) || process.env.EVOLUTION_RECIPIENT || '';
  }

  /**
   * Resolve o destino do envio a partir de EVOLUTION_RECIPIENT:
   *  - JID (grupo "…@g.us" ou contato "…@s.whatsapp.net") → usado COMO ESTÁ.
   *  - número de telefone → mantém só os dígitos (remove +, espaços, etc.).
   * Sem isto, um JID de grupo perderia o sufixo "@g.us" no replace(/\D/g) e a
   * Evolution não o reconheceria como grupo.
   */
  private formatarDestino(recipient: string): string {
    const r = (recipient || '').trim();
    if (r.includes('@')) return r; // já é um JID (grupo/contato)
    return r.replace(/\D/g, '');   // número de telefone
  }

  /**
   * Memo do token da instância (chave: nome da instância). O token só muda quando a
   * instância é recriada, e cada envio pagava um GET /instance/all — com o agente no
   * WhatsApp (resposta longa fatiada em 3 mensagens + presença + marcar lido) isso
   * virava 5 requests extras por pergunta.
   */
  private static tokenCache = new Map<string, { token: string; at: number }>();
  private static readonly TOKEN_TTL_MS = 10 * 60_000;

  /**
   * Busca no Evolution GO o token da instância configurada (necessário para enviar).
   * Retorna null (e loga) se as instâncias não puderem ser lidas ou a instância não existir.
   */
  private async obterTokenInstancia(): Promise<string | null> {
    const memo = WhatsAppNotifier.tokenCache.get(this.instanceName);
    if (memo && Date.now() - memo.at < WhatsAppNotifier.TOKEN_TTL_MS) return memo.token;
    console.log(`✉️ [WhatsApp] Buscando token da instância "${this.instanceName}" no Evolution GO...`);
    const instancesResponse = await fetch(`${this.apiUrl}/instance/all`, {
      method: 'GET',
      headers: { apikey: this.apiKey },
    });
    if (!instancesResponse.ok) {
      const errText = await instancesResponse.text();
      console.error(`❌ [WhatsApp] Falha ao obter instâncias da Evolution GO (${instancesResponse.status}):`, errText);
      return null;
    }
    const instancesJson: any = await instancesResponse.json();
    const targetInstance = (instancesJson.data || []).find((inst: any) => inst.name === this.instanceName);
    if (!targetInstance) {
      console.error(`❌ [WhatsApp] Instância "${this.instanceName}" não encontrada no servidor.`);
      return null;
    }
    if (!targetInstance.connected) {
      console.warn(`⚠️ [WhatsApp] Instância "${this.instanceName}" está desconectada do WhatsApp.`);
    }
    if (targetInstance.token) {
      WhatsAppNotifier.tokenCache.set(this.instanceName, { token: targetInstance.token, at: Date.now() });
    }
    return targetInstance.token;
  }

  /** Config mínima presente? (usado por todos os envios antes de tocar a rede) */
  private configurado(): boolean {
    return !!(
      this.apiUrl &&
      this.apiKey &&
      this.instanceName &&
      this.recipient &&
      !this.recipient.includes('xxxxx')
    );
  }

  /**
   * Marca mensagens como LIDAS no chat de destino (best-effort).
   * Usado pelo agente no WhatsApp: sem isto, quem pergunta vê a mensagem "não lida" por
   * mais de um minuto enquanto o agente consulta as casas.
   */
  async marcarLido(ids: string[]): Promise<void> {
    if (!this.configurado() || !ids.length) return;
    try {
      const token = await this.obterTokenInstancia();
      if (!token) return;
      await fetch(`${this.apiUrl}/message/markread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: token },
        body: JSON.stringify({ number: this.formatarDestino(this.recipient), id: ids }),
      });
    } catch {
      /* presença/recibo são cosméticos: nunca podem derrubar o fluxo de resposta */
    }
  }

  /**
   * Baixa a MÍDIA de uma mensagem recebida (imagem/documento) pela Evolution.
   *
   * O webhook não traz os bytes: traz o objeto `Message` com a URL criptografada e as
   * chaves. `POST /message/downloadmedia` recebe esse objeto DE VOLTA e devolve o
   * conteúdo — em base64 (campo variável por versão) ou binário.
   *
   * @param mensagem o `data.Message` cru do webhook.
   * @returns base64 SEM prefixo data-URI + mimeType, ou null se não vier nada.
   */
  async baixarMidia(mensagem: any): Promise<{ base64: string; mimeType: string } | null> {
    if (!this.configurado() || !mensagem) return null;
    try {
      const token = await this.obterTokenInstancia();
      if (!token) return null;
      const r = await fetch(`${this.apiUrl}/message/downloadmedia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: token },
        body: JSON.stringify({ message: mensagem }),
      });
      if (!r.ok) {
        console.error(`❌ [WhatsApp] downloadmedia falhou (${r.status}):`, (await r.text()).slice(0, 200));
        return null;
      }
      const tipoResposta = r.headers.get('content-type') || '';
      if (/application\/json/.test(tipoResposta)) {
        const j: any = await r.json();
        // A chave do base64 muda por versão: aceita as conhecidas e, no limite, a 1ª string
        // grande do objeto (é sempre o payload).
        const alvo = j?.data ?? j;
        const b64 =
          alvo?.base64 ?? alvo?.media ?? alvo?.buffer ?? alvo?.data ??
          Object.values(alvo || {}).find((v) => typeof v === 'string' && v.length > 1000);
        if (typeof b64 !== 'string' || b64.length < 100) {
          console.error('❌ [WhatsApp] downloadmedia sem base64 reconhecível:', JSON.stringify(j).slice(0, 200));
          return null;
        }
        return {
          base64: b64.replace(/^data:[^;]+;base64,/, ''),
          mimeType: alvo?.mimetype || alvo?.mimeType || 'image/jpeg',
        };
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return null;
      return { base64: buf.toString('base64'), mimeType: tipoResposta.split(';')[0] || 'image/jpeg' };
    } catch (err: any) {
      console.error('❌ [WhatsApp] erro no download de mídia:', `${err?.message || err}`.slice(0, 160));
      return null;
    }
  }

  /**
   * Indicador de "digitando…"/"parado" no chat (best-effort).
   * @param estado 'composing' | 'paused' | 'recording'
   * @param manterMs mantém o indicador vivo por N ms (a Evolution reenvia sozinha e
   * depois manda 'paused'); 0 = disparo único.
   */
  async presenca(estado: 'composing' | 'paused' | 'recording', manterMs = 0): Promise<void> {
    if (!this.configurado()) return;
    try {
      const token = await this.obterTokenInstancia();
      if (!token) return;
      await fetch(`${this.apiUrl}/message/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: token },
        body: JSON.stringify({
          number: this.formatarDestino(this.recipient),
          state: estado,
          ...(estado === 'composing' && manterMs > 0 ? { delay: Math.min(60_000, Math.round(manterMs)) } : {}),
        }),
      });
    } catch {
      /* idem: cosmético */
    }
  }

  /**
   * Best-effort: lista os grupos do WhatsApp (subject + JID "…@g.us"), para descobrir
   * qual JID colocar em EVOLUTION_RECIPIENT. A rota de grupos varia por versão do
   * evolution-go; tenta uma lista de candidatos e devolve a 1ª que responder com grupos.
   * Se nenhuma responder, veja o Swagger em <EVOLUTION_API_URL>/swagger/index.html.
   */
  async listarGrupos(): Promise<Array<{ subject: string; id: string }>> {
    if (!this.apiUrl || !this.apiKey || !this.instanceName) {
      console.warn('⚠️ [WhatsApp] Configuração da Evolution API incompleta no .env.');
      return [];
    }
    const token = await this.obterTokenInstancia();
    if (!token) return [];

    const candidatos = ['/group/all', '/group/list', '/groups', '/group/fetchAll', '/chat/all', '/chats'];
    for (const path of candidatos) {
      try {
        const r = await fetch(`${this.apiUrl}${path}`, { headers: { apikey: token } });
        if (!r.ok) continue;
        const j: any = await r.json();
        const arr = Array.isArray(j) ? j : j.data || j.groups || j.chats || [];
        const grupos = (Array.isArray(arr) ? arr : [])
          .map((g: any) => ({
            subject: g.subject || g.name || g.pushName || '(sem nome)',
            id: g.id || g.jid || g.remoteJid || '',
          }))
          .filter((g: any) => /@g\.us$/i.test(g.id));
        if (grupos.length) {
          console.log(`   [WhatsApp] ${grupos.length} grupo(s) via ${path}`);
          return grupos;
        }
      } catch {
        /* tenta o próximo candidato */
      }
    }
    console.warn('⚠️ [WhatsApp] Nenhuma rota de grupos respondeu. Confira <EVOLUTION_API_URL>/swagger/index.html.');
    return [];
  }

  /**
   * Obtém o link direto da casa de aposta.
   */
  private obterLinkCasa(casaName: string): string {
    const c = casaName.toLowerCase();
    if (c.includes('betano')) return 'https://www.betano.bet.br';
    if (c.includes('kto')) return 'https://www.kto.bet.br';
    if (c.includes('superbet')) return 'https://superbet.bet.br';
    if (c.includes('blaze')) return 'https://blaze.bet.br';
    if (c.includes('1xbet')) return 'https://1xbet.bet.br';
    if (c.includes('betnacional')) return 'https://betnacional.bet.br';
    if (c.includes('seubet') || c.includes('seu.bet')) return 'https://www.seu.bet.br';
    if (c.includes('betboom')) return 'https://betboom.bet.br';
    if (c.includes('esportesdasorte')) return 'https://esportesdasorte.bet.br';
    if (c.includes('betwarrior')) return 'https://apostas.betwarrior.bet.br';
    if (c.includes('aposta1')) return 'https://www.aposta1.bet.br';
    if (c.includes('estrela')) return 'https://www.estrelabet.bet.br';
    if (c.includes('4play') || c.includes('fourplay')) return 'https://4play.bet.br';
    if (c.includes('bolsa')) return 'https://bolsadeaposta.bet.br';
    if (c.includes('pinnacle')) return 'https://www.pinnacle.com';
    if (c.includes('pixbet')) return 'https://pixbet.com';
    if (c.includes('sportingbet')) return 'https://sportingbet.com';
    if (c.includes('bet365')) return 'https://www.bet365.com';
    return `https://www.google.com/search?q=${encodeURIComponent(casaName)}`;
  }

  /**
   * Envia uma mensagem de TEXTO LIVRE para o destino configurado (grupo/contato).
   * Usado para avisos operacionais (ex.: deploy concluído) — os alertas de surebet
   * continuam no enviarAlerta (formatado).
   */
  async enviarTexto(texto: string): Promise<boolean> {
    if (!this.configurado()) {
      console.warn('⚠️ [WhatsApp] Configuração da Evolution API incompleta no .env.');
      return false;
    }
    const destino = this.formatarDestino(this.recipient);
    try {
      const instanceToken = await this.obterTokenInstancia();
      if (!instanceToken) return false;
      const response = await fetch(`${this.apiUrl}/send/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: instanceToken },
        body: JSON.stringify({ number: destino, text: texto }),
      });
      if (!response.ok) {
        console.error(`❌ [WhatsApp] Falha ao enviar texto (${response.status}):`, await response.text());
        return false;
      }
      console.log('✅ [WhatsApp] Mensagem de texto enviada.');
      return true;
    } catch (err: any) {
      console.error('❌ [WhatsApp] Erro no envio de texto:', err.message || err);
      return false;
    }
  }

  /**
   * Envia um alerta de arbitragem estruturado e formatado para o WhatsApp.
   */
  async enviarAlerta(alert: WhatsAppAlert): Promise<boolean> {
    if (!this.configurado()) {
      console.warn('⚠️ [WhatsApp] Configuração da Evolution API incompleta ou usando número placeholder no .env.');
      return false;
    }

    const mensagem = this.formatarMensagem(alert);
    const destino = this.formatarDestino(this.recipient);
    const ehGrupo = /@g\.us$/i.test(destino);

    try {
      const instanceToken = await this.obterTokenInstancia();
      if (!instanceToken) return false;

      const sendEndpoint = `${this.apiUrl}/send/text`;
      console.log(
        `✉️ [WhatsApp] Enviando alerta de surebet para ${ehGrupo ? 'o grupo' : 'o número'} ${destino} usando a instância "${this.instanceName}"...`
      );

      const response = await fetch(sendEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': instanceToken
        },
        body: JSON.stringify({
          number: destino,
          text: mensagem
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [WhatsApp] Falha ao enviar mensagem pela Evolution GO (${response.status}):`, errorText);
        return false;
      }

      console.log('✅ [WhatsApp] Alerta de surebet enviado com sucesso via WhatsApp!');
      return true;
    } catch (err: any) {
      console.error('❌ [WhatsApp] Erro na requisição de envio de WhatsApp:', err.message || err);
      return false;
    }
  }


  private formatarMensagem(a: WhatsAppAlert): string {
    const casaA = a.casa1 || 'Casa 1';
    const casaB = a.casa2 || 'Casa 2';
    const linkA = a.link1 || this.obterLinkCasa(casaA);
    const linkB = a.link2 || this.obterLinkCasa(casaB);

    const linhaEsporte = [a.esporte, a.dataPartida].filter(Boolean).join(' • ');

    return `🔥 *SUREBET: ${a.roi.toFixed(2)}% ROI* 🔥${a.fonte ? `\n📡 *${a.fonte}*` : ''}

🏆 *${a.evento}*${linhaEsporte ? `\n🏅 ${linhaEsporte}` : ''}
🎯 Mercado: ${a.mercado}

🟢 *${casaA}* - ${a.opcao1}
👉 Odd: *${a.odd1.toFixed(2)}* | Aporte: *R$ ${a.stake1.toFixed(2)}*
🔗 Abrir: ${linkA}

🟢 *${casaB}* - ${a.opcao2}
👉 Odd: *${a.odd2.toFixed(2)}* | Aporte: *R$ ${a.stake2.toFixed(2)}*
🔗 Abrir: ${linkB}

📊 Lucro: *R$ ${a.lucro.toFixed(2)}* (Total: R$ ${a.investimento.toFixed(2)})${a.nota ? `\n🧭 ${a.nota}` : ''}

⏱️ _Odds coletadas agora. As cotações mudam rápido — revalide no painel antes de apostar._`;
  }
}
