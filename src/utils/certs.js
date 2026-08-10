/**
 * utils/certs.js — Gera certificado HTTPS local com 3 estratégias em ordem de qualidade.
 *
 * 1. mkcert (se instalado) → cria CA local + cert assinado por ela. Browser fica VERDE.
 * 2. self-signed + auto-trust no Windows (certutil) / Mac (security) / Linux (update-ca-certs)
 * 3. self-signed simples → user vê "Não seguro" (fallback)
 *
 * Web Speech API + getUserMedia em alguns browsers exigem secure context.
 * Chrome aceita http://localhost mas Firefox e outros podem bloquear.
 * Acesso via IP da LAN (192.168.x.x) sempre exige HTTPS.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { X509Certificate } from 'crypto'
import { execSync, spawnSync } from 'child_process'
import selfsigned from 'selfsigned'
import { makeLogger } from './logger.js'

const log = makeLogger('certs')

function getLanIPv4() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(address => address && address.family === 'IPv4' && !address.internal)
    .map(address => address.address)
}

function certificateCoversLan(cert) {
  const addresses = getLanIPv4()
  if (!addresses.length) return true
  try {
    const san = new X509Certificate(cert).subjectAltName || ''
    return addresses.every(address => san.includes(`IP Address:${address}`))
  } catch {
    return false
  }
}

/**
 * Verifica se mkcert está instalado e funcional no sistema.
 */
function hasMkcert() {
  try {
    const r = spawnSync('mkcert', ['-version'], { encoding: 'utf-8', timeout: 3000 })
    return r.status === 0
  } catch { return false }
}

/**
 * Gera cert via mkcert (cert verde de verdade).
 * mkcert cria/atualiza uma CA local na primeira run, instalada no trust store
 * do sistema. Cert assinado por essa CA é confiado por todos os browsers.
 */
function generateWithMkcert(certsDir) {
  const certPath = path.join(certsDir, 'cert.pem')
  const keyPath  = path.join(certsDir, 'key.pem')
  fs.mkdirSync(certsDir, { recursive: true })

  // mkcert -install (idempotente — só faz nada se CA já tá instalada)
  try {
    log.info('mkcert -install (instala CA local 1x na vida, pode pedir senha admin)...')
    spawnSync('mkcert', ['-install'], { stdio: 'inherit', timeout: 60000 })
  } catch (err) {
    log.warn('mkcert -install falhou:', err.message)
  }

  // Gera cert assinado pela CA local
  const r = spawnSync('mkcert', [
    '-cert-file', certPath,
    '-key-file', keyPath,
    'localhost', '127.0.0.1', '::1', '*.localhost', ...getLanIPv4(),
  ], { stdio: 'inherit', timeout: 30000 })

  if (r.status !== 0) {
    throw new Error('mkcert exit ' + r.status)
  }
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error('mkcert nao gerou os arquivos')
  }

  return {
    cert: fs.readFileSync(certPath, 'utf-8'),
    key:  fs.readFileSync(keyPath, 'utf-8'),
    method: 'mkcert',
  }
}

/**
 * Gera cert self-signed via lib `selfsigned`.
 */
function generateSelfSigned(certsDir) {
  const certPath = path.join(certsDir, 'cert.pem')
  const keyPath  = path.join(certsDir, 'key.pem')

  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'Samaritano - Operador Luiz' },
  ]
  const opts = {
    algorithm: 'sha256',
    days: 3650,
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: '*.localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          ...getLanIPv4().map(ip => ({ type: 7, ip })),
        ],
      },
    ],
  }
  const pems = selfsigned.generate(attrs, opts)
  fs.mkdirSync(certsDir, { recursive: true })
  fs.writeFileSync(certPath, pems.cert)
  fs.writeFileSync(keyPath, pems.private)
  return { cert: pems.cert, key: pems.private, certPath, keyPath, method: 'self-signed' }
}

/**
 * Tenta instalar cert no Trusted Root Certification Authorities do Windows
 * (Mac: System keychain, Linux: /usr/local/share/ca-certificates).
 *
 * Retorna { ok, message } indicando sucesso ou motivo da falha.
 */
