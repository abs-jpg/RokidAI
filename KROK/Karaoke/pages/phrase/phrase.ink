<script setup>
import wx from 'wx'
import { getSongAudio, getSongFromLibrary, readDownloadedAudio } from '../../utils/songLibrary.js'
import { clearDownloadInputPage, isDownloadReturnEcho, rememberDownloadReturn, setDownloadInputPage, takeDownloadInput } from '../../utils/downloadReturn.js'
import { phraseAimSession, SongChoice } from '../../utils/songChoice.js'
import { PhrasePractice, practiceLayout } from '../../utils/phrasePractice.js'
import { createPhrasePlayer, openPhraseCapture } from '../../utils/phraseAudio.js'
import { leavePhrasePage, PHRASE_PICKER_URL, PhraseBackInput } from '../../utils/phraseNavigation.js'

export default {
  data: {
    loaded: false, errorText: '',
    songName: '', lineText: '', linePosition: '', lineTime: '', statusText: '', countdownDots: '',
    lyricScore: '—', pitchScore: '—', pitchDetail: '', heardText: '', lastAttempt: '',
    centerLabel: '', canStop: false, phase: 'ready', choiceAvailable: [], choiceIndex: -1, fallback: false,
    controls: [], width: 448, height: 328, compact: false
  },

  async onLoad(query) {
    const entry = phraseAimSession.current
    if (entry && entry.songId === query.songId) {
      this.aim = entry.aim
    }
    try {
      const song = await getSongFromLibrary(query.songId)
      if (this.unloaded) return
      const modes = ['guide', 'instrumental'].filter(mode => song.bundled || String(query[mode]) === '1')
      const versions = await Promise.all(modes.map(async mode => {
        const audio = getSongAudio(song, mode)
        if (!audio) return [mode, null]
        const bytes = await readDownloadedAudio(song, mode).catch(() => null)
        return [mode, { ...audio, bytes }]
      }))
      if (this.unloaded) return
      const audio = Object.fromEntries(versions)
      const source = audio.guide || audio.instrumental
      if (!source) throw new Error('没有可用的已下载音频')
      this.layout = practiceLayout(globalThis.innerWidth, globalThis.innerHeight)
      this.model = new PhrasePractice(song, {
        openPlayer(fromMs, _listen, onEnd, onError) {
          return createPhrasePlayer(source, fromMs, onEnd, onError)
        },
        openInput: onPartial => openPhraseCapture(onPartial, song.category),
        update: view => this.updatePractice(view)
      })
      this.setData({
        loaded: true, width: this.layout.width, height: this.layout.height, compact: this.layout.compact,
        controls: this.layout.boxes,
        audioHint: audio.guide ? '' : '未下载歌词版 · 当前播放伴奏'
      })
      this.model.emit()
      this.startAim()
    } catch (error) {
      this.stopAim()
      if (!this.unloaded) this.setData({ errorText: error?.message || '无法打开练句' })
    }
  },

  onShow() {
    this.visible = true
    this.leaving = false
    this.backInput = new PhraseBackInput(() => this.back())
    this.input = { handleInput: (event, pressed) => this.handleInput(event, pressed) }
    setDownloadInputPage(this.input)
    if (this.pickerRequest) {
      const { selectedIndex } = this.pickerRequest
      this.clearPickerRequest()
      if (selectedIndex != null) this.model.select(selectedIndex)
    }
    this.model?.emit()
    this.startAim()
  },

  onHide() {
    this.visible = false
    this.releasePage()
  },

  onUnload() {
    this.unloaded = true
    this.visible = false
    rememberDownloadReturn()
    this.releasePage()
    this.stopAim()
    this.clearPickerRequest()
  },

  releasePage() {
    this.backInput?.cancel()
    if (this.input) clearDownloadInputPage(this.input)
    this.input = null
    this.aim?.unbindPage(this)
    this.model?.select(this.model.index)
  },

  startAim() {
    if (!this.visible || !this.model) return
    const createCanvas = () => wx.createCanvasContext('phraseCanvas')
    if (this.aim) this.aim.bindPage(this, this.layout, createCanvas)
    else {
      this.aim = new SongChoice(this, this.layout, createCanvas)
      phraseAimSession.current = { songId: this.model.song.id, aim: this.aim }
      this.aim.start({ transition: false })
    }
  },

  stopAim() {
    if (phraseAimSession.current?.aim === this.aim) phraseAimSession.current = null
    this.aim?.stop()
    this.aim = null
  },

  drawAimUnderlay(ctx) {
    this.model.drawPitch(ctx, this.layout.chart)
  },

  updatePractice(view) {
    if (this.unloaded) return
    const centerChanged = this.data.canStop !== view.canStop
    this.setData(view)
    if (centerChanged && this.aim?.page === this && this.aim.focus === 1) this.aim.requireMove()
  },

  setChoiceFocus(index) {
    this.setData({ choiceIndex: index })
  },

  showChoiceControls(fallback) {
    this.setData({ fallback, choiceIndex: fallback ? this.data.choiceAvailable.indexOf(true) : -1 })
  },

  confirmChoice(target) {
    if (!this.visible || this.leaving) return
    if (target === 4 && this.model?.line) this.openPicker()
    else this.model?.activate(target)
  },

  openPicker() {
    if (this.pickerRequest) return
    this.model.stop()
    const request = { song: this.model.song, index: this.model.index }
    this.pickerRequest = request
    getApp().globalData.phrasePicker = request
    wx.navigateTo({ url: PHRASE_PICKER_URL, fail: () => {
      this.clearPickerRequest()
      if (this.visible) this.setData({ statusText: '无法打开选句 · 请重试' })
    } })
  },

  clearPickerRequest() {
    if (!this.pickerRequest) return
    const state = getApp().globalData
    if (state.phrasePicker === this.pickerRequest) delete state.phrasePicker
    this.pickerRequest = null
  },

  onTapControl(event) {
    const target = Number(event.currentTarget.dataset.index)
    if (!this.visible || this.leaving) return
    if (target === 1 && this.data.canStop) this.model?.stop()
    else if (this.data.fallback) this.confirmChoice(target)
  },

  onKeyDown(event) { this.handleInput(event, true) },
  onKeyUp(event) { this.handleInput(event, false) },

  handleInput(event, pressed) {
    if (!this.visible || this.backInput?.handle(event, pressed)) return
    if (pressed || !takeDownloadInput(event) || this.leaving || isDownloadReturnEcho(event) || event.repeat) return
    const code = event.code || event.key
    const { choiceAvailable, choiceIndex } = this.data
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (this.data.canStop && (!this.data.fallback || choiceIndex === 1)) this.model?.stop()
      else if (this.data.fallback) this.confirmChoice(choiceIndex)
      return
    }
    if (!this.data.fallback) return
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1 }[code]
    if (!step || !choiceAvailable.some(Boolean)) return
    let index = choiceIndex
    do { index = (index + choiceAvailable.length + step) % choiceAvailable.length } while (!choiceAvailable[index])
    this.setChoiceFocus(index)
  },

  back() {
    if (!this.visible || this.leaving) return
    this.model?.stop()
    leavePhrasePage(this)
  }
}
</script>

