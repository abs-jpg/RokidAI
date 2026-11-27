<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { getSongById, getLyricAt, getRefNoteAt } from '../../utils/songData.js'
import { calcLiveScoreIncrement, countExpectedFrames, createPitchDetector, createVoiceActivityDetector, encodePitchTrack, hzToMidi, PITCH_STEP_MS, SCORING_VERSION } from '../../utils/pitchEngine.js'
import { countLyricCharacters } from '../../utils/scoreEngine.js'
import { getSongAudio, getSongFromLibrary, readDownloadedAudio } from '../../utils/songLibrary.js'
import { localBattleStart, measureBattleClock, onBattleMessage, sendBattle } from '../../utils/battleClient.js'

const WIDTH = 448
const HEIGHT = 180
const PAST_MS = 3200
const FUTURE_MS = 1600
const PLAYER_TIMEOUT_MS = 10000
const GUIDE_HEIGHT = 22
const GUIDE_PADDING = 2
const PRACTICE_READY_HINT = '确认开始 · 返回'
const CARD_PITCH_HINT = '双击展开全屏可显示音准 · 返回'
const MIN_SINGING_HZ = 40
const MAX_SINGING_HZ = 1200
const LOCAL_DOT_DELAY_MS = 24
const LOCAL_PITCH_GAP_MS = 65
const PERFECT_PITCH_TOLERANCE = 2
const OCTAVE_CONFIRM_MS = 120
const SEMITONES_PER_OCTAVE = 12
const OCTAVE_SWITCH_DISTANCE = SEMITONES_PER_OCTAVE / 2 + 1
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
// 真机采音链路固定延迟估计：麦克风采集缓冲 + 分析窗一半 + 播放输出延迟。
// 如果真机测试发现曲线整体提前/滞后，只调整 INPUT_LATENCY_MS 即可。
const INPUT_LATENCY_MS = 25
const MAX_CAPTURE_OFFSET_MS = 260
const RECORDING_KEY = 'karaoke_last_recording'
const BATTLE_PROGRESS_MS = 120
const BATTLE_PITCH_GAP_MS = 500
const BATTLE_DOT_DELAY_MS = 160
const BATTLE_PITCH_STALE_MS = BATTLE_PITCH_GAP_MS + BATTLE_DOT_DELAY_MS
const BATTLE_PITCH_WIDTH = 200
const BATTLE_PITCH_HEIGHT = 130
const BATTLE_TAP_WINDOW_MS = 350
const BATTLE_TAP_BOUNCE_MS = 60
const BATTLE_TAP_ECHO_MS = 150
const BATTLE_TAP_RETURN_DELAY_MS = 190
const BATTLE_FIREWORKS_MS = 1350
const LYRIC_SIDE_MARGIN = 8
const BATTLE_LYRIC_SIDE_PADDING = 12
const ASR_VIEWPORT_WIDTH = 240
const ASR_FONT = 'bold 15px sans-serif'
const ASR_RENDER_INTERVAL_MS = 100
const ASR_MAX_PENDING_CHUNKS = 12
const ASR_FINISH_TIMEOUT_MS = 1800
const ASR_BLANK = '\u00A0'
let textMeasureContext

function createPitchTrace(gapMs, delayMs) {
  return { points: [], shift: 0, candidate: null, gapMs, delayMs }
}

function countdownDots(seconds) {
  const count = Math.max(1, Math.min(3, Math.ceil(Number(seconds) || 1)))
  return Array.from({ length: count }, () => '●').join('  ')
}

function measureCanvasText(text, font) {
  if (textMeasureContext === undefined) {
    textMeasureContext = null
    if (typeof Canvas === 'function') {
      try {
        textMeasureContext = new Canvas(1, 1).getContext('2d')
      } catch (error) {
        console.error('字幕测宽不可用', error)
      }
    }
  }
  if (!textMeasureContext) return null
  try {
    textMeasureContext.font = font
    const metrics = textMeasureContext.measureText(text)
    if (Number.isFinite(metrics.width) && (metrics.width > 0 || !text)) return metrics
  } catch (error) {
    console.error('字幕测宽失败', error)
    textMeasureContext = null
  }
  return null
}

function fitLyricFontSize(text, size, bold, availableWidth) {
  if (!text) return size
  const metrics = measureCanvasText(text, (bold ? 'bold ' : '') + size + 'px sans-serif')
  let width = 0
  if (metrics) {
    width = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0) +
      Math.max(0, metrics.actualBoundingBoxLeft || 0)
  } else {
    for (const char of text) {
      const em = /\s/.test(char) ? 0.35 : char.codePointAt(0) <= 0x024f ? 0.75 : 1.05
      width += size * em
    }
  }
  return width <= availableWidth ? size : Math.max(1, Math.floor(size * availableWidth / width))
}

function measureAsrText(text) {
  const metrics = measureCanvasText(text, ASR_FONT)
  if (metrics) return metrics.width
  let width = 0
  for (const char of text) {
    const narrow = /^[a-z0-9.,!?-]$/.test(char) && char !== 'm' && char !== 'w'
    width += /\s/.test(char) ? 6 : narrow ? 11 : 16
  }
  return width
}

function getRecognitionTail(text) {
  // 测量有限长度的尾部，避免把整场转写交给视图排版。
  const characters = Array.from(text).slice(-96)
  let start = 0
  let end = characters.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    const candidate = characters.slice(middle).join('').trimStart()
    if (measureAsrText(candidate) <= ASR_VIEWPORT_WIDTH) end = middle
    else start = middle + 1
  }
  return characters.slice(start).join('').trimStart()
}

function mergeRecognitionText(previous, incoming) {
  const oldText = String(previous || '').trim()
  const newText = String(incoming || '').trim()
  if (!oldText) return newText
  if (!newText) return oldText
  // Rokid 可能把整段累计结果放进一个新结果对象，不能再次追加旧前缀。
  if (newText.startsWith(oldText)) return newText
  if (oldText.startsWith(newText) || oldText.endsWith(newText)) return oldText
  const maxOverlap = Math.min(oldText.length, newText.length)
  for (let size = maxOverlap; size > 0; size--) {
    if (oldText.slice(-size) === newText.slice(0, size)) {
      return oldText + newText.slice(size)
    }
  }
  return oldText + ' ' + newText
}

function isCardAudioUnavailable(error) {
  return error?.name === 'InvalidStateError' && error.message?.includes('target is _current')
}

function langForCategory(category) {
  switch (category) {
    case 'English': return 'en-US'
    case '日本語': return 'ja-JP'
    case '한국어': return 'ko-KR'
    default: return 'zh-CN'
  }
}

