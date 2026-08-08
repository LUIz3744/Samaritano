/**
 * Tool para verificar se um site está acessível e retornar seu status de conexão.
 * Útil quando o usuário precisa saber se um site está online ou não, por exemplo, para verificação de serviços.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const definition = {
  name: 'site_tool',
  description: 'Verifica se um site está acessível e retorna seu status de conexão. Útil para saber se um serviço está online.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL do site a ser verificado (ex: https://www.exemplo.com)' },
    },
    required: ['url'],
  },
}

export async function execute(args = {}) {
  try {
    const { url } = args
    if (!url) return { ok: false, error: 'url obrigatório' }

    if (!url.startsWith('http')) {
      return { ok: false, error: 'A URL deve começar com http ou https' }
    }

    const command = `curl -s --connect-timeout 5 --fail ${url} || echo "erro"` 
    const result = await execAsync(command)

    if (result.stdout.includes('error')) {
      return { ok: true, message: `O site ${url} não está acessível.` }
    } else {
      return { ok: true, message: `O site ${url} está acessível.` }
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message || 'Erro ao verificar o site. Verifique a conexão de rede.',
    }
  }
}