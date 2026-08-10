import { execute as searchWeb } from '../web_search.js'

export const definition = {
  name: 'legal_research',
  description: 'Pesquisa uma questão jurídica brasileira em fontes verificáveis. Prioriza Planalto, tribunais e CNJ; inclui JusBrasil apenas como fonte secundária. Nunca confirma dívida, processo ou fato pessoal sem documento identificável fornecido pelo operador.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Pergunta jurídica geral ou termo a pesquisar.' },
      max_results: { type: 'number', default: 8 },
    },
    required: ['query'],
  },
}

export async function execute({ query, max_results = 8 }) {
  const cleanQuery = String(query || '').trim()
  if (!cleanQuery) return { ok: false, error: 'Pergunta jurídica vazia.' }

  const researchQuery = `${cleanQuery} Brasil (site:planalto.gov.br OR site:stj.jus.br OR site:cnj.jus.br OR site:stf.jus.br OR site:jusbrasil.com.br)`
  const result = await searchWeb({ query: researchQuery, max_results })
  return {
    ...result,
    query: cleanQuery,
    research_query: researchQuery,
    legal_scope: 'informação geral; não substitui orientação profissional',
    source_policy: 'fontes oficiais são primárias; JusBrasil é fonte secundária',
    personal_fact_policy: 'não inferir dívida, processo, valor, data ou decisão sobre Luiz sem documento explícito',
  }
}
