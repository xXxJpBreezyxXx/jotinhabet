/**
 * Opções de navegador stealth compartilhadas.
 *
 * Extraído do padrão repetido em casa_blaze.ts / casa_1xbet.ts / casa_kto.ts /
 * casa_superbet.ts. Garante que o recon "pareça" o mesmo browser da produção
 * (mesmo UA, locale pt-BR, geolocation BR e navigator.webdriver oculto).
 */
import type { BrowserContext } from 'playwright';

export const USER_AGENT_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Geolocation de São Paulo — casas .bet.br checam região BR (Lei 14.790). */
export const GEO_SAO_PAULO = { latitude: -23.55052, longitude: -46.633308 };

/** Opções para chromium.launchPersistentContext / newContext. */
export const stealthContextOptions = {
  channel: 'chrome' as const,
  args: ['--disable-blink-features=AutomationControlled'],
  userAgent: USER_AGENT_CHROME,
  viewport: { width: 1280, height: 800 },
  permissions: ['geolocation'],
  geolocation: GEO_SAO_PAULO,
  locale: 'pt-BR',
};

/** Injeta o disfarce de `navigator.webdriver` (deve rodar após criar o contexto). */
export async function aplicarStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}
