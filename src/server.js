/**
 * server.js — Entrypoint HTTP + HTTPS + WebSocket.
 *
 * Endpoints:
 *   GET  /              → GUI (public/index.html)
 *   GET  /health        → status
 *   POST /chat          → orquestrador (JSON: {session, message})
 *   POST /tts           → TTS streaming (JSON: {text})
 *   POST /stt           → Whisper transcribe (multipart audio file)
 *   POST /tools/exec    → executa tool específica (debug)
 *   GET  /tools         → lista tools disponíveis
 *
 * Modo dual:
 *   HTTP em PORT (default 5070) — pra dev/teste rápido
 *   HTTPS em PORT+1 (default 5071) — pra mic seguro (cert self-signed auto-gerado)
 */

import './utils/env.js'
import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ToolRegistry } from './tools/registry.js'
import { MemoryStore } from './memory/store.js'
import { Orchestrator } from './orchestrator/index.js'
import { ttsStream } from './voice/tts.js'
import { stt as whisperSTT, complete as llmComplete, getProviderInfo } from './llm/index.js'
import { setStore as setMemoryToolStore } from './tools/memory_op.js'
import { setRegistry as setSkillCreateRegistry, setLLMRouter as setSkillCreateLLM } from './tools/skill_create.js'
import { setRegistry as setSkillListRegistry } from './tools/skill_list.js'
import { setRegistry as setSkillRemoveRegistry } from './tools/skill_remove.js'
import { setRegistry as setHelpRegistry } from './tools/kerneo_help.js'
import { setRegistry as setSkillShareRegistry } from './tools/skill_share.js'
import { setRegistry as setSkillInstallUrlRegistry } from './tools/skill_install_url.js'
import { setRegistry as setSkillIterateRegistry, setLLMRouter as setSkillIterateLLM } from './tools/skill_iterate.js'
import { setLLMRouter as setScreenCaptureLLM } from './tools/screen_capture.js'
import { ensureCerts } from './utils/certs.js'
import {
  loadConfig,
  configInfo,
  saveConfig,
  maskedConfig,
  testProviderKey,
  invalidateCache as invalidateConfigCache,
} from './utils/config.js'
import { resetCache as resetLLMCache } from './llm/index.js'
import { makeLogger } from './utils/logger.js'
import { FaceAuth } from './auth/face_auth.js'

const log = makeLogger('server')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Carrega config (config.json + .env overrides) ──
const config = loadConfig()
const PORT_HTTP = config.server.port
const PORT_HTTPS = config.server.httpsPort
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const BIND_HOST = config.server.bindLan ? '0.0.0.0' : '127.0.0.1'
const HTTPS_ENABLED = config.server.httpsEnabled
const FACE_AUTH_ENABLED = config.server.faceAuthEnabled === true

// ── Bootstrap ──
log.info('booting...')

// Valida que tem pelo menos 1 provider configurado
let providerInfo
try {
  providerInfo = getProviderInfo()
  log.info(`LLM chain: ${providerInfo.chain.join(' → ')} (primário: ${providerInfo.primary})`)
} catch (err) {
  log.error(err.message)
  log.error('Edite config.json (recomendado) ou .env')
  log.error(`Caminho config: ${path.join(process.cwd(), 'config.json')}`)
  log.error(`Caminho env:    ${path.join(process.cwd(), '.env')}`)
  log.error('')
  log.error('Recomendado começar com Groq (FREE TIER, sem cartão):')
  log.error('  1. Pegue key em https://console.groq.com')
  log.error('  2. Edite config.json: providers.groq.apiKey = "gsk_..."')
  process.exit(1)
}

const memoryStore = new MemoryStore(DATA_DIR, config.privacy)
const faceAuth = FACE_AUTH_ENABLED ? new FaceAuth(DATA_DIR, log) : null
setMemoryToolStore(memoryStore)

const toolRegistry = new ToolRegistry()
await toolRegistry.discover()

// Inject registry + llm router pros tools que precisam (skill_*, help, share)
setSkillCreateRegistry(toolRegistry)
setSkillCreateLLM({ complete: llmComplete })
setSkillListRegistry(toolRegistry)
setSkillRemoveRegistry(toolRegistry)
setHelpRegistry(toolRegistry)
setSkillShareRegistry(toolRegistry)
setSkillInstallUrlRegistry(toolRegistry)
setSkillIterateRegistry(toolRegistry)
setSkillIterateLLM({ complete: llmComplete })
setScreenCaptureLLM({ complete: llmComplete })

const orchestrator = new Orchestrator({ toolRegistry, memoryStore })

