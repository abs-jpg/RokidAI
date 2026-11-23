let backEchoUntil = 0
let confirmEchoUntil = 0
let downloadPage
const handledEvents = new WeakSet()

export function setDownloadInputPage(page) {
  downloadPage = page
}

export function clearDownloadInputPage(page) {
  if (downloadPage === page) downloadPage = null
}

export function forwardDownloadInput(event, pressed) {
  if (handledEvents.has(event)) return true
  if (!pressed && isDownloadReturnEcho(event)) return takeDownloadInput(event)
  if (downloadPage) {
    downloadPage.handleInput(event, pressed)
    return true
  }
  return false
}

export function takeDownloadInput(event) {
  if (handledEvents.has(event)) return false
  handledEvents.add(event)
  event.preventDefault()
  event.stopPropagation?.()
  return true
}

export function rememberDownloadReturn() {
  // 两次 GlobalHook 已触发返回时，拦截宿主稍后补发的返回键。
  backEchoUntil = Date.now() + 300
  rememberDownloadConfirm()
}

export function rememberDownloadConfirm() {
  confirmEchoUntil = Date.now() + 400
}

export function clearDownloadConfirmEcho() {
  confirmEchoUntil = 0
}

export function isDownloadReturnEcho(event) {
  const now = Date.now()
  return [event.code, event.key].some(key =>
    (now < backEchoUntil && ['Backspace', 'Escape'].includes(key)) ||
    (now < confirmEchoUntil && ['Enter', 'NumpadEnter', 'Space', ' '].includes(key))
  )
}
