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
   * Obtém o link direto da casa de aposta.
   */
  private obterLinkCasa(casaName: string): string {
    const c = casaName.toLowerCase();
    if (c.includes('betano')) return 'https://www.betano.bet.br';
    if (c.includes('kto')) return 'https://www.kto.bet.br';
    if (c.includes('superbet')) return 'https://superbet.bet.br';
    if (c.includes('blaze')) return 'https://blaze.bet.br';
    if (c.includes('1xbet')) return 'https://1xbet.bet.br';
    if (c.includes('betnacional')) return 'https://betnacional.com';
    if (c.includes('seubet')) return 'https://www.seubet.com';
    if (c.includes('pixbet')) return 'https://pixbet.com';
    if (c.includes('sportingbet')) return 'https://sportingbet.com';
    if (c.includes('bet365')) return 'https://www.bet365.com';
    return `https://www.google.com/search?q=${encodeURIComponent(casaName)}`;
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
    const numeroLimpo = this.recipient.replace(/\D/g, '');

    try {
      console.log(`✉️ [WhatsApp] Buscando token da instância "${this.instanceName}" no Evolution GO...`);
      
      // 1. Obter todas as instâncias para encontrar o token
      const instancesResponse = await fetch(`${this.apiUrl}/instance/all`, {
        method: 'GET',
        headers: {
          'apikey': this.apiKey
        }
      });

      if (!instancesResponse.ok) {
        const errText = await instancesResponse.text();
        console.error(`❌ [WhatsApp] Falha ao obter instâncias da Evolution GO (${instancesResponse.status}):`, errText);
        return false;
      }

      const instancesJson: any = await instancesResponse.json();
      const instancesList = instancesJson.data || [];
      const targetInstance = instancesList.find((inst: any) => inst.name === this.instanceName);

      if (!targetInstance) {
        console.error(`❌ [WhatsApp] Instância "${this.instanceName}" não encontrada no servidor.`);
        return false;
      }

      if (!targetInstance.connected) {
        console.warn(`⚠️ [WhatsApp] Instância "${this.instanceName}" está desconectada do WhatsApp.`);
      }

      const instanceToken = targetInstance.token;
      const sendEndpoint = `${this.apiUrl}/send/text`;

      console.log(`✉️ [WhatsApp] Enviando alerta de surebet para o número ${numeroLimpo} usando a instância "${this.instanceName}"...`);
      
      const response = await fetch(sendEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': instanceToken
        },
        body: JSON.stringify({
          number: numeroLimpo,
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

    return `🔥 *SUREBET: ${a.roi.toFixed(2)}% ROI* 🔥

🏆 *${a.evento}*
🎯 Mercado: ${a.mercado}

🟢 *${casaA}* - ${a.opcao1}
👉 Odd: *${a.odd1.toFixed(2)}* | Aporte: *R$ ${a.stake1.toFixed(2)}*
🔗 Abrir: ${linkA}

🟢 *${casaB}* - ${a.opcao2}
👉 Odd: *${a.odd2.toFixed(2)}* | Aporte: *R$ ${a.stake2.toFixed(2)}*
🔗 Abrir: ${linkB}

📊 Lucro: *R$ ${a.lucro.toFixed(2)}* (Total: R$ ${a.investimento.toFixed(2)})

⏱️ _Odds coletadas agora. As cotações mudam rápido — revalide no painel antes de apostar._`;
  }
}
