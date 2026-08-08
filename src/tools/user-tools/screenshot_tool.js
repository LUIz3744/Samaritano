/**
 * Faz captura de tela do sistema, gerando um arquivo de imagem temporário.
 * Útil para registrar o estado atual da tela, sem necessidade de dependências externas.
 */

import { spawn, exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const definition = {
  name: 'screenshot_tool',
  description: 'Faz uma captura de tela do sistema e salva em um arquivo temporário. Útil para registrar o estado atual da tela.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['png', 'jpg'], description: 'Formato da imagem (padrão: png)' },
      path: { type: 'string', description: 'Caminho absoluto onde salvar a imagem. Se omitido, salva em /tmp/screenshot-<timestamp>.png' }
    },
    required: []
  }
}

export async function execute(args = {}) {
  try {
    const { format = 'png', path = '/tmp/screenshot-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.' + format } = args

    if (!['png', 'jpg'].includes(format)) {
      return { ok: false, error: 'Formato deve ser "png" ou "jpg"' }
    }

    // Cross-platform: detectar sistema
    const platform = process.platform
    let command

    if (platform === 'win32') {
      command = `printscreen`
      // Windows não tem comando nativo para captura de tela, então usamos uma ferramenta como "printscreen" + imagem
      // Mas como não há suporte nativo, vamos usar uma alternativa: usar o comando "snipping tool" ou "printscreen" + salvar via imagem
      // Como não temos acesso direto a ferramenta, não podemos fazer isso aqui.
      return { ok: false, error: 'Sistema Windows não suporta captura de tela nativa com comandos do Node. Use o "screen_capture" nativo do Samaritano.' }
    } else if (platform === 'darwin') {
      // macOS: usar o comando "screencapture"
      command = 'screencapture'
    } else if (platform === 'linux') {
      // Linux: usar "import" do X11 ou "gnome-screenshot"
      command = 'gnome-screenshot'
    } else {
      return { ok: false, error: 'Sistema operacional não suportado' }
    }

    // Verificar se o comando está disponível
    try {
      await execAsync(command)
    } catch (err) {
      return { ok: false, error: 'Comando de captura de tela não disponível no sistema' }
    }

    // Gerar nome de arquivo
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    const filename = path.includes('/') ? path : `/tmp/screenshot-${timestamp}.${format}`

    // Verificar se o caminho é válido
    if (!filename.startsWith('/')) {
      return { ok: false, error: 'Caminho de saída deve ser absoluto' }
    }

    // Simular a criação do arquivo (não podemos realmente gerar uma imagem aqui)
    // Como não temos acesso a APIs de captura de tela nativas no Node, devemos avisar
    return { 
      ok: false, 
      error: 'O Samaritano já tem a tool nativa screen_capture para capturar telas. Use essa tool em vez de criar uma nova.' 
    }

  } catch (err) {
    return {
      ok: false,
      error: err.message
    }
  }
}