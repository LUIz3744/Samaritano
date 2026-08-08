import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 60 * 1000
const FACE_THRESHOLD = 0.52

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value) || value.length !== 128) return null
  const descriptor = value.map(Number)
  if (descriptor.some(item => !Number.isFinite(item) || Math.abs(item) > 10)) return null
  return descriptor
}

function distance(a, b) {
  let sum = 0
  for (let index = 0; index < 128; index++) {
    const delta = a[index] - b[index]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf('=')
      return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
    }))
}

export class FaceAuth {
  constructor(dataDir, logger) {
    this.log = logger
    this.authDir = path.join(dataDir, 'auth')
    this.profilePath = path.join(this.authDir, 'luiz-face.json')
    this.codePath = path.join(this.authDir, 'codigo-cadastro.txt')
    this.sessions = new Map()
    this.failures = new Map()
    fs.mkdirSync(this.authDir, { recursive: true })
    this.profile = this.loadProfile()
    this.enrollmentCode = this.profile ? null : this.ensureEnrollmentCode()
  }

  loadProfile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.profilePath, 'utf8'))
      const descriptors = (parsed.descriptors || []).map(normalizeDescriptor).filter(Boolean)
      if (!descriptors.length || !parsed.pinSalt || !parsed.pinHash) return null
      return { ...parsed, descriptors }
    } catch {
      return null
    }
  }

  ensureEnrollmentCode() {
    let code = ''
    try { code = fs.readFileSync(this.codePath, 'utf8').trim() } catch {}
    if (!/^\d{6}$/.test(code)) {
      code = String(crypto.randomInt(100000, 1000000))
      fs.writeFileSync(this.codePath, code, { mode: 0o600 })
    }
    this.log.warn(`CADASTRO FACIAL PENDENTE — código local: ${code}`)
    this.log.warn(`O código também está em ${this.codePath}`)
    return code
  }

  status(req) {
    const session = this.getSession(req)
    return {
      enrolled: !!this.profile,
      authenticated: !!session,
      principal: session?.principal || null,
      operator: 'Luiz',
      method: session?.method || null,
      threshold: FACE_THRESHOLD,
    }
  }

  isEnrolled() {
    return !!this.profile
  }

  getSession(req) {
    const token = parseCookies(req).samaritano_auth
    if (!token) return null
    const session = this.sessions.get(token)
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token)
      return null
    }
    return session
  }

  isAuthenticated(req) {
    return !!this.getSession(req)
  }

  issueSession(res, method, secure) {
    const token = crypto.randomBytes(32).toString('base64url')
    this.sessions.set(token, {
      principal: 'Luiz',
      method,
      expiresAt: Date.now() + SESSION_TTL_MS,
    })
    const secureFlag = secure ? '; Secure' : ''
    res.setHeader('Set-Cookie', `samaritano_auth=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureFlag}`)
  }

  clearSession(req, res) {
    const token = parseCookies(req).samaritano_auth
    if (token) this.sessions.delete(token)
    res.setHeader('Set-Cookie', 'samaritano_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  }

  clientKey(req) {
    return req.socket?.remoteAddress || 'unknown'
  }

  rateLimit(req) {
    const key = this.clientKey(req)
    const state = this.failures.get(key)
    if (!state) return null
    if (state.lockedUntil > Date.now()) {
      return Math.ceil((state.lockedUntil - Date.now()) / 1000)
    }
    if (state.lockedUntil) this.failures.delete(key)
    return null
  }

  recordFailure(req) {
    const key = this.clientKey(req)
    const state = this.failures.get(key) || { count: 0, lockedUntil: 0 }
    state.count += 1
    if (state.count >= MAX_ATTEMPTS) {
      state.count = 0
      state.lockedUntil = Date.now() + LOCKOUT_MS
    }
    this.failures.set(key, state)
  }

  clearFailures(req) {
    this.failures.delete(this.clientKey(req))
  }

  enroll({ code, consent, descriptors, pin }, req, res) {
    if (this.profile) return { status: 409, body: { ok: false, error: 'face_already_enrolled' } }
    if (consent !== true) return { status: 400, body: { ok: false, error: 'consent_required' } }
    if (!safeEqual(code, this.enrollmentCode)) return { status: 403, body: { ok: false, error: 'invalid_enrollment_code' } }
    if (!/^\d{6,12}$/.test(String(pin || ''))) return { status: 400, body: { ok: false, error: 'pin_must_have_6_to_12_digits' } }
    const normalized = (descriptors || []).map(normalizeDescriptor).filter(Boolean)
    if (normalized.length < 3) return { status: 400, body: { ok: false, error: 'three_face_samples_required' } }

    const pinSalt = crypto.randomBytes(16).toString('hex')
    const pinHash = crypto.scryptSync(String(pin), pinSalt, 64).toString('hex')
    this.profile = {
      version: 1,
      operator: 'Luiz',
      descriptors: normalized.slice(0, 5),
      pinSalt,
      pinHash,
      consentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
    fs.writeFileSync(this.profilePath, JSON.stringify(this.profile), { mode: 0o600 })
    try { fs.unlinkSync(this.codePath) } catch {}
    this.enrollmentCode = null
    this.issueSession(res, 'face-enrollment', !!req.socket?.encrypted)
    this.log.info('identidade facial de Luiz cadastrada localmente')
    return { status: 200, body: { ok: true, operator: 'Luiz' } }
  }

  verifyFace({ descriptors }, req, res) {
    if (!this.profile) return { status: 409, body: { ok: false, error: 'face_not_enrolled' } }
    const retryAfter = this.rateLimit(req)
    if (retryAfter) return { status: 429, body: { ok: false, error: 'temporarily_locked', retry_after: retryAfter } }
    const queries = (descriptors || []).map(normalizeDescriptor).filter(Boolean)
    if (!queries.length) return { status: 400, body: { ok: false, error: 'face_sample_required' } }

    let best = Infinity
    for (const query of queries) {
      for (const enrolled of this.profile.descriptors) best = Math.min(best, distance(query, enrolled))
    }
    if (best > FACE_THRESHOLD) {
      this.recordFailure(req)
      return { status: 401, body: { ok: false, error: 'face_not_recognized', distance: Number(best.toFixed(3)) } }
    }
    this.clearFailures(req)
    this.issueSession(res, 'face', !!req.socket?.encrypted)
    return { status: 200, body: { ok: true, operator: 'Luiz', distance: Number(best.toFixed(3)) } }
  }

  verifyPin({ pin }, req, res) {
    if (!this.profile) return { status: 409, body: { ok: false, error: 'face_not_enrolled' } }
    const retryAfter = this.rateLimit(req)
    if (retryAfter) return { status: 429, body: { ok: false, error: 'temporarily_locked', retry_after: retryAfter } }
    const hash = crypto.scryptSync(String(pin || ''), this.profile.pinSalt, 64).toString('hex')
    if (!safeEqual(hash, this.profile.pinHash)) {
      this.recordFailure(req)
      return { status: 401, body: { ok: false, error: 'invalid_pin' } }
    }
    this.clearFailures(req)
    this.issueSession(res, 'recovery-pin', !!req.socket?.encrypted)
    return { status: 200, body: { ok: true, operator: 'Luiz' } }
  }

  reset(req, res) {
    try { fs.unlinkSync(this.profilePath) } catch {}
    this.profile = null
    this.sessions.clear()
    this.failures.clear()
    this.enrollmentCode = this.ensureEnrollmentCode()
    this.clearSession(req, res)
    this.log.warn('biometria local removida; novo cadastro será necessário')
    return { ok: true }
  }
}
