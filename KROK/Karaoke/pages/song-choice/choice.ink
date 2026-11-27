<script setup>
import wx from 'wx'
import { getSongById } from '../../utils/songData.js'
import { preloadSongAudio } from '../../utils/songLibrary.js'
import { clearDownloadInputPage, isDownloadReturnEcho, isRecentReturn, isReturnKey, rememberDownloadReturn, setDownloadInputPage, takeDownloadInput } from '../../utils/downloadReturn.js'
import { phraseAimSession, SongChoice, songChoiceLayout } from '../../utils/songChoice.js'

const DOUBLE_TAP_MS = 350
const TOUCH_BOUNCE_MS = 60
const HOST_RETURN_MS = 450
const TITLE_SIDE_MARGIN = 14
const TITLE_SCROLL_SPEED = 26
const TITLE_MOVING_FRACTION = 0.64
const AIM_HINT = '转头瞄准 · 停留一圈确认 · 双击镜腿返回'
const FALLBACK_HINT = '当前无法瞄准 · 点击选项 · 双击镜腿返回'

function measureTitle(name, fontSize) {
  if (typeof Canvas === 'function') {
    try {
      const ctx = new Canvas(1, 1).getContext('2d')
      ctx.font = 'bold ' + fontSize + 'px sans-serif'
      const { width } = ctx.measureText(name)
      if (Number.isFinite(width) && width > 0) return width
    } catch {
      // Some preview and device runtimes lack Canvas text measurement.
    }
  }

  let em = 0
  for (const char of name) {
    if (/\p{M}/u.test(char)) continue
    if (/[\s.,\u0027ilI!|]/.test(char)) em += 0.31
    else if (/[MWmw@%]/.test(char)) em += 0.85
    else em += char.codePointAt(0) <= 0x024f ? 0.62 : 1
  }
  return em * fontSize
}

function titleScrollStyle(name, fontSize, availableWidth) {
  if (!name) return ''
  const measuredWidth = measureTitle(name, fontSize)
  if (measuredWidth <= availableWidth) return ''

  const textWidth = Math.ceil(measuredWidth) + 2
  const distance = textWidth - availableWidth
  const duration = Math.max(3200, Math.round(1000 * distance / (TITLE_SCROLL_SPEED * TITLE_MOVING_FRACTION)))
  return `width: ${textWidth}px; --choice-title-end: -${distance}px; animation-duration: ${duration}ms;`
}

