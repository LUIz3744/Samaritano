'use strict'

const PANEL_KEY = 'samaritano:panel:v1'
const MODULES = {
  engine: 'Núcleo de IA',
  network: 'Rede local',
  capabilities: 'Capacidades',
  memory: 'Memória',
  security: 'Identidade',
  actions: 'Ações rápidas',
}
const DEFAULT_PANEL = {
  order: Object.keys(MODULES),
  hidden: [],
  density: 'compact',
  accent: 'red',
  collapsed: false,
}

let panelConfig = loadPanelConfig()
let dashboardTimer = null

function panelEl(id) { return document.getElementById(id) }

function loadPanelConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}')
    const order = Array.isArray(saved.order)
      ? [...saved.order.filter(name => MODULES[name]), ...Object.keys(MODULES).filter(name => !saved.order.includes(name))]
      : DEFAULT_PANEL.order
    return {
      ...DEFAULT_PANEL,
      ...saved,
      order,
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(name => MODULES[name]) : [],
    }
  } catch {
    return { ...DEFAULT_PANEL, order: [...DEFAULT_PANEL.order], hidden: [] }
  }
}

function savePanelConfig() {
  localStorage.setItem(PANEL_KEY, JSON.stringify(panelConfig))
  applyPanelConfig()
}

function applyPanelConfig() {
  const dashboard = panelEl('dashboard')
  const grid = panelEl('dashboard-grid')
  if (!dashboard || !grid) return

  panelConfig.order.forEach(name => {
    const card = grid.querySelector(`[data-module="${name}"]`)
    if (card) grid.appendChild(card)
  })
  grid.querySelectorAll('[data-module]').forEach(card => {
    card.classList.toggle('module-hidden', panelConfig.hidden.includes(card.dataset.module))
  })
  dashboard.classList.toggle('collapsed', !!panelConfig.collapsed)
  document.body.dataset.panelDensity = panelConfig.density
  document.body.dataset.panelAccent = panelConfig.accent
  const collapse = panelEl('dashboard-collapse')
  if (collapse) {
    collapse.textContent = panelConfig.collapsed ? '+' : '—'
    collapse.setAttribute('aria-label', panelConfig.collapsed ? 'Expandir painel' : 'Recolher painel')
  }
  renderModuleList()
  updatePanelChoices()
}

function renderModuleList() {
  const list = panelEl('panel-module-list')
  if (!list) return
  list.innerHTML = panelConfig.order.map((name, index) => `
    <div class="panel-module-row" data-module-config="${name}">
      <label><input type="checkbox" ${panelConfig.hidden.includes(name) ? '' : 'checked'} /> <span>${String(index + 1).padStart(2, '0')} // ${MODULES[name]}</span></label>
      <div>
        <button data-move="up" aria-label="Mover ${MODULES[name]} para cima" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-move="down" aria-label="Mover ${MODULES[name]} para baixo" ${index === panelConfig.order.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </div>
  `).join('')

  list.querySelectorAll('.panel-module-row').forEach(row => {
    const name = row.dataset.moduleConfig
    const checkbox = row.querySelector('input')
    checkbox.onchange = () => {
      panelConfig.hidden = checkbox.checked
        ? panelConfig.hidden.filter(item => item !== name)
        : [...new Set([...panelConfig.hidden, name])]
      savePanelConfig()
    }
    row.querySelectorAll('[data-move]').forEach(button => {
      button.onclick = () => moveModule(name, button.dataset.move === 'up' ? -1 : 1)
    })
  })
}

function moveModule(name, delta) {
  const current = panelConfig.order.indexOf(name)
  const next = current + delta
  if (current < 0 || next < 0 || next >= panelConfig.order.length) return
  const order = [...panelConfig.order]
  ;[order[current], order[next]] = [order[next], order[current]]
  panelConfig.order = order
  savePanelConfig()
}

