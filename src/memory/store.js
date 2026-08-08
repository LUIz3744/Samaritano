/**
 * memory/store.js — Memória persistente em SQLite.
 *
 * 3 tabelas simples:
 *   - facts: key/value de fatos sobre o user (cep, nome, preferências)
 *   - history: histórico de turnos chat (last 1000)
 *   - sessions: estado por sessão (last_plan, last_response — pra "tenta novamente")
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { makeLogger } from '../utils/logger.js'

const log = makeLogger('memory')

export class MemoryStore {
  constructor(dataDir, opts = {}) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, 'samaritano.db')
    this.options = {
      historyRetentionDays: Number(opts.historyRetentionDays ?? 30),
      maxHistoryItems: Number(opts.maxHistoryItems ?? 1000),
      redactSensitiveHistory: opts.redactSensitiveHistory !== false,
      allowSensitiveFacts: opts.allowSensitiveFacts === true,
    }
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this._init()
    this.applyRetention()
    log.info('memória iniciada', { db: dbPath })
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,           -- 'user' | 'assistant'
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id, created_at);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        last_user_input TEXT,
        last_response TEXT,
        last_plan TEXT,                -- JSON
        updated_at INTEGER NOT NULL
      );
    `)
  }

  // ── Facts ──────────────────────────────────────────────────────
  saveFact(key, value, opts = {}) {
    const textValue = typeof value === 'string' ? value : JSON.stringify(value)
    if (!this.options.allowSensitiveFacts) {
      const risks = detectSensitiveData(`${key} ${textValue}`)
      if (risks.length) {
        const err = new Error(`Dado sensível bloqueado na memória: ${risks.join(', ')}`)
        err.code = 'SENSITIVE_DATA_BLOCKED'
        throw err
      }
    }
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO facts (key, value, category, created_at, updated_at)
      VALUES (@key, @value, @category, @now, @now)
      ON CONFLICT(key) DO UPDATE SET
        value=@value, category=@category, updated_at=@now
    `).run({
      key,
      value: textValue,
      category: opts.category || null,
      now,
    })
    return { key, value }
  }

  getFact(key) {
    const row = this.db.prepare('SELECT * FROM facts WHERE key = ?').get(key)
    if (!row) return null
    return { key: row.key, value: row.value, category: row.category }
  }

  listFacts(limit = 50) {
    return this.db.prepare('SELECT * FROM facts ORDER BY updated_at DESC LIMIT ?').all(limit)
  }

  searchFacts(query, limit = 10) {
    const q = `%${query.toLowerCase()}%`
    return this.db.prepare(`
      SELECT * FROM facts
      WHERE LOWER(key) LIKE ? OR LOWER(value) LIKE ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(q, q, limit)
  }

  // ── History ────────────────────────────────────────────────────
  addHistory(sessionId, role, content) {
    const safeContent = this.options.redactSensitiveHistory
      ? redactSensitiveData(String(content))
      : String(content)
    this.db.prepare(`
      INSERT INTO history (session_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, role, safeContent, Date.now())
    this.applyRetention()
  }

  recentHistory(sessionId, limit = 10) {
    const rows = this.db.prepare(`
      SELECT role, content FROM history
      WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit)
    return rows.reverse() // chronological
  }

  listChatSessions(limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50))
    return this.db.prepare(`
      SELECT
        s.session_id,
        s.updated_at,
        COUNT(h.id) AS message_count,
        COALESCE(
          (SELECT content FROM history first
           WHERE first.session_id = s.session_id AND first.role = 'user'
           ORDER BY first.created_at ASC, first.id ASC LIMIT 1),
          s.last_user_input,
          'Nova conversa'
        ) AS title
      FROM sessions s
      LEFT JOIN history h ON h.session_id = s.session_id
      WHERE s.session_id LIKE 'web-%'
      GROUP BY s.session_id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(safeLimit).map(row => ({
      ...row,
      title: String(row.title || 'Nova conversa').replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
  }

  getChatSession(sessionId, limit = 300) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 300))
    return this.db.prepare(`
      SELECT id, role, content, created_at FROM history
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(String(sessionId), safeLimit)
  }

  // ── Sessions ───────────────────────────────────────────────────
  setSessionState(sessionId, state) {
    const now = Date.now()
    const protect = (value) => {
      if (!value) return null
      return this.options.redactSensitiveHistory ? redactSensitiveData(String(value)) : String(value)
    }
    this.db.prepare(`
      INSERT INTO sessions (session_id, last_user_input, last_response, last_plan, updated_at)
      VALUES (@session_id, @user_input, @response, @plan, @now)
      ON CONFLICT(session_id) DO UPDATE SET
        last_user_input=@user_input,
        last_response=@response,
        last_plan=@plan,
        updated_at=@now
    `).run({
      session_id: sessionId,
      user_input: protect(state.userInput),
      response: protect(state.response),
      plan: state.plan ? JSON.stringify(state.plan) : null,
      now,
    })
  }

  getSessionState(sessionId) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    if (!row) return null
    return {
      session_id: row.session_id,
      last_user_input: row.last_user_input,
      last_response: row.last_response,
      last_plan: row.last_plan ? JSON.parse(row.last_plan) : null,
    }
  }

  applyRetention() {
    const days = Math.max(0, this.options.historyRetentionDays)
    if (days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      this.db.prepare('DELETE FROM history WHERE created_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(cutoff)
    }

    const max = Math.max(0, this.options.maxHistoryItems)
    if (max > 0) {
      this.db.prepare(`
        DELETE FROM history WHERE id NOT IN (
          SELECT id FROM history ORDER BY created_at DESC, id DESC LIMIT ?
        )
      `).run(max)
    }
  }

  privacySummary() {
    return {
      facts: this.db.prepare('SELECT COUNT(*) AS count FROM facts').get().count,
      history: this.db.prepare('SELECT COUNT(*) AS count FROM history').get().count,
      sessions: this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      retention_days: this.options.historyRetentionDays,
      sensitive_history_redaction: this.options.redactSensitiveHistory,
      sensitive_facts_allowed: this.options.allowSensitiveFacts,
    }
  }

  exportData() {
    return {
      exported_at: new Date().toISOString(),
      facts: this.db.prepare('SELECT key, value, category, created_at, updated_at FROM facts ORDER BY updated_at DESC').all(),
      history: this.db.prepare('SELECT session_id, role, content, created_at FROM history ORDER BY created_at ASC').all(),
      sessions: this.db.prepare('SELECT session_id, last_user_input, last_response, last_plan, updated_at FROM sessions ORDER BY updated_at DESC').all(),
    }
  }

  deleteData(scope, sessionId = null) {
    const transaction = this.db.transaction(() => {
      if (scope === 'all') {
        const facts = this.db.prepare('DELETE FROM facts').run().changes
        const history = this.db.prepare('DELETE FROM history').run().changes
        const sessions = this.db.prepare('DELETE FROM sessions').run().changes
        return { facts, history, sessions }
      }
      if (scope === 'facts') return { facts: this.db.prepare('DELETE FROM facts').run().changes }
      if (scope === 'history') {
        const history = this.db.prepare('DELETE FROM history').run().changes
        const sessions = this.db.prepare('DELETE FROM sessions').run().changes
        return { history, sessions }
      }
      if (scope === 'session') {
        if (!sessionId) throw new Error('sessionId obrigatório')
        const history = this.db.prepare('DELETE FROM history WHERE session_id = ?').run(sessionId).changes
        const sessions = this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes
        return { history, sessions }
      }
      throw new Error('Escopo inválido')
    })
    return transaction()
  }

  close() {
    try { this.db.close() } catch {}
  }
}

const SENSITIVE_PATTERNS = [
  ['CPF', /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g],
  ['cartão', /\b(?:\d[ -]*?){13,19}\b/g],
  ['chave de API', /\b(?:sk|gsk|xox[baprs]|ghp)_[A-Za-z0-9_-]{12,}\b/g],
  ['senha', /\b(?:senha|password|passwd)\s*[:=]\s*\S+/gi],
]

export function detectSensitiveData(value) {
  const text = String(value ?? '')
  return SENSITIVE_PATTERNS.filter(([, pattern]) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  }).map(([label]) => label)
}

export function redactSensitiveData(value) {
  let text = String(value ?? '')
  for (const [label, pattern] of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0
    text = text.replace(pattern, `[${label.toUpperCase()} REMOVIDO]`)
  }
  return text
}
