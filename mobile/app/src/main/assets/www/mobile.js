'use strict'

const $ = id => document.getElementById(id)
const core = () => window.SamaritanoAndroid
let sessionId = localStorage.getItem('samaritano:mobile-session') || newSessionId()
let messages = []
let lastAnswer = ''
let speaking = false
let activeRequest = null
let activeAudioButton = null
let pendingAttachment = null
let webSearchEnabled = false
let activeWebSearch = false

function newSessionId() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function formatDate(value) {
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function appendMessage(role, content, meta = '') {
  const chat = $('chat')
  const empty = chat.querySelector('.empty')
  if (empty) empty.remove()
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.dataset.content = content
  const text = document.createElement('span')
  text.className = 'message-text'
  text.textContent = content
  el.appendChild(text)
  if (role === 'assistant' && content !== '…') {
    const actions = document.createElement('div')
    actions.className = 'message-actions'
    const audio = document.createElement('button')
    audio.className = 'message-audio-btn'
    audio.type = 'button'
    audio.textContent = '🔊 OUVIR'
    audio.onclick = () => speaking && activeAudioButton === audio ? stopSpeaking() : speak(content, audio)
    actions.appendChild(audio)
    el.appendChild(actions)
  }
  if (meta) {
    const info = document.createElement('span')
    info.className = 'meta'
    info.textContent = meta
    el.appendChild(info)
  }
  chat.appendChild(el)
  chat.scrollTop = chat.scrollHeight
  return el
}

function showEmptyState() {
  const chat = $('chat')
  if (chat.children.length) return
  const empty = document.createElement('div')
  empty.className = 'empty empty-minimal'
  empty.innerHTML = '<div class="empty-hint">NÚCLEO MOBILE PRONTO // DIGITE OU USE O MICROFONE</div>'
  chat.appendChild(empty)
}

function speak(text, button = null) {
  text = cleanAssistantText(text)
  if (!text || !core()) return
  stopSpeaking()
  core().speak(text)
  speaking = true
  activeAudioButton = button
  if (activeAudioButton) {
    activeAudioButton.classList.add('active')
    activeAudioButton.textContent = '■ PARAR'
  }
}

function cleanAssistantText(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
}

function stopSpeaking() {
  core()?.stopSpeaking()
  speaking = false
  if (activeAudioButton) {
    activeAudioButton.classList.remove('active')
    activeAudioButton.textContent = '🔊 OUVIR'
  }
  activeAudioButton = null
}

function formatBytes(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function renderAttachment() {
  const tray = $('attachment-tray')
  if (!pendingAttachment) {
    tray.classList.add('hidden')
    tray.innerHTML = ''
    return
  }
  tray.classList.remove('hidden')
  tray.innerHTML = ''
  const info = document.createElement('span')
  info.textContent = `${pendingAttachment.name} // ${formatBytes(pendingAttachment.size)}`
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '×'
  remove.setAttribute('aria-label', 'Remover anexo')
  remove.onclick = () => {
    pendingAttachment = null
    core()?.clearAttachment()
    renderAttachment()
  }
  tray.append(info, remove)
}

function createNewChat() {
  sessionId = newSessionId()
  localStorage.setItem('samaritano:mobile-session', sessionId)
  messages = []
  lastAnswer = ''
  $('chat').innerHTML = ''
  showEmptyState()
  closeModal('history-modal')
}

function loadSession(id) {
  if (!core()) return
  const stored = parseJson(core().getMessages(id), [])
  sessionId = id
  localStorage.setItem('samaritano:mobile-session', id)
  messages = stored.map(item => ({ role: item.role, content: item.content }))
  $('chat').innerHTML = ''
  for (const item of stored) appendMessage(item.role, item.content, formatDate(item.created_at))
  const assistants = stored.filter(item => item.role === 'assistant')
  lastAnswer = assistants.length ? assistants[assistants.length - 1].content : ''
  if (!stored.length) showEmptyState()
  closeModal('history-modal')
}

function renderHistory() {
  const list = $('history-list')
  list.innerHTML = ''
  const sessions = core() ? parseJson(core().listSessions(), []) : []
  if (!sessions.length) {
    list.innerHTML = '<div class="history-empty">Nenhuma conversa salva.</div>'
    return
  }
  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = `history-item-row${session.session_id === sessionId ? ' active' : ''}`
    const open = document.createElement('button')
    open.className = 'history-item'
    const title = document.createElement('strong')
    title.textContent = session.title || 'Nova conversa'
    const meta = document.createElement('span')
    meta.textContent = `${formatDate(session.updated_at)} // ${session.message_count} MENSAGENS`
    open.append(title, meta)
    open.onclick = () => loadSession(session.session_id)
    const remove = document.createElement('button')
    remove.className = 'history-delete'
    remove.textContent = '×'
    remove.setAttribute('aria-label', 'Excluir conversa')
    remove.onclick = () => {
      if (!confirm('Excluir esta conversa do celular?')) return
      core().deleteSession(session.session_id)
      if (session.session_id === sessionId) createNewChat()
      renderHistory()
    }
    row.append(open, remove)
    list.appendChild(row)
  }
}

function openModal(id) { $(id)?.classList.remove('hidden') }
function closeModal(id) { $(id)?.classList.add('hidden') }

function getConfig() {
  return core() ? parseJson(core().getConfig(), {}) : { provider: 'groq', model: '', has_api_key: false }
}

function renderSettings() {
  const config = getConfig()
  $('settings-body').innerHTML = `
    <div class="mobile-settings">
      <label>PROVEDOR DE IA
        <select id="mobile-provider">
          <option value="groq">GROQ</option>
          <option value="gemini">GOOGLE GEMINI</option>
          <option value="offline">OFFLINE // QWEN3 LOCAL</option>
        </select>
      </label>
      <label>MODELO
        <input id="mobile-model" autocomplete="off" />
      </label>
      <label>CHAVE DA API
        <input id="mobile-api-key" type="password" autocomplete="off" placeholder="${config.has_api_key ? 'CHAVE JÁ PROTEGIDA — DEIXE VAZIO PARA MANTER' : 'COLE SUA CHAVE'}" />
      </label>
      <p class="provider-info">A chave é criptografada pelo Android Keystore e não aparece no histórico.</p>
      <label>LOCAL PADRÃO DO CLIMA
        <input id="mobile-weather-location" autocomplete="off" placeholder="Soledade, Rio Grande do Sul" />
      </label>
      <label>OBJETIVOS, REGRAS E LIMITES (.MD)
        <textarea id="mobile-directives" rows="9" placeholder="# Objetivos\n- Ajudar Luiz...\n\n# Regras\n- ..."></textarea>
      </label>
      <p class="provider-info">Este texto é local e entra nas diretrizes do Samaritano. Limite de 8.000 caracteres.</p>
      <div class="offline-model-card">
        <strong>NÚCLEO OFFLINE // QWEN3 1.7B</strong>
        <span id="offline-model-status">VERIFICANDO…</span>
        <div class="offline-progress"><i id="offline-progress-bar"></i></div>
        <button id="offline-download" class="provider-btn">BAIXAR MODELO OFFLINE // 1,28 GB</button>
        <small>Baixe uma vez no Wi-Fi. Depois o chat funciona sem internet.</small>
      </div>
      <button id="mobile-save-config" class="provider-btn primary">SALVAR NO NÚCLEO SEGURO</button>
      <div id="mobile-config-status" class="save-bar-msg"></div>
    </div>`
  const provider = $('mobile-provider')
  const model = $('mobile-model')
  provider.value = config.provider || 'groq'
  model.value = config.model || defaultModel(provider.value)
  $('mobile-weather-location').value = config.weather_location || 'Soledade, Rio Grande do Sul'
  $('mobile-directives').value = config.directives || ''
  provider.onchange = () => { model.value = defaultModel(provider.value) }
  $('offline-download').onclick = () => {
    const result = parseJson(core()?.startOfflineDownload(), {})
    if (!result.ok) alert(result.error || 'Falha ao iniciar download')
    updateOfflineStatus()
  }
  updateOfflineStatus()
  $('mobile-save-config').onclick = () => {
    const result = parseJson(core().saveConfig(
      provider.value,
      model.value.trim(),
      $('mobile-api-key').value,
      $('mobile-weather-location').value.trim(),
      $('mobile-directives').value,
    ), {})
    const status = $('mobile-config-status')
    status.textContent = result.ok ? '✓ CONFIGURAÇÃO PROTEGIDA' : `✕ ${result.error || 'Falha ao salvar'}`
    status.className = `save-bar-msg ${result.ok ? 'success' : 'error'}`
    if (result.ok) updateDashboard()
  }
}

function defaultModel(provider) {
  if (provider === 'offline') return 'Qwen3-1.7B-Q4_K_M'
  return provider === 'gemini' ? 'gemini-2.5-flash-lite' : 'llama-3.1-8b-instant'
}

function updateOfflineStatus() {
  const label = $('offline-model-status')
  if (!label || !core()) return
  const status = parseJson(core().getOfflineStatus(), {})
  const bar = $('offline-progress-bar')
  const button = $('offline-download')
  let percent = 0
  if (status.total > 0) percent = Math.min(100, Math.round((status.downloaded / status.total) * 100))
  if (bar) bar.style.width = `${percent}%`
  if (status.ready) {
    label.textContent = '✓ INSTALADO E VERIFICADO // PRONTO'
    button.disabled = true
    button.textContent = 'MODELO OFFLINE INSTALADO'
  } else if (status.verifying) {
    label.textContent = 'VERIFICANDO SHA-256…'
    button.disabled = true
  } else if (status.downloading) {
    label.textContent = `BAIXANDO // ${percent}% // ${formatBytes(status.downloaded || 0)}`
    button.disabled = true
  } else {
    label.textContent = status.error ? `✕ ${status.error}` : 'NÃO INSTALADO'
    button.disabled = false
  }
  updateDashboard()
}

function wantsWebSearch(text) {
  return /\b(pesquis[ae]|busque|procure|na web|na internet|not[ií]cias|hoje|agora|atualizad[oa]s?|quanto custa|pre[cç]o atual)\b/i.test(text)
}

function isWhatsAppCommand(text) {
  return /^(abra|abre|abrir|inicie|inicia|ir para|me leve (?:para|ao))\s+(o\s+)?(whats(?:app)?|zap)\s*[.!?]*$/i.test(text.trim())
}

function weatherRequest(text) {
  if (!/\b(tempo|clima|previs[aã]o)\b/i.test(text)) return null
  const dayOffset = /\bamanh[aã]\b/i.test(text) ? 1 : 0
  const matches = [...text.matchAll(/\b(?:em|para)\s+([^?!.]+)/gi)]
  let location = matches.length ? matches[matches.length - 1][1].trim() : ''
  location = location.replace(/\b(hoje|amanh[aã])\b/gi, '').replace(/^[,\s]+|[,\s]+$/g, '').trim()
  if (/^(hoje|amanh[aã])$/i.test(location)) location = ''
  return { location, dayOffset }
}

function setWebSearch(enabled) {
  webSearchEnabled = enabled
  const button = $('web-search')
  button.classList.toggle('active', enabled)
  button.setAttribute('aria-pressed', String(enabled))
  button.title = enabled ? 'Busca web ativada para a próxima mensagem' : 'Buscar na web'
}

async function submit() {
  const input = $('input')
  let text = input.value.trim()
  if ((!text && !pendingAttachment) || activeRequest) return
  if (isWhatsAppCommand(text)) {
    input.value = ''
    appendMessage('user', text)
    core()?.saveMessage(sessionId, 'user', text)
    core()?.openWhatsApp()
    return
  }
  if (!text && pendingAttachment) text = pendingAttachment.mime.startsWith('video/')
    ? 'Analise este vídeo, descreva os eventos principais e indique os momentos relevantes.'
    : 'Analise este arquivo e apresente os pontos principais.'
  const attachment = pendingAttachment
  input.value = ''
  stopSpeaking()
  const storedText = attachment ? `${text}\n\n[ANEXO: ${attachment.name} // ${attachment.mime}]` : text
  appendMessage('user', storedText)
  messages.push({ role: 'user', content: text })
  core()?.saveMessage(sessionId, 'user', storedText)

  const weather = weatherRequest(text)
  if (weather && !attachment) {
    const thinking = appendMessage('assistant', '…')
    activeRequest = `weather-${Date.now().toString(36)}`
    activeWebSearch = true
    thinking.dataset.requestId = activeRequest
    $('send').classList.add('busy')
    core()?.requestWeather(activeRequest, weather.location, weather.dayOffset)
    return
  }

  const config = getConfig()
  if (!config.has_api_key && !config.offline_ready) {
    const warning = 'Configure gratuitamente uma chave Groq ou Gemini nas configurações.'
    appendMessage('assistant', warning)
    openModal('settings-modal')
    renderSettings()
    return
  }

  const thinking = appendMessage('assistant', '…')
  activeRequest = `req-${Date.now().toString(36)}`
  activeWebSearch = webSearchEnabled || wantsWebSearch(text)
  const request = {
    sessionId,
    provider: config.provider,
    model: config.model || defaultModel(config.provider),
    messages: messages.slice(-20),
    includeAttachment: Boolean(attachment),
    webSearch: activeWebSearch,
  }
  core().sendChat(activeRequest, JSON.stringify(request))
  thinking.dataset.requestId = activeRequest
  $('send').classList.add('busy')
}

function updateDashboard() {
  const config = getConfig()
  const device = core() ? parseJson(core().deviceInfo(), {}) : {}
  const sessions = core() ? parseJson(core().listSessions(), []) : []
  $('dash-engine-status').textContent = config.has_api_key ? 'OPERACIONAL' : 'CONFIGURAÇÃO NECESSÁRIA'
  $('dash-provider').textContent = (config.provider || '—').toUpperCase()
  $('dash-model').textContent = config.model || '—'
  $('dash-network-status').textContent = navigator.onLine ? 'ONLINE' : 'SEM REDE'
  $('dash-protocol').textContent = 'ANDROID HTTPS'
  $('dash-tools').textContent = 'MOBILE CORE'
  $('dash-memory-total').textContent = `${sessions.length} CONVERSAS`
  $('dash-history').textContent = String(sessions.reduce((sum, item) => sum + Number(item.message_count || 0), 0))
  $('dash-facts').textContent = 'LOCAL'
  $('dash-security-status').textContent = 'ANDROID KEYSTORE'
  $('dash-face').textContent = 'BIOMETRIA'
  const networkAddress = document.querySelector('[data-module="network"] .dash-row:last-child b')
  if (networkAddress) networkAddress.textContent = `${device.manufacturer || ''} ${device.model || ''}`.trim() || 'ANDROID'
}

function unlock(success, message) {
  const gate = $('auth-gate')
  gate.dataset.state = success ? 'success' : 'error'
  $('auth-subject').textContent = success ? 'LUIZ' : 'NÃO AUTORIZADO'
  $('auth-status').textContent = message
  if (!success) return
  setTimeout(() => {
    document.body.classList.remove('auth-pending')
    gate.classList.add('hidden')
    $('input').focus()
    updateDashboard()
  }, 400)
}

window.SamaritanoNative = {
  onAuthResult: unlock,
  onChatResult(requestId, ok, payload) {
    if (requestId !== activeRequest) return
    const target = document.querySelector(`.msg[data-request-id="${requestId}"]`)
    if (target) target.remove()
    const answer = ok ? cleanAssistantText(payload) : `Falha no núcleo de IA: ${payload}`
    appendMessage('assistant', answer, ok ? (activeWebSearch ? 'WEB // MOBILE CORE' : 'MOBILE CORE') : 'ERRO')
    if (ok) {
      messages.push({ role: 'assistant', content: answer })
      core()?.saveMessage(sessionId, 'assistant', answer)
      lastAnswer = answer
      if (pendingAttachment) {
        pendingAttachment = null
        renderAttachment()
      }
    }
    activeRequest = null
    activeWebSearch = false
    setWebSearch(false)
    $('send').classList.remove('busy')
    updateDashboard()
  },
  onSpeechResult(ok, text) {
    if (!ok || !text) return
    $('input').value = text
    submit()
  },
  onSpeechFinished() { stopSpeaking() },
  onAttachmentResult(ok, name, mime, size, error) {
    if (!ok) {
      if (error !== 'Seleção cancelada') alert(error || 'Falha ao anexar arquivo')
      return
    }
    pendingAttachment = { name, mime, size }
    renderAttachment()
    $('input').focus()
  },
  onExternalAppResult(ok, message) {
    const answer = ok ? message : `Falha: ${message}`
    appendMessage('assistant', answer, ok ? 'AÇÃO ANDROID' : 'ERRO')
    core()?.saveMessage(sessionId, 'assistant', answer)
  },
  onOfflineStatusChanged() { updateOfflineStatus() },
}

function init() {
  const resetHorizontalPosition = () => {
    window.scrollTo(0, window.scrollY)
    document.documentElement.scrollLeft = 0
    document.body.scrollLeft = 0
  }
  resetHorizontalPosition()
  window.addEventListener('resize', resetHorizontalPosition)
  window.addEventListener('orientationchange', () => setTimeout(resetHorizontalPosition, 50))
  localStorage.setItem('samaritano:mobile-session', sessionId)
  $('auth-subtitle').textContent = 'IDENTIDADE NATIVA // OPERADOR LUIZ'
  $('auth-camera-placeholder').textContent = 'BIOMETRIA PROTEGIDA PELO ANDROID'
  $('auth-face-btn').textContent = 'AUTORIZAR COM BIOMETRIA'
  $('auth-pin-toggle').textContent = 'USAR BLOQUEIO DO APARELHO'
  $('auth-message').textContent = 'Nenhuma imagem facial é armazenada pelo Samaritano.'
  $('auth-enroll-fields').classList.add('hidden')
  $('auth-pin-fields').classList.add('hidden')
  $('auth-face-btn').onclick = () => core()?.authenticate()
  $('auth-pin-toggle').onclick = () => core()?.authenticate()

  $('send').onclick = submit
  $('input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }
  $('mic').onclick = () => core()?.startListening()
  $('attach').onclick = () => core()?.pickAttachment()
  $('web-search').onclick = () => setWebSearch(!webSearchEnabled)
  $('settings-btn').onclick = () => { renderSettings(); openModal('settings-modal') }
  $('settings-close').onclick = () => closeModal('settings-modal')
  $('settings-modal').querySelector('.modal-backdrop').onclick = () => closeModal('settings-modal')
  $('history-btn').onclick = () => { renderHistory(); openModal('history-modal') }
  $('history-close').onclick = () => closeModal('history-modal')
  $('history-modal').querySelector('.modal-backdrop').onclick = () => closeModal('history-modal')
  $('history-new').onclick = createNewChat
  $('auth-lock-btn').onclick = () => {
    stopSpeaking()
    document.body.classList.add('auth-pending')
    $('auth-gate').classList.remove('hidden')
    $('auth-gate').dataset.state = 'idle'
    $('auth-status').textContent = 'BLOQUEADO'
  }
  $('dashboard-collapse').onclick = () => $('dashboard-grid').classList.toggle('hidden')
  $('panel-config-btn').onclick = () => openModal('panel-modal')
  $('panel-modal-close').onclick = () => closeModal('panel-modal')
  $('panel-modal').querySelector('.modal-backdrop').onclick = () => closeModal('panel-modal')
  $('install-app').textContent = 'APK INSTALADO'
  $('install-app').disabled = true
  $('install-status').textContent = 'Samaritano Mobile Core 0.4.4'
  $('realtime-btn').onclick = () => core()?.startListening()
  $('status-text').textContent = 'MOBILE'
  $('status-dot').classList.add('ok')

  document.querySelectorAll('[data-command]').forEach(button => {
    button.onclick = () => {
      $('input').value = button.dataset.command
      submit()
    }
  })
  setInterval(() => { $('dashboard-clock').textContent = new Date().toLocaleTimeString('pt-BR') }, 1000)
  setInterval(updateOfflineStatus, 3000)
  showEmptyState()
  updateDashboard()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