function updatePanelChoices() {
  document.querySelectorAll('#panel-density [data-value]').forEach(button => {
    button.classList.toggle('active', button.dataset.value === panelConfig.density)
  })
  document.querySelectorAll('#panel-accent [data-value]').forEach(button => {
    button.classList.toggle('active', button.dataset.value === panelConfig.accent)
  })
}

function setText(id, value) {
  const element = panelEl(id)
  if (element) element.textContent = value
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}H ${String(minutes).padStart(2, '0')}M`
}

async function refreshDashboard() {
  try {
    const response = await fetch('/api/dashboard', { credentials: 'same-origin' })
    if (response.status === 401 || response.status === 423) return
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    setText('dash-engine-status', data.provider_ready ? 'OPERACIONAL' : 'INDISPONÍVEL')
    setText('dash-provider', String(data.provider || '—').toUpperCase())
    setText('dash-model', data.models?.fast || 'PADRÃO LOCAL')
    setText('dash-network-status', data.network === 'private-lan' ? 'REDE PRIVADA' : 'SOMENTE LOCAL')
    setText('dash-protocol', data.protocol)
    setText('dash-tools', `${data.tools || 0} TOOLS`)
    setText('dash-memory-total', `${(data.memory?.history || 0) + (data.memory?.facts || 0)} REGISTROS`)
    setText('dash-history', data.memory?.history ?? 0)
    setText('dash-facts', data.memory?.facts ?? 0)
    setText('dash-security-status', data.security?.facial ? 'PROTEGIDO' : 'REDE LOCAL')
    setText('dash-face', data.security?.facial ? 'ATIVO' : 'DESATIVADO')
    const meter = panelEl('dash-tools-meter')
    if (meter) meter.style.width = `${Math.min(100, Math.max(12, (data.tools || 0) * 4))}%`
    const dashboard = panelEl('dashboard')
    if (dashboard) dashboard.dataset.ready = data.provider_ready ? 'true' : 'false'
    const uptime = dashboard?.querySelector('.dashboard-kicker')
    if (uptime) uptime.textContent = `OPERATIONAL OVERVIEW // LUIZ // UPTIME ${formatUptime(data.uptime_seconds || 0)}`
  } catch (error) {
    setText('dash-engine-status', 'SEM RESPOSTA')
    console.warn('[Samaritano] dashboard:', error.message)
  }
}

function openPanelConfig() {
  panelEl('panel-modal')?.classList.remove('hidden')
  renderModuleList()
}

function closePanelConfig() {
  panelEl('panel-modal')?.classList.add('hidden')
}

function tickClock() {
  setText('dashboard-clock', new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()))
}

function initDashboard() {
  applyPanelConfig()
  tickClock()
  setInterval(tickClock, 1000)

  panelEl('panel-config-btn').onclick = openPanelConfig
  panelEl('panel-modal-close').onclick = closePanelConfig
  panelEl('panel-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', closePanelConfig)
  panelEl('dashboard-collapse').onclick = () => {
    panelConfig.collapsed = !panelConfig.collapsed
    savePanelConfig()
  }
  panelEl('panel-reset').onclick = () => {
    panelConfig = { ...DEFAULT_PANEL, order: [...DEFAULT_PANEL.order], hidden: [] }
    savePanelConfig()
  }
  document.querySelectorAll('#panel-density [data-value]').forEach(button => {
    button.onclick = () => { panelConfig.density = button.dataset.value; savePanelConfig() }
  })
  document.querySelectorAll('#panel-accent [data-value]').forEach(button => {
    button.onclick = () => { panelConfig.accent = button.dataset.value; savePanelConfig() }
  })
  document.querySelectorAll('.dash-actions [data-command]').forEach(button => {
    button.onclick = () => {
      const input = panelEl('input')
      if (!input) return
      input.value = button.dataset.command
      panelEl('send')?.click()
    }
  })
  window.addEventListener('samaritano:authorized', () => {
    refreshDashboard()
    clearInterval(dashboardTimer)
    dashboardTimer = setInterval(refreshDashboard, 15000)
  })
  setTimeout(refreshDashboard, 600)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDashboard)
else initDashboard()

