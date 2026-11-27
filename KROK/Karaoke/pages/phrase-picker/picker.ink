<script setup>
import wx from 'wx'
import { clearDownloadInputPage, isDownloadReturnEcho, rememberDownloadReturn, setDownloadInputPage, takeDownloadInput } from '../../utils/downloadReturn.js'
import { PhrasePractice, practiceLayout } from '../../utils/phrasePractice.js'
import { leavePhrasePage, PhraseBackInput } from '../../utils/phraseNavigation.js'
import { phraseAimSession, SongChoice } from '../../utils/songChoice.js'

const defaultLayout = practiceLayout()

export default {
  data: {
    errorText: '', emptyText: '正在加载歌词',
    pickerRows: Array.from({ length: 5 }, () => ({ text: '', time: '', current: false })),
    pickerPosition: '', choiceAvailable: [false, false, false, false, false, false, true, false],
    controls: defaultLayout.pickerBoxes.map(box => box.style),
    choiceIndex: -1, fallback: false, width: defaultLayout.width, height: defaultLayout.height, compact: false
  },

  onLoad() {
    const layout = practiceLayout(globalThis.innerWidth, globalThis.innerHeight)
    this.layout = { ...layout, boxes: layout.pickerBoxes }
    this.request = getApp().globalData.phrasePicker
    if (this.request) this.aim = phraseAimSession.current?.aim
    if (this.request?.song) {
      this.model = new PhrasePractice(this.request.song, { update: view => {
        if (view.picker && !this.unloaded) this.renderPicker(view)
      } })
    }
    if (this.model?.line) {
      this.model.select(this.request.index)
      this.model.activate(4)
    } else {
      this.renderPicker()
    }
    this.startAim()
  },

  renderPicker(view) {
    const { boxes, width, height, compact } = this.layout
    const content = view?.picker ? {
      pickerRows: view.pickerRows,
      pickerPosition: view.pickerPosition,
      choiceAvailable: view.choiceAvailable,
      emptyText: ''
    } : { emptyText: this.request ? '这首歌暂无逐句歌词' : '请从练唱页打开选句' }
    this.setData({ ...content, controls: boxes.map(box => box.style), width, height, compact })
  },

  onShow() {
    this.visible = true
    this.leaving = false
    this.backInput = new PhraseBackInput(() => leavePhrasePage(this))
    this.input = { handleInput: (event, pressed) => this.handleInput(event, pressed) }
    setDownloadInputPage(this.input)
    this.startAim()
  },

  onHide() {
    this.visible = false
    this.backInput?.cancel()
    if (this.input) clearDownloadInputPage(this.input)
    this.input = null
    this.aim?.unbindPage(this)
  },

  onUnload() {
    this.unloaded = true
    rememberDownloadReturn()
    this.onHide()
    if (this.ownsAim) this.aim?.stop()
    this.aim = null
  },

  startAim() {
    if (!this.visible || !this.layout) return
    const createCanvas = () => wx.createCanvasContext('phrasePickerCanvas')
    if (this.aim) this.aim.bindPage(this, this.layout, createCanvas)
    else {
      this.aim = new SongChoice(this, this.layout, createCanvas)
      this.ownsAim = true
      this.aim.start({ transition: false })
    }
  },

  showChoiceControls(fallback) {
    this.setData({ fallback, choiceIndex: fallback ? this.data.choiceAvailable.indexOf(true) : -1 })
  },

  setChoiceFocus(index) { this.setData({ choiceIndex: index }) },

  confirmChoice(target) {
    if (!this.visible || this.leaving || !this.data.choiceAvailable[target]) return
    const row = this.data.pickerRows[target]
    if (row?.text || target === 6) {
      if (this.request) this.request.selectedIndex = row?.index
      leavePhrasePage(this)
    } else {
      this.model.activate(target)
    }
  },

  onTapControl(event) {
    const target = Number(event.currentTarget.dataset.index)
    if (target === 6 || this.data.fallback) this.confirmChoice(target)
  },

  onKeyDown(event) { this.handleInput(event, true) },
  onKeyUp(event) { this.handleInput(event, false) },

  handleInput(event, pressed) {
    if (!this.visible || this.backInput?.handle(event, pressed)) return
    if (pressed || !this.data.fallback || !takeDownloadInput(event) || this.leaving ||
        isDownloadReturnEcho(event) || event.repeat) return
    const code = event.code || event.key
    const { choiceAvailable, choiceIndex } = this.data
    if (code === 'Enter' || code === 'NumpadEnter') {
      this.confirmChoice(choiceIndex)
      return
    }
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }[code]
    if (!step || !choiceAvailable.some(Boolean)) return
    let index = choiceIndex
    do { index = (index + choiceAvailable.length + step) % choiceAvailable.length } while (!choiceAvailable[index])
    this.setChoiceFocus(index)
  }
}
</script>

