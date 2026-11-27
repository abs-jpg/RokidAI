let backEchoUntil = 0
let confirmEchoUntil = 0
let downloadPage
const handledEvents = new WeakSet()
const RETURN_KEYS = new Set(['Backspace', 'Escape', 'BrowserBack', 'GoBack', 'Back'])

export function isReturnKey(event) {
  return RETURN_KEYS.has(event.code) || RETURN_KEYS.has(event.key)
}

export function isRecentReturn() {
  return Date.now() < backEchoUntil
}

export function setDownloadInputPage(page) {
  downloadPage = page
}

export function clearDownloadInputPage(page) {
  if (downloadPage === page) downloadPage = null
}

export function forwardDownloadInput(event, pressed) {
  if (handledEvents.has(event)) return true
  if ((!pressed || isReturnKey(event)) && isDownloadReturnEcho(event)) return takeDownloadInput(event)
  if (downloadPage) {
    downloadPage.handleInput(event, pressed)
    return true
  }
  return false
}

export function takeDownloadInput(event, { passthrough = false } = {}) {
  if (handledEvents.has(event)) return false
  handledEvents.add(event)
  if (!passthrough) {
    event.preventDefault()
    event.stopPropagation?.()
  }
  return true
}

export function rememberDownloadReturn({ suppressConfirm = true } = {}) {
  // 返回已处理，拦截宿主稍后补发的返回键。
  backEchoUntil = Date.now() + 300
  if (suppressConfirm) rememberDownloadConfirm()
}

export function rememberDownloadConfirm() {
  confirmEchoUntil = Date.now() + 400
}

export function clearDownloadConfirmEcho() {
  confirmEchoUntil = 0
}

export function isDownloadReturnEcho(event) {
  const now = Date.now()
  return (isRecentReturn() && isReturnKey(event)) ||
    (now < confirmEchoUntil && [event.code, event.key].some(key => ['Enter', 'NumpadEnter', 'Space', ' '].includes(key)))
}
