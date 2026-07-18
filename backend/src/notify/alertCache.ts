import * as fs from 'fs';
import * as path from 'path';

// Cache em arquivo (logs/sent_alerts.json) para evitar alertas de WhatsApp
// duplicados entre varreduras/reinícios. Movido de core/scanner_v2.ts para ser
// compartilhado com o pipeline de sinais do Telegram — mesma profundidade de
// diretório, o path relativo continua resolvendo para backend/logs.
export function alertAlreadySent(key: string): boolean {
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

export function markAlertAsSent(key: string) {
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