// ── HTTP utils ──
function json(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', c => {
      total += c.length
      if (total > maxBytes) {
        req.destroy()
        return reject(new Error(`body too large (>${maxBytes} bytes)`))
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  const text = buf.toString('utf-8')
  if (!text) return {}
  try { return JSON.parse(text) }
  catch (err) { throw new Error('invalid JSON: ' + err.message) }
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || ''
  if (ip.includes('127.0.0.1') || ip.includes('::1') || ip.includes('::ffff:127')) return true

  // Navegadores embutidos podem chegar por uma ponte local e não preservar o IP
  // de loopback. Nesse caso, aceita apenas requisições originadas da própria GUI
  // servida em localhost/127.0.0.1. Sites externos continuam bloqueados.
  const requestHost = String(req.headers.host || '').toLowerCase()
  const hostname = requestHost.split(':')[0].replace(/^\[|\]$/g, '')
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return false

  for (const header of [req.headers.origin, req.headers.referer]) {
    if (!header) continue
    try {
      if (new URL(header).host.toLowerCase() === requestHost) return true
    } catch {}
  }
  return false
}

function isPrivateNetwork(req) {
  const raw = String(req.socket?.remoteAddress || '').toLowerCase()
  const ip = raw.replace(/^::ffff:/, '')
  if (ip === '::1' || ip.startsWith('127.')) return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  const match172 = ip.match(/^172\.(\d+)\./)
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true
  return false
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '')
  const abs = path.join(PUBLIC_DIR, filePath)
  if (!abs.startsWith(PUBLIC_DIR)) { json(res, 403, { error: 'forbidden' }); return }
  fs.readFile(abs, (err, data) => {
    if (err) { json(res, 404, { error: 'not_found', path: urlPath }); return }
    const ext = path.extname(abs).toLowerCase()
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  })
}

