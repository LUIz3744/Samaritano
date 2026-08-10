/**
 * app.js — Frontend Samaritano (state machine robusta).
 *
 * REGRA DE OURO de inicialização:
 *   1. TODAS as declarações de elementos DOM no TOPO
 *   2. TODAS as constantes/state no TOPO
 *   3. TODAS as functions definidas (hoisted)
 *   4. Init chamado SÓ NO FIM, dentro de DOMContentLoaded
 *   5. Cada init step com try/catch — falha de um não quebra outros
 *   6. Erros sempre VISÍVEIS no banner UI (não só console)
 *
 * Modos de input:
 *   - Texto (Enter ou click no send)
 *   - Web Speech API (browser nativo) — primário
 *   - MediaRecorder + Whisper — fallback automático
 */

'use strict'

// ════════════════════════════════════════════════════════════
// 1. CONSTANTES (declaradas ANTES de qualquer init)
// ════════════════════════════════════════════════════════════

let SESSION_ID = localStorage.getItem('samaritano:active-session') || ('web-' + Math.random().toString(36).slice(2, 10))
localStorage.setItem('samaritano:active-session', SESSION_ID)

const State = {
  IDLE: 'idle',
  REQUESTING_PERM: 'requesting_perm',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  ERROR: 'error',
}

const PROVIDER_INFO = {
  groq: {
    label: 'Groq',
    desc: 'GPT-OSS 120B — rápido, free tier generoso (sem cartão)',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
    pros: '✓ Free tier · ✓ Ultra-rápido',
    cons: '✗ Sem voz/TTS · ✗ Tool calling instável',
  },
  openai: {
    label: 'OpenAI',
    desc: 'GPT-4o — full features (LLM + voz + visão com 1 chave)',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-proj-...',
    pros: '✓ Voz nativa · ✓ Visão · ✓ Web search',
    cons: '✗ Precisa cartão',
  },
  gemini: {
    label: 'Google Gemini',
    desc: 'Gemini 2.0 Flash — free tier no AI Studio',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza...',
    pros: '✓ Free tier · ✓ Visão',
    cons: '✗ Sem voz nativa',
  },
  anthropic: {
    label: 'Anthropic Claude',
    desc: 'Claude Sonnet/Haiku — qualidade alta',
    keyUrl: 'https://console.anthropic.com/',
    keyHint: 'sk-ant-...',
    pros: '✓ Excelente raciocínio · ✓ Visão',
    cons: '✗ Pago · ✗ Sem voz',
  },
  deepseek: {
    label: 'DeepSeek',
    desc: 'DeepSeek-Chat — bom em PT-BR, custo baixo',
    keyUrl: 'https://platform.deepseek.com/',
    keyHint: 'sk-...',
    pros: '✓ Muito barato · ✓ Bom em PT-BR',
    cons: '✗ Sem voz',
  },
  openrouter: {
    label: 'OpenRouter',
    desc: '200+ modelos via 1 chave (mix de provedores)',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
    pros: '✓ Multi-modelo · ✓ Alguns free',
    cons: '✗ Sem voz nativa',
  },
  ollama: {
    label: 'Ollama (local)',
    desc: 'Roda offline no seu PC. 100% privado e gratuito.',
    keyUrl: 'https://ollama.com',
    keyHint: 'ollama (literal)',
    pros: '✓ Offline · ✓ Privacidade total · ✓ Grátis',
    cons: '✗ Precisa GPU/RAM bom · ✗ Sem voz',
  },
}

// ════════════════════════════════════════════════════════════
// 2. STATE (mutable)
// ════════════════════════════════════════════════════════════

let micState = State.IDLE
let recognition = null
let mediaRecorder = null
let recordedChunks = []
let voiceMode = false
let lastEmptyResults = 0
let webSpeechAvailable = false
let mediaStream = null

// DOM elements — preenchidos no init() depois que DOM tá pronto
let chat, input, sendBtn, micBtn, statusDot, statusText, ttsPlayer
let voiceStatus, voiceIcon, voiceText, realtimeBtn
let settingsModal, settingsClose, settingsBtn, settingsBody

// Realtime mode state
let realtimeActive = false
let realtimeAudioCtx = null
let realtimeAnalyser = null
let realtimeStream = null
let realtimeRecorder = null
let realtimeRecording = false
let realtimeChunks = []
let realtimeRMSCheckInterval = null
let realtimeSilenceStart = null
let realtimeSpeechStart = null

// VAD config
const VAD_RMS_THRESHOLD = 0.015          // mínimo de volume pra contar como fala
const VAD_SILENCE_DURATION_MS = 900      // tempo de silêncio pra encerrar utterance
const VAD_MIN_SPEECH_MS = 400            // mínimo de fala antes de encerrar (anti glitch)
const VAD_CHECK_INTERVAL_MS = 50         // frequência da medição RMS

// ════════════════════════════════════════════════════════════
// 3. UTILS
// ════════════════════════════════════════════════════════════

function $(id) {
  return document.getElementById(id)
}

