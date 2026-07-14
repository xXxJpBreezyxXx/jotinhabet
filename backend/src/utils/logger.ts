import * as fs from 'fs';
import * as path from 'path';

// Setup file log directory and file
const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'scanner.log');

// Clear log file on startup to keep it clean and relevant, or append.
// Let's append to preserve history, but start with a separation separator.
fs.appendFileSync(logFile, `\n\n=== JOTINHABET STARTUP: ${new Date().toISOString()} ===\n`, 'utf8');

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const writeToFile = (prefix: string, args: any[]) => {
  try {
    const timestamp = new Date().toLocaleString('pt-BR');
    const message = args.map(arg => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') return JSON.stringify(arg);
      return String(arg);
    }).join(' ');
    
    // Remove ANSI colors
    const cleanMsg = message.replace(/\x1b\[[0-9;]*m/g, '');
    const logLine = `[${timestamp}] [${prefix}] ${cleanMsg}\n`;
    
    fs.appendFileSync(logFile, logLine, 'utf8');
  } catch (err) {
    originalError('Falha ao escrever log no arquivo:', err);
  }
};

// Override console methods
console.log = (...args: any[]) => {
  writeToFile('INFO', args);
  originalLog(...args);
};

console.error = (...args: any[]) => {
  writeToFile('ERROR', args);
  originalError(...args);
};

console.warn = (...args: any[]) => {
  writeToFile('WARN', args);
  originalWarn(...args);
};

export { originalLog, originalError, originalWarn };