async function providerStatus(liveConfig, providerName) {
  if (providerName !== 'ollama') return { ready: true, detail: 'configured' }
  const ollama = liveConfig.providers?.ollama || {}
  const root = String(ollama.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')
  try {
    const response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const installed = new Set((data.models || []).map(model => String(model.name).replace(/:latest$/, '')))
    const fast = ollama.models?.fast || 'llama3.2:3b'
    const smart = ollama.models?.smart || 'qwen3:4b'
    const hasModel = name => installed.has(name) || installed.has(String(name).replace(/:latest$/, ''))
    return {
      ready: hasModel(fast) && hasModel(smart),
      detail: hasModel(fast) && hasModel(smart) ? 'ready' : 'models_missing',
      models: { fast, smart },
      models_ready: { fast: hasModel(fast), smart: hasModel(smart) },
    }
  } catch {
    return { ready: false, detail: 'ollama_offline' }
  }
}

// ── HTTP handler ──
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const route = `${req.method} ${url.pathname}`

  if (config.server.bindLan && !isPrivateNetwork(req)) {
    return json(res, 403, { error: 'private_network_only' })
  }

  // CORS — permite GUI servida de qualquer origem (security via loopback ainda aplica)
  const requestOrigin = req.headers.origin
  if (requestOrigin) {
    try {
      const origin = new URL(requestOrigin)
      if (origin.host === req.headers.host) res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    } catch {}
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // Autenticação biométrica local. Fotos nunca chegam ao servidor; apenas
    // descritores numéricos produzidos no navegador são comparados aqui.
    if (route === 'GET /api/auth/status') {
      return json(res, 200, FACE_AUTH_ENABLED
        ? { required: true, ...faceAuth.status(req) }
        : { required: false, enrolled: false, authenticated: true, principal: 'Luiz', operator: 'Luiz', method: 'local-network' })
    }

    if (route === 'GET /api/auth/certificate') {
      const certificatePath = path.join(DATA_DIR, 'certs', 'cert.pem')
      try {
        const certificate = fs.readFileSync(certificatePath)
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="samaritano-local-ca.crt"',
          'Content-Length': certificate.length,
          'Cache-Control': 'no-store',
        })
        res.end(certificate)
      } catch {
        return json(res, 404, { ok: false, error: 'certificate_not_ready' })
      }
      return
    }

    if (route === 'POST /api/auth/enroll') {
      if (!FACE_AUTH_ENABLED) return json(res, 409, { ok: false, error: 'face_auth_disabled' })
      const body = await readJsonBody(req)
      const result = faceAuth.enroll(body, req, res)
      return json(res, result.status, result.body)
    }

    if (route === 'POST /api/auth/verify') {
      if (!FACE_AUTH_ENABLED) return json(res, 409, { ok: false, error: 'face_auth_disabled' })
      const body = await readJsonBody(req)
      const result = faceAuth.verifyFace(body, req, res)
      return json(res, result.status, result.body)
    }

    if (route === 'POST /api/auth/pin') {
      if (!FACE_AUTH_ENABLED) return json(res, 409, { ok: false, error: 'face_auth_disabled' })
      const body = await readJsonBody(req)
      const result = faceAuth.verifyPin(body, req, res)
      return json(res, result.status, result.body)
    }

    if (route === 'POST /api/auth/logout') {
      if (!FACE_AUTH_ENABLED) return json(res, 200, { ok: true })
      faceAuth.clearSession(req, res)
      return json(res, 200, { ok: true })
    }

    if (route === 'POST /api/auth/reset') {
      if (!FACE_AUTH_ENABLED) return json(res, 409, { ok: false, error: 'face_auth_disabled' })
      if (!faceAuth.isAuthenticated(req)) return json(res, 401, { ok: false, error: 'face_authentication_required' })
      const body = await readJsonBody(req)
      if (body.confirm !== 'APAGAR BIOMETRIA') return json(res, 400, { ok: false, error: 'confirmation_required' })
      return json(res, 200, faceAuth.reset(req, res))
    }

    const protectedPath = [
      '/chat', '/chat/stream', '/tts', '/stt', '/tools', '/tools/exec',
      '/api/config', '/api/privacy', '/api/dashboard', '/api/chats',
    ].some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))

    if (FACE_AUTH_ENABLED && protectedPath && !faceAuth.isEnrolled()) {
      return json(res, 423, { ok: false, error: 'face_enrollment_required' })
    }
    if (FACE_AUTH_ENABLED && protectedPath && !faceAuth.isAuthenticated(req)) {
      return json(res, 401, { ok: false, error: 'face_authentication_required' })
    }

    // GET /health
    if (route === 'GET /health') {
      const liveConfig = loadConfig()
      const info = configInfo(liveConfig)
      const engine = await providerStatus(liveConfig, info.provider)
      return json(res, 200, {
        ready: true,
        ts: Date.now(),
        version: '0.3.0',
        tools: toolRegistry.list().length,
        provider: info.provider,
        provider_ready: engine.ready,
        provider_detail: engine.detail,
        models: engine.models,
        models_ready: engine.models_ready,
        https: HTTPS_ENABLED,
        skills_auto_create: info.skills_auto_create,
      })
    }

    // GET /tools
    if (route === 'GET /tools') {
      return json(res, 200, { tools: toolRegistry.list() })
    }

    if (route === 'GET /api/dashboard') {
      const liveConfig = loadConfig()
      const info = configInfo(liveConfig)
      const engine = await providerStatus(liveConfig, info.provider)
      const privacy = memoryStore.privacySummary()
      return json(res, 200, {
        ok: true,
        ts: Date.now(),
        uptime_seconds: Math.round(process.uptime()),
        operator: 'Luiz',
        network: config.server.bindLan ? 'private-lan' : 'local-only',
        protocol: req.socket?.encrypted ? 'HTTPS' : 'HTTP',
        provider: info.provider,
        provider_ready: engine.ready,
        models: engine.models || {},
        tools: toolRegistry.list().length,
        memory: {
          history: privacy.history,
          facts: privacy.facts,
          retention_days: privacy.retention_days,
        },
        security: {
          facial: FACE_AUTH_ENABLED,
          private_network_only: true,
          https: HTTPS_ENABLED,
        },
      })
    }

    if (route === 'GET /api/chats') {
      return json(res, 200, { ok: true, sessions: memoryStore.listChatSessions(60) })
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/chats/')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/api/chats/'.length))
      if (!/^web-[a-z0-9_-]{1,80}$/i.test(sessionId)) {
        return json(res, 400, { ok: false, error: 'invalid_session_id' })
      }
      return json(res, 200, {
        ok: true,
        session_id: sessionId,
        messages: memoryStore.getChatSession(sessionId, 300),
      })
    }

    // Direitos do titular: consulta, portabilidade e eliminação (somente no PC local).
    if (route === 'GET /api/privacy') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      return json(res, 200, memoryStore.privacySummary())
    }

    if (route === 'GET /api/privacy/export') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      res.setHeader('Content-Disposition', `attachment; filename="samaritano-dados-${Date.now()}.json"`)
      return json(res, 200, memoryStore.exportData())
    }

    if (route === 'POST /api/privacy/delete') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      const body = await readJsonBody(req)
      if (body.confirm !== true) return json(res, 400, { error: 'confirm=true obrigatório' })
      const allowed = ['all', 'history', 'facts', 'session']
      if (!allowed.includes(body.scope)) return json(res, 400, { error: 'scope inválido', allowed })
      const deleted = memoryStore.deleteData(body.scope, body.sessionId)
      return json(res, 200, { ok: true, deleted })
    }

    // POST /chat
    if (route === 'POST /chat') {
      const body = await readJsonBody(req)
      const sessionId = body.session || body.sessionId || 'default'
      const message = (body.message || body.text || '').trim()
      if (!message) return json(res, 400, { error: 'message obrigatória' })

      try {
        const result = await orchestrator.handleRequest({ sessionId, userInput: message })
        return json(res, 200, {
          ok: true,
          text: result.text,
          tool_calls: result.tool_calls,
          from_reflex: result.from_reflex || false,
          iterations: result.iterations || 0,
          duration_ms: result.duration_ms,
        })
      } catch (err) {
        log.error('chat falhou', { err: err.message })
        return json(res, 200, {
          ok: false,
          error: err.message,
          text: 'Desculpa, deu erro. Tenta de novo em um instante.',
        })
      }
    }

    // POST /chat/stream — SSE (Server-Sent Events)
    // Body: { session, message } → stream de eventos { type: 'text'|'tool_call_*'|'done'|... }
    // Eventos: data: {json}\n\n
    if (route === 'POST /chat/stream') {
      const body = await readJsonBody(req)
      const sessionId = body.session || body.sessionId || 'default'
      const message = (body.message || body.text || '').trim()
      if (!message) return json(res, 400, { error: 'message obrigatória' })

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // nginx/proxy: não bufferizar
      })

      // Heartbeat pra manter conexão viva durante long thinks
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch {}
      }, 15000)

      // Aborta orchestrator se cliente desconectar
      const ac = new AbortController()
      req.on('close', () => {
        ac.abort()
        clearInterval(heartbeat)
      })

      const t0 = Date.now()
      try {
        for await (const event of orchestrator.handleRequestStream({
          sessionId, userInput: message, signal: ac.signal,
        })) {
          if (res.writableEnded) break
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          log.error('chat/stream falhou', { err: err.message })
          try {
            res.write(`data: ${JSON.stringify({
              type: 'error',
              message: err.message || 'erro interno',
            })}\n\n`)
          } catch {}
        }
      } finally {
        clearInterval(heartbeat)
        try { res.end() } catch {}
        log.info('stream done', { dt_ms: Date.now() - t0, msg: message.slice(0, 30) })
      }
      return
    }

    // POST /tts (audio MP3)
    if (route === 'POST /tts') {
      const body = await readJsonBody(req)
      const text = (body.text || '').trim()
      if (!text) return json(res, 400, { error: 'text obrigatório' })
      try {
        const buf = await ttsStream({ text, voice: body.voice, speed: body.speed })
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        })
        res.end(buf)
      } catch (err) {
        log.warn('TTS falhou', { err: err.message })
        if (!res.headersSent) json(res, 500, { error: err.message })
      }
      return
    }

    // POST /stt (Whisper transcribe — fallback quando Web Speech falha)
    // Body: raw audio bytes (Content-Type: audio/webm | audio/mp4 | etc)
    if (route === 'POST /stt') {
      const contentType = req.headers['content-type'] || 'audio/webm'
      try {
        const audioBuf = await readBody(req, 25 * 1024 * 1024)  // 25MB max
        if (audioBuf.length < 1000) {
          return json(res, 400, { error: 'áudio muito pequeno', size: audioBuf.length })
        }
        log.info('STT request', { size_kb: Math.round(audioBuf.length / 1024), mime: contentType })

        // Detect extension from mime
        let filename = 'audio.webm'
        if (contentType.includes('mp4')) filename = 'audio.mp4'
        else if (contentType.includes('ogg')) filename = 'audio.ogg'
        else if (contentType.includes('wav')) filename = 'audio.wav'
        else if (contentType.includes('mpeg')) filename = 'audio.mp3'

        const result = await whisperSTT(audioBuf, {
          filename,
          mimeType: contentType,
          language: 'pt',
        })
        return json(res, 200, { ok: true, text: result.text, model: result.model })
      } catch (err) {
        log.warn('STT falhou', { err: err.message })
        return json(res, 500, { ok: false, error: err.message })
      }
    }

    // ── Config API (loopback only — segurança) ──
    // GET /api/config — retorna config com keys mascaradas
    if (route === 'GET /api/config') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      try {
        const masked = maskedConfig()
        return json(res, 200, masked)
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
    }

    // POST /api/config — atualiza config (apiKey, provider, voice, etc)
    // Body: { providers?: {groq: {apiKey: "..."}}, provider?: "openai", voice?: {...} }
    if (route === 'POST /api/config') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      try {
        const body = await readJsonBody(req)
        const result = saveConfig(body)
        if (!result.ok) return json(res, 500, result)

        // Reset LLM router pra usar config nova
        resetLLMCache()
        invalidateConfigCache()

        // Re-detect provider primário pra retornar info
        let info
        try { info = configInfo(loadConfig(true)) }
        catch (err) { info = { error: err.message } }

        return json(res, 200, {
          ok: true,
          message: 'Config salvo. Mudanças aplicam IMEDIATAMENTE (sem restart).',
          path: result.path,
          new_provider: info.provider,
          chain: info.chain,
        })
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
    }

    // POST /api/config/test — testa apiKey sem salvar
    // Body: { provider: "openai", apiKey: "sk-...", baseUrl?: "..." }
    if (route === 'POST /api/config/test') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      try {
        const body = await readJsonBody(req)
        if (!body.provider || !body.apiKey) {
          return json(res, 400, { error: 'provider e apiKey obrigatórios' })
        }
        const result = await testProviderKey(body.provider, body.apiKey, body.baseUrl)
        return json(res, 200, result)
      } catch (err) {
        return json(res, 500, { error: err.message })
      }
    }

    // POST /tools/exec (loopback only — debug)
    if (route === 'POST /tools/exec') {
      if (!isLoopback(req)) return json(res, 403, { error: 'loopback_only' })
      const body = await readJsonBody(req)
      const tool = toolRegistry.get(body.tool)
      if (!tool) return json(res, 404, { error: `tool not found: ${body.tool}` })
      try {
        const out = await tool.execute(body.args || {})
        return json(res, 200, { ok: true, output: out })
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message })
      }
    }

    // Static
    if (req.method === 'GET') {
      return serveStatic(req, res, url.pathname)
    }

    json(res, 404, { error: 'not_found', route })
  } catch (err) {
    log.error('handler crash', { err: err.message, stack: err.stack?.split('\n')[1]?.trim() })
    if (!res.headersSent) json(res, 500, { error: err.message })
  }
}