function showFatalError(msg) {
  // Erro CRÍTICO — mostra banner persistente e loga.
  console.error('[Samaritano] FATAL:', msg)
  const body = document.body
  if (!body) return
  let banner = document.getElementById('fatal-error')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'fatal-error'
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
      background: #ef4444; color: #fff; padding: 12px 16px;
      font-family: sans-serif; font-size: 14px; text-align: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    `
    body.insertBefore(banner, body.firstChild)
  }
  banner.innerHTML = `⚠ <b>Erro:</b> ${msg} <span style="opacity:.7;font-size:12px;">(F12 pra detalhes técnicos)</span>`
}

function showBanner(html, type = 'warning') {
  if (!chat) return
  const existing = document.querySelector('.banner')
  if (existing) existing.remove()
  const b = document.createElement('div')
  b.className = `banner ${type}`
  b.innerHTML = `<span>${html}</span><button class="banner-close" aria-label="Fechar">×</button>`
  const closeBtn = b.querySelector('.banner-close')
  if (closeBtn) closeBtn.onclick = () => b.remove()
  if (chat.parentNode) chat.parentNode.insertBefore(b, chat)
}

// ════════════════════════════════════════════════════════════
// 4. HEALTH CHECK
// ════════════════════════════════════════════════════════════

async function checkHealth() {
  if (!statusDot || !statusText) return
  try {
    const r = await fetch('/health')
    if (!r.ok) throw new Error('not ready')
    const j = await r.json()
    statusDot.classList.remove('error', 'warn')
    statusDot.classList.add('ok')
    const isHttps = location.protocol === 'https:'
    const httpsTag = isHttps ? '🔒 HTTPS' : '⚠ HTTP'
    const provider = j.provider || '?'
    statusText.textContent = `${httpsTag} · ${j.tools || 0} tools · ${provider}`

    if (j.provider_ready === false) {
      statusDot.classList.remove('ok')
      statusDot.classList.add('error')
      statusText.textContent = `MOTOR OFFLINE · ${provider}`
      const detail = j.provider_detail === 'models_missing'
        ? `Modelos ausentes. Instale <code>${j.models?.fast || 'llama3.2:3b'}</code> e <code>${j.models?.smart || 'qwen3:4b'}</code>.`
        : 'Ollama não está iniciado ou instalado. Abra o Ollama e recarregue esta página.'
      showBanner(`⚠ <b>Motor de IA indisponível.</b> ${detail}`, 'error')
    } else if (!j.provider) {
      showBanner(
        '⚠ <b>Nenhum provider LLM configurado!</b> Clique em ⚙ pra adicionar uma API key.',
        'error'
      )
    } else if (!isHttps && j.https) {
      showBanner('Acesse via <a href="https://localhost:5071">https://localhost:5071</a> pra mic mais estável.', 'warning')
    }
  } catch (err) {
    console.warn('[Samaritano] health check falhou:', err)
    statusDot.classList.remove('ok')
    statusDot.classList.add('error')
    statusText.textContent = 'offline'
    showBanner('⚠ Servidor não responde. Verifique se está rodando (start.bat).', 'error')
  }
}

// ════════════════════════════════════════════════════════════
// 5. EMPTY STATE
// ════════════════════════════════════════════════════════════

function showEmptyState() {
  if (!chat || chat.children.length > 0) return

  // User fechou as sugestões antes? respeita
  const dismissed = localStorage.getItem('samaritano:suggestions:dismissed') === '1'

  if (dismissed) {
    chat.innerHTML = `
      <div class="empty empty-minimal">
        <div class="empty-hint">
          Digite, ou segure <kbd>espaço</kbd> pra falar.
          <button class="empty-show-tips" id="show-tips" title="Mostrar sugestões">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </button>
        </div>
      </div>
    `
    const showBtn = chat.querySelector('#show-tips')
    if (showBtn) showBtn.onclick = () => {
      localStorage.removeItem('samaritano:suggestions:dismissed')
      chat.innerHTML = ''
      showEmptyState()
    }
    return
  }

  const examples = [
    { icon: '🖥️', text: 'abre a calculadora' },
    { icon: '🌐', text: 'abre o youtube' },
    { icon: '🔍', text: 'pesquisa pizza no google' },
    { icon: '🕐', text: 'que horas são' },
    { icon: '📸', text: 'tira um screenshot' },
    { icon: '❓', text: 'ajuda' },
  ]

  chat.innerHTML = `
    <div class="empty empty-suggestions">
      <button class="empty-close" id="close-suggestions" aria-label="Fechar sugestões" title="Fechar (não mostrar mais)">×</button>
      <div class="empty-title">Tente algo:</div>
      <div class="examples">
        ${examples.map(e => `
          <button class="example-chip" data-q="${e.text}">
            <span class="chip-icon">${e.icon}</span>
            <span class="chip-text">${e.text}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `

  // X fecha e salva preferência
  const closeBtn = chat.querySelector('#close-suggestions')
  if (closeBtn) closeBtn.onclick = () => {
    localStorage.setItem('samaritano:suggestions:dismissed', '1')
    chat.innerHTML = ''
    showEmptyState()
  }

  chat.querySelectorAll('.example-chip').forEach(btn => {
    btn.onclick = () => {
      input.value = btn.dataset.q
      voiceMode = false
      submitStream()
    }
  })
}

// ════════════════════════════════════════════════════════════
// 6. VOICE STATUS BANNER
// ════════════════════════════════════════════════════════════

function setVoiceStatus(state, text) {
  if (!voiceStatus || !voiceText) return
  if (!state) {
    voiceStatus.classList.add('hidden')
    return
  }
  voiceStatus.classList.remove('hidden')
  voiceStatus.classList.remove('listening', 'processing', 'error')
  voiceStatus.classList.add(state)
  voiceText.textContent = text
}

function setMicState(newState, reason = '') {
  micState = newState
  if (!micBtn) return
  micBtn.classList.remove('recording', 'processing')
  switch (newState) {
    case State.IDLE:
      setVoiceStatus(null)
      break
    case State.REQUESTING_PERM:
      setVoiceStatus('processing', 'Pedindo permissão do mic…')
      break
    case State.LISTENING:
      micBtn.classList.add('recording')
      setVoiceStatus('listening', '🎙️ Escutando… (solte pra enviar)')
      break
    case State.PROCESSING:
      micBtn.classList.add('processing')
      setVoiceStatus('processing', '⏳ Processando áudio…')
      break
    case State.ERROR:
      setVoiceStatus('error', `⚠️ ${reason || 'Erro'}`)
      setTimeout(() => { if (micState === State.ERROR) setMicState(State.IDLE) }, 3000)
      break
  }
}

// ════════════════════════════════════════════════════════════
// 7. WEB SPEECH API (DESABILITADO — Whisper sempre primário)
// ════════════════════════════════════════════════════════════
//
// Decisão: Web Speech API era inconsistente (latência variável, qualidade
// instável, falha silenciosa em alguns Chromes). Whisper via servidor é
// mais previsível e tem qualidade superior em PT-BR. Pequena penalidade
// de latência (envio áudio + transcribe ~800ms) compensa pela confiabilidade.
//
// Pra reativar Web Speech, remova o `return` early e mude webSpeechAvailable.
//

function setupRecognition() {
  // Whisper primário — Web Speech permanece desativado por consistência.
  console.log('[Samaritano] STT: Whisper (servidor) é o caminho primário')
  webSpeechAvailable = false
  recognition = null
}

// ════════════════════════════════════════════════════════════
// 8. WHISPER FALLBACK (MediaRecorder)
// ════════════════════════════════════════════════════════════

async function startWhisperRecording() {
  setMicState(State.REQUESTING_PERM)
  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      })
    }
  } catch (err) {
    console.warn('[Samaritano] getUserMedia fail:', err)
    if (err.name === 'NotAllowedError') {
      showBanner('Permissão do mic negada. Clique no 🔒 da URL e permita.', 'error')
    } else if (err.name === 'NotFoundError') {
      showBanner('Nenhum microfone detectado.', 'error')
    } else {
      showBanner(`Erro no mic: ${err.message}`, 'error')
    }
    setMicState(State.ERROR, err.name)
    return
  }

  const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || ''

  recordedChunks = []
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined)
  } catch (err) {
    showBanner(`MediaRecorder falhou: ${err.message}`, 'error')
    setMicState(State.ERROR, err.message)
    return
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data)
  }
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mime || 'audio/webm' })
    recordedChunks = []
    if (blob.size < 2000) {
      setMicState(State.ERROR, 'Áudio muito curto')
      return
    }
    setMicState(State.PROCESSING)
    setVoiceStatus('processing', `🎙️ Transcrevendo (${(blob.size / 1024).toFixed(0)} KB)…`)
    try {
      const r = await fetch('/stt', {
        method: 'POST',
        headers: { 'Content-Type': mime || 'audio/webm' },
        body: blob,
      })
      const j = await r.json()
      if (j.ok && j.text && j.text.trim()) {
        if (input) input.value = j.text.trim()
        voiceMode = true
        await submitStream()
      } else {
        setMicState(State.ERROR, 'Whisper sem texto')
      }
    } catch (err) {
      console.warn('[Samaritano] STT error:', err)
      setMicState(State.ERROR, 'Falha no Whisper')
    } finally {
      if (micState === State.PROCESSING) setMicState(State.IDLE)
    }
  }
  mediaRecorder.start()
  setMicState(State.LISTENING)
}

function stopWhisperRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
}

function handleMicClick() {
  if (micState === State.LISTENING) {
    if (recognition && webSpeechAvailable) recognition.stop()
    else stopWhisperRecording()
    return
  }
  if (micState !== State.IDLE) return

  if (webSpeechAvailable && recognition) {
    try { recognition.start() }
    catch (err) {
      console.warn('[Samaritano] mic start error:', err)
      setMicState(State.ERROR, err.message)
    }
  } else {
    startWhisperRecording().catch(err => {
      console.warn('[Samaritano] whisper start error:', err)
      setMicState(State.ERROR, err.message)
    })
  }
}

