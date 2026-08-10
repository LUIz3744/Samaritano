import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, detectSensitiveData, redactSensitiveData } from '../src/memory/store.js'

assert.deepEqual(detectSensitiveData('CPF 123.456.789-00'), ['CPF'])
assert.equal(redactSensitiveData('CPF 123.456.789-00'), 'CPF [CPF REMOVIDO]')
assert.match(redactSensitiveData('senha: segredo'), /\[SENHA REMOVIDO\]/)

{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samaritano-privacy-'))
  const store = new MemoryStore(dataDir)
  try {
    store.saveFact('idioma', 'português')
    store.addHistory('sessao-1', 'user', 'meu CPF é 123.456.789-00')
    store.setSessionState('sessao-1', { userInput: 'senha: segredo', response: 'ok' })
    const data = store.exportData()
    assert.equal(data.facts.length, 1)
    assert.match(data.history[0].content, /\[CPF REMOVIDO\]/)
    assert.match(data.sessions[0].last_user_input, /\[SENHA REMOVIDO\]/)
    assert.equal(store.deleteData('all').facts, 1)
    assert.deepEqual(store.privacySummary(), {
      facts: 0,
      history: 0,
      sessions: 0,
      retention_days: 30,
      sensitive_history_redaction: true,
      sensitive_facts_allowed: false,
    })
  } finally {
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samaritano-privacy-'))
  const store = new MemoryStore(dataDir)
  try {
    assert.throws(() => store.saveFact('senha', 'minha senha: segredo'), { code: 'SENSITIVE_DATA_BLOCKED' })
  } finally {
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

console.log('privacy tests: ok')
