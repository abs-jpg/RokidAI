<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { getSongById, getLyricAt, getRefNoteAt } from '../../utils/songData.js'
import { calcAccuracyScore, createPitchDetector, encodePitchTrack, hzToMidi, MIN_SAMPLE_QUALITY, PITCH_STEP_MS, SCORING_VERSION } from '../../utils/pitchEngine.js'
import { getSongFromLibrary, readDownloadedAudio } from '../../utils/songLibrary.js'
import { localBattleStart, measureBattleClock, onBattleMessage, sendBattle } from '../../utils/battleClient.js'

const WIDTH = 448
const HEIGHT = 180
const PAST_MS = 3200
const FUTURE_MS = 1600
const PLAYER_TIMEOUT_MS = 10000
const GUIDE_HEIGHT = 22
const GUIDE_PADDING = 2
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
// 真机采音链路固定延迟估计：麦克风采集缓冲 + 分析窗一半 + 播放输出延迟。
// 如果真机测试发现曲线整体提前/滞后，只调整 INPUT_LATENCY_MS 即可。
const INPUT_LATENCY_MS = 25
const MAX_CAPTURE_OFFSET_MS = 260
const BATTLE_PERFECT = 10
const BATTLE_GREAT = 6
const BATTLE_GOOD = 2
const RECORDING_KEY = 'karaoke_last_recording'

function isCardAudioUnavailable(error) {
  return error?.name === 'InvalidStateError' && error.message?.includes('target is _current')
}

