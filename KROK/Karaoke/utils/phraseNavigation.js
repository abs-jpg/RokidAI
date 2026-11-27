import wx from 'wx'
import { isDownloadReturnEcho, isRecentReturn, isReturnKey, rememberDownloadReturn, takeDownloadInput } from './downloadReturn.js'

export const PHRASE_PICKER_URL = '/pages/phrase-picker/picker'
const HOME_URL = '/pages/home/home'
const DOUBLE_TAP_MS = 350
const BOUNCE_MS = 60
const HOST_RETURN_MS = 450

export class PhraseBackInput {
  constructor(back) {
    this.back = back
  }

  handle(event, pressed) {
    if (isReturnKey(event)) {
      if (isDownloadReturnEcho(event) || event.repeat) takeDownloadInput(event)
      else if (!pressed) this.waitForHost(true)
      return true
    }
    if (event.code !== 'GlobalHook' && event.key !== 'GlobalHook') return false
    if (!takeDownloadInput(event) || event.repeat || isRecentReturn()) return true
    const now = performance.now()
    const pairedRelease = !pressed && now - (this.downAt ?? -Infinity) <= DOUBLE_TAP_MS
    this.downAt = pressed ? now : null
    if (pairedRelease || this.timer != null) return true
    const gap = now - (this.tapAt ?? -Infinity)
    if (gap >= BOUNCE_MS) {
      this.tapAt = now
      if (gap <= DOUBLE_TAP_MS) this.waitForHost(false)
    }
    return true
  }

  waitForHost(logicalKey) {
    // A real Backspace may make the host pop the page after key dispatch.
    // A host pop calls onHide, which cancels this fallback before it can pop again.
    if (this.timer != null && (!logicalKey || this.logicalKey)) return
    this.cancel()
    this.logicalKey = logicalKey
    this.timer = setTimeout(() => {
      this.timer = null
      this.back()
    }, HOST_RETURN_MS)
  }

  cancel() {
    if (this.timer == null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

export function leavePhrasePage(page) {
  if (!page.visible || page.leaving) return
  page.leaving = true
  page.backInput?.cancel()
  rememberDownloadReturn()
  const restore = () => {
    if (!page.visible || page.unloaded) return
    page.leaving = false
    page.setData({ statusText: '返回失败 · 请重试', errorText: '返回失败 · 请重试' })
  }
  wx.navigateBack({
    delta: 1, success: rememberDownloadReturn,
    fail: () => {
      if (!page.visible || page.unloaded) return
      wx.redirectTo({ url: HOME_URL, success: rememberDownloadReturn, fail: restore })
    }
  })
}