// ════════════════════════════════════════════════════════════
// 9. SUBMIT (chat)
// ════════════════════════════════════════════════════════════

async function submit() {
  if (!input || !chat) {
    console.error('[Samaritano] submit() sem DOM elements')
    return
  }
  const text = input.value.trim()
  if (!text) return
  input.value = ''

  // Remove empty state
  const empty = chat.querySelector('.empty')
  if (empty) empty.remove()

  appendMsg('user', text)
  const thinking = appendMsg('assistant', '…', { thinking: true })

  const t0 = Date.now()
  try {
    const r = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESSION_ID, message: text }),
    })

    if (thinking && thinking.parentNode) thinking.remove()

    if (!r.ok) {
      // HTTP error code (500, 502, etc)
      let errBody = ''
      try { errBody = (await r.json()).error || '' } catch {}
      appendMsg('assistant',
        `❌ Servidor retornou erro ${r.status}. ${errBody}\n💡 Verifica config providers em ⚙ ou veja terminal do servidor.`,
        { error: true }
      )
      return
    }

    const j = await r.json()

    if (!j.ok) {
      appendMsg('assistant',
        `❌ ${j.text || j.error || 'erro desconhecido'}\n💡 Tente reformular ou trocar provider em ⚙.`,
        { error: true }
      )
      return
    }

    const dt = Date.now() - t0
    const tools = (j.tool_calls || []).map(tc => tc.name)
    const reflexBadge = j.from_reflex ? ' · reflex' : ''
    appendMsg('assistant', j.text || '(sem resposta)', {
      meta: `${dt}ms · ${j.iterations || 0} iter${reflexBadge}`,
      tools,
    })

    if (voiceMode) playTTS(j.text)
  } catch (err) {
    if (thinking && thinking.parentNode) thinking.remove()
    console.error('[Samaritano] submit network error:', err)
    appendMsg('assistant',
      `❌ Falha de rede: ${err.message}\n💡 Servidor pode ter caído. Tenta recarregar a página (F5).`,
      { error: true }
    )
  }
}

/**
 * STREAMING SUBMIT — usa /chat/stream (SSE) e renderiza tokens em tempo real.
 *
 * Pipeline:
 *   1. POST /chat/stream → reader de body (ReadableStream)
 *   2. Parse SSE: cada `data: {json}\n\n` é um evento
 *   3. text events → atualizam DOM textNode incrementalmente + buffer pra TTS
 *   4. Detecta sentença completa (.!?:) → enqueueTTSSentence (paralelo, ordenado)
 *   5. tool_call_start/end → cria/atualiza chip visual
 *   6. done → finaliza meta footer
 *
 * Vantagem vs submit() não-stream:
 *   - User vê texto aparecer letra por letra (perceived latency ~0)
 *   - TTS começa após 1ª sentença (~300ms vs 2-4s)
 *   - Tools mostram chip "executando..." em tempo real
 */
async function submitStream() {
  if (!input || !chat) {
    console.error('[Samaritano] submitStream() sem DOM')
    return
  }
  const text = input.value.trim()
  if (!text) return
  input.value = ''

  // Remove empty state
  const empty = chat.querySelector('.empty')
  if (empty) empty.remove()

  appendMsg('user', text)

  // Cria assistant msg manualmente com text node estável
  const assistantEl = document.createElement('div')
  assistantEl.className = 'msg assistant streaming'
  const textNode = document.createTextNode('')
  assistantEl.appendChild(textNode)
  // Cursor visual blinkante
  const cursor = document.createElement('span')
  cursor.className = 'stream-cursor'
  cursor.textContent = '▌'
  assistantEl.appendChild(cursor)
  chat.appendChild(assistantEl)
  chat.scrollTop = chat.scrollHeight

  const wantTTS = voiceMode
  const t0 = Date.now()
  let fullText = ''
  let pendingSentence = ''
  let toolsContainer = null
  const toolChipMap = {}
  const startedToolCalls = []
  let iterations = 0
  let fromReflex = false

  if (wantTTS) startTTSStream()

  const ensureToolsContainer = () => {
    if (!toolsContainer) {
      toolsContainer = document.createElement('div')
      toolsContainer.className = 'tools'
      assistantEl.insertBefore(toolsContainer, cursor)
    }
    return toolsContainer
  }

  const addOrUpdateToolChip = (name, state, output) => {
    const container = ensureToolsContainer()
    let chip = toolChipMap[name]
    if (!chip) {
      chip = document.createElement('span')
      chip.className = 'tool-chip'
      chip.textContent = name
      container.appendChild(chip)
      toolChipMap[name] = chip
    }
    chip.classList.remove('pending', 'ok', 'err')
    if (state === 'pending') chip.classList.add('pending')
    else if (state === 'ok') chip.classList.add('ok')
    else if (state === 'err') chip.classList.add('err')
    if (output && output.ok === false && state === 'ok') {
      chip.classList.remove('ok')
      chip.classList.add('err')
    }
  }

  // Extrai sentenças completas do buffer e dispatcha pra TTS
  const flushSentencesToTTS = () => {
    if (!wantTTS) return
    let m
    // Match sentença que termina em .!?: seguido por whitespace
    while ((m = pendingSentence.match(/^([\s\S]+?[.!?:][\s])([\s\S]*)$/))) {
      const sent = m[1].trim()
      if (sent && sent.length >= 3) enqueueTTSSentence(sent)
      pendingSentence = m[2]
    }
  }

  try {
    const r = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESSION_ID, message: text }),
    })

    if (!r.ok) {
      let errBody = ''
      try { errBody = (await r.json()).error || '' } catch {}
      textNode.nodeValue = `❌ Servidor retornou erro ${r.status}. ${errBody}\n💡 Verifica config providers em ⚙ ou veja terminal.`
      assistantEl.classList.add('error')
      assistantEl.classList.remove('streaming')
      cursor.remove()
      if (wantTTS) endTTSStream()
      return
    }

    if (!r.body || typeof r.body.getReader !== 'function') {
      // Browser sem ReadableStream — fallback pro endpoint não-streaming
      console.warn('[Samaritano] sem ReadableStream, fallback /chat')
      assistantEl.remove()
      if (wantTTS) endTTSStream()
      input.value = text
      return submit()
    }

    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE: blocks separated by \n\n
      let sepIdx
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)

        // Concat lines starting with "data: "
        let payload = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) payload += line.slice(6)
          // ': ' = heartbeat comment, ignora
        }
        if (!payload) continue

        let evt
        try { evt = JSON.parse(payload) }
        catch (e) { console.warn('[Samaritano] bad SSE payload:', payload.slice(0, 100)); continue }

        if (evt.type === 'text') {
          pendingSentence += evt.content
          fullText += evt.content
          textNode.nodeValue = fullText
          chat.scrollTop = chat.scrollHeight
          flushSentencesToTTS()
        } else if (evt.type === 'tool_call_start') {
          startedToolCalls.push({ name: evt.name, args: evt.args || {} })
          addOrUpdateToolChip(evt.name, 'pending')
          if (evt.name === 'skill_create' && !fullText) {
            textNode.nodeValue = 'Criando a skill localmente… neste notebook pode levar até 4 minutos. Mantenha a página aberta.'
          }
        } else if (evt.type === 'tool_call_end') {
          addOrUpdateToolChip(evt.name, evt.output?.ok === false ? 'err' : 'ok', evt.output)
        } else if (evt.type === 'reflex') {
          fromReflex = true
          // Reflexos retornam a resposta completa neste evento, sem chunks
          // do tipo `text`. Antes o texto era ignorado e o balão ficava vazio.
          if (evt.text && !fullText) {
            fullText = evt.text
            textNode.nodeValue = fullText
            pendingSentence += evt.text
            chat.scrollTop = chat.scrollHeight
            flushSentencesToTTS()
          }
        } else if (evt.type === 'meta') {
          if (evt.iteration) iterations = Math.max(iterations, evt.iteration)
        } else if (evt.type === 'done') {
          if (evt.from_reflex) fromReflex = true
          if (evt.iterations) iterations = evt.iterations
          // Compatibilidade defensiva com respostas completas sem chunks.
          if (!fullText && evt.text) {
            fullText = evt.text
            textNode.nodeValue = fullText
          }
        } else if (evt.type === 'error') {
          fullText += `\n❌ ${evt.message}`
          textNode.nodeValue = fullText
          assistantEl.classList.add('error')
        }
      }
    }

    // Flush sentença restante
    if (wantTTS && pendingSentence.trim().length >= 3) {
      enqueueTTSSentence(pendingSentence.trim())
    }
    pendingSentence = ''
    if (wantTTS) endTTSStream()

    // Meta footer
    const dt = Date.now() - t0
    const reflexBadge = fromReflex ? ' · reflex' : ''
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `${dt}ms · ${iterations || 1} iter${reflexBadge} · stream`
    assistantEl.appendChild(meta)
    cursor.remove()
    assistantEl.classList.remove('streaming')
  } catch (err) {
    console.error('[Samaritano] submitStream error:', err)
    if (wantTTS) endTTSStream()
    cursor.remove()
    assistantEl.classList.remove('streaming')
    if (!fullText) {
      const skillCall = startedToolCalls.find(call => call.name === 'skill_create')
      let recoveredSkill = null
      if (skillCall) {
        try {
          const toolsResponse = await fetch('/tools', { cache: 'no-store' })
          if (toolsResponse.ok) {
            const available = (await toolsResponse.json()).tools || []
            const requestedName = String(skillCall.args?.name || '').trim()
            if (requestedName) {
              recoveredSkill = available.find(tool => tool.name === requestedName)
            }
          }
        } catch {}
      }

      if (recoveredSkill) {
        textNode.nodeValue = `✅ A conexão do celular encerrou, mas a skill "${recoveredSkill.name}" foi criada no notebook e já está disponível.`
        addOrUpdateToolChip('skill_create', 'ok')
      } else if (skillCall) {
        textNode.nodeValue = '⚠ A conexão do celular encerrou durante a criação. Recarregue a página e diga “lista minhas skills” para conferir o resultado.'
        assistantEl.classList.add('error')
      } else {
        textNode.nodeValue = `❌ Falha de rede: ${err.message}\n💡 Tenta recarregar a página.`
        assistantEl.classList.add('error')
      }
    } else {
      const meta = document.createElement('span')
      meta.className = 'meta error'
      meta.textContent = `⚠ Stream interrompido: ${err.message}`
      assistantEl.appendChild(meta)
    }
  }
}

