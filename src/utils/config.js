/**
 * utils/config.js — Carrega config.json com fallback graceful pra .env.
 *
 * Estratégia:
 *   1. Se config.json existe → usa (multi-provider, full features)
 *   2. Senão → constrói config a partir de OPENAI_API_KEY do .env
 *   3. Variables de ambiente PORT/etc sobrescrevem config.json (override)
 */

import fs from 'fs'
import path from 'path'
import { makeLogger } from './logger.js'

const log = makeLogger('config')

// Default config (usado quando nem config.json nem .env têm tudo)
const DEFAULT_CONFIG = {
  provider: 'auto',
  providers: {
    openai: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      models: {
        fast: 'gpt-4o-mini',
        smart: 'gpt-4o',
        tts: 'gpt-4o-mini-tts',  // melhor PT-BR (entonação natural, sotaque correto)
        stt: 'whisper-1',          // melhor PT-BR (mais robusto que gpt-4o-mini-transcribe)
        vision: 'gpt-4o',
      },
    },
    anthropic: {
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      models: { fast: 'claude-haiku-4-5', smart: 'claude-sonnet-4-5', vision: 'claude-sonnet-4-5' },
    },
    deepseek: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      models: { fast: 'deepseek-chat', smart: 'deepseek-chat' },
    },
    groq: {
      apiKey: '',
      baseUrl: 'https://api.groq.com/openai/v1',
      models: { fast: 'openai/gpt-oss-120b', smart: 'openai/gpt-oss-120b' },
    },
    gemini: {
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      models: { fast: 'gemini-2.0-flash', smart: 'gemini-2.5-pro' },
    },
    openrouter: {
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: { fast: 'openai/gpt-4o-mini', smart: 'anthropic/claude-3.5-sonnet' },
    },
    ollama: {
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      models: { fast: 'llama3.2:3b', smart: 'qwen3:4b-instruct' },
    },
    custom: {
      apiKey: '',
      baseUrl: '',
      models: { fast: '', smart: '' },
    },
  },
  voice: { ttsEnabled: false, voice: 'nova', speed: 1.0 },
  server: { port: 5070, httpsPort: 5071, httpsEnabled: true, bindLan: false },
  logging: { level: 'info' },
  privacy: {
    historyRetentionDays: 30,
    maxHistoryItems: 1000,
    redactSensitiveHistory: true,
    allowSensitiveFacts: false,
  },
  skills: { allowAutoCreate: true, maxUserSkills: 50 },
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object') return base
  const out = { ...base }
  for (const key of Object.keys(overlay)) {
    if (key.startsWith('//')) continue   // ignora docstring keys
    const v = overlay[key]
    if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], v)
    } else {
      out[key] = v
    }
  }
  return out
}

let _cached = null

/** Força recarregar config na próxima chamada */
export function invalidateCache() {
  _cached = null
}

export function loadConfig(force = false) {
  if (_cached && !force) return _cached

  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

  // 1. Lê config.json se existe
  const configPath = path.join(process.cwd(), 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      config = deepMerge(config, parsed)
      log.info(`config.json carregado de ${configPath}`)
    } catch (err) {
      log.warn(`config.json inválido: ${err.message} — usando defaults`)
    }
  } else {
    log.debug('config.json não encontrado — usando defaults + .env')
  }

  // 2. Override com env vars (.env já carregado por dotenv no server.js)
  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    config.providers.openai.apiKey = config.providers.openai.apiKey || process.env.OPENAI_API_KEY
  }
  if (process.env.OPENAI_BASE_URL) {
    config.providers.openai.baseUrl = process.env.OPENAI_BASE_URL
  }
  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic.apiKey = config.providers.anthropic.apiKey || process.env.ANTHROPIC_API_KEY
  }
  // DeepSeek
  if (process.env.DEEPSEEK_API_KEY) {
    config.providers.deepseek.apiKey = config.providers.deepseek.apiKey || process.env.DEEPSEEK_API_KEY
  }
  // Groq
  if (process.env.GROQ_API_KEY) {
    config.providers.groq.apiKey = config.providers.groq.apiKey || process.env.GROQ_API_KEY
  }
  // Gemini
  if (process.env.GEMINI_API_KEY) {
    config.providers.gemini.apiKey = config.providers.gemini.apiKey || process.env.GEMINI_API_KEY
  }
  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    config.providers.openrouter.apiKey = config.providers.openrouter.apiKey || process.env.OPENROUTER_API_KEY
  }
  // Ollama
  if (process.env.OLLAMA_BASE_URL) {
    config.providers.ollama.baseUrl = process.env.OLLAMA_BASE_URL
  }

  // Server overrides
  if (process.env.PORT) config.server.port = Number(process.env.PORT)
  if (process.env.PORT_HTTPS) config.server.httpsPort = Number(process.env.PORT_HTTPS)
  if (process.env.KERNEO_DISABLE_HTTPS === '1' || process.env.SAMARITANO_DISABLE_HTTPS === '1') config.server.httpsEnabled = false
  if (process.env.KERNEO_BIND_LAN === '1' || process.env.SAMARITANO_BIND_LAN === '1') config.server.bindLan = true
  if (process.env.LOG_LEVEL) config.logging.level = process.env.LOG_LEVEL

  // Voice
  if (process.env.OPENAI_VOICE) config.voice.voice = process.env.OPENAI_VOICE

  // Provider explicit override
  if (process.env.KERNEO_PROVIDER || process.env.SAMARITANO_PROVIDER) {
    config.provider = process.env.SAMARITANO_PROVIDER || process.env.KERNEO_PROVIDER
  }

  _cached = config
  return config
}

