import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renderiza o MARKDOWN das respostas do agente (aba "IA & Automação").
 *
 * O agente escreve em markdown — negrito, listas, e principalmente TABELAS de odds e de
 * stake. Antes isto ia para a tela como texto cru (`**Flamengo**`, `| Casa | Odd |`).
 *
 * Decisões:
 *  - `remark-gfm` porque a tabela é justamente o que o agente mais usa (comparador de
 *    odds, cobertura de promoção).
 *  - NADA de estilo inline aqui: o visual sai da classe `.md` no index.css, senão o tema
 *    claro (variáveis CSS + `:root.light`) deixa de valer.
 *  - HTML bruto é DESCARTADO (comportamento padrão do react-markdown v9+; não adicionar
 *    `rehype-raw`): o texto vem de um LLM que repassa conteúdo de casas de aposta e de
 *    mensagens do Telegram, ou seja, conteúdo semi-confiável.
 *  - A tabela vai dentro de um wrapper que ROLA: a bolha tem `max-width` e vive num flex
 *    coluna, onde o filho usa a largura do CONTEÚDO e estouraria a bolha (a mesma
 *    armadilha do `.surebet-footer > *` documentada no index.css).
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // `node` é prop interna do react-markdown: se entrar no spread, vai para o DOM
          // como node="[object Object]" (com aviso do React no console).
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
          table: ({ node: _n, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