// ════════════════════════════════════════════════════════════
// 10. RENDER MESSAGES
// ════════════════════════════════════════════════════════════

function appendMsg(role, text, opts = {}) {
  if (!chat) return null
  const el = document.createElement('div')
  el.className = `msg ${role}` + (opts.thinking ? ' thinking' : '') + (opts.error ? ' error' : '')
  el.textContent = text
  if (opts.meta || (opts.tools && opts.tools.length)) {
    if (opts.tools && opts.tools.length) {
      const toolsEl = document.createElement('div')
      toolsEl.className = 'tools'
      for (const t of opts.tools) {
        const chip = document.createElement('span')
        chip.className = 'tool-chip'
        chip.textContent = t
        toolsEl.appendChild(chip)
      }
      el.appendChild(toolsEl)
    }
    if (opts.meta) {
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = opts.meta
      el.appendChild(meta)
    }
  }
  chat.appendChild(el)
  chat.scrollTop = chat.scrollHeight
  return el
}

function loadChatSession(sessionId, messages = []) {
  if (!/^web-[a-z0-9_-]{1,80}$/i.test(String(sessionId))) return false
  SESSION_ID = String(sessionId)
  localStorage.setItem('samaritano:active-session', SESSION_ID)
  if (!chat) return false
  chat.innerHTML = ''
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const when = Number(message.created_at)
    const meta = Number.isFinite(when)
      ? new Date(when).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : ''
    appendMsg(message.role, message.content, { meta })
  }
  if (messages.length === 0) showEmptyState()
  input?.focus()
  return true
}

function createNewChatSession() {
  return loadChatSession('web-' + Math.random().toString(36).slice(2, 10), [])
}

window.SamaritanoChat = {
  loadSession: loadChatSession,
  newSession: createNewChatSession,
  getSessionId: () => SESSION_ID,
}

// ════════════════════════════════════════════════════════════
// 11. TTS — STREAMING POR SENTENÇA (latência mínima)
// ════════════════════════════════════════════════════════════
//
// Estratégia:
//   1. Divide o texto em sentenças via regex
//   2. Dispara fetch /tts pra TODAS em paralelo (Promise.all)
//   3. Mas TOCA em ordem — assim que a 1ª chega, começa a tocar
//   4. As próximas vão entrando na fila e tocam em sequência
//   5. Resultado: user ouve ~300-500ms após chegada da resposta,
//      mesmo se o texto for longo (vs. ~2-4s se gerasse tudo de uma vez)
//
// Interruption: ttsAbortRequested cancela qualquer áudio em andamento
// e descarta os pendentes da fila.

let ttsAbortRequested = false
let ttsCurrentlyPlaying = false

// Streaming TTS state — sentenças chegam dinamicamente conforme LLM gera tokens
let ttsStreamQueue = []          // Promise<Blob|null>[] — gerações em paralelo
let ttsStreamDraining = false    // drain loop ativo?
let ttsStreamOpen = false        // stream ainda recebendo sentenças?

function isTTSPlaying() {
  return ttsCurrentlyPlaying || (ttsPlayer && !ttsPlayer.paused && !ttsPlayer.ended && ttsPlayer.currentTime > 0)
}

function stopTTS() {
  ttsAbortRequested = true
  ttsStreamQueue.length = 0
  ttsStreamOpen = false
  if (ttsPlayer) {
    try { ttsPlayer.pause() } catch {}
    try { ttsPlayer.currentTime = 0 } catch {}
    ttsPlayer.removeAttribute('src')
    try { ttsPlayer.load() } catch {}
  }
  ttsCurrentlyPlaying = false
  console.log('[Samaritano] TTS interrompido')
}