// ── Boot dual: HTTP + HTTPS ──
const httpServer = http.createServer(handleRequest)
httpServer.listen(PORT_HTTP, BIND_HOST, () => {
  log.info(`HTTP listening on ${BIND_HOST}:${PORT_HTTP}`)
})
httpServer.on('error', (err) => {
  log.error(`HTTP server error: ${err.message}`)
  if (err.code === 'EADDRINUSE') {
    log.error(`Porta ${PORT_HTTP} já em uso. Edite .env e mude PORT.`)
    process.exit(1)
  }
})

let httpsServer = null
let httpsUp = false

if (HTTPS_ENABLED) {
  try {
    const { cert, key } = ensureCerts(DATA_DIR)
    httpsServer = https.createServer({ cert, key }, handleRequest)
    httpsServer.listen(PORT_HTTPS, BIND_HOST, () => {
      httpsUp = true
      log.info(`HTTPS listening on ${BIND_HOST}:${PORT_HTTPS}`)
    })
    httpsServer.on('error', (err) => {
      log.warn(`HTTPS server error: ${err.message}`)
      if (err.code === 'EADDRINUSE') {
        log.warn(`Porta HTTPS ${PORT_HTTPS} ocupada — só HTTP disponível`)
      }
    })
  } catch (err) {
    log.warn(`HTTPS setup falhou: ${err.message} — continuando só HTTP`)
  }
}

// Aguarda HTTPS subir (ou timeout) antes de imprimir banner
setTimeout(() => {
  const localhost = BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST
  const httpUrl = `http://${localhost}:${PORT_HTTP}`
  const httpsUrl = httpsUp ? `https://${localhost}:${PORT_HTTPS}` : null
  log.info('═══════════════════════════════════════════════')
  log.info(`✅ Samaritano online (operador Luiz)`)
  log.info(`   HTTP:  ${httpUrl}`)
  if (httpsUrl) log.info(`   HTTPS: ${httpsUrl}  (recomendado pra microfone)`)
  log.info(`   Health: ${httpUrl}/health`)
  log.info(`   Tools:  ${toolRegistry.list().map(t => t.name).join(', ')}`)
  log.info('═══════════════════════════════════════════════')
}, 500)

// Graceful shutdown
function shutdown(sig) {
  log.info(`received ${sig}, shutting down...`)
  let closed = 0
  const total = (httpsServer ? 2 : 1)
  const done = () => {
    closed++
    if (closed >= total) { memoryStore.close(); process.exit(0) }
  }
  httpServer.close(done)
  if (httpsServer) httpsServer.close(done)
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
