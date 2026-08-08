const MODEL_URL = 'https://vladmandic.github.io/face-api/model'
const FACE_API_URL = 'https://vladmandic.github.io/face-api/dist/face-api.esm.js'

const gate = document.getElementById('auth-gate')
const video = document.getElementById('auth-video')
const canvas = document.getElementById('auth-canvas')
const placeholder = document.getElementById('auth-camera-placeholder')
const statusEl = document.getElementById('auth-status')
const subjectEl = document.getElementById('auth-subject')
const subtitleEl = document.getElementById('auth-subtitle')
const messageEl = document.getElementById('auth-message')
const faceBtn = document.getElementById('auth-face-btn')
const pinToggle = document.getElementById('auth-pin-toggle')
const pinFields = document.getElementById('auth-pin-fields')
const pinInput = document.getElementById('auth-pin')
const pinBtn = document.getElementById('auth-pin-btn')
const enrollFields = document.getElementById('auth-enroll-fields')
const codeInput = document.getElementById('auth-code')
const newPinInput = document.getElementById('auth-new-pin')
const consentInput = document.getElementById('auth-consent')
const lockBtn = document.getElementById('auth-lock-btn')
const certLink = document.getElementById('auth-cert-link')

let authState = { enrolled: false, authenticated: false }
let stream = null
let faceapi = null
let modelsPromise = null
let busy = false

function setState(status, message, type = '') {
  statusEl.textContent = status
  messageEl.textContent = message
  gate.dataset.state = type
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(track => track.stop())
  stream = null
  video.srcObject = null
  placeholder.classList.remove('hidden')
}

function unlock(operator = 'LUIZ') {
  stopCamera()
  subjectEl.textContent = operator.toUpperCase()
  statusEl.textContent = 'AUTORIZADO'
  gate.dataset.state = 'success'
  document.body.classList.remove('auth-pending')
  document.body.classList.add('auth-authorized')
  setTimeout(() => gate.classList.add('hidden'), 650)
  window.dispatchEvent(new CustomEvent('samaritano:authorized', { detail: { operator } }))
}

function secureCameraAvailable() {
  return window.isSecureContext || ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
}

function httpsLanUrl() {
  return `https://${location.hostname}:5071${location.pathname}`
}

async function loadModels() {
  if (modelsPromise) return modelsPromise
  modelsPromise = (async () => {
    setState('CARREGANDO MODELOS', 'Preparando reconhecimento facial local…', 'loading')
    faceapi = await import(FACE_API_URL)
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
    return faceapi
  })().catch(error => {
    modelsPromise = null
    throw error
  })
  return modelsPromise
}

async function startCamera() {
  if (!secureCameraAvailable()) {
    throw new Error(`A câmera exige conexão segura. Abra ${httpsLanUrl()}`)
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador não disponibilizou a câmera para esta página.')
  }
  stopCamera()
  setState('SOLICITANDO CÂMERA', 'Aguarde ou permita o acesso quando o navegador solicitar.', 'loading')

  let markCameraReady
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('A câmera foi autorizada, mas não iniciou. Recarregue a página.')), 12000)
    markCameraReady = () => {
      clearTimeout(timeout)
      resolve()
    }
    video.addEventListener('loadedmetadata', markCameraReady, { once: true })
    video.addEventListener('canplay', markCameraReady, { once: true })
  })

  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  })
  video.srcObject = stream
  if (video.readyState < 1) await ready
  else markCameraReady()
  await video.play()
  placeholder.classList.add('hidden')
}

