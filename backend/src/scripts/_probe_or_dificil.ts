import * as fs from 'fs';
import * as path from 'path';
import { PROMPT_EXTRACAO } from '../IA/extractors/telegramSignalExtractor';
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODELOS = [
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];
const img = fs.readFileSync(path.resolve(__dirname, '../../../docs/template_telegram_exemplo_2.jpg')).toString('base64');
(async () => {
  for (const model of MODELOS) {
    const t0 = Date.now();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, max_tokens: 700, messages: [
          { role: 'user', content: [
            { type: 'text', text: PROMPT_EXTRACAO },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } },
          ] },
        ] }),
        signal: AbortSignal.timeout(120000),
      });
      const j: any = await r.json();
      const t = String(j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 200));
      const casas = (t.match(/"casa[AB]"\s*:\s*"([^"]+)"/g) || []).join(' ');
      console.log(`${model} | HTTP ${r.status} | ${((Date.now()-t0)/1000).toFixed(1)}s | casas: ${casas || '(não extraiu)'} | odds: ${(t.match(/"odd[AB]"\s*:\s*[\d.]+/g)||[]).join(' ')}`);
    } catch (e: any) { console.log(`${model} | ERRO ${e?.message}`); }
  }
})();
