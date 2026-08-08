'use strict'

const $ = id => document.getElementById(id)
const core = () => window.SamaritanoAndroid
let sessionId = localStorage.getItem('samaritano:mobile-session') || newSessionId()
let messages = []
let lastAnswer = ''
let speaking = false
let activeRequest = null

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
    const audio = document.createElement('button')
    audio.className = 'message-audio-btn'
    audio.type = 'button'
    audio.textContent = '▶ LER'
    audio.onclick = () => speak(content)
    el.appendChild(audio)
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

function speak(text) {
  if (!text || !core()) return
  core().speak(text)
  speaking = true
  $('read-last').classList.add('active')
  $('read-last').textContent = '■ PARAR VOZ'
}

function stopSpeaking() {
  core()?.stopSpeaking()
  speaking = false
  $('read-last').classList.remove('active')
  $('read-last').textContent = '▶ LER RESPOSTA'
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
        </select>
      </label>
      <label>MODELO
        <input id="mobile-model" autocomplete="off" />
      </label>
      <label>CHAVE DA API
        <input id="mobile-api-key" type="password" autocomplete="off" placeholder="${config.has_api_key ? 'CHAVE JÁ PROTEGIDA — DEIXE VAZIO PARA MANTER' : 'COLE SUA CHAVE'}" />
      </label>
      <p class="provider-info">A chave é criptografada pelo Android Keystore e não aparece no histórico.</p>
      <button id="mobile-save-config" class="provider-btn primary">SALVAR NO NÚCLEO SEGURO</button>
      <div id="mobile-config-status" class="save-bar-msg"></div>
    </div>`
  const provider = $('mobile-provider')
  const model = $('mobile-model')
  provider.value = config.provider || 'groq'
  model.value = config.model || defaultModel(provider.value)
  provider.onchange = () => { model.value = defaultModel(provider.value) }
  $('mobile-save-config').onclick = () => {
    const result = parseJson(core().saveConfig(provider.value, model.value.trim(), $('mobile-api-key').value), {})
    const status = $('mobile-config-status')
    status.textContent = result.ok ? '✓ CONFIGURAÇÃO PROTEGIDA' : `✕ ${result.error || 'Falha ao salvar'}`
    status.className = `save-bar-msg ${result.ok ? 'success' : 'error'}`
    if (result.ok) updateDashboard()
  }
}

function defaultModel(provider) {
  return provider === 'gemini' ? 'gemini-2.5-flash-lite' : 'llama-3.1-8b-instant'
}

async function submit() {
  const input = $('input')
  const text = input.value.trim()
  if (!text || activeRequest) return
  input.value = ''
  stopSpeaking()
  appendMessage('user', text)
  messages.push({ role: 'user', content: text })
  core()?.saveMessage(sessionId, 'user', text)

  const config = getConfig()
  if (!config.has_api_key) {
    const warning = 'Configure gratuitamente uma chave Groq ou Gemini nas configurações.'
    appendMessage('assistant', warning)
    openModal('settings-modal')
    renderSettings()
    return
  }

  const thinking = appendMessage('assistant', '…')
  activeRequest = `req-${Date.now().toString(36)}`
  const request = {
    provider: config.provider,
    model: config.model || defaultModel(config.provider),
    messages: messages.slice(-20),
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
    const answer = ok ? payload : `Falha no núcleo de IA: ${payload}`
    appendMessage('assistant', answer, ok ? 'MOBILE CORE' : 'ERRO')
    if (ok) {
      messages.push({ role: 'assistant', content: answer })
      core()?.saveMessage(sessionId, 'assistant', answer)
      lastAnswer = answer
    }
    activeRequest = null
    $('send').classList.remove('busy')
    updateDashboard()
  },
  onSpeechResult(ok, text) {
    if (!ok || !text) return
    $('input').value = text
    submit()
  },
}

function init() {
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
  $('install-status').textContent = 'Samaritano Mobile Core 0.1.0'
  $('realtime-btn').onclick = () => core()?.startListening()
  $('status-text').textContent = 'MOBILE'
  $('status-dot').classList.add('ok')

  const read = document.createElement('button')
  read.id = 'read-last'
  read.className = 'read-last-btn'
  read.textContent = '▶ LER RESPOSTA'
  read.onclick = () => speaking ? stopSpeaking() : speak(lastAnswer)
  document.body.appendChild(read)

  document.querySelectorAll('[data-command]').forEach(button => {
    button.onclick = () => {
      $('input').value = button.dataset.command
      submit()
    }
  })
  setInterval(() => { $('dashboard-clock').textContent = new Date().toLocaleTimeString('pt-BR') }, 1000)
  showEmptyState()
  updateDashboard()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