function tryAutoTrust(certPath) {
  if (process.platform === 'win32') {
    // Estratégia: usa store do USUÁRIO atual (-user flag) em vez do Sistema.
    // Não precisa admin, instala silencioso, e Chrome/Edge usam esse store.
    // Resultado: browser deixa de mostrar "Não seguro".
    try {
      const r = spawnSync('certutil', ['-user', '-addstore', '-f', 'Root', certPath], {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      })
      if (r.status === 0) {
        return { ok: true, message: 'cert adicionado ao Trusted Root do USUÁRIO (sem admin)' }
      }
      const stderr = (r.stderr || r.stdout || '').toString()
      // Se falhou no user store, tenta no sistema (precisa admin)
      const r2 = spawnSync('certutil', ['-addstore', '-f', 'Root', certPath], {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
      })
      if (r2.status === 0) {
        return { ok: true, message: 'cert adicionado ao Trusted Root do SISTEMA (admin)' }
      }
      return { ok: false, message: `certutil falhou. user=${r.status} sys=${r2.status}` }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  }

  if (process.platform === 'darwin') {
    try {
      // security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <cert>
      const r = spawnSync('security', [
        'add-trusted-cert', '-d', '-r', 'trustRoot',
        '-k', '/Library/Keychains/System.keychain', certPath,
      ], { encoding: 'utf-8', timeout: 10000 })
      if (r.status === 0) return { ok: true, message: 'cert adicionado ao keychain do macOS' }
      return { ok: false, message: 'security falhou (precisa admin)' }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  }

  if (process.platform === 'linux') {
    try {
      const dest = '/usr/local/share/ca-certificates/kerneo-lite.crt'
      execSync(`sudo cp ${certPath} ${dest}`, { timeout: 10000 })
      execSync('sudo update-ca-certificates', { timeout: 10000 })
      return { ok: true, message: 'cert instalado em /usr/local/share/ca-certificates/' }
    } catch (err) {
      return { ok: false, message: 'sudo update-ca-certificates falhou (precisa sudo)' }
    }
  }

  return { ok: false, message: `plataforma ${process.platform} sem auto-trust` }
}

/**
 * Garante que existe cert/key. Estratégia:
 *   1. Se já tem em disco → reusa
 *   2. Se mkcert disponível → usa mkcert (cert verde)
 *   3. Senão self-signed + tenta auto-trust no sistema (best effort)
 *
 * Flag KERNEO_NO_AUTO_TRUST=1 desativa auto-trust pra debug.
 */
export function ensureCerts(dataDir) {
  const certsDir  = path.join(dataDir, 'certs')
  const certPath  = path.join(certsDir, 'cert.pem')
  const keyPath   = path.join(certsDir, 'key.pem')
  const markerPath = path.join(certsDir, '.method')

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cachedCert = fs.readFileSync(certPath, 'utf-8')
    if (!certificateCoversLan(cachedCert)) {
      log.warn('certificado antigo não cobre o IP da rede local; gerando um novo')
      try { fs.copyFileSync(certPath, path.join(certsDir, 'cert.previous.pem')) } catch {}
      try { fs.copyFileSync(keyPath, path.join(certsDir, 'key.previous.pem')) } catch {}
      try { fs.unlinkSync(certPath) } catch {}
      try { fs.unlinkSync(keyPath) } catch {}
      try { fs.unlinkSync(markerPath) } catch {}
    }
  }

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf-8')
    const key  = fs.readFileSync(keyPath, 'utf-8')
    let method = 'cached'
    try { method = fs.readFileSync(markerPath, 'utf-8').trim() || 'cached' } catch {}
    log.debug('cert existente carregado', { path: certPath, method })

    // CRÍTICO: força auto-trust SEMPRE (idempotente) pro cert existente também.
    // Cobre o caso do user ter cert antigo gerado sem auto-trust → não confia no browser.
    // certutil com -f reaplica sem duplicar. Resultado: a próxima vez que abrir
    // https://localhost:5071, browser já confia.
    if (process.env.KERNEO_NO_AUTO_TRUST !== '1' && method !== 'mkcert' && method !== 'self-signed-trusted') {
      const trustResult = tryAutoTrust(certPath)
      if (trustResult.ok) {
        log.info('cert existente → auto-trust aplicado: ' + trustResult.message)
        log.info('Recarregue o browser (Ctrl+Shift+Del → Cookies/Cache se ainda mostrar "Não seguro")')
        method = 'self-signed-trusted'
        try { fs.writeFileSync(markerPath, method) } catch {}
      } else {
        log.debug('auto-trust idempotente nao funcionou: ' + trustResult.message)
      }
    }

    return { cert, key, method, trusted: method === 'mkcert' || method === 'self-signed-trusted' }
  }

  // ── Estratégia 1: mkcert ──
  if (hasMkcert()) {
    log.info('mkcert detectado — gerando cert assinado por CA local (browser ficará VERDE)')
    try {
      const result = generateWithMkcert(certsDir)
      fs.writeFileSync(markerPath, 'mkcert')
      log.info('cert mkcert gerado com sucesso')
      return { ...result, trusted: true }
    } catch (err) {
      log.warn('mkcert falhou, fallback pra self-signed:', err.message)
    }
  } else {
    log.info('mkcert não instalado (https://github.com/FiloSottile/mkcert) — usando self-signed')
    log.info('  Pra cert verde de verdade: winget install FiloSottile.mkcert (depois reinicia)')
  }

  // ── Estratégia 2: self-signed + auto-trust ──
  log.info('gerando cert self-signed (1x na vida)...')
  const ss = generateSelfSigned(certsDir)
  let method = 'self-signed'
  let trusted = false

  if (process.env.KERNEO_NO_AUTO_TRUST !== '1') {
    log.info('tentando adicionar ao Trusted Root do sistema...')
    const trustResult = tryAutoTrust(certPath)
    if (trustResult.ok) {
      log.info('auto-trust SUCESSO: ' + trustResult.message)
      log.info('Browser não vai mais mostrar "Não seguro" pra https://localhost:5071')
      method = 'self-signed-trusted'
      trusted = true
    } else {
      log.warn('auto-trust falhou: ' + trustResult.message)
      log.warn('Browser vai mostrar "Não seguro" — clique Avançado → Continuar.')
      log.warn('Pra resolver de vez: instale mkcert (winget install FiloSottile.mkcert) e delete data/certs/, depois reinicia.')
    }
  }

  fs.writeFileSync(markerPath, method)
  log.info('cert gerado', { cert: certPath, key: keyPath, method, trusted })
  return { cert: ss.cert, key: ss.key, method, trusted }
}
