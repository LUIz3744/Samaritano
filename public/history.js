'use strict'

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('history-btn')
  const modal = document.getElementById('history-modal')
  const close = document.getElementById('history-close')
  const create = document.getElementById('history-new')
  const list = document.getElementById('history-list')
  if (!button || !modal || !list) return

  const hide = () => modal.classList.add('hidden')
  const dateLabel = value => {
    const date = new Date(Number(value))
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  }

  async function loadSessions() {
    list.innerHTML = '<div class="loading">Carregando…</div>'
    try {
      const response = await fetch('/api/chats', { credentials: 'same-origin' })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`)
      list.innerHTML = ''
      if (!data.sessions.length) {
        list.innerHTML = '<div class="history-empty">Nenhuma conversa salva.</div>'
        return
      }
      const active = window.SamaritanoChat?.getSessionId()
      for (const session of data.sessions) {
        const item = document.createElement('button')
        item.className = 'history-item' + (session.session_id === active ? ' active' : '')
        const title = document.createElement('strong')
        title.textContent = session.title || 'Nova conversa'
        const meta = document.createElement('span')
        meta.textContent = `${dateLabel(session.updated_at)} // ${session.message_count} mensagens`
        item.append(title, meta)
        item.onclick = async () => {
          item.classList.add('loading-item')
          try {
            const result = await fetch(`/api/chats/${encodeURIComponent(session.session_id)}`, { credentials: 'same-origin' })
            const chat = await result.json()
            if (!result.ok || !chat.ok) throw new Error(chat.error || `HTTP ${result.status}`)
            window.SamaritanoChat?.loadSession(chat.session_id, chat.messages)
            hide()
          } catch (error) {
            meta.textContent = `Falha ao abrir: ${error.message}`
          } finally {
            item.classList.remove('loading-item')
          }
        }
        list.appendChild(item)
      }
    } catch (error) {
      list.innerHTML = ''
      const failure = document.createElement('div')
      failure.className = 'history-empty error'
      failure.textContent = `Falha ao carregar histórico: ${error.message}`
      list.appendChild(failure)
    }
  }

  button.onclick = () => {
    modal.classList.remove('hidden')
    loadSessions()
  }
  close?.addEventListener('click', hide)
  modal.querySelector('.modal-backdrop')?.addEventListener('click', hide)
  create?.addEventListener('click', () => {
    window.SamaritanoChat?.newSession()
    hide()
  })
})