export default {
  data: {
    choiceReady: false,
    choiceFallback: false,
    choiceIndex: -1,
    choiceAvailable: [false, false, true],
    choiceWidth: 448,
    choiceHeight: 328,
    choiceCompact: false,
    choiceBoxes: [],
    choiceHint: AIM_HINT,
    choiceSongName: '',
    choiceTitleWidth: 448 - 2 * TITLE_SIDE_MARGIN,
    choiceTitleScrollStyle: '',
    choiceOptions: [
      { value: 'guide', label: '带歌词版', desc: '伴奏与跟唱引导' },
      { value: 'instrumental', label: '伴奏版', desc: '纯伴奏 · 自己唱' },
      { value: 'phrase', label: '练这一句', desc: '逐句跟唱 · 核对唱词和音准' }
    ]
  },

  onLoad() {
    const state = getApp().globalData
    const entry = state.songChoiceEntry
    delete state.songChoiceEntry
    this.songId = entry?.songId
    this.layout = songChoiceLayout(globalThis.innerWidth, globalThis.innerHeight)
    const name = entry?.name || ''
    const titleWidth = Math.max(1, this.layout.width - 2 * TITLE_SIDE_MARGIN)
    this.setData({
      choiceSongName: name,
      choiceTitleWidth: titleWidth,
      choiceTitleScrollStyle: titleScrollStyle(name, this.layout.compact ? 16 : 23, titleWidth),
      choiceAvailable: entry ? [...entry.versions, true] : [false, false, false],
      choiceWidth: this.layout.width,
      choiceHeight: this.layout.height,
      choiceCompact: this.layout.compact,
      choiceBoxes: this.layout.boxes
    })
  },

  onShow() {
    this.visible = true
    this.leaving = false
    setDownloadInputPage(this)
    this.startChoice()
  },

  onHide() {
    this.visible = false
    clearDownloadInputPage(this)
    this.cancelBackTimer()
    this.choice?.stop()
    this.choice = null
    this.choosing = null
    this.backKeyDown = false
    this.touchDownAt = null
    this.tapAt = null
  },

  onUnload() {
    if (!this.leaving) rememberDownloadReturn()
    this.onHide()
  },

  startChoice(transition = true) {
    this.setData({ choiceReady: false, choiceFallback: false, choiceIndex: -1, choiceHint: AIM_HINT })
    this.choice = new SongChoice(this, this.layout, () => wx.createCanvasContext('songChoiceCanvas'))
    this.choice.start({ transition })
  },

  onKeyDown(event) { this.handleInput(event, true) },
  onKeyUp(event) { this.handleInput(event, false) },

  handleInput(event, pressed) {
    if (!this.visible) return
    const back = isReturnKey(event)
    const hook = event.code === 'GlobalHook' || event.key === 'GlobalHook'
    if (pressed && !back && !hook) return
    if (isDownloadReturnEcho(event) || event.repeat || this.leaving) {
      takeDownloadInput(event)
      return
    }
    if (back) {
      if (!takeDownloadInput(event, { passthrough: true })) return
      this.backKeyDown = true
      if (!pressed) {
        this.cancelBackTimer()
        // Like the leaderboard and battle lobby, allow the host to pop the page.
        if (event.code !== 'Backspace') this.scheduleBack()
      }
      return
    }
    if (hook) {
      if (!takeDownloadInput(event, { passthrough: true })) return
      if (isRecentReturn() || this.backTimer != null) return
      const now = performance.now()
      const pairedRelease = !pressed && now - (this.touchDownAt ?? -Infinity) <= DOUBLE_TAP_MS
      this.touchDownAt = pressed ? now : null
      if (pairedRelease) return
      const gap = now - (this.tapAt ?? -Infinity)
      if (gap < TOUCH_BOUNCE_MS) return
      this.tapAt = now
      if (gap <= DOUBLE_TAP_MS) this.scheduleBack()
      return
    }
    if (!takeDownloadInput(event)) return
    if (!this.data.choiceFallback || !this.songId) return
    const code = event.code || event.key
    if (code === 'Enter') {
      this.confirmChoice(this.data.choiceIndex)
      return
    }
    const offset = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }[code]
    if (!offset) return
    const count = this.data.choiceAvailable.length
    let index = this.data.choiceIndex
    do { index = (index + offset + count) % count } while (!this.data.choiceAvailable[index])
    this.setChoiceFocus(index)
  },

  scheduleBack() {
    this.backTimer = setTimeout(() => this.back(), HOST_RETURN_MS)
  },

  cancelBackTimer() {
    if (this.backTimer != null) clearTimeout(this.backTimer)
    this.backTimer = null
  },

  back() {
    this.cancelBackTimer()
    this.leaving = true
    rememberDownloadReturn()
    wx.navigateBack({
      success: rememberDownloadReturn,
      fail: () => {
        this.leaving = false
        this.backKeyDown = false
        this.setData({ choiceHint: '返回失败 · 请重试' })
      }
    })
  },

  onTapChoice(event) {
    const index = Number(event.currentTarget.dataset.idx)
    if (!this.data.choiceFallback || !this.data.choiceAvailable[index]) return
    this.setChoiceFocus(index)
    this.confirmChoice(index)
  },

  setChoiceFocus(index) {
    this.setData({ choiceIndex: index, choiceHint: this.data.choiceFallback ? FALLBACK_HINT : AIM_HINT })
  },

  showChoiceControls(fallback) {
    this.setData({
      choiceReady: true,
      choiceFallback: fallback,
      choiceIndex: fallback ? this.data.choiceAvailable.indexOf(true) : -1,
      choiceHint: fallback ? FALLBACK_HINT : AIM_HINT
    })
  },

  async confirmChoice(index) {
    if (!this.visible || !this.songId || !this.data.choiceReady || this.choosing || this.leaving ||
        this.backKeyDown || this.backTimer != null || !this.data.choiceAvailable[index]) return
    const option = this.data.choiceOptions[index]
    const aim = this.choice
    const songId = encodeURIComponent(this.songId)
    this.choosing = aim

    if (option.value === 'phrase') {
      const [guide, instrumental] = this.data.choiceAvailable
      aim.unbindPage(this)
      this.choice = null
      const entry = { songId: this.songId, aim }
      phraseAimSession.current = entry
      this.openPerformance('/pages/phrase/phrase?songId=' + songId +
        '&guide=' + Number(guide) + '&instrumental=' + Number(instrumental), () => {
        if (phraseAimSession.current === entry) phraseAimSession.current = null
        aim.stop()
        if (this.visible) this.startChoice(false)
      })
      return
    }

    const bundled = getSongById(this.songId)
    if (bundled) {
      this.setData({ choiceHint: '正在预热默认伴奏' })
      await Promise.allSettled([preloadSongAudio(bundled, option.value)])
    }
    if (!this.visible || this.choice !== aim || this.leaving || this.backKeyDown || this.backTimer != null) {
      if (this.choosing === aim) this.choosing = null
      return
    }
    this.openPerformance('/pages/record/record?songId=' + songId + '&mode=' + option.value)
  },

  openPerformance(url, restoreAim) {
    this.leaving = true
    // Replace the chooser so the performance and its results still return directly to the song list.
    wx.redirectTo({
      url,
      fail: () => {
        this.leaving = false
        this.choosing = null
        restoreAim?.()
        this.choice?.requireMove()
        if (this.visible) this.setData({ choiceHint: '打开失败 · 再确认重试' })
      }
    })
  }
}
</script>