/**
 * Detecta qual provider usar baseado em qual tem apiKey preenchida.
 *
 * Ordem de preferência ATUAL (Sprint v0.4):
 *   1. groq (free tier, rápido) — recomendado pra começar
 *   2. openai (full features: TTS+STT+vision)
 *   3. gemini (free tier também)
 *   4. anthropic (qualidade alta)
 *   5. deepseek (barato)
 *   6. openrouter (mix)
 *   7. ollama (offline)
 *   8. custom (qualquer outro)
 */
export function detectProvider(config) {
  if (config.provider && config.provider !== 'auto') {
    const p = config.providers[config.provider]
    if (p && (p.apiKey || config.provider === 'ollama')) {
      return config.provider
    }
    log.warn(`provider explícito "${config.provider}" sem apiKey — fallback auto`)
  }

  // Auto: Groq primeiro (free tier permite testar sem cartão)
  const order = ['groq', 'openai', 'gemini', 'anthropic', 'deepseek', 'openrouter', 'ollama', 'custom']
  for (const name of order) {
    const p = config.providers[name]
    if (!p) continue
    const hasKey = name === 'ollama' ? !!p.baseUrl : !!p.apiKey
    if (hasKey) return name
  }
  return null
}

/**
 * Retorna lista ordenada de providers disponíveis (com fallback chain).
 * Primeiro = primário; demais = fallbacks se primário falhar.
 */
export function buildProviderChain(config) {
  const order = ['groq', 'openai', 'gemini', 'anthropic', 'deepseek', 'openrouter', 'ollama', 'custom']
  const available = []
  for (const name of order) {
    const p = config.providers[name]
    if (!p) continue
    const hasKey = name === 'ollama' ? !!p.baseUrl : !!p.apiKey
    if (hasKey) available.push(name)
  }
  // Se user setou provider explícito, prioriza ele
  if (config.provider && config.provider !== 'auto') {
    const idx = available.indexOf(config.provider)
    if (idx > 0) {
      available.splice(idx, 1)
      available.unshift(config.provider)
    }
  }
  return available
}

/**
 * Salva config.json no disco (preservando comments via merge).
 * Args: { provider?, providers?, voice?, server?, skills? }
 *
 * Não substitui o arquivo todo — só faz patch dos campos enviados.
 * Invalida cache pra próxima chamada usar config nova.
 */
export function saveConfig(patch) {
  const configPath = path.join(process.cwd(), 'config.json')
  let current = {}

  // Lê atual (se existe) preservando comments
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      current = JSON.parse(raw)
    } catch (err) {
      log.warn(`config.json corrompido, recriando: ${err.message}`)
    }
  }

  // Merge profundo
  const merged = deepMerge(current, patch)

  // Salva
  try {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8')
    invalidateCache()
    log.info('config.json salvo')
    return { ok: true, path: configPath }
  } catch (err) {
    log.error(`falha ao salvar config: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

/**
 * Retorna config com apiKeys MASCARADAS (pra mostrar no GUI sem expor segredos).
 * Mantém só os primeiros 8 chars: "sk-proj-AbCd...****"
 */
export function maskedConfig(config = null) {
  const cfg = JSON.parse(JSON.stringify(config || loadConfig()))
  for (const name of Object.keys(cfg.providers || {})) {
    const p = cfg.providers[name]
    if (p?.apiKey) {
      const k = String(p.apiKey)
      if (k.length > 12) {
        p.apiKey = k.slice(0, 8) + '****' + k.slice(-4)
      } else if (k.length > 0) {
        p.apiKey = '****'
      }
      p._hasKey = true
    } else {
      p._hasKey = false
    }
  }
  return cfg
}

/**
 * Testa uma API key contra o endpoint do provider sem salvar.
 * Returns: { ok, latency_ms, error? }
 */
export async function testProviderKey(providerName, apiKey, customBaseUrl = null) {
  const config = loadConfig()
  const provider = config.providers[providerName]
  if (!provider) return { ok: false, error: `Provider "${providerName}" desconhecido` }
  if (!apiKey) return { ok: false, error: 'apiKey vazia' }

  const baseUrl = customBaseUrl || provider.baseUrl
  const t0 = Date.now()

  try {
    let url, headers
    if (providerName === 'anthropic') {
      // Anthropic não tem /models endpoint — testa com /messages curtos
      url = `${baseUrl}/v1/messages`
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: provider.models?.fast || 'claude-haiku-4-5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (resp.status === 200 || resp.status === 201) {
        return { ok: true, latency_ms: Date.now() - t0 }
      }
      const errText = await resp.text()
      return { ok: false, error: `${resp.status}: ${errText.slice(0, 200)}`, latency_ms: Date.now() - t0 }
    }

    // OpenAI-compatible: lista models
    url = `${baseUrl}/models`
    headers = { Authorization: `Bearer ${apiKey}` }
    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout?.(10000) })
    if (resp.ok) {
      return { ok: true, latency_ms: Date.now() - t0 }
    }
    const errText = await resp.text()
    return { ok: false, error: `${resp.status}: ${errText.slice(0, 200)}`, latency_ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: err.message, latency_ms: Date.now() - t0 }
  }
}

/**
 * Retorna info do config pra mostrar no /health.
 */
export function configInfo(config) {
  const chain = buildProviderChain(config)
  const primary = chain[0] || null
  const p = primary ? config.providers[primary] : {}
  return {
    provider: primary,
    chain,
    base_url: p?.baseUrl,
    models: p?.models,
    skills_auto_create: config.skills?.allowAutoCreate !== false,
    https_enabled: config.server?.httpsEnabled !== false,
  }
}
