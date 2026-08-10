'use strict'

let deferredInstallPrompt = null

function installElement(id) { return document.getElementById(id) }

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function updateInstallUI() {
  const button = installElement('install-app')
  const status = installElement('install-status')
  if (!button || !status) return
  if (isInstalled()) {
    button.textContent = 'SAMARITANO INSTALADO'
    button.disabled = true
    status.textContent = 'Executando como aplicativo independente.'
  } else if (deferredInstallPrompt) {
    button.textContent = 'INSTALAR SAMARITANO'
    button.disabled = false
    status.textContent = 'Pronto para instalar neste aparelho.'
  } else {
    button.textContent = 'COMO INSTALAR'
    button.disabled = false
    status.textContent = 'Se o botão automático não aparecer, use o menu do navegador.'
  }
}

async function installApp() {
  const status = installElement('install-status')
  if (isInstalled()) return
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt()
    const choice = await deferredInstallPrompt.userChoice
    deferredInstallPrompt = null
    if (status) status.textContent = choice.outcome === 'accepted' ? 'Instalação autorizada.' : 'Instalação cancelada.'
    updateInstallUI()
    return
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  if (status) {
    status.textContent = isIOS
      ? 'No Safari: Compartilhar → Adicionar à Tela de Início.'
      : 'No Chrome: menu ⋮ → Adicionar à tela inicial ou Instalar aplicativo.'
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault()
  deferredInstallPrompt = event
  updateInstallUI()
})
window.addEventListener('appinstalled', updateInstallUI)

async function initInstall() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register('/sw.js') }
    catch (error) { console.warn('[Samaritano] service worker:', error.message) }
  }
  installElement('install-app')?.addEventListener('click', installApp)
  updateInstallUI()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInstall)
else initInstall()