/**
 * cleanForTTS — Sanitiza texto pra TTS soar natural.
 *
 * Remove o que TTS pronuncia letra-a-letra (e fica horrível):
 *   - URLs (http://..., www....)        → "" ou "(o link)"
 *   - Emails                            → ""
 *   - Blocos de código ``` ... ```      → ""
 *   - Inline code `...`                 → texto interno
 *   - Markdown links [texto](url)       → "texto"
 *   - Markdown bold/italic              → texto interno
 *   - Headers (# ## ###)                → texto interno
 *   - Listas (-, *, +)                  → texto interno
 *   - Caracteres soltos (#, _, >)       → ""
 *   - Pontuação repetida (??!! → ?!)
 *
 * Usa heurística: substitui URLs por placeholder se o texto inteiro perderia
 * sentido (ex: "Abri http://..." vira "Abri o link"), senão remove silenciosa.
 */
function cleanForTTS(text) {
  if (!text || typeof text !== 'string') return ''
  let s = text

  // 1. Remove blocos de código ``` ... ``` (multiline)
  s = s.replace(/```[\s\S]*?```/g, ' ')

  // 2. Remove markdown links mantendo o label: [texto](url) → texto
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // 3. URLs com preposição imediata: "em https://...", "no http://...", etc → some o pacote inteiro
  //    Evita "em o site" estranho. A frase ainda fica natural sem a URL.
  s = s.replace(/\s*\b(em|no|na|para|pra|de|do|da|via|por|pelo|pela)\s+(?:https?:\/\/|www\.)[^\s<>"')]+/gi, '')

  // 4. URLs restantes: se vem após verbo de ação direto, vira "o site". Senão some.
  const urlRe = /(?:https?:\/\/|www\.)[^\s<>"')]+/gi
  s = s.replace(urlRe, (match, offset) => {
    const before = s.slice(Math.max(0, offset - 30), offset).toLowerCase()
    if (/\b(abri|abrindo|acessei|acessando|navegando|visite|olha|encontrei)\b/.test(before)) {
      return 'o site'
    }
    return ''
  })

  // 5. Emails (com preposição também)
  s = s.replace(/\s*\b(em|no|na|para|pra|de|do|da|via|por)\s+[\w.+-]+@[\w-]+\.[\w.-]+/gi, '')
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')

  // 6. Paths de arquivo
  s = s.replace(/(?:[A-Z]:\\|\/(?:usr|etc|home|var|tmp)\/)\S+/g, '')

  // 7. Inline code: `texto` → texto, ou some se técnico
  s = s.replace(/`([^`]+)`/g, (_, inner) => {
    if (/[\\\/\-_=]{2,}|--/.test(inner)) return ''
    return inner
  })

  // 8. Markdown
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/^[\s>]*[-*+]\s+/gm, '')
  s = s.replace(/^[\s>]*\d+\.\s+/gm, '')

  // 9. Caracteres soltos que TTS lê literalmente
  s = s.replace(/[#_~`>|]/g, '')
  s = s.replace(/->|=>/g, ',')
  s = s.replace(/\.{3,}/g, '...')
  s = s.replace(/!{2,}/g, '!')
  s = s.replace(/\?{2,}/g, '?')

  // 10. Whitespace + pontuação solta
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/\s+([.,!?:;])/g, '$1')
  s = s.replace(/([.,!?:;])\1+/g, '$1')

  // 11. Dedup: "o site o site" → "o site" (caso URL substituida apos texto que ja tinha "site")
  s = s.replace(/\b(o site|o link|a página|a pagina)(\s+\1)+/gi, '$1')

  s = s.trim()
  return s
}

/**
 * Divide texto em sentenças mantendo a pontuação.
 * Junta sentenças muito curtas (<25 chars) com a próxima pra evitar
 * fragmentos esquisitos tipo "OK." sozinhos.
 */
function splitIntoSentences(text) {
  if (!text || typeof text !== 'string') return []
  // Limpeza prévia (URLs, código, markdown, etc)
  const clean = cleanForTTS(text)
  if (!clean) return []

  // Match: termina em .!?: e seguido por espaço ou fim
  const matches = clean.match(/[^.!?:\n]+[.!?:\n]?\s*/g) || [clean]
  const sentences = []
  let buffer = ''
  for (const raw of matches) {
    const s = raw.trim()
    if (!s) continue
    if (buffer.length + s.length < 25) {
      buffer += (buffer ? ' ' : '') + s
    } else {
      if (buffer) {
        sentences.push((buffer + ' ' + s).trim())
        buffer = ''
      } else {
        sentences.push(s)
      }
    }
  }
  if (buffer) sentences.push(buffer.trim())
  return sentences.filter(s => s.length > 0)
}

async function generateTTSBlob(text) {
  // Defesa em profundidade: limpa de novo (caso o caller tenha esquecido)
  const cleaned = cleanForTTS(text)
  if (!cleaned) throw new Error('texto vazio após limpeza TTS')
  const r = await fetch('/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cleaned }),
  })
  if (!r.ok) throw new Error(`TTS fail HTTP ${r.status}`)
  return await r.blob()
}

async function playBlob(blob) {
  if (!ttsPlayer) return
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const cleanup = () => {
      try { URL.revokeObjectURL(url) } catch {}
      ttsPlayer.onended = null
      ttsPlayer.onerror = null
      resolve()
    }
    ttsPlayer.onended = cleanup
    ttsPlayer.onerror = cleanup
    ttsPlayer.src = url
    ttsPlayer.play().catch(err => {
      console.warn('[Samaritano] play() blocked:', err)
      cleanup()
    })
  })
}

async function playTTS(text) {
  if (!text || !ttsPlayer) return

  // Reset state
  ttsAbortRequested = false
  ttsCurrentlyPlaying = true

  const sentences = splitIntoSentences(text)
  if (sentences.length === 0) {
    ttsCurrentlyPlaying = false
    return
  }

  console.log(`[Samaritano] TTS: ${sentences.length} sentenças, streaming em paralelo`)

  // Dispara TODAS as gerações em paralelo (não espera 1ª terminar)
  const blobPromises = sentences.map(s => generateTTSBlob(s).catch(err => {
    console.warn('[Samaritano] TTS sentence err:', err.message)
    return null
  }))

  // Toca em ORDEM (await cada uma)
  for (let i = 0; i < blobPromises.length; i++) {
    if (ttsAbortRequested) break
    try {
      const blob = await blobPromises[i]
      if (!blob || ttsAbortRequested) break
      await playBlob(blob)
    } catch (err) {
      console.warn('[Samaritano] TTS play err:', err)
    }
  }

  ttsCurrentlyPlaying = false
}

/**
 * Inicia uma sessão de streaming TTS — sentenças vão chegando dinamicamente
 * conforme o LLM gera tokens. Cada sentença vira fetch /tts em paralelo,
 * mas tocam em ordem (FIFO).
 */
function startTTSStream() {
  ttsAbortRequested = false
  ttsStreamQueue.length = 0
  ttsStreamOpen = true
  ttsStreamDraining = false
  ttsCurrentlyPlaying = true
}

/**
 * Adiciona uma sentença na fila. Inicia geração TTS imediatamente (paralela)
 * mas garante ordem de reprodução. Se um drain loop não está rodando, inicia.
 */
function enqueueTTSSentence(text) {
  const t = (text || '').trim()
  if (!t || ttsAbortRequested) return
  console.log(`[Samaritano] TTS enqueue: "${t.slice(0, 50)}${t.length > 50 ? '…' : ''}"`)
  const blobPromise = generateTTSBlob(t).catch(err => {
    console.warn('[Samaritano] TTS sentence err:', err.message)
    return null
  })
  ttsStreamQueue.push(blobPromise)
  if (!ttsStreamDraining) {
    ttsStreamDraining = true
    drainTTSQueue()  // fire & forget
  }
}

