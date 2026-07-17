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
}

export class WhatsAppNotifier {
  private apiUrl: string;
  private apiKey: string;
  private instanceName: string;
  private recipient: string;

  constructor() {
    this.apiUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); // Remove barra no final
    this.apiKey = process.env.EVOLUTION_API_KEY || '';
    this.instanceName = process.env.EVOLUTION_INSTANCE || '';
    this.recipient = process.env.EVOLUTION_RECIPIENT || '';
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
   * Busca no Evolution GO o token da instância configurada (necessário para enviar).
   * Retorna null (e loga) se as instâncias não puderem ser lidas ou a instância não existir.
   */
  private async obterTokenInstancia(): Promise<string | null> {
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
    return targetInstance.token;
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
    if (c.includes('betwarrior')) return 'https://apostas.betwarrior.bet.br';
    if (c.includes('aposta1')) return 'https://www.aposta1.bet.br';
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
    if (!this.apiUrl || !this.apiKey || !this.instanceName || !this.recipient || this.recipient.includes('xxxxx')) {
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
    if (!this.apiUrl || !this.apiKey || !this.instanceName || !this.recipient || this.recipient.includes('xxxxx')) {
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
    const linkA = this.obterLinkCasa(casaA);
    const linkB = this.obterLinkCasa(casaB);

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