<page>
  <view class="phrase-screen {{compact ? 'phrase-compact' : ''}}" style="width:{{width}}px;height:{{height}}px;">
    <view class="phrase-loading" ink:if="{{!loaded}}">
      <text>{{errorText || '正在加载逐句练习'}}</text>
      <text class="phrase-muted">双击镜腿返回</text>
    </view>
    <view class="phrase-content" ink:else>
      <view class="phrase-content">
        <view class="phrase-heading"><text class="phrase-song">{{songName}} · 练这一句</text><text class="phrase-muted">{{linePosition}}　{{lineTime}}</text></view>
        <view class="phrase-button phrase-utility {{choiceIndex === 3 ? 'phrase-active' : ''}} {{choiceAvailable[3] ? '' : 'phrase-disabled'}}"
          style="{{controls[3].style}}" bindtap="onTapControl" data-index="3"><text>听示范</text></view>
        <view class="phrase-button phrase-utility {{choiceIndex === 4 ? 'phrase-active' : ''}} {{choiceAvailable[4] ? '' : 'phrase-disabled'}}"
          style="{{controls[4].style}}" bindtap="onTapControl" data-index="4"><text>选句</text></view>
        <view class="phrase-target"><text class="phrase-lyric">{{lineText}}</text></view>
        <view class="phrase-track">
          <view class="phrase-stage"><text>{{statusText}}</text><text>{{lastAttempt || audioHint}}</text></view>
          <view class="phrase-countdown" ink:if="{{countdownDots}}"><text>{{countdownDots}}</text></view>
        </view>
        <view class="phrase-readout">
          <view class="phrase-metrics">
            <view class="phrase-metric"><text>歌词匹配</text><text class="phrase-value">{{lyricScore}}</text></view>
            <view class="phrase-metric"><text>音准匹配</text><text class="phrase-value">{{pitchScore}}</text></view>
            <text class="phrase-pitch-detail">{{pitchDetail}}</text>
          </view>
          <view class="phrase-asr"><text class="phrase-asr-label">识别</text><text class="phrase-heard">{{heardText}}</text></view>
        </view>
        <view class="phrase-button {{choiceIndex === 0 ? 'phrase-active' : ''}} {{choiceAvailable[0] ? '' : 'phrase-disabled'}}"
          style="{{controls[0].style}}" bindtap="onTapControl" data-index="0"><text>‹ 上一句</text></view>
        <view class="phrase-button phrase-primary {{choiceIndex === 1 ? 'phrase-active' : ''}} {{choiceAvailable[1] ? '' : 'phrase-disabled'}}"
          style="{{controls[1].style}}" bindtap="onTapControl" data-index="1"><text>{{centerLabel}}</text></view>
        <view class="phrase-button {{choiceIndex === 2 ? 'phrase-active' : ''}} {{choiceAvailable[2] ? '' : 'phrase-disabled'}}"
          style="{{controls[2].style}}" bindtap="onTapControl" data-index="2"><text>下一句 ›</text></view>
      </view>
      <view class="phrase-footer"><text>{{fallback ? '点击或上下选择 · 双击镜腿返回' : '停留一圈确认 · 双击镜腿返回'}}</text></view>
      <canvas id="phraseCanvas" class="phrase-canvas" width="{{width}}" height="{{height}}"
        style="width:{{width}}px;height:{{height}}px;"></canvas>
    </view>
  </view>
</page>

<style>
@import "./phrase.wxss";
</style>