function euclidean(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function eyeAspectRatio(points) {
  return (euclidean(points[1], points[5]) + euclidean(points[2], points[4])) /
    (2 * Math.max(euclidean(points[0], points[3]), 0.001))
}

function averageEyeAspectRatio(landmarks) {
  const points = landmarks.positions
  return (eyeAspectRatio(points.slice(36, 42)) + eyeAspectRatio(points.slice(42, 48))) / 2
}

function drawDetection(result) {
  const width = video.videoWidth || 640
  const height = video.videoHeight || 480
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  if (!result) return
  const { x, y, width: boxWidth, height: boxHeight } = result.detection.box
  const mirroredX = width - x - boxWidth
  ctx.strokeStyle = '#e51b23'
  ctx.lineWidth = Math.max(2, width / 300)
  ctx.strokeRect(mirroredX, y, boxWidth, boxHeight)
  ctx.fillStyle = '#e51b23'
  ctx.font = `${Math.max(12, width / 38)}px monospace`
  ctx.fillText('LUIZ // CANDIDATO', mirroredX, Math.max(18, y - 8))
}

async function detectOne() {
  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.65 })
  return faceapi.detectSingleFace(video, options).withFaceLandmarks().withFaceDescriptor()
}

async function collectLiveSamples() {
  const deadline = Date.now() + 24000
  const openReadings = []
  let openBaseline = null
  let sawClosed = false
  let lastResult = null
  subtitleEl.textContent = 'PROVA DE PRESENÇA // DESAFIO GUIADO'
  setState('OLHOS ABERTOS', 'Olhe para a câmera com os olhos abertos.', 'scanning')

  while (Date.now() < deadline) {
    const result = await detectOne()
    drawDetection(result)
    if (!result) {
      subjectEl.textContent = 'NÃO LOCALIZADO'
      await new Promise(resolve => setTimeout(resolve, 180))
      continue
    }
    subjectEl.textContent = 'ROSTO DETECTADO'
    lastResult = result
    const ear = averageEyeAspectRatio(result.landmarks)
    if (openBaseline === null) {
      openReadings.push(ear)
      if (openReadings.length >= 3) {
        const sorted = [...openReadings].sort((a, b) => a - b)
        openBaseline = sorted[Math.floor(sorted.length / 2)]
        setState('FECHE OS OLHOS', 'Feche os olhos e segure por um segundo.', 'scanning')
      }
    } else if (!sawClosed) {
      if (ear < openBaseline * 0.84 || openBaseline - ear > 0.03) {
        sawClosed = true
        setState('ABRA OS OLHOS', 'Agora abra os olhos.', 'scanning')
      }
    } else if (ear > openBaseline * 0.91) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }

  if (!sawClosed || !lastResult) throw new Error('Prova de presença não concluída. Siga as mensagens: abra, feche e segure, depois abra.')

  setState('PRESENÇA CONFIRMADA', 'Fique imóvel enquanto coleto três amostras.', 'scanning')
  const descriptors = []
  for (let index = 0; index < 3; index++) {
    const result = await detectOne()
    drawDetection(result)
    if (!result) throw new Error('Rosto perdido durante a leitura. Tente novamente.')
    descriptors.push(Array.from(result.descriptor))
    await new Promise(resolve => setTimeout(resolve, 320))
  }
  return descriptors
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`)
    error.result = result
    throw error
  }
  return result
}

function friendlyError(error) {
  const code = error?.result?.error || error?.message || 'unknown_error'
  const messages = {
    invalid_enrollment_code: 'Código de cadastro incorreto. Confira o terminal do notebook.',
    consent_required: 'Marque o consentimento para cadastrar a biometria.',
    pin_must_have_6_to_12_digits: 'O PIN precisa ter entre 6 e 12 números.',
    face_not_recognized: 'Identidade não reconhecida. Acesso negado.',
    invalid_pin: 'PIN incorreto. Acesso negado.',
    temporarily_locked: `Muitas tentativas. Aguarde ${error?.result?.retry_after || 60}s.`,
    NotAllowedError: 'Permissão da câmera negada. Toque no ícone ao lado do endereço e permita a câmera.',
    NotFoundError: 'Nenhuma câmera foi encontrada neste aparelho.',
    NotReadableError: 'A câmera está ocupada por outro aplicativo. Feche-o e tente novamente.',
  }
  return messages[error?.name] || messages[code] || String(code).replace(/^TypeError:\s*/, '')
}

async function handleFace() {
  if (busy) return
  busy = true
  faceBtn.disabled = true
  try {
    if (!authState.enrolled) {
      if (!/^\d{6}$/.test(codeInput.value.trim())) throw new Error('Digite o código de seis números mostrado no notebook.')
      if (!/^\d{6,12}$/.test(newPinInput.value.trim())) throw new Error('Crie um PIN de recuperação com 6 a 12 números.')
      if (!consentInput.checked) throw Object.assign(new Error('consent_required'), { result: { error: 'consent_required' } })
    }
    await loadModels()
    await startCamera()
    const descriptors = await collectLiveSamples()
    if (authState.enrolled) {
      const result = await postJson('/api/auth/verify', { descriptors })
      setState('IDENTIDADE CONFIRMADA', `Correspondência autorizada: ${result.operator}.`, 'success')
      unlock(result.operator)
    } else {
      const result = await postJson('/api/auth/enroll', {
        code: codeInput.value.trim(),
        pin: newPinInput.value.trim(),
        consent: true,
        descriptors,
      })
      setState('IDENTIDADE REGISTRADA', 'Luiz definido como único operador autorizado.', 'success')
      unlock(result.operator)
    }
  } catch (error) {
    stopCamera()
    setState('ACESSO NEGADO', friendlyError(error), 'error')
  } finally {
    busy = false
    faceBtn.disabled = false
  }
}

async function handlePin() {
  if (busy) return
  busy = true
  pinBtn.disabled = true
  try {
    const result = await postJson('/api/auth/pin', { pin: pinInput.value.trim() })
    setState('RECUPERAÇÃO AUTORIZADA', 'Sessão local restaurada.', 'success')
    unlock(result.operator)
  } catch (error) {
    setState('ACESSO NEGADO', friendlyError(error), 'error')
  } finally {
    busy = false
    pinBtn.disabled = false
  }
}

async function initAuth() {
  try {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin' })
    authState = await response.json()
    if (authState.required === false) {
      unlock(authState.principal || 'Luiz')
      return
    }
    if (authState.authenticated) {
      unlock(authState.principal || 'Luiz')
      return
    }
    if (authState.enrolled) {
      subtitleEl.textContent = 'OPERADOR RESTRITO // LUIZ'
      faceBtn.textContent = 'IDENTIFICAR LUIZ'
      setState('BLOQUEADO', 'A câmera só será ativada após seu comando.', '')
    } else {
      subtitleEl.textContent = 'CADASTRO DO OPERADOR // LUIZ'
      faceBtn.textContent = 'CADASTRAR ROSTO DE LUIZ'
      enrollFields.classList.remove('hidden')
      pinToggle.classList.add('hidden')
      setState('CADASTRO NECESSÁRIO', 'Digite o código exibido no terminal do notebook.', '')
    }
    if (!secureCameraAvailable()) {
      setState('HTTPS NECESSÁRIO', `Para liberar a câmera, abra ${httpsLanUrl()}`, 'error')
      certLink.classList.remove('hidden')
    }
  } catch (error) {
    setState('NÚCLEO INDISPONÍVEL', friendlyError(error), 'error')
  }
}

faceBtn.addEventListener('click', handleFace)
pinBtn.addEventListener('click', handlePin)
pinInput.addEventListener('keydown', event => { if (event.key === 'Enter') handlePin() })
pinToggle.addEventListener('click', () => {
  pinFields.classList.toggle('hidden')
  if (!pinFields.classList.contains('hidden')) pinInput.focus()
})
lockBtn?.addEventListener('click', async () => {
  try { await postJson('/api/auth/logout') } catch {}
  location.reload()
})
window.addEventListener('pagehide', stopCamera)

initAuth()