/**
 * Drena a fila tocando blobs em ordem. Quando vazia, encerra. Se mais sentenças
 * forem adicionadas depois (enqueue), o próximo enqueue reinicia o drainer.
 */
async function drainTTSQueue() {
  try {
    while (ttsStreamQueue.length > 0 && !ttsAbortRequested) {
      const p = ttsStreamQueue.shift()
      try {
        const blob = await p
        if (!blob || ttsAbortRequested) continue
        await playBlob(blob)
      } catch (err) {
        console.warn('[Samaritano] TTS drain play err:', err)
      }
    }
  } finally {
    ttsStreamDraining = false
    // Se stream já fechado e fila vazia, marca não tocando
    if (!ttsStreamOpen && ttsStreamQueue.length === 0) {
      ttsCurrentlyPlaying = false
    }
  }
}

/** Marca o stream como fechado — não vão chegar mais sentenças. */
function endTTSStream() {
  ttsStreamOpen = false
  if (!ttsStreamDraining && ttsStreamQueue.length === 0) {
    ttsCurrentlyPlaying = false
  }
}

// ════════════════════════════════════════════════════════════
// 12. REALTIME MODE — conversa contínua com VAD
// ════════════════════════════════════════════════════════════
//
// Pipeline:
//   - User clica botão "AO VIVO" → realtime ON
//   - Mic fica sempre escutando
//   - Web Audio API mede RMS do áudio em tempo real
//   - Quando RMS > threshold → começa gravar (speech detected)
//   - Quando RMS < threshold por 900ms → encerra utterance, envia pra Whisper
//   - Resposta do orchestrator → TTS toca
//   - User pode INTERROMPER falando — VAD detecta voz, para TTS, gravando
//   - Loop infinito até user clicar botão pra desligar

async function startRealtimeMode() {
  if (realtimeActive) return
  console.log('[Samaritano] Realtime ON — pedindo permissão do mic...')

  try {
    realtimeStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
      },
    })
  } catch (err) {
    console.warn('[Samaritano] realtime mic permission:', err)
    if (err.name === 'NotAllowedError') {
      showBanner('Permissão do mic negada. Clique no 🔒 da URL e permita.', 'error')
    } else {
      showBanner(`Erro mic: ${err.message}`, 'error')
    }
    return
  }

  realtimeActive = true
  realtimeBtn.classList.add('active')
  setVoiceStatus('listening', '🔴 Ao vivo — fale quando quiser')

  // Setup Web Audio API pra VAD
  realtimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const source = realtimeAudioCtx.createMediaStreamSource(realtimeStream)
  realtimeAnalyser = realtimeAudioCtx.createAnalyser()
  realtimeAnalyser.fftSize = 512
  realtimeAnalyser.smoothingTimeConstant = 0.5
  source.connect(realtimeAnalyser)

  // Loop de medição RMS
  realtimeSilenceStart = null
  realtimeSpeechStart = null
  realtimeRMSCheckInterval = setInterval(checkVAD, VAD_CHECK_INTERVAL_MS)

  console.log('[Samaritano] Realtime ON, VAD ativo')
}

function stopRealtimeMode() {
  if (!realtimeActive) return
  console.log('[Samaritano] Realtime OFF')

  realtimeActive = false
  realtimeBtn.classList.remove('active')

  if (realtimeRMSCheckInterval) {
    clearInterval(realtimeRMSCheckInterval)
    realtimeRMSCheckInterval = null
  }
  if (realtimeRecorder && realtimeRecorder.state !== 'inactive') {
    try { realtimeRecorder.stop() } catch {}
  }
  realtimeRecording = false
  realtimeChunks = []
  realtimeSilenceStart = null
  realtimeSpeechStart = null

  if (realtimeStream) {
    realtimeStream.getTracks().forEach(t => t.stop())
    realtimeStream = null
  }
  if (realtimeAudioCtx) {
    try { realtimeAudioCtx.close() } catch {}
    realtimeAudioCtx = null
  }
  realtimeAnalyser = null

  setVoiceStatus(null)
}

function toggleRealtimeMode() {
  if (realtimeActive) stopRealtimeMode()
  else startRealtimeMode()
}

/**
 * Roda a cada 50ms. Mede RMS (volume) do mic atual.
 * Decide se está em "fala" ou "silêncio".
 */
function checkVAD() {
  if (!realtimeActive || !realtimeAnalyser) return

  const buffer = new Float32Array(realtimeAnalyser.fftSize)
  realtimeAnalyser.getFloatTimeDomainData(buffer)

  // Calcula RMS (Root Mean Square) — proxy de volume
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  const rms = Math.sqrt(sum / buffer.length)

  const speaking = rms > VAD_RMS_THRESHOLD
  const now = Date.now()

  if (speaking) {
    realtimeSilenceStart = null

    if (!realtimeSpeechStart) realtimeSpeechStart = now

    // Se TTS está tocando E user falando → INTERROMPE TTS
    if (isTTSPlaying()) {
      console.log('[Samaritano] User interrompeu TTS, voltando a escutar')
      stopTTS()
    }

    // Se ainda não começou a gravar, começa
    if (!realtimeRecording && micState !== State.PROCESSING) {
      startRealtimeRecording()
    }
  } else {
    // silêncio
    if (realtimeRecording) {
      if (!realtimeSilenceStart) realtimeSilenceStart = now
      const silenceMs = now - realtimeSilenceStart
      const speechMs = realtimeSpeechStart ? now - realtimeSpeechStart : 0

      // Silêncio prolongado E fala foi mínima → encerra utterance
      if (silenceMs >= VAD_SILENCE_DURATION_MS && speechMs >= VAD_MIN_SPEECH_MS) {
        console.log(`[Samaritano] Fim de fala detectado (${speechMs}ms speech, ${silenceMs}ms silence)`)
        stopRealtimeRecording()
      }
    }
  }
}

function startRealtimeRecording() {
  if (realtimeRecording || !realtimeStream) return

  const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || ''

  realtimeChunks = []
  try {
    realtimeRecorder = new MediaRecorder(realtimeStream, mime ? { mimeType: mime } : undefined)
  } catch (err) {
    console.warn('[Samaritano] realtime MediaRecorder:', err)
    return
  }
  realtimeRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) realtimeChunks.push(e.data)
  }
  realtimeRecorder.onstop = async () => {
    const blob = new Blob(realtimeChunks, { type: mime || 'audio/webm' })
    realtimeChunks = []
    realtimeRecording = false
    realtimeSpeechStart = null

    if (blob.size < 2000) {
      // Áudio muito curto, ignora — provavelmente foi noise spike
      setVoiceStatus('listening', '🔴 Ao vivo — fale quando quiser')
      return
    }

    setMicState(State.PROCESSING)
    setVoiceStatus('processing', '⏳ Processando...')

    try {
      const r = await fetch('/stt', {
        method: 'POST',
        headers: { 'Content-Type': mime || 'audio/webm' },
        body: blob,
      })
      const j = await r.json()
      if (j.ok && j.text && j.text.trim()) {
        if (input) input.value = j.text.trim()
        voiceMode = true
        await submitStream()
      } else {
        console.log('[Samaritano] realtime STT vazio')
      }
    } catch (err) {
      console.warn('[Samaritano] realtime STT:', err)
    } finally {
      setMicState(State.IDLE)
      // Volta a escutar (loop)
      if (realtimeActive) {
        setVoiceStatus('listening', '🔴 Ao vivo — fale quando quiser')
      }
    }
  }
  realtimeRecorder.start()
  realtimeRecording = true
  setVoiceStatus('listening', '🎙️ Captando...')
  console.log('[Samaritano] realtime gravando...')
}