export default {
  data: {
    phase: 'loading',
    isBattle: false,
    practiceOnly: false,
    songName: '',
    timeLabel: '00:00 / 00:00',
    currentLyric: '',
    guideVisible: false,
    guideTopPx: GUIDE_HEIGHT / 2,
    guideNote: '',
    battleSelfScore: 0,
    battleOpponentScore: 0,
    battleSelfNote: '--',
    battleOpponentNote: '--',
    battleOpponentName: '对手',
    battleResultText: '',
    statusText: '正在加载伴奏',
    hintText: '返回'
  },

  onLoad(query) {
    this.query = query || {}
    this.isBattle = this.query.mode === 'battle'
    this.forcedSilent = this.query.mode === 'silent'
    this.roomId = this.query.roomId || ''
    this.roundId = this.query.roundId || ''
    this.selfId = this.query.selfId || ''
    this.opponentName = this.query.opponent || '对手'
    this.battleScore = 0
    this.lastBattleSend = 0
    this.lastBattleUi = 0
    if (this.isBattle) {
      this.setData({ isBattle: true, battleOpponentName: this.opponentName })
      this.unsubscribeBattle = onBattleMessage(message => this.handleBattleMessage(message))
    }
    this.initializeSong()
  },

  handleBattleMessage(message) {
    if (!this.isBattle) return
    if (message.roomId && (message.roomId !== this.roomId || message.roundId !== this.roundId)) return
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
      const now = performance.now()
      if (now - this.lastBattleUi < 120) return
      this.lastBattleUi = now
      this.setData({
        battleOpponentScore: Math.round(message.score || 0),
        battleOpponentNote: message.note || '--'
      })
      return
    }
    if (message.type === 'battle.result') {
      const players = Array.isArray(message.players) ? message.players : []
      const selfId = String(this.selfId)
      const winner = String(message.winner)
      const mine = players.find(player => String(player.id) === selfId)
      const other = players.find(player => String(player.id) !== selfId)
      const text = winner === 'draw' ? '平局' :
        (winner === selfId ? '你赢了！' : '对手获胜')
      this.releaseAudio()
      this.setData({
        phase: 'battleDone',
        statusText: text,
        battleResultText: mine && other
          ? '我 ' + mine.score + '  :  ' + other.score + ' ' + other.name
          : '',
        battleSelfScore: mine ? mine.score : this.battleScore,
        battleOpponentScore: other ? other.score : this.data.battleOpponentScore,
        hintText: '确认返回联机大厅'
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
        if (!this.forcedSilent) this.audioBytes = await readDownloadedAudio(song).catch(() => null)
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
      this.setData({ songName: song.name })
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
    this.canvas = wx.createCanvasContext('pitchCanvas')
  },

  onTargetChanged(target, previousTarget) {
    // The first callback can carry the default card target before the host is ready.
    if (target === '_current' && previousTarget == null) return
    if (this.hostTarget === target) return
    this.hostTarget = target
    if (!this.visible || !this.song) return
    if (this.isBattle) {
      if (target === '_current' && previousTarget === '_blank') this.abortBattle('对战需要在全屏进行')
      return
    }
    if (target === '_blank' && this.data.practiceOnly && !this.forcedSilent) this.prepareAudio()
  },

  onHide() {
    this.visible = false
    if (this.isBattle && this.data.phase !== 'battleDone') this.abortBattle('对战已退出')
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
    this.releaseAudio()
    this.canvas = null
  },

  onKeyUp(event) {
    if (event.code === 'Enter') {
      event.preventDefault()
      this.onConfirm()
    }
  },

  onConfirm() {
    switch (this.data.phase) {
      case 'ready':
        this.primeBrowserAudio()
        this.requestMicrophone()
        break
      case 'recording':
        this.finishRecording()
        break
      case 'error':
      case 'practiceDone':
        if (this.song) this.prepareAudio()
        break
      case 'settling':
        this.goToResult()
        break
      case 'battleDone':
        wx.navigateBack()
        break
    }
  },

  prepareAudio() {
    this.releaseAudio()
    this.clearCanvas()
    this.elapsedMs = 0
    this.practiceReason = ''
    this.setData({
      phase: 'loading',
      practiceOnly: false,
      timeLabel: this.formatTime(0),
      currentLyric: '',
      guideVisible: false,
      guideNote: '',
      statusText: '正在加载伴奏',
      hintText: '返回'
    })
    if (this.forcedSilent) {
      this.showSilentReady()
      return
    }
    if (!this.song.accompaniment && !this.audioBytes) {
      this.showError('伴奏不可用')
      return
    }
    if (typeof Audio !== 'undefined' && (!this.audioBytes || typeof URL.createObjectURL === 'function')) {
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
      if (this.audioBytes) player.setBuffer(this.audioBytes, 'ogg')
      else player.src = this.song.accompaniment
    } catch (error) {
      this.showError('无法加载伴奏', error)
    }
  },

  prepareBrowserAudio() {
    let audio
    let localUrl
    try {
      if (this.audioBytes) localUrl = URL.createObjectURL(new Blob([this.audioBytes], { type: 'audio/ogg' }))
      audio = new Audio(localUrl || this.song.accompaniment)
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
      statusText: '准备跟唱',
      hintText: '确认开始 · 返回'
    })
  },

  showSilentReady() {
    this.releasePlayer()
    this.setData({
      phase: 'ready',
      practiceOnly: false,
      statusText: '无声版本',
      hintText: '确认开始 · 返回'
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
      // Check that this host can process sound before requesting a microphone stream.
      context = new AudioContext()
      this.audioContext = context
      await context.resume()
      if (this.player !== player || this.audioContext !== context) return

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
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

      this.detectPitch = createPitchDetector(analyser)
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
        if (this.forcedSilent) {
          this.practiceReason = '无声练习 · 不计分'
          this.setData({ practiceOnly: true })
        }
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
        ? '卡片练习 · 展开全屏可评分'
        : '麦克风不可用 · 本次不计分'
      this.setData({ practiceOnly: true })
      this.startCountdown()
    }
  },

  startCountdown() {
    let seconds = 3
    this.setData({ phase: 'countdown', statusText: String(seconds), hintText: '返回' })
    this.countdownTimer = setInterval(() => {
      seconds--
      if (seconds > 0) {
        this.setData({ statusText: String(seconds) })
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
      if (remaining <= 0) {
        clearInterval(this.countdownTimer)
        this.countdownTimer = null
        if (this.player) this.playAccompaniment()
        else this.beginFollowing()
        return
      }
      this.setData({
        phase: 'countdown',
        statusText: String(Math.max(1, Math.ceil(remaining / 1000))),
        hintText: '同步开始 · 返回退出'
      })
    }
    this.setData({ phase: 'countdown', statusText: '3', hintText: '同步开始 · 返回退出' })
    this.countdownTimer = setInterval(tick, 200)
    tick()
  },

  sendRound(type, payload = {}) {
    return sendBattle(type, { ...payload, roomId: this.roomId, roundId: this.roundId })
  },

  abortBattle(reason, notify = true) {
    if (this.data.phase === 'battleDone') return
    this.releaseAudio()
    this.setData({
      phase: 'battleDone',
      currentLyric: '',
      statusText: reason,
      hintText: '确认返回联机大厅'
    })
    if (notify) this.sendRound('battle.cancel')
  },

  handlePlaybackError(error) {
    if (this.isBattle) {
      this.abortBattle('伴奏不可用 · 对战已取消')
      return
    }
    if (isCardAudioUnavailable(error)) {
      this.startLyricsPractice('无声练习 · 展开全屏播放')
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
    this.battleScore = 0
    this.lastBattleSend = 0
    this.lastBattleUi = 0
    this.lastPitchTime = -1
    this.lastFrameTime = -Infinity
    this.practiceStartedAt = performance.now()
    this.setData({
      phase: 'recording',
      battleSelfScore: 0,
      battleSelfNote: '--',
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
      if (now - this.lastFrameTime >= 30) {
        this.lastFrameTime = now
        try {
          this.updateRecording()
        } catch (error) {
          this.showError('读取音频失败', error)
          return
        }
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
    if (Number.isFinite(pitchTime) && pitchTime >= 0 && pitchTime < this.song.durationMs) {
      const timeMs = Math.floor(pitchTime / PITCH_STEP_MS) * PITCH_STEP_MS + PITCH_STEP_MS / 2
      if (timeMs > this.lastPitchTime) {
        this.lastPitchTime = timeMs
        const midi = hzToMidi(this.detectPitch())
        this.pitchTrack.push({ timeMs, midi })
        if (this.isBattle && Number.isFinite(midi)) this.updateBattleScore(timeMs, midi)
      }
    }
  },

  updateRecording() {
    const elapsedMs = this.getElapsedMs()
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
    this.elapsedMs = elapsedMs
    const lyric = getLyricAt(this.song.lyrics, elapsedMs)
    const refNote = getRefNoteAt(this.song.refNotes, elapsedMs)
    const currentLyric = lyric ? lyric.text : ''
    const timeLabel = this.formatTime(elapsedMs)
    const guideVisible = !!refNote
    const guideTopPx = refNote ? this.getGuideTopPx(refNote.midi) : this.data.guideTopPx
    const guideNote = refNote ? this.midiToNoteName(refNote.midi) : ''
    if (currentLyric !== this.data.currentLyric || timeLabel !== this.data.timeLabel ||
        guideVisible !== this.data.guideVisible || guideTopPx !== this.data.guideTopPx ||
        guideNote !== this.data.guideNote) {
      this.setData({ currentLyric, timeLabel, guideVisible, guideTopPx, guideNote })
    }

    if (this.detectPitch) {
      if (!this.canvas) this.canvas = wx.createCanvasContext('pitchCanvas')
      if (this.canvas) this.drawPitch(elapsedMs)
    }
    if (elapsedMs >= this.song.durationMs) this.finishRecording(true)
  },

  updateBattleScore(timeMs, midi) {
    const ref = getRefNoteAt(this.song.refNotes, timeMs)
    if (!ref) return
    const difference = midi - ref.midi
    const cents = Math.abs(difference) * 100
    const points = cents <= 25 ? BATTLE_PERFECT
      : (cents <= 50 ? BATTLE_GREAT : (cents <= 100 ? BATTLE_GOOD : 0))
    this.battleScore += points
    const now = performance.now()
    const note = this.midiToNoteName(midi)

    if (now - this.lastBattleUi >= 120) {
      this.lastBattleUi = now
      this.setData({
        battleSelfScore: this.battleScore,
        battleSelfNote: note
      })
    }
    if (now - this.lastBattleSend >= 400) {
      this.lastBattleSend = now
      this.sendRound('battle.progress', {
        score: this.battleScore,
        midi,
        note,
        cents: Math.round(difference * 100)
      })
    }
  },

  drawPitch(elapsedMs) {
    const ctx = this.canvas
    const startMs = elapsedMs - PAST_MS
    const endMs = elapsedMs + FUTURE_MS
    const toX = timeMs => (timeMs - startMs) * WIDTH / (PAST_MS + FUTURE_MS)
    const toY = midi => {
      const bounded = Math.max(this.minMidi, Math.min(this.maxMidi, midi))
      return 8 + (this.maxMidi - bounded) * (HEIGHT - 16) / (this.maxMidi - this.minMidi)
    }

    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    ctx.strokeStyle = 'rgba(64,255,94,0.40)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(elapsedMs), 0)
    ctx.lineTo(toX(elapsedMs), HEIGHT)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(64,255,94,0.48)'
    ctx.lineWidth = 3
    ctx.beginPath()
    for (const note of this.song.refNotes) {
      if (note.endMs <= startMs || note.startMs >= endMs) continue
      const y = toY(note.midi)
      ctx.moveTo(toX(Math.max(startMs, note.startMs)), y)
      ctx.lineTo(toX(Math.min(endMs, note.endMs)), y)
    }
    ctx.stroke()

    ctx.strokeStyle = '#40ff5e'
    ctx.fillStyle = '#40ff5e'
    ctx.lineWidth = 2
    ctx.beginPath()
    let previousTime = -Infinity
    const first = Math.max(0, this.pitchTrack.length - Math.ceil(PAST_MS / PITCH_STEP_MS) - 2)
    for (let index = first; index < this.pitchTrack.length; index++) {
      const sample = this.pitchTrack[index]
      if (sample.timeMs < startMs || sample.midi === null) continue
      const x = toX(sample.timeMs)
      const y = toY(sample.midi)
      if (sample.timeMs - previousTime > PITCH_STEP_MS) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      previousTime = sample.timeMs
    }
    ctx.stroke()

    const sample = this.pitchTrack[this.pitchTrack.length - 1]
    if (sample && sample.midi !== null && elapsedMs - sample.timeMs < 200) {
      const ref = getRefNoteAt(this.song.refNotes, sample.timeMs)
      const offPitch = ref && Math.abs(sample.midi - ref.midi) >= 1
      ctx.beginPath()
      ctx.arc(toX(sample.timeMs), toY(sample.midi), offPitch ? 5 : 3, 0, 2 * Math.PI)
      if (offPitch) ctx.stroke()
      else ctx.fill()
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

  getGuideTopPx(midi) {
    const span = this.guideMaxMidi - this.guideMinMidi || 1
    const bounded = Math.max(this.guideMinMidi, Math.min(this.guideMaxMidi, midi))
    return Math.round(GUIDE_PADDING + (this.guideMaxMidi - bounded) * (GUIDE_HEIGHT - GUIDE_PADDING * 2 - 2) / span)
  },

  midiToNoteName(midi) {
    const rounded = Math.round(midi)
    return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1)
  },

  finishRecording(completed = false) {
    if (this.data.phase !== 'recording') return
    if (this.data.practiceOnly) {
      this.releaseAudio()
      this.setData({ phase: 'practiceDone', currentLyric: '', statusText: '已完成', hintText: '确认重来 · 返回' })
      return
    }
    this.samplePitch()
    if (completed && calcAccuracyScore(this.pitchTrack, this.song.refNotes).sampleQuality < MIN_SAMPLE_QUALITY) {
      this.showError('设备采样不稳定 · 请重唱')
      return
    }
    if (this.isBattle) {
      if (!completed) {
        this.abortBattle('已退出本场对战')
        return
      }
      if (!this.sendRound('battle.finish', { samples: encodePitchTrack(this.pitchTrack) })) {
        this.abortBattle('联机已断开', false)
        return
      }
      this.releaseAudio()
      this.setData({
        phase: 'battleWaiting',
        currentLyric: '',
        statusText: '等待对手完成',
        hintText: '请稍候'
      })
      return
    }
    const attemptId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    try {
      wx.setStorageSync(RECORDING_KEY, {
        attemptId,
        songId: this.song.id,
        completed,
        chartVersion: this.song.chartVersion,
        scoringVersion: SCORING_VERSION,
        pitchTrack: this.pitchTrack
      })
    } catch (error) {
      this.showError('保存本次演唱失败', error)
      return
    }
    this.releaseAudio()
    this.attemptId = attemptId
    this.setData({ phase: 'settling', currentLyric: '', statusText: '正在打开成绩', hintText: '返回' })
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
    this.setData({ phase: 'error', currentLyric: '', statusText, hintText: '确认重试 · 返回' })
  },

  releaseAudio() {
    if (this.playerTimeout != null) clearTimeout(this.playerTimeout)
    if (this.countdownTimer != null) clearInterval(this.countdownTimer)
    if (this.drawRequest != null) cancelAnimationFrame(this.drawRequest)
    if (this.pitchTimer != null) clearInterval(this.pitchTimer)
    this.playerTimeout = null
    this.countdownTimer = null
    this.drawRequest = null
    this.pitchTimer = null

    this.releasePlayer()
    this.releaseMicrophone()
    this.pitchTrack = null
  },

  releasePlayer() {
    const player = this.player
    this.player = null
    this.browserAudio = null
    this.browserAudioPrimed = false
    if (player) player.destroy()
  },

  releaseMicrophone() {
    const context = this.audioContext
    this.audioContext = null
    if (this.source) this.source.disconnect()
    if (this.mediaStream) this.mediaStream.getTracks().forEach(track => track.stop())
    if (context) context.close().catch(error => console.error('关闭音频失败', error))
    this.source = null
    this.mediaStream = null
    this.detectPitch = null
  }
}
</script>

<page>
  <view class="page-root {{isBattle ? 'battle-mode' : ''}}">
    <view class="topbar">
      <text class="song-name">{{songName}}</text>
      <text class="timer">{{timeLabel}}</text>
    </view>
    <view class="battle-panels" ink:if="{{isBattle}}">
      <view class="battle-side">
        <view class="battle-side-head">
          <text class="battle-role">我</text>
          <text class="battle-score">{{battleSelfScore}}</text>
        </view>
        <text class="battle-note">{{battleSelfNote}}</text>
      </view>
      <view class="battle-side battle-rival">
        <view class="battle-side-head">
          <text class="battle-role">{{battleOpponentName}}</text>
          <text class="battle-score">{{battleOpponentScore}}</text>
        </view>
        <text class="battle-note">{{battleOpponentNote}}</text>
      </view>
    </view>
    <view class="pitch-guide">
      <view class="guide-rule guide-rule-high"></view>
      <view class="guide-rule guide-rule-mid"></view>
      <view class="guide-rule guide-rule-low"></view>
      <view class="guide-line" ink:if="{{guideVisible}}" style="top: {{guideTopPx}}px;"></view>
      <text class="guide-note" ink:if="{{guideVisible}}">{{guideNote}}</text>
    </view>
    <view class="lyric-bar">
      <text class="lyric">{{currentLyric}}</text>
    </view>
    <view class="activity" bindtap="onConfirm">
      <canvas id="pitchCanvas" class="pitch-canvas" width="448" height="180"></canvas>
      <view class="status-overlay" ink:if="{{phase !== 'recording'}}">
        <text class="{{phase === 'countdown' ? 'countdown' : 'status'}}">{{statusText}}</text>
        <text class="battle-result-line" ink:if="{{phase === 'battleDone'}}">{{battleResultText}}</text>
      </view>
      <view class="status-overlay card-lyrics" ink:if="{{phase === 'recording'}}">
        <text class="lyric">{{currentLyric}}</text>
      </view>
    </view>
    <view class="hintbar" bindtap="onConfirm">
      <text class="hint-text">{{hintText}}</text>
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
  border-bottom: 1px solid rgba(64,255,94,0.40);
}

.song-name, .timer {
  color: rgba(64,255,94,0.72);
  font-size: 16px;
}

.battle-panels {
  display: flex;
  flex-direction: row;
  height: 42px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(64,255,94,0.24);
}

.battle-side {
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex: 1 1 0;
  padding: 0 10px;
  border-right: 1px solid rgba(64,255,94,0.24);
}

.battle-rival {
  border-right: 0;
  align-items: flex-end;
}

.battle-side-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.battle-role {
  font-size: 10px;
  color: rgba(64,255,94,0.48);
}

.battle-score {
  font-size: 22px;
  font-weight: bold;
  color: #40ff5e;
}

.battle-note {
  font-size: 11px;
  color: rgba(64,255,94,0.72);
}

.battle-mode .pitch-guide {
  display: none;
}

.lyric-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 46px;
}

.lyric {
  color: #40ff5e;
  font-size: 25px;
  font-weight: bold;
}

.pitch-guide {
  position: relative;
  height: 22px;
  flex-shrink: 0;
  margin-bottom: 4px;
  background-color: rgba(64,255,94,0.04);
  border-top: 1px solid rgba(64,255,94,0.16);
  border-bottom: 1px solid rgba(64,255,94,0.24);
}

.guide-rule {
  position: absolute;
  left: 8px;
  right: 44px;
  height: 1px;
  background-color: rgba(64,255,94,0.12);
}

.guide-rule-high { top: 4px; }
.guide-rule-mid { top: 11px; }
.guide-rule-low { top: 18px; }

.guide-line {
  position: absolute;
  left: 8px;
  right: 44px;
  height: 2px;
  background-color: #40ff5e;
}

.guide-note {
  position: absolute;
  right: 6px;
  top: 4px;
  width: 34px;
  text-align: right;
  font-size: 12px;
  color: rgba(64,255,94,0.72);
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
  color: #40ff5e;
  font-weight: bold;
}

.status { font-size: 25px; }
.countdown { font-size: 64px; }
.card-lyrics { display: none; }

.battle-result-line {
  font-size: 14px;
  color: rgba(64,255,94,0.72);
  margin-top: 6px;
}

.hintbar {
  display: flex;
  flex: 1;
  justify-content: center;
  align-items: flex-end;
  padding-bottom: 4px;
}

.hint-text {
  color: rgba(64,255,94,0.72);
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

  .lyric-bar, .pitch-canvas, .pitch-guide { display: none; }

  .activity {
    flex: 1;
    height: auto;
  }

  .status-overlay {
    width: 100%;
    height: 100%;
  }

  .card-lyrics { display: flex; }

  .hintbar {
    flex: 0 0 30px;
    justify-content: center;
    align-items: center;
    padding-bottom: 0;
  }
}
</style>
