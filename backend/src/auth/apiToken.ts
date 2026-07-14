import { Request, Response, NextFunction } from 'express';

/**
 * Middleware de autenticação por token compartilhado para as rotas que gastam
 * cota paga de IA. Espera o header `Authorization: Bearer <API_TOKEN>`.
 *
 * Comportamento:
 *  - Se API_TOKEN não estiver configurado (ou for o placeholder), a rota é
 *    LIBERADA com um aviso — para não travar o desenvolvimento local. Em
 *    produção, defina API_TOKEN para exigir o token.
 *  - Se estiver configurado, exige o Bearer token correspondente (401 se faltar/errado).
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.API_TOKEN;

  if (!configured || configured.includes('your-api-token')) {
    console.warn(
      '⚠️ [Auth] API_TOKEN não configurado — rota protegida liberada (apenas dev). Configure API_TOKEN em produção.'
    );
    return next();
  }

  const header = (req.headers['authorization'] as string) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || token !== configured) {
    return res.status(401).json({ error: 'Não autorizado: token de API ausente ou inválido.' });
  }

  next();
}