<page>
  <view class="page-root">
    <view class="choice-mask {{choiceCompact ? 'choice-compact' : ''}}"
      style="width: {{choiceWidth}}px; height: {{choiceHeight}}px;">
      <view class="choice-panel" ink:if="{{choiceReady}}">
        <view class="choice-header">
          <text class="choice-sub">选择演唱版本</text>
          <view class="choice-title-window" style="width: {{choiceTitleWidth}}px;">
            <text class="choice-title {{choiceTitleScrollStyle ? 'choice-title-scroll' : ''}}"
              style="{{choiceTitleScrollStyle}}">{{choiceSongName}}</text>
          </view>
        </view>
        <view
          class="choice-option {{choiceIndex === 0 ? 'choice-active' : ''}} {{choiceAvailable[0] ? '' : 'choice-disabled'}}"
          style="{{choiceBoxes[0].style}}"
          bindtap="onTapChoice"
          data-idx="0"
        >
          <text class="choice-label">{{choiceOptions[0].label}}</text>
          <text class="choice-desc">{{choiceAvailable[0] ? choiceOptions[0].desc : '还未下载此音频'}}</text>
        </view>
        <view
          class="choice-option {{choiceIndex === 1 ? 'choice-active' : ''}} {{choiceAvailable[1] ? '' : 'choice-disabled'}}"
          style="{{choiceBoxes[1].style}}"
          bindtap="onTapChoice"
          data-idx="1"
        >
          <text class="choice-label">{{choiceOptions[1].label}}</text>
          <text class="choice-desc">{{choiceAvailable[1] ? choiceOptions[1].desc : '还未下载此音频'}}</text>
        </view>
        <view class="choice-option {{choiceIndex === 2 ? 'choice-active' : ''}}"
          style="{{choiceBoxes[2].style}}" bindtap="onTapChoice" data-idx="2">
          <text class="choice-label">{{choiceOptions[2].label}}</text>
          <text class="choice-desc">{{choiceOptions[2].desc}}</text>
        </view>
        <view class="choice-footer">
          <text class="choice-hint">{{choiceHint}}</text>
        </view>
      </view>
      <canvas id="songChoiceCanvas" class="choice-canvas" width="{{choiceWidth}}" height="{{choiceHeight}}"
        style="width: {{choiceWidth}}px; height: {{choiceHeight}}px;"></canvas>
    </view>
  </view>
</page>

<style>
:root {
  --green-100: #4cc773;
  --green-72: rgba(76,199,115,0.72);
  --green-48: rgba(76,199,115,0.48);
}

.page-root {
  display: flex;
  flex-direction: column;
  position: relative;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
  padding: 0;
}

.choice-mask {
  position: absolute;
  left: 0;
  top: 0;
  overflow: hidden;
  z-index: 10;
}

.choice-panel, .choice-canvas {
  position: absolute;
  left: 0;
  top: 0;
}

.choice-panel {
  width: 100%;
  height: 100%;
  animation: choice-emerge 300ms ease-out both;
}

.choice-canvas {
  z-index: 2;
  pointer-events: none;
}

.choice-header {
  display: flex;
  position: absolute;
  flex-direction: column;
  align-items: center;
  left: 14px;
  right: 14px;
  top: 23px;
}

.choice-sub {
  color: var(--green-72);
  font-size: 11px;
  letter-spacing: 3px;
  margin-bottom: 5px;
}

.choice-title-window {
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}

.choice-title {
  color: var(--green-100);
  font-size: 23px;
  font-weight: bold;
  text-align: center;
  white-space: nowrap;
}

.choice-title-scroll {
  text-align: left;
  animation-name: choice-title-scroll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

.choice-option {
  display: flex;
  position: absolute;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  box-sizing: border-box;
  border: 2px solid #357f52;
  border-radius: 5px;
  background-color: transparent;
}

.choice-label {
  color: var(--green-100);
  font-size: 19px;
  font-weight: bold;
  line-height: 23px;
}

.choice-desc {
  color: var(--green-72);
  font-size: 12px;
  line-height: 16px;
}

.choice-active {
  border-color: #65e08a;
}

.choice-disabled {
  border-color: #2a653f;
}

.choice-disabled .choice-label, .choice-disabled .choice-desc {
  color: var(--green-48);
}

.choice-footer {
  position: absolute;
  bottom: 13px;
  left: 12px;
  right: 12px;
  text-align: center;
}

.choice-hint {
  color: var(--green-72);
  font-size: 12px;
}

.choice-compact .choice-header { top: 4px; }
.choice-compact .choice-sub { font-size: 9px; margin-bottom: 1px; }
.choice-compact .choice-title { font-size: 16px; }
.choice-compact .choice-label { font-size: 14px; line-height: 16px; }
.choice-compact .choice-desc { font-size: 10px; line-height: 12px; }
.choice-compact .choice-footer { bottom: 3px; }
.choice-compact .choice-hint { font-size: 10px; }

@keyframes choice-emerge {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes choice-title-scroll {
  0%, 18% { transform: translateX(0px); }
  82%, 100% { transform: translateX(var(--choice-title-end)); }
}
</style>