export default {
  data: {
    phase: 'loading',
    isBattle: false,
    practiceOnly: false,
    playbackLabel: '',
    songName: '',
    songKey: '',
    timeLabel: '00:00 / 00:00',
    currentLyric: '',
    nextLyric: '',
    currentLyricFontSize: 20,
    nextLyricFontSize: 14,
    asrDisplayText: ASR_BLANK,
    asrDisplayFull: false,
    asrStatusText: '等待 ASR',
    cueText: '',
    guideVisible: false,
    guideTopPx: GUIDE_HEIGHT / 2,
    guideNote: '',
    selfOctaveShift: 0,
    opponentOctaveShift: 0,
    battleSelfScore: 0,
    battleOpponentScore: 0,
    battleSelfNote: '--',
    battleOpponentNote: '--',
    battleOpponentName: '对手',
    battleResultOutcome: '',
    battleResultTitle: '对战结束',
    battleFireworksA: [],
    battleFireworksB: [],
    statusText: '正在加载伴奏',
    hintText: '返回'
  },

  onLoad(query) {
    this.query = query || {}
    this.isBattle = this.query.mode === 'battle'
    this.mode = this.isBattle || this.query.mode === 'guide' ? 'guide' : 'instrumental'
    this.playbackLabel = this.mode === 'guide' ? '带歌词版' : '纯音乐版'
    this.roomId = this.query.roomId || ''
    this.roundId = this.query.roundId || ''
    this.selfId = this.query.selfId || ''
    this.opponentName = this.query.opponent || '对手'
    this.battleScore = 0
    this.battleScoreExact = 0
    this.battlePitchExact = 0
    this.battleRecognizedChars = 0
    this.battleExpectedLyricChars = 0
    this.battleExpectedFrames = 0
    this.asrPendingDisplayText = ''
    this.asrLastDisplayAt = 0
    this.asrRetryCount = 0
    this.recognitionStartRequested = false
    this.lastBattleSend = 0
    this.lastBattleUi = 0
    this.lastOpponentUi = -Infinity
    if (this.isBattle) {
      this.setData({ isBattle: true, battleOpponentName: this.opponentName })
      this.unsubscribeBattle = onBattleMessage(message => this.handleBattleMessage(message))
    }
    this.setData({ playbackLabel: this.playbackLabel })
    this.initializeSong()
  },

  handleBattleMessage(message) {
    if (!this.isBattle) return
    if (message.roomId && (message.roomId !== this.roomId || message.roundId !== this.roundId)) return
    if (message.type === 'battle.cheer') {
      this.showBattleFireworks(this.battleCheerSide === 'A' ? 'B' : 'A')
      return
    }
    if (message.type === 'socket.close' || message.type === 'socket.error') {
      this.abortBattle('联机已断开', false)
      return
    }
    if (message.type === 'battle.cancelled') {
      this.abortBattle(message.reason || '对战已取消', false)
      return
    }
    if (message.type === 'battle.start' && this.data.phase === 'battleReady') {
      const localStart = localBattleStart(message.startAt)
      if (localStart === null || localStart < Date.now() - 500) {
        this.abortBattle('无法同步开唱')
        return
      }
      this.startAtLocal = localStart
      this.scheduleBattleStart()
      return
    }
    if (message.type === 'error' && ['INVALID_ROUND', 'ROUND_NOT_STARTED', 'ROUND_NOT_ENDED'].includes(message.code)) {
      this.abortBattle(message.message || '对战已结束')
      return
    }
    if (message.type === 'opponent.progress') {
      if (this.data.phase !== 'recording') return
      this.lastOpponentUi = performance.now()
      const midi = Number.isFinite(message.midi) ? message.midi : null
      // 现有进度包没有发送端采样时间，用已同步的本地播放进度定位对手采样。
      const timeMs = this.getElapsedMs() - this.captureOffsetMs
      if (Number.isFinite(timeMs)) this.updatePitchTrace(this.opponentPitch, Math.max(0, timeMs), midi)
      const battleOpponentScore = Math.max(0, Math.min(100, Math.round(Number(message.score) || 0)))
      const battleOpponentNote = midi == null ? '--' : this.midiToNoteName(midi)
      const opponentOctaveShift = this.opponentPitch.shift
      if (battleOpponentScore !== this.data.battleOpponentScore || battleOpponentNote !== this.data.battleOpponentNote ||
          opponentOctaveShift !== this.data.opponentOctaveShift) {
        this.setData({ battleOpponentScore, battleOpponentNote, opponentOctaveShift })
      }
      return
    }
    if (message.type === 'battle.result') {
      if (this.data.phase === 'battleDone') return
      const players = Array.isArray(message.players) ? message.players : []
      const selfId = String(this.selfId)
      const mine = players.find(player => String(player.id) === selfId)
      const other = players.find(player => String(player.id) !== selfId)
      if (!Number.isFinite(mine?.score) || !Number.isFinite(other?.score)) {
        this.abortBattle('未收到完整结算分数', false)
        return
      }
      const battleResultOutcome = mine.score > other.score ? 'win' : (mine.score < other.score ? 'loss' : 'draw')
      const battleResultTitle = battleResultOutcome === 'win'
        ? '胜利'
        : (battleResultOutcome === 'loss' ? '失败' : '平局')
      this.battleCheerSide = players[0] === mine ? 'A' : 'B'
      this.releaseAudio()
      this.setData({
        phase: 'battleDone',
        battleResultOutcome,
        battleResultTitle,
        battleSelfScore: mine.score,
        battleOpponentScore: other.score,
        hintText: '单击镜腿喝彩 · 双击返回'
      })
      return
    }
    if (message.type === 'notice' && message.message) {
      this.setData({ statusText: message.message, hintText: '确认返回联机大厅' })
    }
  },

  async initializeSong() {
    let song = getSongById(this.query.songId)
    if (!song) {
      try {
        song = await getSongFromLibrary(this.query.songId)
        this.audioBytes = await readDownloadedAudio(song, this.mode).catch(() => null)
      } catch (error) {
        console.error('加载在线歌曲失败', error)
      }
    }
    if (this.unloaded) return
    if (this.data.phase === 'battleDone') return
    if (this.isBattle && (!song || song.chartVersion !== Number(this.query.chartVersion) ||
        SCORING_VERSION !== Number(this.query.scoringVersion))) {
      this.abortBattle('歌曲版本不同 · 对战已取消')
      return
    }
    if (song) {
      this.song = song
      this.battleExpectedLyricChars = countLyricCharacters(
        (song.lyrics || []).map(line => line.text || '').join('')
      )
      this.setData({ songName: song.name, songKey: song.estimatedKey || '' })
      const notes = (song.refNotes || []).map(note => note.midi)
      if (notes.length) {
        this.minMidi = Math.min(...notes) - 7
        this.maxMidi = Math.max(...notes) + 7
        this.guideMinMidi = Math.min(...notes)
        this.guideMaxMidi = Math.max(...notes)
      } else {
        this.minMidi = 48
        this.maxMidi = 72
        this.guideMinMidi = 48
        this.guideMaxMidi = 72
      }
      if (this.visible) this.prepareAudio()
    } else {
      this.setData({ phase: 'error', statusText: '歌曲不可用', hintText: '返回重选' })
    }
  },

  onShow() {
    this.visible = true
    if (this.song && this.data.phase !== 'battleDone') this.prepareAudio()
  },

  onReady() {
    if (!this.isBattle) this.canvas = wx.createCanvasContext('pitchCanvas')
    const display = this.getLyricDisplayChanges(this.data.currentLyric, this.data.nextLyric)
    if (display) this.setData(display)
  },

  onTargetChanged(target, previousTarget) {
    if (this.lyricTarget !== target) {
      this.canvas = null
      this.pitchFrameDirty = true
    }
    this.lyricTarget = target
    const display = this.getLyricDisplayChanges(this.data.currentLyric, this.data.nextLyric)
    if (display) this.setData(display)
    if (!this.isBattle && this.data.phase === 'ready') {
      this.setData({ hintText: target === '_current' ? CARD_PITCH_HINT : PRACTICE_READY_HINT })
    }
    // The first callback can carry the default card target before the host is ready.
    if (target === '_current' && previousTarget == null) return
    if (this.hostTarget === target) return
    this.hostTarget = target
    if (!this.visible || !this.song) return
    if (this.isBattle) {
      if (target === '_current' && previousTarget === '_blank') this.abortBattle('对战需要在全屏进行')
      return
    }
    if (target === '_blank' && (this.data.practiceOnly ||
        (previousTarget === '_current' && this.data.phase === 'requesting'))) this.prepareAudio()
  },

  onHide() {
    this.visible = false
    if (this.isBattle && this.data.phase !== 'battleDone') this.abortBattle('对战已退出')
    this.releaseBattleResult()
    this.releaseAudio()
  },

  onUnload() {
    this.unloaded = true
    if (this.isBattle && this.data.phase !== 'battleDone') this.sendRound('battle.cancel')
    if (this.unsubscribeBattle) {
      this.unsubscribeBattle()
      this.unsubscribeBattle = null
    }
    this.visible = false
    this.releaseBattleResult()
    this.releaseAudio()
    this.canvas = null
  },

  onKeyDown(event) {
    if (this.data.phase !== 'battleDone' || (event.code !== 'GlobalHook' && event.key !== 'GlobalHook')) return
    event.preventDefault()
    event.stopPropagation?.()
    if (event.repeat) return
    this.battleHookAt = performance.now()
    this.battleHookDownAt = this.battleHookAt
    this.onBattleResultTap(true)
  },

  onKeyUp(event) {
    if (this.data.phase === 'battleDone' && (event.code === 'GlobalHook' || event.key === 'GlobalHook')) {
      event.preventDefault()
      event.stopPropagation?.()
      if (event.repeat) return
      const now = performance.now()
      const paired = now - (this.battleHookDownAt ?? -Infinity) <= BATTLE_TAP_WINDOW_MS
      this.battleHookDownAt = null
      this.battleHookAt = now
      if (!paired) this.onBattleResultTap(true)
      return
    }
    if (event.code === 'Backspace' || event.key === 'Backspace' || event.code === 'Escape') {
      event.preventDefault()
      if (this.data.phase === 'battleDone') event.stopPropagation?.()
      this.leavePage()
      return
    }
    if (event.code === 'Enter') {
      event.preventDefault()
      if (this.data.phase === 'battleDone') {
        event.stopPropagation?.()
        if (event.repeat || performance.now() - (this.battleHookAt ?? -Infinity) < BATTLE_TAP_ECHO_MS) return
      }
      this.onConfirm()
    }
  },

  leavePage() {
    if (this.leaving) return
    this.leaving = true
    this.clearBattleResultTap()
    if (this.isBattle && this.data.phase !== 'battleDone') {
      this.abortBattle('已退出本场对战')
    }
    this.releaseAudio()
    wx.navigateBack({
      fail: () => { this.leaving = false }
    })
  },

  onConfirm() {
    switch (this.data.phase) {
      case 'ready':
        this.primeBrowserAudio()
        this.requestMicrophone()
        break
      case 'recording':
        this.finishRecording(!this.isBattle && this.reachedSingingEnd())
        break
      case 'error':
      case 'practiceDone':
        if (this.song) this.prepareAudio()
        break
      case 'settling':
        this.goToResult()
        break
      case 'battleDone':
        this.onBattleResultTap()
        break
    }
  },

  clearBattleResultTap() {
    if (this.battleTapTimer != null) clearTimeout(this.battleTapTimer)
    if (this.battleReturnTimer != null) clearTimeout(this.battleReturnTimer)
    this.battleTapTimer = null
    this.battleReturnTimer = null
  },

  onBattleResultTap(templeTouch = false) {
    if (this.leaving || this.battleResultClosed || this.battleReturnTimer != null) return
    const now = performance.now()
    if (templeTouch && now - (this.lastBattleTapAt ?? -Infinity) < BATTLE_TAP_BOUNCE_MS) return
    this.lastBattleTapAt = now
    if (this.battleTapTimer != null) {
      this.clearBattleResultTap()
      if (templeTouch) {
        // 给宿主补发触碰松开和确认键留出时间，避免串到大厅。
        this.battleReturnTimer = setTimeout(() => this.leavePage(), BATTLE_TAP_RETURN_DELAY_MS)
      } else {
        this.leavePage()
      }
      return
    }
    this.battleTapTimer = setTimeout(() => {
      this.battleTapTimer = null
      if (this.showBattleFireworks(this.battleCheerSide)) this.sendRound('battle.cheer')
    }, BATTLE_TAP_WINDOW_MS)
  },

  showBattleFireworks(side) {
    if (!this.battleCheerSide || this.leaving || this.battleResultClosed || this.data.phase !== 'battleDone' ||
        this.data.battleResultOutcome === 'cancelled') return false
    const key = side === 'A' ? 'battleFireworksA' : 'battleFireworksB'
    const timers = this.battleFireworksTimers ??= {}
    if (timers[side] != null) clearTimeout(timers[side])
    this.battleFireworksId = (this.battleFireworksId || 0) + 1
    this.setData({ [key]: [{ id: this.battleFireworksId }] })
    timers[side] = setTimeout(() => {
      delete timers[side]
      this.setData({ [key]: [] })
    }, BATTLE_FIREWORKS_MS)
    return true
  },

  releaseBattleResult() {
    if (!this.isBattle || this.data.phase !== 'battleDone' || this.battleResultClosed) return
    this.battleResultClosed = true
    this.clearBattleResultTap()
    for (const timer of Object.values(this.battleFireworksTimers || {})) clearTimeout(timer)
    this.battleFireworksTimers = null
    if (this.data.battleResultOutcome !== 'cancelled') this.sendRound('battle.result.leave')
  },

  prepareAudio() {
    this.releaseAudio()
    this.clearCanvas()
    this.elapsedMs = 0
    this.practiceReason = ''
    const playback = getSongAudio(this.song, this.mode)
    this.audioSrc = playback?.src || ''
    this.audioFormat = playback?.format || 'ogg'
    const firstLyricPair = this.getLyricPair(0)
    this.recognizedFinalText = ''
    this.asrRetryCount = 0
    this.asrLastDisplayAt = 0
    this.recognitionStartRequested = false
    this.setData({
      phase: 'loading',
      practiceOnly: false,
      timeLabel: this.formatTime(0),
      ...this.getLyricDisplayChanges(firstLyricPair.current, firstLyricPair.next),
      asrDisplayText: ASR_BLANK,
      asrDisplayFull: false,
      asrStatusText: '等待 ASR',
      cueText: '',
      guideVisible: false,
      guideNote: '',
      statusText: '正在加载伴奏',
      hintText: '返回'
    })
    if (!this.audioSrc && !this.audioBytes) {
      this.showError('伴奏不可用')
      return
    }
    if (typeof AudioPlayer === 'undefined') {
      this.prepareBrowserAudio()
      return
    }
    try {
      const player = new AudioPlayer()
      this.player = player
      player.autoplay = false
      player.onCanplay(() => {
        if (this.player !== player || this.data.phase !== 'loading') return
        clearTimeout(this.playerTimeout)
        this.playerTimeout = null
        this.showReady()
      })
      player.onPlay(() => {
        if (this.player !== player || this.data.phase !== 'starting') return
        this.beginFollowing()
      })
      player.onEnded(() => {
        if (this.player === player && this.data.phase === 'recording') this.finishRecording(true)
      })
      player.onError(error => {
        if (this.player === player) this.handlePlaybackError(error)
      })

      this.playerTimeout = setTimeout(() => this.showError('加载伴奏超时'), PLAYER_TIMEOUT_MS)
      if (this.audioBytes) player.setBuffer(this.audioBytes, this.audioFormat)
      else player.src = this.audioSrc
    } catch (error) {
      this.showError('无法加载伴奏', error)
    }
  },

  prepareBrowserAudio() {
    let audio
    let localUrl
    try {
      if (this.audioBytes) localUrl = URL.createObjectURL(new Blob([this.audioBytes], { type: 'audio/' + this.audioFormat }))
      audio = new Audio(localUrl || this.audioSrc)
    } catch (error) {
      if (localUrl) URL.revokeObjectURL(localUrl)
      this.showError('无法加载伴奏', error)
      return
    }
    this.browserAudio = audio
    audio.preload = 'auto'
    audio.volume = 1
    const player = {
      get currentTime() { return audio.currentTime },
      play() { return audio.play() },
      destroy() {
        try { audio.pause() } catch (error) {}
        audio.src = ''
        if (localUrl) URL.revokeObjectURL(localUrl)
      }
    }
    this.player = player

    const ready = () => {
      if (this.player !== player || this.data.phase !== 'loading') return
      if (this.playerTimeout != null) clearTimeout(this.playerTimeout)
      this.playerTimeout = null
      this.showReady()
    }
    audio.addEventListener('canplay', ready)
    audio.addEventListener('canplaythrough', ready)
    audio.addEventListener('playing', () => {
      if (this.player === player && this.data.phase === 'starting') this.beginFollowing()
    })
    audio.addEventListener('ended', () => {
      if (this.player === player && this.data.phase === 'recording') this.finishRecording(true)
    })
    audio.addEventListener('error', () => {
      if (this.player === player) this.handlePlaybackError(new Error('browser audio error'))
    })
    this.playerTimeout = setTimeout(() => this.showError('加载伴奏超时'), PLAYER_TIMEOUT_MS)
    audio.load()
  },

  primeBrowserAudio() {
    const audio = this.browserAudio
    if (!audio || this.browserAudioPrimed) return
    this.browserAudioPrimed = true
    audio.volume = 0
    audio.play().then(() => {
      if (this.browserAudio !== audio) return
      audio.volume = 1
      if (this.data.phase !== 'starting' && this.data.phase !== 'recording') {
        audio.pause()
        audio.currentTime = 0
      }
    }).catch(error => {
      if (this.browserAudio !== audio) return
      audio.volume = 1
      this.browserAudioPrimed = false
      console.error('browser audio prime failed', error)
    })
  },

  showReady() {
    if (this.isBattle) {
      this.setData({
        phase: 'ready',
        practiceOnly: false,
        statusText: '确认准备对战',
        hintText: '确认麦克风 · 返回退出'
      })
      return
    }
    this.setData({
      phase: 'ready',
      practiceOnly: false,
      statusText: this.playbackLabel + ' · 准备跟唱',
      hintText: this.lyricTarget === '_current' ? CARD_PITCH_HINT : PRACTICE_READY_HINT
    })
  },

  startLyricsPractice(reason) {
    this.releasePlayer()
    this.releaseMicrophone()
    if (this.playerTimeout != null) clearTimeout(this.playerTimeout)
    this.playerTimeout = null
    this.practiceReason = reason
    this.setData({ practiceOnly: true })
    this.beginFollowing()
  },

  async requestMicrophone() {
    const player = this.player
    let context
    this.setData({ phase: 'requesting', practiceOnly: false, statusText: '正在开启麦克风', hintText: '返回' })
    try {
      context = new AudioContext()
      this.audioContext = context
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true }
      })
      if (this.player !== player || this.audioContext !== context) {
        stream.getTracks().forEach(track => track.stop())
        return
      }

      this.mediaStream = stream
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 4096
      this.source = source
      source.connect(analyser)
      if (context.state !== 'running') await context.resume()
      if (this.player !== player || this.audioContext !== context) return
      if (context.state === 'suspended' || context.state === 'closed') throw new Error('音频分析未启动')

      this.detectPitch = createPitchDetector(analyser, MIN_SINGING_HZ, MAX_SINGING_HZ)
      this.detectVoice = createVoiceActivityDetector(analyser)
      const analysisWindowMs = 1000 * analyser.fftSize / (2 * context.sampleRate)
      const outputLatencyMs = Number.isFinite(context.baseLatency) ? context.baseLatency * 1000 : 0
      this.captureOffsetMs = Math.min(
        MAX_CAPTURE_OFFSET_MS,
        analysisWindowMs + INPUT_LATENCY_MS + outputLatencyMs
      )
      console.log('pitch timing', {
        analysisWindowMs,
        inputLatencyMs: INPUT_LATENCY_MS,
        outputLatencyMs,
        captureOffsetMs: this.captureOffsetMs
      })
      if (this.isBattle) {
        measureBattleClock()
        this.setData({ phase: 'battleReady', statusText: '等待对手准备', hintText: '返回退出' })
        if (!this.sendRound('battle.ready')) this.abortBattle('联机已断开', false)
      }
      else {
        this.startCountdown()
      }
    } catch (error) {
      if (this.player !== player || (context && this.audioContext !== context)) return
      if (this.isBattle) {
        this.abortBattle('麦克风不可用 · 对战已取消')
        return
      }
      console.error('麦克风不可用', error)
      this.releaseMicrophone()
      if (isCardAudioUnavailable(error)) this.hostTarget = '_current'
      this.practiceReason = this.hostTarget === '_current'
        ? CARD_PITCH_HINT
        : (error?.name === 'NotAllowedError' ? '麦克风未授权 · 本次不计分' : '音准不可用 · 本次不计分')
      this.setData({ practiceOnly: true })
      this.startCountdown()
    }
  },

  async startRecognition() {
    const stream = this.mediaStream
    if (!stream || this.recognitionFeed) return
    if (typeof SpeechRecognitionSession === 'undefined' || typeof MediaRecorder === 'undefined') {
      this.setData({ asrStatusText: 'ASR 不可用' })
      return
    }
    const feed = { queue: Promise.resolve(), pending: 0 }
    this.recognitionFeed = feed
    try {
      const capabilities = this.asrCapabilities || await SpeechRecognitionSession.getCapabilities()
      if (this.recognitionFeed !== feed) return
      this.asrCapabilities = capabilities
      const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/wav']
      const formats = Array.isArray(capabilities.audioFormats) ? capabilities.audioFormats : []
      const mimeType = candidates.find(candidate =>
        MediaRecorder.isTypeSupported(candidate) &&
        (!formats.length || formats.some(format => format.mimeType.toLowerCase() === candidate))
      )
      if (!mimeType) {
        this.recognitionFeed = null
        this.setData({ asrStatusText: '格式不兼容' })
        return
      }

      const options = {
        lang: langForCategory(this.song && this.song.category),
        interimResults: capabilities.interimResults !== false,
        audio: { mimeType }
      }

      const session = new SpeechRecognitionSession(options)
      this.recognition = session
      this.asrSeenFinalResults = new WeakSet()
      session.onresult = event => this.applyRecognitionResult(event, session)
      session.onerror = event => this.recoverRecognition(feed, event.error || event.message)
      session.onend = () => this.recoverRecognition(feed, '识别会话已结束')

      feed.writer = session.audio.getWriter()
      const recorder = new MediaRecorder(stream, { mimeType })
      feed.recorder = recorder
      recorder.ondataavailable = ({ data }) => {
        if (this.recognitionFeed !== feed || !data?.size) return
        if (feed.pending >= ASR_MAX_PENDING_CHUNKS) {
          this.recoverRecognition(feed, '识别音频发送超时')
          return
        }
        feed.pending++
        feed.queue = feed.queue.then(() => {
          if (this.recognitionFeed === feed) return feed.writer.write(data)
        }).catch(error => this.recoverRecognition(feed, error))
          .finally(() => { feed.pending-- })
      }
      recorder.onerror = event => this.recoverRecognition(feed, event.error || '录音器出错')
      recorder.onstop = () => this.recoverRecognition(feed, '录音器已停止')
      recorder.start(250)
      if (this.recognitionFeed === feed) this.setData({ asrStatusText: '' })
    } catch (error) {
      this.recoverRecognition(feed, error)
    }
  },

  recoverRecognition(feed, reason) {
    if (this.recognitionFeed !== feed) return
    if (feed.finish) {
      feed.finish()
      return
    }
    console.error('语音识别中断', reason)
    this.stopRecognition()
    if (!this.mediaStream || !['countdown', 'starting', 'recording'].includes(this.data.phase)) return
    const delay = Math.min(8000, 400 * 2 ** (this.asrRetryCount || 0))
    this.asrRetryCount = Math.min(5, (this.asrRetryCount || 0) + 1)
    this.setData({ asrStatusText: '识别重连中' })
    this.asrRetryTimer = setTimeout(() => {
      this.asrRetryTimer = null
      this.startRecognition()
    }, delay)
  },

  applyRecognitionResult(event, session) {
    if (this.recognition !== session) return
    const results = event?.results
    if (!results || !results.length) return
    if (!this.asrSeenFinalResults) this.asrSeenFinalResults = new WeakSet()
    const finalTranscripts = []
    let interim = ''
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      const alternative = result?.[0]
      const transcript = String(alternative?.transcript || '').trim()
      if (!transcript) continue
      const isFinal = result.isFinal ?? alternative.isFinal ?? true
      if (isFinal) {
        if (this.asrSeenFinalResults.has(result)) continue
        this.asrSeenFinalResults.add(result)
        finalTranscripts.push(transcript)
      } else {
        interim = transcript
      }
    }
    if (!finalTranscripts.length && !interim) return
    this.asrRetryCount = 0
    if (finalTranscripts.length) {
      for (const transcript of finalTranscripts) {
        this.recognizedFinalText = mergeRecognitionText(this.recognizedFinalText, transcript)
      }
      if (this.isBattle && this.battleExpectedLyricChars) {
        this.battleRecognizedChars = countLyricCharacters(this.recognizedFinalText)
        const completenessPoints = Math.min(
          80,
          80 * this.battleRecognizedChars / this.battleExpectedLyricChars
        )
        this.battleScoreExact = completenessPoints + Math.min(20, this.battlePitchExact)
        this.battleScore = Math.max(0, Math.min(100, Math.round(this.battleScoreExact)))
        this.publishBattleProgress()
      }
    }
    const text = mergeRecognitionText(this.recognizedFinalText, interim)
    this.scheduleRecognitionDisplay(text, finalTranscripts.length > 0)
  },

  scheduleRecognitionDisplay(text, immediate = false) {
    this.asrPendingDisplayText = text
    const elapsed = Date.now() - (this.asrLastDisplayAt || 0)
    if (immediate || elapsed >= ASR_RENDER_INTERVAL_MS) {
      this.flushRecognitionDisplay()
      return
    }
    if (this.asrDisplayTimer != null) return
    this.asrDisplayTimer = setTimeout(() => {
      this.asrDisplayTimer = null
      this.flushRecognitionDisplay()
    }, ASR_RENDER_INTERVAL_MS - elapsed)
  },

  flushRecognitionDisplay() {
    if (this.asrDisplayTimer != null) {
      clearTimeout(this.asrDisplayTimer)
      this.asrDisplayTimer = null
    }
    const text = this.asrPendingDisplayText
    this.asrLastDisplayAt = Date.now()
    if (!text) return
    const displayText = getRecognitionTail(text)
    const displayFull = displayText !== text
    if (displayText && (displayText !== this.data.asrDisplayText || displayFull !== this.data.asrDisplayFull)) {
      this.setData({ asrDisplayText: displayText, asrDisplayFull: displayFull })
    }
  },

  stopRecognition() {
    if (this.asrRetryTimer != null) clearTimeout(this.asrRetryTimer)
    this.asrRetryTimer = null
    const feed = this.recognitionFeed
    this.recognitionFeed = null
    this.recognition = null
    if (feed?.finishTimer != null) clearTimeout(feed.finishTimer)
    const recorder = feed?.recorder
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch (error) { console.error('停止识别录音失败', error) }
    }
    if (feed?.writer) feed.writer.abort().catch(() => {})
  },

  startCountdown() {
    let seconds = 3
    this.setData({ phase: 'countdown', statusText: countdownDots(seconds), hintText: '返回' })
    this.countdownTimer = setInterval(() => {
      seconds--
      if (seconds > 0) {
        if (seconds === 1) this.ensureRecognitionStarted()
        this.setData({ statusText: countdownDots(seconds) })
        return
      }
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
      if (this.player) this.playAccompaniment()
      else this.beginFollowing()
    }, 1000)
  },

  async playAccompaniment() {
    const player = this.player
    this.setData({ phase: 'starting', statusText: '正在播放伴奏' })
    this.playerTimeout = setTimeout(() => this.showError('伴奏启动超时'), PLAYER_TIMEOUT_MS)
    try {
      await player.play()
    } catch (error) {
      if (this.player === player) this.handlePlaybackError(error)
    }
  },

  scheduleBattleStart() {
    if (this.countdownTimer != null) clearInterval(this.countdownTimer)
    const tick = () => {
      if (this.data.phase !== 'countdown' && this.data.phase !== 'requesting' && this.data.phase !== 'ready') {
        clearInterval(this.countdownTimer)
        this.countdownTimer = null
        return
      }
      const remaining = this.startAtLocal - Date.now()
      if (remaining > 0 && remaining <= 1000) this.ensureRecognitionStarted()
      if (remaining <= 0) {
        clearInterval(this.countdownTimer)
        this.countdownTimer = null
        this.ensureRecognitionStarted()
        if (this.player) this.playAccompaniment()
        else this.beginFollowing()
        return
      }
      this.setData({
        phase: 'countdown',
        statusText: countdownDots(Math.max(1, Math.ceil(remaining / 1000))),
        hintText: '同步开始 · 返回退出'
      })
    }
    this.setData({ phase: 'countdown', statusText: countdownDots(3), hintText: '同步开始 · 返回退出' })
    this.countdownTimer = setInterval(tick, 200)
    tick()
  },

  ensureRecognitionStarted() {
    if (this.recognitionStartRequested) return
    this.recognitionStartRequested = true
    this.startRecognition()
  },

  sendRound(type, payload = {}) {
    return sendBattle(type, { ...payload, roomId: this.roomId, roundId: this.roundId })
  },

  getRecordingRecognitionText() {
    const finalText = String(this.recognizedFinalText || '').trim()
    const pendingText = String(this.asrPendingDisplayText || '').trim()
    const displayText = this.data.asrDisplayText === ASR_BLANK
      ? ''
      : String(this.data.asrDisplayText || '').trim()
    if (!pendingText && !finalText) return displayText
    return mergeRecognitionText(finalText || displayText, pendingText)
  },

  abortBattle(reason, notify = true) {
    if (this.data.phase === 'battleDone') return
    this.releaseAudio()
    this.setData({
      phase: 'battleDone',
      currentLyric: '',
      nextLyric: '',
      asrDisplayText: ASR_BLANK,
      battleResultOutcome: 'cancelled',
      battleResultTitle: '对战结束',
      statusText: reason,
      hintText: '双击镜腿返回'
    })
    if (notify) this.sendRound('battle.cancel')
  },

  handlePlaybackError(error) {
    if (this.isBattle) {
      this.abortBattle('伴奏不可用 · 对战已取消')
      return
    }
    if (isCardAudioUnavailable(error)) {
      this.startLyricsPractice('伴奏不可用 · 请展开全屏重试')
      return
    }
    this.showError(error?.name === 'NotAllowedError'
      ? '浏览器阻止播放 · 确认重试'
      : '伴奏播放失败', error)
  },

  beginFollowing() {
    if (this.playerTimeout != null) clearTimeout(this.playerTimeout)
    this.playerTimeout = null
    this.pitchTrack = []
    this.selfPitch = createPitchTrace(LOCAL_PITCH_GAP_MS, LOCAL_DOT_DELAY_MS)
    this.opponentPitch = this.isBattle ? createPitchTrace(BATTLE_PITCH_GAP_MS, BATTLE_DOT_DELAY_MS) : null
    this.lastPitchDrawMs = -Infinity
    this.pitchFrameDirty = true
    this.battleScore = 0
    this.battleScoreExact = 0
    this.battlePitchExact = 0
    this.battleRecognizedChars = 0
    this.battleExpectedFrames = countExpectedFrames(this.song.refNotes || [])
    this.lastBattleSend = 0
    this.lastBattleUi = 0
    this.lastOpponentUi = -Infinity
    this.battleLivePitch = null
    this.lastPitchTime = -1
    this.lastFrameTime = -Infinity
    this.practiceStartedAt = performance.now()
    this.setData({
      phase: 'recording',
      selfOctaveShift: 0,
      opponentOctaveShift: 0,
      battleSelfScore: 0,
      battleSelfNote: '--',
      battleOpponentScore: 0,
      battleOpponentNote: '--',
      statusText: '',
      hintText: this.practiceReason || '确认结束 · 返回'
    })
    if (this.detectPitch) {
      this.samplePitch()
      if (this.data.phase !== 'recording') return
      this.pitchTimer = setInterval(() => {
        try {
          this.samplePitch()
        } catch (error) {
          this.showError('读取音频失败', error)
        }
      }, PITCH_STEP_MS / 2)
    }
    this.drawLoop()
  },

  drawLoop() {
    const frame = () => {
      if (this.data.phase !== 'recording') return
      const now = performance.now()
      try {
        const elapsedMs = this.getElapsedMs()
        if (now - this.lastFrameTime >= 30) {
          this.lastFrameTime = now
          this.updateRecording(elapsedMs)
        }
        const showPitch = this.isBattle ? !!this.detectPitch : this.lyricTarget !== '_current'
        if (this.data.phase === 'recording' && showPitch && Number.isFinite(elapsedMs) && elapsedMs >= 0 &&
            (this.pitchFrameDirty || elapsedMs !== this.lastPitchDrawMs || (!this.isBattle && !this.canvas))) {
          this.drawPitchGraphs(elapsedMs)
          this.lastPitchDrawMs = elapsedMs
          this.pitchFrameDirty = false
        }
      } catch (error) {
        this.showError('读取音频失败', error)
        return
      }
      if (this.data.phase === 'recording') this.drawRequest = requestAnimationFrame(frame)
    }
    this.drawRequest = requestAnimationFrame(frame)
  },

  getElapsedMs() {
    const progress = !this.player
      ? performance.now() - this.practiceStartedAt
      : this.player.currentTime * 1000
    return Math.min(this.song.durationMs, progress)
  },

  samplePitch() {
    if (this.data.phase !== 'recording' || !this.detectPitch) return
    const pitchTime = this.getElapsedMs() - this.captureOffsetMs
    if (!Number.isFinite(pitchTime) || pitchTime < 0 || pitchTime >= this.song.durationMs) return
    const timeMs = Math.floor(pitchTime / PITCH_STEP_MS) * PITCH_STEP_MS + PITCH_STEP_MS / 2
    const scoreFrame = timeMs > this.lastPitchTime
    const points = this.selfPitch.points
    const displayFrame = pitchTime > (points[points.length - 1]?.timeMs ?? -Infinity)
    if (!scoreFrame && !displayFrame) return

    const midi = hzToMidi(this.detectPitch())
    if (displayFrame) {
      this.updatePitchTrace(this.selfPitch, pitchTime, midi)
      if (this.data.selfOctaveShift !== this.selfPitch.shift) this.setData({ selfOctaveShift: this.selfPitch.shift })
    }
    if (scoreFrame) {
      this.lastPitchTime = timeMs
      const voiceActive = this.detectVoice ? this.detectVoice() : Number.isFinite(midi)
      this.pitchTrack.push({ timeMs, midi, voiceActive })
      if (this.isBattle) this.updateBattleScore(timeMs, midi, voiceActive)
    }
  },

  updatePitchTrace(trace, timeMs, midi) {
    const points = trace.points
    const previous = points[points.length - 1]
    if (previous && timeMs <= previous.timeMs) return
    const voiced = Number.isFinite(midi)
    let wantedShift = null
    let displayShift = trace.shift
    if (voiced) {
      if (previous?.midi != null) displayShift = previous.shift
      const displayedMidi = midi + displayShift
      const atEdge = displayedMidi <= this.minMidi || displayedMidi >= this.maxMidi
      const ref = getRefNoteAt(this.song.refNotes, timeMs)
      if (ref) {
        // 八度交界处保留一个半音的回差，防止圆点来回跳动。
        if (atEdge || Math.abs(ref.midi - displayedMidi) > OCTAVE_SWITCH_DISTANCE) {
          displayShift = Math.round((ref.midi - midi) / SEMITONES_PER_OCTAVE) * SEMITONES_PER_OCTAVE
        }
        wantedShift = displayShift
      } else if (atEdge) {
        const centerMidi = (this.minMidi + this.maxMidi) / 2
        displayShift = Math.round((centerMidi - midi) / SEMITONES_PER_OCTAVE) * SEMITONES_PER_OCTAVE
      }
    }

    if (wantedShift == null || wantedShift === trace.shift) {
      trace.candidate = null
    } else if (trace.candidate?.shift !== wantedShift || timeMs - previous.timeMs > trace.gapMs) {
      trace.candidate = { shift: wantedShift, sinceMs: timeMs }
    } else if (timeMs - trace.candidate.sinceMs >= OCTAVE_CONFIRM_MS) {
      trace.shift = wantedShift
      trace.candidate = null
    }

    // 圆点即时对齐，八度提示等音区稳定后再更新。
    points.push({ timeMs, midi: voiced ? midi + displayShift : null, shift: displayShift })
    while (points[0].timeMs < timeMs - PAST_MS - trace.gapMs) points.shift()
    this.pitchFrameDirty = true
  },

  getPitchDotMidi(trace, timeMs) {
    const points = trace.points
    let index = points.length - 1
    while (index >= 0 && points[index].timeMs > timeMs) index--
    const sample = points[index]
    if (!sample || sample.midi == null || timeMs - sample.timeMs > trace.gapMs) return null
    const next = points[index + 1]
    if (!next || next.midi == null || next.shift !== sample.shift ||
        next.timeMs - sample.timeMs > trace.gapMs) return sample.midi
    const fraction = (timeMs - sample.timeMs) / (next.timeMs - sample.timeMs)
    return sample.midi + (next.midi - sample.midi) * fraction
  },

  updateRecording(elapsedMs = this.getElapsedMs()) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
    this.elapsedMs = elapsedMs
    const lyricPair = this.getLyricPair(elapsedMs)
    const lyricDisplay = this.getLyricDisplayChanges(lyricPair.current, lyricPair.next)
    const refNote = getRefNoteAt(this.song.refNotes, elapsedMs)
    const timeLabel = this.formatTime(elapsedMs)
    const guideVisible = !!refNote
    const guideTopPx = refNote && !this.isBattle ? this.getGuideTopPx(refNote.midi) : this.data.guideTopPx
    const guideNote = refNote ? this.midiToNoteName(refNote.midi) : ''
    const firstLyric = (this.song.lyrics || []).find(line => line && line.text)
    const firstLyricMs = firstLyric ? firstLyric.startMs : 0
    let cueText = ''
    if (firstLyricMs >= 3000 && elapsedMs >= firstLyricMs - 3000 && elapsedMs < firstLyricMs) {
      cueText = countdownDots(Math.max(1, Math.ceil((firstLyricMs - elapsedMs) / 1000)))
    }
    if (lyricDisplay ||
        timeLabel !== this.data.timeLabel ||
        guideVisible !== this.data.guideVisible || guideTopPx !== this.data.guideTopPx ||
        guideNote !== this.data.guideNote || cueText !== this.data.cueText) {
      this.setData({ ...lyricDisplay, timeLabel, guideVisible, guideTopPx, guideNote, cueText })
    }

    if (this.isBattle && this.data.battleOpponentNote !== '--' &&
        performance.now() - this.lastOpponentUi >= BATTLE_PITCH_STALE_MS) {
      this.setData({ battleOpponentNote: '--' })
    }
    if (elapsedMs >= this.song.durationMs) this.finishRecording(true)
  },

  updateBattleScore(timeMs, midi, voiceActive) {
    const ref = getRefNoteAt(this.song.refNotes, timeMs)
    if (ref && voiceActive) {
      this.battlePitchExact += calcLiveScoreIncrement(midi, ref.midi, this.battleExpectedFrames, true)
      const completenessPoints = this.battleExpectedLyricChars
        ? Math.min(80, 80 * this.battleRecognizedChars / this.battleExpectedLyricChars)
        : 0
      this.battleScoreExact = completenessPoints + Math.min(20, this.battlePitchExact)
      this.battleScore = Math.max(0, Math.min(100, Math.round(this.battleScoreExact)))
    }
    const liveMidi = voiceActive && Number.isFinite(midi) ? midi : null
    this.battleLivePitch = {
      midi: liveMidi,
      note: liveMidi == null ? '--' : this.midiToNoteName(liveMidi),
      cents: liveMidi != null && ref ? Math.round((liveMidi - ref.midi) * 100) : null
    }
    this.publishBattleProgress()
  },

  publishBattleProgress() {
    if (this.data.phase !== 'recording') return
    const now = performance.now()
    const pitch = this.battleLivePitch || { midi: null, note: '--', cents: null }

    if (now - this.lastBattleUi >= BATTLE_PROGRESS_MS) {
      this.lastBattleUi = now
      if (this.battleScore !== this.data.battleSelfScore || pitch.note !== this.data.battleSelfNote) {
        this.setData({ battleSelfScore: this.battleScore, battleSelfNote: pitch.note })
      }
    }
    if (this.roundId && now - this.lastBattleSend >= BATTLE_PROGRESS_MS) {
      this.lastBattleSend = now
      this.sendRound('battle.progress', { score: this.battleScore, ...pitch })
    }
  },

  drawPitchGraphs(elapsedMs) {
    if (!this.isBattle) {
      if (!this.canvas) this.canvas = wx.createCanvasContext('pitchCanvas')
      if (this.canvas) this.drawPitch(this.canvas, WIDTH, HEIGHT, elapsedMs, this.selfPitch)
      return
    }
    if (this.data.cueText) {
      this.battleSelfCanvas = null
      this.battleOpponentCanvas = null
      return
    }
    if (!this.battleSelfCanvas) this.battleSelfCanvas = wx.createCanvasContext('battleSelfCanvas')
    if (!this.battleOpponentCanvas) this.battleOpponentCanvas = wx.createCanvasContext('battleOpponentCanvas')
    if (this.battleSelfCanvas) {
      this.drawPitch(this.battleSelfCanvas, BATTLE_PITCH_WIDTH, BATTLE_PITCH_HEIGHT, elapsedMs, this.selfPitch)
    }
    if (this.battleOpponentCanvas) {
      this.drawPitch(this.battleOpponentCanvas, BATTLE_PITCH_WIDTH, BATTLE_PITCH_HEIGHT, elapsedMs, this.opponentPitch)
    }
  },

  drawPitch(ctx, width, height, elapsedMs, trace) {
    const startMs = elapsedMs - PAST_MS
    const endMs = elapsedMs + FUTURE_MS
    const toX = timeMs => (timeMs - startMs) * width / (PAST_MS + FUTURE_MS)
    const toY = midi => {
      const bounded = Math.max(this.minMidi, Math.min(this.maxMidi, midi))
      return 8 + (this.maxMidi - bounded) * (height - 16) / (this.maxMidi - this.minMidi)
    }

    ctx.clearRect(0, 0, width, height)
    ctx.strokeStyle = 'rgba(76,199,115,0.40)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(elapsedMs), 0)
    ctx.lineTo(toX(elapsedMs), height)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(76,199,115,0.48)'
    ctx.lineWidth = 3
    ctx.beginPath()
    for (const note of this.song.refNotes) {
      if (note.endMs <= startMs || note.startMs >= endMs) continue
      const y = toY(note.midi)
      ctx.moveTo(toX(Math.max(startMs, note.startMs)), y)
      ctx.lineTo(toX(Math.min(endMs, note.endMs)), y)
    }
    ctx.stroke()

    ctx.strokeStyle = '#4cc773'
    ctx.fillStyle = '#4cc773'
    ctx.lineWidth = 2
    ctx.beginPath()
    let previous = null
    for (const sample of trace.points) {
      if (sample.timeMs < startMs) continue
      if (sample.midi == null) {
        previous = null
        continue
      }
      const x = toX(sample.timeMs)
      const y = toY(sample.midi)
      if (!previous || previous.shift !== sample.shift || sample.timeMs - previous.timeMs > trace.gapMs) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      previous = sample
    }
    ctx.stroke()

    const captureTimeMs = elapsedMs - (this.captureOffsetMs ?? 0)
    let dotTimeMs = captureTimeMs - trace.delayMs
    let dotMidi = this.getPitchDotMidi(trace, dotTimeMs)
    const latest = trace.points[trace.points.length - 1]
    // 播放位置可能成批更新。插值点不可用时，用同一时刻已采到的本地音高。
    if (dotMidi == null && trace === this.selfPitch && latest?.midi != null &&
        latest.timeMs > dotTimeMs && latest.timeMs <= captureTimeMs) {
      dotTimeMs = latest.timeMs
      dotMidi = latest.midi
    }
    if (dotMidi != null) {
      const ref = getRefNoteAt(this.song.refNotes, dotTimeMs)
      const pitchError = ref ? Math.abs(dotMidi - ref.midi) : Infinity
      const offPitch = !!ref && pitchError >= 1
      const dotX = toX(dotTimeMs)
      const dotY = toY(dotMidi)
      ctx.beginPath()
      ctx.arc(dotX, dotY, offPitch ? 5 : 4, 0, 2 * Math.PI)
      if (offPitch) ctx.stroke()
      else ctx.fill()

      const perfect = pitchError <= PERFECT_PITCH_TOLERANCE
      const fitsAbove = dotY >= 21
      ctx.font = 'bold 12px sans-serif'
      ctx.textAlign = fitsAbove ? 'center' : 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = perfect ? '#4cc773' : 'rgba(76,199,115,0.72)'
      // 圆点靠近画布上沿时，文字向右错开以免遮挡圆点。
      ctx.fillText(perfect ? 'Perfect' : 'Good', fitsAbove ? dotX : dotX + 9, Math.max(13, dotY - 8))
    }
    ctx.flush()
  },

  clearCanvas() {
    if (!this.canvas) return
    this.canvas.clearRect(0, 0, WIDTH, HEIGHT)
    this.canvas.flush()
  },

  formatTime(elapsedMs) {
    const format = ms => {
      const seconds = Math.floor(ms / 1000)
      return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
        String(seconds % 60).padStart(2, '0')
    }
    return format(elapsedMs) + ' / ' + format(this.song.durationMs)
  },

  getLyricDisplayChanges(currentLyric, nextLyric) {
    const viewportWidth = globalThis.innerWidth
    const pageWidth = viewportWidth > 0 ? Math.min(WIDTH, viewportWidth) : WIDTH
    const sideInset = LYRIC_SIDE_MARGIN + (this.isBattle ? BATTLE_LYRIC_SIDE_PADDING : 0)
    const availableWidth = Math.max(1, pageWidth - sideInset * 2)
    const card = !this.isBattle && this.lyricTarget === '_current'
    const currentSize = card ? 22 : 20
    const nextSize = card ? 15 : 14
    if (this.lyricFitWidth === availableWidth && this.lyricFitCard === card &&
        this.data.currentLyric === currentLyric && this.data.nextLyric === nextLyric) return null

    this.lyricFitWidth = availableWidth
    this.lyricFitCard = card
    return {
      currentLyric,
      nextLyric,
      currentLyricFontSize: fitLyricFontSize(currentLyric, currentSize, true, availableWidth),
      nextLyricFontSize: fitLyricFontSize(nextLyric, nextSize, false, availableWidth)
    }
  },

  getLyricPair(elapsedMs) {
    const lyrics = (this.song?.lyrics || []).filter(line => line?.text?.trim())
    const current = lyrics.find(line => line.startMs <= elapsedMs && elapsedMs < line.endMs)
    let primaryIndex = current ? lyrics.indexOf(current) : lyrics.findIndex(line => line.startMs > elapsedMs)
    if (primaryIndex < 0) primaryIndex = lyrics.length - 1
    return {
      current: primaryIndex >= 0 ? lyrics[primaryIndex].text : '',
      next: primaryIndex >= 0 && lyrics[primaryIndex + 1] ? lyrics[primaryIndex + 1].text : '',
      startMs: primaryIndex >= 0 ? lyrics[primaryIndex].startMs : null
    }
  },

  getDisplayLyric(elapsedMs) {
    return this.getLyricPair(elapsedMs).current
  },

  getGuideTopPx(midi) {
    const span = this.guideMaxMidi - this.guideMinMidi || 1
    const bounded = Math.max(this.guideMinMidi, Math.min(this.guideMaxMidi, midi))
    return Math.round(GUIDE_PADDING + (this.guideMaxMidi - bounded) * (GUIDE_HEIGHT - GUIDE_PADDING * 2 - 2) / span)
  },

  midiToNoteName(midi) {
    const rounded = Math.round(midi)
    return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1)
  },

  reachedSingingEnd() {
    const { lyrics = [], refNotes = [], durationMs } = this.song
    const lastLyric = lyrics[lyrics.length - 1]
    const lastNote = refNotes[refNotes.length - 1]
    let endMs = Math.min(durationMs, Math.max(lastLyric?.endMs || 0, lastNote?.endMs || 0) || durationMs)
    // 曲库会把末句字幕延长到伴奏结束。末句谱面已经唱完时可跳过尾奏。
    if (lastLyric?.endMs >= durationMs && lastNote?.endMs > lastLyric.startMs) {
      endMs = Math.min(endMs, lastNote.endMs)
    }
    return this.getElapsedMs() >= endMs
  },

  finishRecording(completed = false) {
    if (this.data.phase !== 'recording') return
    if (this.data.practiceOnly) {
      this.releaseAudio()
      this.setData({ phase: 'practiceDone', currentLyric: '', nextLyric: '', asrDisplayText: ASR_BLANK, statusText: '已完成', hintText: '确认重来 · 返回' })
      return
    }
    this.samplePitch()
    if (this.isBattle) {
      if (!completed) {
        this.abortBattle('已退出本场对战')
        return
      }
      if (!this.sendRound('battle.finish', {
        samples: encodePitchTrack(this.pitchTrack),
        recognizedText: this.getRecordingRecognitionText()
      })) {
        this.abortBattle('联机已断开', false)
        return
      }
      this.releaseAudio()
      this.setData({
        phase: 'battleWaiting',
        currentLyric: '',
        nextLyric: '',
        asrDisplayText: ASR_BLANK,
        statusText: '等待对手完成',
        hintText: '请稍候'
      })
      return
    }
    const sungUntilMs = completed ? Math.max(this.elapsedMs || 0, this.getElapsedMs() || 0) : this.getElapsedMs()
    const feed = this.recognitionFeed
    const recorder = feed?.recorder
    if (!completed || !recorder || recorder.state === 'inactive' || !feed.writer?.close) {
      this.saveSoloRecording(completed, sungUntilMs)
      return
    }

    this.setData({ phase: 'finalizing', statusText: '正在确认最后一句唱词', cueText: '', hintText: '返回' })
    feed.finish = () => {
      if (this.recognitionFeed === feed && this.data.phase === 'finalizing') {
        this.saveSoloRecording(true, sungUntilMs)
      }
    }
    feed.finishTimer = setTimeout(feed.finish, ASR_FINISH_TIMEOUT_MS)
    recorder.onstop = () => {
      feed.queue.then(() => {
        if (this.recognitionFeed === feed) return feed.writer.close()
      }).then(feed.finish, feed.finish)
    }
    try { recorder.stop() } catch { feed.finish() }
  },

  saveSoloRecording(completed, sungUntilMs) {
    const attemptId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    try {
      wx.setStorageSync(RECORDING_KEY, {
        attemptId,
        songId: this.song.id,
        completed,
        sungUntilMs,
        chartVersion: this.song.chartVersion,
        scoringVersion: SCORING_VERSION,
        pitchTrack: this.pitchTrack,
        recognizedText: this.getRecordingRecognitionText()
      })
    } catch (error) {
      this.showError('保存本次演唱失败', error)
      return
    }
    this.releaseAudio()
    this.attemptId = attemptId
    this.setData({ phase: 'settling', currentLyric: '', nextLyric: '', asrDisplayText: ASR_BLANK, statusText: '正在打开成绩', hintText: '返回' })
    this.goToResult()
  },

  goToResult() {
    if (!this.attemptId || this.openingResult) return
    this.openingResult = true
    wx.navigateTo({
      url: '/pages/result/result?songId=' + this.song.id + '&attemptId=' + this.attemptId,
      fail: error => {
        console.error('打开成绩页失败', error)
        this.setData({ statusText: '未能打开成绩页', hintText: '确认重试 · 返回' })
      },
      complete: () => { this.openingResult = false }
    })
  },

  showError(statusText, error) {
    if (error) console.error(statusText, error)
    if (this.isBattle) {
      this.abortBattle(statusText)
      return
    }
    this.releaseAudio()
    this.setData({ phase: 'error', currentLyric: '', nextLyric: '', asrDisplayText: ASR_BLANK, statusText, hintText: '确认重试 · 返回' })
  },

  releaseAudio() {
    if (this.playerTimeout != null) clearTimeout(this.playerTimeout)
    if (this.countdownTimer != null) clearInterval(this.countdownTimer)
    if (this.drawRequest != null) cancelAnimationFrame(this.drawRequest)
    if (this.pitchTimer != null) clearInterval(this.pitchTimer)
    if (this.asrDisplayTimer != null) clearTimeout(this.asrDisplayTimer)
    this.playerTimeout = null
    this.countdownTimer = null
    this.drawRequest = null
    this.pitchTimer = null
    this.asrDisplayTimer = null
    this.asrPendingDisplayText = ''

    this.releasePlayer()
    this.releaseMicrophone()
    this.pitchTrack = null
    this.selfPitch = null
    this.opponentPitch = null
    this.battleSelfCanvas = null
    this.battleOpponentCanvas = null
  },

  releasePlayer() {
    const player = this.player
    this.player = null
    this.browserAudio = null
    this.browserAudioPrimed = false
    if (player) player.destroy()
  },

  releaseMicrophone() {
    this.stopRecognition()
    const context = this.audioContext
    this.audioContext = null
    if (this.source) this.source.disconnect()
    if (this.mediaStream) this.mediaStream.getTracks().forEach(track => track.stop())
    if (context) context.close().catch(error => console.error('关闭音频失败', error))
    this.source = null
    this.mediaStream = null
    this.detectPitch = null
    this.detectVoice = null
  }
}
</script>