function stopRealtimeRecording() {
  if (!realtimeRecording || !realtimeRecorder) return
  if (realtimeRecorder.state !== 'inactive') {
    try { realtimeRecorder.stop() } catch {}
  }
  realtimeSilenceStart = null
}

function setupRealtime() {
  if (!realtimeBtn) return
  realtimeBtn.onclick = toggleRealtimeMode
}


// ════════════════════════════════════════════════════════════
// 13. KEYBOARD (espaço pra falar)
// ════════════════════════════════════════════════════════════

function setupKeyboard() {
  let spaceHeld = false

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return
    if (document.activeElement === input) return  // user digitando
    if (spaceHeld) return
    spaceHeld = true
    e.preventDefault()

    // PRIORIDADE 1: TTS tocando? interrompe (não inicia mic)
    if (isTTSPlaying()) {
      stopTTS()
      // Mostra feedback visual rápido
      setVoiceStatus('error', '⏹️ Fala interrompida')
      setTimeout(() => setVoiceStatus(null), 800)
      return
    }

    // PRIORIDADE 2: mic IDLE? inicia
    if (micState === State.IDLE) {
      handleMicClick()
    }
  })

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return
    spaceHeld = false

    // Solta espaço durante recording → para e processa
    if (micState === State.LISTENING) {
      if (recognition && webSpeechAvailable) {
        try { recognition.stop() } catch {}
      } else {
        stopWhisperRecording()
      }
    }
  })
}

// ════════════════════════════════════════════════════════════
// 13. SETTINGS MODAL
// ════════════════════════════════════════════════════════════

function setupSettings() {
  if (!settingsBtn || !settingsModal) return
  settingsBtn.onclick = openSettings
  if (settingsClose) settingsClose.onclick = closeSettings
  const backdrop = settingsModal.querySelector('.modal-backdrop')
  if (backdrop) backdrop.onclick = closeSettings
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
      closeSettings()
    }
  })
}

async function openSettings() {
  if (!settingsModal || !settingsBody) return
  settingsModal.classList.remove('hidden')
  settingsBody.innerHTML = '<div class="loading">Carregando…</div>'
  try {
    const [configResponse, privacyResponse] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/privacy'),
    ])
    if (!configResponse.ok) throw new Error(`HTTP ${configResponse.status}`)
    const cfg = await configResponse.json()
    const privacy = privacyResponse.ok ? await privacyResponse.json() : null
    renderSettings(cfg, privacy)
  } catch (err) {
    settingsBody.innerHTML = `<div class="loading">Erro: ${err.message}</div>`
  }
}

function closeSettings() {
  if (settingsModal) settingsModal.classList.add('hidden')
}

function renderSettings(cfg, privacy = null) {
  if (!settingsBody) return

  const primary = (() => {
    if (cfg.provider && cfg.provider !== 'auto') return cfg.provider
    const order = ['groq', 'openai', 'gemini', 'anthropic', 'deepseek', 'openrouter', 'ollama']
    return order.find(n => cfg.providers[n] && cfg.providers[n]._hasKey) || null
  })()

  const providersHtml = Object.keys(PROVIDER_INFO).map(name => {
    const info = PROVIDER_INFO[name]
    const p = (cfg.providers && cfg.providers[name]) || {}
    const hasKey = !!p._hasKey
    const isActive = name === primary
    return `
      <div class="provider-card${isActive ? ' active' : ''}" data-provider="${name}">
        <div class="provider-header">
          <div class="provider-name">
            ${info.label}
            ${isActive ? '<span class="provider-badge set">PRIMÁRIO</span>' : ''}
            ${hasKey && !isActive ? '<span class="provider-badge set">SET</span>' : ''}
            ${!hasKey ? '<span class="provider-badge empty">VAZIO</span>' : ''}
          </div>
          <a href="${info.keyUrl}" target="_blank" class="provider-link">Pegar key →</a>
        </div>
        <div class="provider-info">${info.desc}</div>
        <div class="provider-info" style="margin-top:4px;">
          <span style="color:var(--accent);">${info.pros}</span> ·
          <span style="color:var(--text-dim);">${info.cons}</span>
        </div>
        <div class="provider-input-row" style="margin-top:8px;">
          <input
            type="password"
            class="provider-input"
            placeholder="${hasKey ? p.apiKey : info.keyHint}"
            data-key-input="${name}"
          />
          <button class="provider-btn" data-action="test" data-provider="${name}">Testar</button>
          <button class="provider-btn primary" data-action="save" data-provider="${name}">Salvar</button>
        </div>
        <div class="provider-status" data-status="${name}"></div>
      </div>
    `
  }).join('')

  settingsBody.innerHTML = `
    <div class="provider-current">
      <span>📡</span>
      <span><strong>Provider primário ativo:</strong> ${primary ? PROVIDER_INFO[primary].label : '<em>nenhum — configure abaixo</em>'}</span>
    </div>
    <div class="settings-section">
      <h3>Providers LLM</h3>
      ${providersHtml}
    </div>
    <div class="settings-section">
      <h3>Provider preferido</h3>
      <div class="provider-input-row">
        <select class="provider-input" id="primary-select">
          <option value="auto" ${cfg.provider === 'auto' || !cfg.provider ? 'selected' : ''}>auto (detecta automático)</option>
          ${Object.keys(PROVIDER_INFO).map(n =>
            `<option value="${n}" ${cfg.provider === n ? 'selected' : ''}>${PROVIDER_INFO[n].label}</option>`
          ).join('')}
        </select>
        <button class="provider-btn primary" id="save-primary">Salvar preferência</button>
      </div>
      <div class="provider-info" style="margin-top:6px;">
        Se "auto", usa o primeiro com key. Se específico, força esse mas tem fallback automático.
      </div>
    </div>
    <div class="settings-section privacy-section">
      <h3>Privacidade e LGPD</h3>
      <div class="privacy-summary">
        <div><strong>${privacy?.history ?? '—'}</strong><span>mensagens locais</span></div>
        <div><strong>${privacy?.facts ?? '—'}</strong><span>fatos memorizados</span></div>
        <div><strong>${privacy?.retention_days ?? 30}d</strong><span>retenção máxima</span></div>
      </div>
      <p class="provider-info">CPF, cartões, senhas e chaves de API são removidos do histórico. Os dados permanecem neste computador; mensagens enviadas ao provedor seguem a política dele.</p>
      <div class="privacy-actions">
        <button class="provider-btn" id="privacy-export">Exportar meus dados</button>
        <button class="provider-btn danger" id="privacy-delete-history">Apagar histórico</button>
        <button class="provider-btn danger" id="privacy-delete-face">Apagar biometria</button>
        <button class="provider-btn danger" id="privacy-delete-all">Apagar tudo</button>
      </div>
      <div class="provider-status" id="privacy-status"></div>
    </div>
    <div class="save-bar">
      <span class="save-bar-msg" id="save-msg"></span>
      <button class="provider-btn" id="reload-config">Recarregar</button>
    </div>
  `

  settingsBody.querySelectorAll('[data-action="test"]').forEach(btn => {
    btn.onclick = () => testProvider(btn.dataset.provider)
  })
  settingsBody.querySelectorAll('[data-action="save"]').forEach(btn => {
    btn.onclick = () => saveProviderKey(btn.dataset.provider)
  })
  const sp = $('save-primary')
  if (sp) sp.onclick = savePrimaryProvider
  const rc = $('reload-config')
  if (rc) rc.onclick = openSettings
  const pe = $('privacy-export')
  if (pe) pe.onclick = () => { window.location.href = '/api/privacy/export' }
  const pdh = $('privacy-delete-history')
  if (pdh) pdh.onclick = () => deletePrivateData('history')
  const pdf = $('privacy-delete-face')
  if (pdf) pdf.onclick = deleteFaceData
  const pda = $('privacy-delete-all')
  if (pda) pda.onclick = () => deletePrivateData('all')
}