<page>
  <view class="picker-screen {{compact ? 'picker-compact' : ''}}" style="width:{{width}}px;height:{{height}}px;">
    <canvas id="phrasePickerCanvas" class="picker-canvas" width="{{width}}" height="{{height}}"
      style="width:{{width}}px;height:{{height}}px;"></canvas>
    <view class="picker-heading">
      <text class="picker-title">按时间选句</text>
      <text class="picker-muted">{{errorText || pickerPosition}}</text>
    </view>
    <view class="picker-empty" ink:if="{{emptyText}}"><text>{{emptyText}}</text></view>
    <view ink:if="{{choiceAvailable[0]}}"
      class="picker-button picker-row {{pickerRows[0].current ? 'picker-current' : ''}} {{choiceIndex === 0 ? 'picker-active' : ''}}"
      style="{{controls[0]}}" bindtap="onTapControl" data-index="0">
      <text class="picker-time">{{pickerRows[0].time}}</text>
      <text class="picker-lyric">{{pickerRows[0].text}}</text>
    </view>
    <view ink:if="{{choiceAvailable[1]}}"
      class="picker-button picker-row {{pickerRows[1].current ? 'picker-current' : ''}} {{choiceIndex === 1 ? 'picker-active' : ''}}"
      style="{{controls[1]}}" bindtap="onTapControl" data-index="1">
      <text class="picker-time">{{pickerRows[1].time}}</text>
      <text class="picker-lyric">{{pickerRows[1].text}}</text>
    </view>
    <view ink:if="{{choiceAvailable[2]}}"
      class="picker-button picker-row {{pickerRows[2].current ? 'picker-current' : ''}} {{choiceIndex === 2 ? 'picker-active' : ''}}"
      style="{{controls[2]}}" bindtap="onTapControl" data-index="2">
      <text class="picker-time">{{pickerRows[2].time}}</text>
      <text class="picker-lyric">{{pickerRows[2].text}}</text>
    </view>
    <view ink:if="{{choiceAvailable[3]}}"
      class="picker-button picker-row {{pickerRows[3].current ? 'picker-current' : ''}} {{choiceIndex === 3 ? 'picker-active' : ''}}"
      style="{{controls[3]}}" bindtap="onTapControl" data-index="3">
      <text class="picker-time">{{pickerRows[3].time}}</text>
      <text class="picker-lyric">{{pickerRows[3].text}}</text>
    </view>
    <view ink:if="{{choiceAvailable[4]}}"
      class="picker-button picker-row {{pickerRows[4].current ? 'picker-current' : ''}} {{choiceIndex === 4 ? 'picker-active' : ''}}"
      style="{{controls[4]}}" bindtap="onTapControl" data-index="4">
      <text class="picker-time">{{pickerRows[4].time}}</text>
      <text class="picker-lyric">{{pickerRows[4].text}}</text>
    </view>
    <view class="picker-button {{choiceIndex === 5 ? 'picker-active' : ''}} {{choiceAvailable[5] ? '' : 'picker-disabled'}}"
      style="{{controls[5]}}" bindtap="onTapControl" data-index="5"><text>‹ 上一页</text></view>
    <view class="picker-button {{choiceIndex === 6 ? 'picker-active' : ''}}"
      style="{{controls[6]}}" bindtap="onTapControl" data-index="6"><text>返回练唱</text></view>
    <view class="picker-button {{choiceIndex === 7 ? 'picker-active' : ''}} {{choiceAvailable[7] ? '' : 'picker-disabled'}}"
      style="{{controls[7]}}" bindtap="onTapControl" data-index="7"><text>下一页 ›</text></view>
    <view class="picker-footer"><text>{{fallback ? '点击或上下选择 · 双击镜腿返回' : '停留一圈确认 · 双击镜腿返回'}}</text></view>
  </view>
</page>

<style>
.picker-screen {
  position: relative;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
  overflow: hidden;
  color: #4cc773;
}
.picker-canvas {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  pointer-events: none;
}
.picker-heading, .picker-button, .picker-empty, .picker-footer {
  position: absolute;
  z-index: 2;
}
.picker-heading {
  top: 3%;
  left: 23%;
  right: 23%;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.picker-title { color: #4cc773; font-size: 17px; font-weight: bold; }
.picker-muted, .picker-footer { color: #339254; font-size: 11px; }
.picker-empty { top: 43%; left: 0; width: 100%; text-align: center; color: #4cc773; }
.picker-button {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #357f52;
  border-radius: 5px;
  box-sizing: border-box;
  background-color: transparent;
  color: #4cc773;
  font-size: 15px;
  font-weight: bold;
}
.picker-button text { color: #4cc773; }
.picker-row {
  flex-direction: row;
  justify-content: flex-start;
  padding: 0 10px;
  overflow: hidden;
  font-size: 14px;
  font-weight: normal;
}
.picker-current { border-color: #449e63; }
.picker-active { border-color: #65e08a; }
.picker-disabled { border-color: #2a653f; }
.picker-disabled text { color: #339254; }
.picker-button .picker-time { color: #339254; margin-right: 12px; flex-shrink: 0; }
.picker-lyric { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-footer { bottom: 2%; left: 0; width: 100%; text-align: center; }
.picker-compact .picker-title { font-size: 13px; }
.picker-compact .picker-button { font-size: 12px; }
.picker-compact .picker-muted, .picker-compact .picker-footer { font-size: 9px; }
</style>