<page>
  <view class="page-root {{isBattle ? 'battle-mode' : ''}}">
    <view class="topbar" ink:if="{{!isBattle}}">
      <text class="song-name">{{songName}}</text>
      <text class="song-key" ink:if="{{songKey}}">调性 {{songKey}}</text>
      <text class="timer">{{timeLabel}}</text>
    </view>
    <view class="pitch-guide" ink:if="{{!isBattle}}">
      <view class="guide-rule guide-rule-high"></view>
      <view class="guide-rule guide-rule-mid"></view>
      <view class="guide-rule guide-rule-low"></view>
      <view class="guide-line" ink:if="{{guideVisible}}" style="top: {{guideTopPx}}px;"></view>
      <text class="guide-note" ink:if="{{guideVisible}}">{{guideNote}}</text>
    </view>
    <view class="lyric-bar {{isBattle ? 'battle-lyrics' : ''}}" ink:if="{{!isBattle || phase !== 'battleDone'}}">
      <view class="battle-lyric-meta" ink:if="{{isBattle}}">
        <text class="battle-song-title">{{songName}}</text>
        <text class="battle-timer">{{timeLabel}}</text>
      </view>
      <text class="lyric lyric-target" style="font-size: {{currentLyricFontSize}}px;">{{currentLyric}}</text>
      <text class="lyric lyric-next" style="font-size: {{nextLyricFontSize}}px;">{{nextLyric}}</text>
      <view class="recognized-row" ink:if="{{!isBattle}}">
        <text class="recognized-label">ASR</text>
        <view class="recognized-viewport {{asrDisplayFull ? 'recognized-viewport-full' : ''}}">
          <text class="lyric lyric-recognized">{{asrDisplayText}}</text>
        </view>
        <text class="recognized-status" ink:if="{{phase === 'recording' && asrStatusText && asrStatusText !== '等待 ASR'}}">{{asrStatusText}}</text>
      </view>
    </view>
    <view class="battle-field" ink:if="{{isBattle}}" bindtap="onConfirm">
      <view class="battle-result" ink:if="{{phase === 'battleDone'}}">
        <text class="battle-result-eyebrow">本局结算</text>
        <view class="battle-result-fireworks battle-result-fireworks-a" ink:for="{{battleFireworksA}}" ink:key="id">
          <view class="battle-firework battle-firework-ring battle-firework-a-outer"></view>
          <view class="battle-firework battle-firework-ring battle-firework-a-inner"></view>
        </view>
        <view class="battle-result-fireworks battle-result-fireworks-b" ink:for="{{battleFireworksB}}" ink:key="id">
          <view class="battle-firework battle-firework-star battle-firework-b-outer"></view>
          <view class="battle-firework battle-firework-star battle-firework-b-inner"></view>
        </view>
        <view class="battle-result-scores" ink:if="{{battleResultOutcome !== 'cancelled'}}">
          <view class="battle-result-score-cell battle-result-score-self {{battleResultOutcome === 'win' ? 'battle-result-score-leading' : (battleResultOutcome === 'loss' ? 'battle-result-score-trailing' : '')}}">
            <text class="battle-result-score-value">{{battleSelfScore}}</text>
            <text class="battle-result-score-role">你</text>
          </view>
          <view class="battle-result-score-separator"></view>
          <view class="battle-result-score-cell battle-result-score-opponent {{battleResultOutcome === 'loss' ? 'battle-result-score-leading' : (battleResultOutcome === 'win' ? 'battle-result-score-trailing' : '')}}">
            <text class="battle-result-score-value">{{battleOpponentScore}}</text>
            <text class="battle-result-score-role">对手</text>
          </view>
        </view>
        <text class="battle-result-title {{battleResultOutcome}}">{{battleResultTitle}}</text>
        <text class="battle-result-reason" ink:if="{{battleResultOutcome === 'cancelled'}}">{{statusText}}</text>
      </view>
      <view class="battle-panels" ink:elif="{{(phase === 'recording' && !cueText) || phase === 'battleWaiting'}}">
        <view class="battle-side battle-self">
          <view class="battle-player">
            <text class="battle-role">我</text>
            <text class="battle-score-label">得分</text>
            <text class="battle-score">{{battleSelfScore}}</text>
          </view>
          <view class="battle-pitch-box" ink:if="{{phase === 'recording'}}">
            <canvas id="battleSelfCanvas" class="battle-pitch-canvas" width="200" height="130"></canvas>
          </view>
          <view class="battle-pitch-caption" ink:if="{{phase === 'recording'}}">
            <text class="battle-pitch-label">参考 {{guideNote || '--'}}</text>
            <text class="battle-pitch-value">{{battleSelfNote !== '--' && selfOctaveShift ? (selfOctaveShift > 0 ? '低八度 · ' : '高八度 · ') : '实唱 '}}{{battleSelfNote}}</text>
          </view>
        </view>
        <view class="battle-side">
          <view class="battle-player">
            <text class="battle-role">{{battleOpponentName === '对手' ? '对手' : '对手 · ' + battleOpponentName}}</text>
            <text class="battle-score-label">得分</text>
            <text class="battle-score">{{battleOpponentScore}}</text>
          </view>
          <view class="battle-pitch-box" ink:if="{{phase === 'recording'}}">
            <canvas id="battleOpponentCanvas" class="battle-pitch-canvas" width="200" height="130"></canvas>
          </view>
          <view class="battle-pitch-caption" ink:if="{{phase === 'recording'}}">
            <text class="battle-pitch-label">参考 {{guideNote || '--'}}</text>
            <text class="battle-pitch-value">{{battleOpponentNote !== '--' && opponentOctaveShift ? (opponentOctaveShift > 0 ? '低八度 · ' : '高八度 · ') : '实唱 '}}{{battleOpponentNote}}</text>
          </view>
        </view>
        <text class="battle-waiting-text" ink:if="{{phase === 'battleWaiting'}}">{{statusText}}</text>
      </view>
      <view class="battle-state" ink:else>
        <text class="{{phase === 'countdown' || cueText ? 'countdown' : 'status'}}">{{phase === 'recording' ? cueText : statusText}}</text>
      </view>
      <view class="battle-hintbar">
        <text class="battle-hint battle-legend" ink:if="{{phase === 'recording' && !cueText}}">横线参考 · 圆点实唱</text>
        <text class="battle-hint">{{hintText}}</text>
      </view>
    </view>
    <view class="activity" ink:else bindtap="onConfirm">
      <canvas id="pitchCanvas" class="pitch-canvas" width="448" height="180"></canvas>
      <view class="status-overlay" ink:if="{{phase !== 'recording'}}">
        <text class="{{phase === 'countdown' ? 'countdown' : 'status'}}">{{statusText}}</text>
      </view>
      <view class="status-overlay cue-overlay" ink:if="{{phase === 'recording' && cueText}}">
        <text class="countdown">{{cueText}}</text>
      </view>
    </view>
    <view class="hintbar" ink:if="{{!isBattle}}" bindtap="onConfirm">
      <text class="hint-text">{{phase === 'recording' && selfOctaveShift ? (selfOctaveShift > 0 ? '低八度对齐 · ' : '高八度对齐 · ') : ''}}{{hintText}}</text>
    </view>
  </view>