async function deleteFaceData() {
  if (!window.confirm('Apagar o cadastro facial de Luiz? Será necessário cadastrar novamente.')) return
  const status = $('privacy-status')
  try {
    const response = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'APAGAR BIOMETRIA' }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
    location.reload()
  } catch (err) {
    if (status) {
      status.textContent = `Erro ao apagar biometria: ${err.message}`
      status.className = 'provider-status error'
    }
  }
}

async function deletePrivateData(scope) {
  const label = scope === 'all' ? 'todos os fatos, conversas e sessões' : 'todo o histórico de conversas'
  if (!window.confirm(`Apagar ${label}? Esta ação não pode ser desfeita.`)) return
  const status = $('privacy-status')
  if (status) {
    status.textContent = 'Apagando dados locais…'
    status.className = 'provider-status testing'
  }
  try {
    const response = await fetch('/api/privacy/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, confirm: true }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`)
    if (status) {
      status.textContent = 'Dados apagados com sucesso.'
      status.className = 'provider-status ok'
    }
    setTimeout(openSettings, 700)
  } catch (err) {
    if (status) {
      status.textContent = `Erro: ${err.message}`
      status.className = 'provider-status error'
    }
  }
}

async function testProvider(name) {
  const inputEl = settingsBody.querySelector(`[data-key-input="${name}"]`)
  const status = settingsBody.querySelector(`[data-status="${name}"]`)
  if (!inputEl || !status) return
  const apiKey = inputEl.value.trim()
  if (!apiKey) {
    status.textContent = 'Cole a key primeiro'
    status.className = 'provider-status error'
    return
  }
  status.textContent = '⏳ Testando...'
  status.className = 'provider-status testing'
  try {
    const r = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: name, apiKey }),
    })
    const j = await r.json()
    if (j.ok) {
      status.textContent = `✓ Key válida (${j.latency_ms}ms)`
      status.className = 'provider-status ok'
    } else {
      status.textContent = `✗ ${j.error}`
      status.className = 'provider-status error'
    }
  } catch (err) {
    status.textContent = `✗ ${err.message}`
    status.className = 'provider-status error'
  }
}

async function saveProviderKey(name) {
  const inputEl = settingsBody.querySelector(`[data-key-input="${name}"]`)
  const status = settingsBody.querySelector(`[data-status="${name}"]`)
  if (!inputEl || !status) return
  const apiKey = inputEl.value.trim()
  if (!apiKey) {
    status.textContent = 'Cole a key primeiro'
    status.className = 'provider-status error'
    return
  }
  status.textContent = '⏳ Salvando...'
  status.className = 'provider-status testing'
  try {
    const body = { providers: { [name]: { apiKey } } }
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    if (j.ok) {
      status.textContent = `✓ Salvo. Provider primário: ${j.new_provider}`
      status.className = 'provider-status ok'
      inputEl.value = ''
      checkHealth()
      setTimeout(openSettings, 800)
    } else {
      status.textContent = `✗ ${j.error}`
      status.className = 'provider-status error'
    }
  } catch (err) {
    status.textContent = `✗ ${err.message}`
    status.className = 'provider-status error'
  }
}

async function savePrimaryProvider() {
  const select = $('primary-select')
  const msg = $('save-msg')
  if (!select || !msg) return
  msg.textContent = '⏳ Salvando...'
  msg.className = 'save-bar-msg'
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: select.value }),
    })
    const j = await r.json()
    if (j.ok) {
      msg.textContent = `✓ Salvo. Primário: ${j.new_provider}`
      msg.className = 'save-bar-msg ok'
      checkHealth()
      setTimeout(openSettings, 1000)
    } else {
      msg.textContent = `✗ ${j.error}`
      msg.className = 'save-bar-msg error'
    }
  } catch (err) {
    msg.textContent = `✗ ${err.message}`
    msg.className = 'save-bar-msg error'
  }
}

// ════════════════════════════════════════════════════════════
// 14. INIT — chama tudo no FIM, só depois do DOM pronto
// ════════════════════════════════════════════════════════════

function init() {
  console.log('[Samaritano] init starting...')

  // Pega DOM elements (DOM já pronto neste ponto)
  chat = $('chat')
  input = $('input')
  sendBtn = $('send')
  micBtn = $('mic')
  statusDot = $('status-dot')
  statusText = $('status-text')
  ttsPlayer = $('tts-player')
  voiceStatus = $('voice-status')
  voiceIcon = $('voice-icon')
  voiceText = $('voice-text')
  realtimeBtn = $('realtime-btn')
  settingsModal = $('settings-modal')
  settingsClose = $('settings-close')
  settingsBtn = $('settings-btn')
  settingsBody = $('settings-body')

  // Validate critical elements
  const critical = { chat, input, sendBtn, micBtn }
  const missing = Object.keys(critical).filter(k => !critical[k])
  if (missing.length > 0) {
    showFatalError(`Elementos faltando no HTML: ${missing.join(', ')}. App.js incompatível com index.html?`)
    return
  }

  // Wire up text submit (CRITICAL — texto é o input mais usado)
  // Usa submitStream() pra renderização token-by-token + TTS sentence-by-sentence
  sendBtn.onclick = () => {
    voiceMode = false
    submitStream().catch(err => {
      console.error('[Samaritano] submitStream catch:', err)
      appendMsg('assistant', `❌ ${err.message}`, { error: true })
    })
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      voiceMode = false
      submitStream().catch(err => {
        console.error('[Samaritano] submitStream catch:', err)
        appendMsg('assistant', `❌ ${err.message}`, { error: true })
      })
    }
  })

  // Mic
  micBtn.onclick = handleMicClick

  // Setup steps — cada um isolado em try/catch
  try { checkHealth() } catch (err) { console.warn('[Samaritano] checkHealth fail:', err) }
  try { showEmptyState() } catch (err) { console.warn('[Samaritano] showEmptyState fail:', err) }
  try { setupRecognition() } catch (err) { console.warn('[Samaritano] setupRecognition fail:', err) }
  try { setupKeyboard() } catch (err) { console.warn('[Samaritano] setupKeyboard fail:', err) }
  try { setupSettings() } catch (err) { console.warn('[Samaritano] setupSettings fail:', err) }
  try { setupRealtime() } catch (err) { console.warn('[Samaritano] setupRealtime fail:', err) }

  console.log('[Samaritano] init done. SESSION_ID =', SESSION_ID)
}

// Se DOM já pronto, init agora. Senão, espera.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
