/**
 * screen_capture.js — Tira screenshot da tela e ANALISA via Vision AI.
 *
 * Resolve o problema "o que tem na minha tela?" sem precisar criar skill.
 *
 * Pipeline:
 *   1. Captura tela via API nativa do OS
 *      - Windows: PowerShell + .NET Drawing
 *      - Mac: screencapture
 *      - Linux: scrot / gnome-screenshot / import
 *   2. Salva em data/screenshots/screenshot_<timestamp>.png
 *   3. Se OpenAI key disponível → envia pra Vision (gpt-4o)
 *   4. Retorna análise REAL (não placeholder!)
 */

import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

let _llmRouter = null
export function setLLMRouter(router) { _llmRouter = router }

const SCREENSHOTS_DIR = path.join(process.cwd(), 'data', 'screenshots')

export const definition = {
  name: 'screen_capture',
  description:
    'Tira screenshot da tela do user E analisa o conteúdo via Vision AI. Use quando user pedir ' +
    '"o que tem na minha tela", "tira print", "vê minha tela", "analisa o que tô vendo", ' +
    '"descreve a tela". Retorna análise textual real do que está visível.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'Pergunta específica sobre a tela. Default: "Descreva o que está nesta tela."',
      },
      save_path: {
        type: 'string',
        description: 'Caminho onde salvar (opcional). Default: data/screenshots/.',
      },
    },
  },
}

async function ensureScreenshotsDir() {
  try { await fs.mkdir(SCREENSHOTS_DIR, { recursive: true }) } catch {}
}

async function captureWindows(outPath) {
  // PowerShell + System.Drawing — funciona em qualquer Windows 7+ sem dependências
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${outPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "OK"
`.trim()

  // -EncodedCommand evita problemas de escape
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershellExe = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout, stderr } = await execFileAsync(
    powershellExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 15000, windowsHide: true }
  )
  if (stderr && !stdout.includes('OK')) {
    throw new Error(`PowerShell screenshot falhou: ${stderr.slice(0, 200)}`)
  }
  return outPath
}

async function captureMac(outPath) {
  // -x = silent (sem som de obturador), -t png = formato
  await execAsync(`screencapture -x -t png "${outPath}"`, { timeout: 15000 })
  return outPath
}

async function captureLinux(outPath) {
  // Tenta scrot, gnome-screenshot, import, em ordem
  const candidates = [
    `scrot "${outPath}"`,
    `gnome-screenshot -f "${outPath}"`,
    `import -window root "${outPath}"`,  // ImageMagick
  ]
  let lastErr = null
  for (const cmd of candidates) {
    try {
      await execAsync(cmd, { timeout: 15000 })
      return outPath
    } catch (err) {
      lastErr = err
      continue
    }
  }
  throw new Error(`Nenhum screenshot tool disponível (scrot/gnome-screenshot/import). ${lastErr?.message}`)
}

async function captureScreen(outPath) {
  const platform = process.platform
  if (platform === 'win32') return captureWindows(outPath)
  if (platform === 'darwin') return captureMac(outPath)
  return captureLinux(outPath)
}

async function analyzeWithVision(imagePath, question) {
  if (!_llmRouter?.complete) {
    return null
  }

  // Lê arquivo e converte pra base64 data URL
  const imgBuffer = await fs.readFile(imagePath)
  const base64 = imgBuffer.toString('base64')
  const dataUrl = `data:image/png;base64,${base64}`

  // Importa vision do llm router (pode não existir em todos providers)
  try {
    const llm = await import('../llm/index.js')
    if (!llm.vision) return null

    const result = await llm.vision({
      image_url: dataUrl,
      question: question || 'Descreva detalhadamente o que está visível nesta tela. Liste programas abertos, conteúdo, e qualquer coisa relevante.',
      detail: 'high',
    })
    return result.analysis || null
  } catch (err) {
    console.warn('[screen_capture] vision falhou:', err.message)
    return null
  }
}

export async function execute({ question, save_path } = {}) {
  await ensureScreenshotsDir()

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = save_path || path.join(SCREENSHOTS_DIR, `screenshot_${timestamp}.png`)

  // 1. Captura
  let screenshotPath
  try {
    screenshotPath = await captureScreen(outPath)
  } catch (err) {
    return {
      ok: false,
      error: `Falha ao capturar tela: ${err.message}`,
      hint: process.platform === 'linux'
        ? 'Linux: instale scrot (sudo apt install scrot) ou gnome-screenshot.'
        : 'Verifique permissões do sistema (Mac: dar permissão de Screen Recording).',
    }
  }

  // Confirma arquivo existe
  try {
    const stat = await fs.stat(screenshotPath)
    if (stat.size < 1000) {
      return { ok: false, error: 'Screenshot tirado mas arquivo está vazio/corrompido.' }
    }
  } catch {
    return { ok: false, error: 'Screenshot supostamente tirado mas arquivo não existe.' }
  }

  // 2. Analisa com Vision (se disponível)
  const analysis = await analyzeWithVision(screenshotPath, question)

  if (analysis) {
    return {
      ok: true,
      file_path: screenshotPath,
      analysis,
      message: `Analisei a tela:\n\n${analysis}`,
    }
  }

  // Sem vision — ainda retorna sucesso mas só com path
  return {
    ok: true,
    file_path: screenshotPath,
    analysis: null,
    message:
      `Screenshot salvo em ${screenshotPath}.\n` +
      `(Análise visual requer OpenAI/Anthropic/Gemini configurado em ⚙ Configurações)`,
  }
}