</page>

<style>
.page-root {
  display: flex;
  flex-direction: column;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
}

.topbar {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  height: 36px;
  border-bottom: 1px solid rgba(76,199,115,0.40);
}

.song-name, .timer {
  color: rgba(76,199,115,0.72);
  font-size: 16px;
}

.song-key {
  color: rgba(76,199,115,0.48);
  font-size: 11px;
}

.battle-lyric-meta {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-width: 0;
}

.battle-song-title, .battle-timer {
  color: rgba(76,199,115,0.72);
  font-size: 11px;
}

.battle-song-title {
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.battle-timer {
  flex-shrink: 0;
}

.battle-field {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.battle-result {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  align-items: center;
}

.battle-result-eyebrow {
  margin-top: 47px;
  color: rgba(76,199,115,0.65);
  font-size: 11px;
  letter-spacing: 3px;
  animation: battle-result-reveal 400ms ease-out both;
}

.battle-result-title {
  position: absolute;
  top: 218px;
  left: 0;
  right: 0;
  z-index: 2;
  color: #b7bec2;
  font-size: 35px;
  line-height: 44px;
  font-weight: bold;
  letter-spacing: 6px;
  text-align: center;
  animation: battle-result-outcome 420ms ease-out 590ms both;
}

.battle-result-title.win {
  color: #ff6573;
}

.battle-result-title.draw {
  color: #4cc773;
}

.battle-result-title.cancelled {
  top: 119px;
  font-size: 28px;
  animation: battle-result-reveal 350ms ease-out both;
}

.battle-result-scores {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  position: absolute;
  top: 132px;
  left: 84px;
  z-index: 2;
  width: 280px;
  height: 69px;
}

.battle-result-score-cell {
  --battle-score-scale: 1.14;
  --battle-final-score-color: #4cc773;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.battle-result-score-self { --battle-score-start-x: 40px; }
.battle-result-score-opponent { --battle-score-start-x: 123px; }

.battle-result-score-leading {
  --battle-score-scale: 1.55;
  --battle-final-score-color: #ff6573;
}

.battle-result-score-trailing {
  --battle-score-scale: 0.8;
  --battle-final-score-color: rgba(76,199,115,0.66);
}

.battle-result-score-role {
  color: rgba(76,199,115,0.64);
  font-size: 11px;
  line-height: 15px;
  animation: battle-result-reveal 310ms ease-out 435ms both;
}

.battle-result-score-value {
  color: var(--battle-final-score-color);
  font-size: 34px;
  line-height: 50px;
  font-weight: bold;
  animation: battle-score-settle 960ms ease-out both;
}

.battle-result-score-separator {
  width: 1px;
  height: 30px;
  margin-bottom: 13px;
  flex-shrink: 0;
  background-color: rgba(76,199,115,0.32);
  animation: battle-result-reveal 310ms ease-out 435ms both;
}

.battle-result-reason {
  position: absolute;
  top: 174px;
  left: 64px;
  right: 64px;
  max-width: 320px;
  color: rgba(76,199,115,0.64);
  font-size: 12px;
  line-height: 17px;
  text-align: center;
}

.battle-result-fireworks {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  overflow: hidden;
}

.battle-firework {
  position: absolute;
  width: 3px;
  height: 3px;
  color: #4cc773;
  animation: battle-firework-burst 1060ms ease-out both;
}

.battle-firework-ring {
  border-radius: 2px;
  box-shadow: 0 -24px currentColor, 14px -19px currentColor, 23px -7px currentColor, 23px 7px currentColor,
    14px 19px currentColor, 0 24px currentColor, -14px 19px currentColor, -23px 7px currentColor,
    -23px -7px currentColor, -14px -19px currentColor, 0 -12px currentColor, 12px 0 currentColor,
    0 12px currentColor, -12px 0 currentColor;
}

.battle-firework-star {
  box-shadow: 0 -29px currentColor, 0 -20px currentColor, 0 -11px currentColor, 0 11px currentColor,
    0 20px currentColor, 0 29px currentColor, 11px 0 currentColor, 20px 0 currentColor, 29px 0 currentColor,
    -11px 0 currentColor, -20px 0 currentColor, -29px 0 currentColor, 14px 14px currentColor,
    14px -14px currentColor, -14px 14px currentColor, -14px -14px currentColor;
}

.battle-firework-a-outer { top: 99px; left: 69px; }
.battle-firework-a-inner { top: 211px; left: 113px; animation-delay: 160ms; }
.battle-firework-b-outer { top: 108px; right: 71px; }
.battle-firework-b-inner { top: 210px; right: 115px; animation-delay: 225ms; }

@keyframes battle-score-settle {
  0% { transform: translate(var(--battle-score-start-x), -44px) scale(1); color: #4cc773; }
  52% { transform: translate(0, 0) scale(1); color: #4cc773; }
  78% { transform: scale(var(--battle-score-scale)); color: var(--battle-final-score-color); }
  100% { transform: scale(var(--battle-score-scale)); color: var(--battle-final-score-color); }
}

@keyframes battle-result-reveal {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes battle-result-outcome {
  from { opacity: 0; transform: translateY(10px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes battle-firework-burst {
  0% { opacity: 0; transform: scale(0.12); }
  15% { opacity: 1; }
  62% { opacity: 0.8; }
  100% { opacity: 0; transform: scale(2.15) translateY(8px); }
}

.battle-panels {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: row;
  min-height: 0;
}

.battle-waiting-text {
  position: absolute;
  top: 108px;
  left: 0;
  right: 0;
  color: rgba(76,199,115,0.72);
  font-size: 17px;
  text-align: center;
}

.battle-side {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  box-sizing: border-box;
  align-items: center;
  min-width: 0;
  padding-top: 10px;
}

.battle-self {
  border-right: 1px solid rgba(76,199,115,0.32);
}

.battle-player {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-shrink: 0;
  width: 200px;
  height: 42px;
  margin-bottom: 6px;
}

.battle-role {
  flex: 1 1 auto;
  min-width: 0;
  color: rgba(76,199,115,0.83);
  font-size: 15px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.battle-score {
  flex-shrink: 0;
  color: #4cc773;
  font-size: 34px;
  font-weight: bold;
}

.battle-score-label {
  flex-shrink: 0;
  margin: 0 6px;
  color: rgba(76,199,115,0.57);
  font-size: 11px;
}

.battle-pitch-box {
  flex-shrink: 0;
  border-top: 1px solid rgba(76,199,115,0.32);
  border-bottom: 1px solid rgba(76,199,115,0.22);
}

.battle-pitch-canvas {
  width: 200px;
  height: 130px;
}

.battle-pitch-caption {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 200px;
  height: 22px;
}

.battle-pitch-label {
  color: rgba(76,199,115,0.72);
  font-size: 12px;
}

.battle-pitch-value {
  color: #4cc773;
  font-size: 12px;
  font-weight: bold;
}

.battle-state {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
}

.battle-hintbar {
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  justify-content: center;
  align-items: center;
  height: 22px;
  border-top: 1px solid rgba(76,199,115,0.22);
}

.battle-hint {
  color: rgba(76,199,115,0.66);
  font-size: 11px;
}

.battle-legend {
  margin-right: 20px;
}

.lyric-bar {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 64px;
}

.lyric-bar.battle-lyrics {
  box-sizing: border-box;
  flex: 0 0 82px;
  height: 82px;
  justify-content: space-evenly;
  padding: 3px 12px 6px;
  border-bottom: 1px solid rgba(76,199,115,0.48);
}

.lyric {
  color: #4cc773;
  font-weight: bold;
}

.lyric-target, .lyric-next {
  box-sizing: border-box;
  flex-shrink: 0;
  width: 100%;
  padding: 0 8px;
  font-family: sans-serif;
  text-align: center;
  white-space: nowrap;
}

.lyric-target {
  line-height: 24px;
}

.lyric-next {
  min-height: 18px;
  font-weight: normal;
  color: rgba(76,199,115,0.38);
  line-height: 18px;
}

.battle-lyrics .lyric-next {
  color: rgba(76,199,115,0.65);
}

.lyric-recognized {
  font-size: 15px;
  font-family: sans-serif;
  color: rgba(76,199,115,0.72);
  min-height: 16px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 18px;
}

.recognized-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  width: 360px;
  max-width: 100%;
  height: 24px;
  margin: 0 auto;
  margin-top: 0;
}

.recognized-viewport {
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 240px;
  flex-shrink: 1;
  min-width: 0;
  height: 24px;
  overflow: hidden;
  border-bottom: 1px solid rgba(76,199,115,0.18);
}

.recognized-viewport-full {
  justify-content: flex-end;
}

.recognized-label {
  font-size: 10px;
  color: rgba(76,199,115,0.32);
  margin-right: 6px;
  flex-shrink: 0;
}

.recognized-status {
  margin-left: 6px;
  font-size: 10px;
  color: rgba(76,199,115,0.48);
  white-space: nowrap;
}

.pitch-guide {
  position: relative;
  height: 22px;
  flex-shrink: 0;
  margin-bottom: 4px;
  background-color: rgba(76,199,115,0.04);
  border-top: 1px solid rgba(76,199,115,0.16);
  border-bottom: 1px solid rgba(76,199,115,0.24);
}

.guide-rule {
  position: absolute;
  left: 8px;
  right: 44px;
  height: 1px;
  background-color: rgba(76,199,115,0.12);
}

.guide-rule-high { top: 4px; }
.guide-rule-mid { top: 11px; }
.guide-rule-low { top: 18px; }

.guide-line {
  position: absolute;
  left: 8px;
  right: 44px;
  height: 2px;
  background-color: #4cc773;
}

.guide-note {
  position: absolute;
  right: 6px;
  top: 4px;
  width: 34px;
  text-align: right;
  font-size: 12px;
  color: rgba(76,199,115,0.72);
}

.activity {
  position: relative;
  height: 180px;
}

.pitch-canvas, .status-overlay {
  width: 448px;
  height: 180px;
}

.status-overlay {
  display: flex;
  flex-direction: column;
  position: absolute;
  left: 0;
  top: 0;
  justify-content: center;
  align-items: center;
}

.status, .countdown {
  color: #4cc773;
  font-weight: bold;
}

.status { font-size: 25px; }
.countdown { font-size: 64px; }

.cue-overlay {
  background-color: rgba(0, 0, 0, 0.55);
}

.hintbar {
  display: flex;
  flex: 1;
  justify-content: center;
  align-items: flex-end;
  padding-bottom: 4px;
}

.hint-text {
  color: rgba(76,199,115,0.72);
  font-size: 16px;
}

@media (target: _current) {
  .page-root {
    width: 100%;
    height: 100%;
    margin: 0;
  }

  .topbar {
    height: 32px;
    flex-shrink: 0;
    padding: 0 12px;
  }

  .pitch-canvas, .pitch-guide { display: none; }

  .lyric-bar {
    height: 86px;
  }

  .activity {
    flex: 1;
    height: auto;
  }

  .status-overlay {
    width: 100%;
    height: 100%;
  }

  .hintbar {
    flex: 0 0 30px;
    justify-content: center;
    align-items: center;
    padding-bottom: 0;
  }
}
</style>
