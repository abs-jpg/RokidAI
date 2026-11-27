import { PITCH_STEP_MS, calcAccuracyScore, countExpectedFrames } from './pitchEngine.js'
import { calcLyricMatchScore } from './scoreEngine.js'
import { songChoiceLayout } from './songChoice.js'
import { simplifyChartChinese } from './phraseChinese.js'

const PAGE_SIZE = 5
const COUNTDOWN_SECONDS = 3
const CHECK_INTERVAL_MS = 20
const PLAYBACK_STALL_MS = 5000
const MAX_CLOCK_INTERPOLATION_MS = 90

export function phraseLines(song) {
  const duration = song.durationMs
  return (song.lyrics || [])
    .filter(line => line?.text?.trim() && Number.isFinite(line.startMs) &&
      Number.isFinite(line.endMs) && line.startMs >= 0 && line.endMs > line.startMs && line.startMs < duration)
    .map(line => ({ ...line, endMs: Math.min(line.endMs, duration) }))
    .sort((a, b) => a.startMs - b.startMs)
}

function phraseNotes(song, line) {
  return (song.refNotes || [])
    .filter(note => Number.isFinite(note.midi) && note.startMs < line.endMs && note.endMs > line.startMs)
    .map(note => ({ ...note, startMs: Math.max(note.startMs, line.startMs), endMs: Math.min(note.endMs, line.endMs) }))
}

function clockLabel(ms, decimal = false) {
  const seconds = Math.floor(ms / 1000)
  const clock = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
  return decimal ? clock + '.' + Math.floor((ms % 1000) / 100) : clock
}

function matchingText(text, category) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '')
  return category === '中文' ? simplifyChartChinese(normalized) : normalized
}

export function scorePhrase(line, notes, frames, recognition, category) {
  const samples = Array.from(frames.values())
  const { accuracy, pitchProfile } = calcAccuracyScore(samples, notes)
  const expected = countExpectedFrames(notes)
  const voiced = samples.reduce((count, frame) => count + Number(frame.voiceActive || Number.isFinite(frame.midi)), 0)
  const pitchCoverage = expected ? Math.min(100, Math.round(pitchProfile.pitchedFrames * 100 / expected)) : null
  const allowedPitch = expected > 0 && pitchProfile.pitchedFrames >= Math.min(expected, 5) && pitchCoverage >= 20
  const text = String(recognition?.text || '').trim()
  const recognized = matchingText(text, category)
  const target = matchingText(line.text, category)
  const lyricMatch = recognized && target && voiced >= 3 ? calcLyricMatchScore(recognized, target) : null
  return {
    text,
    lyricMatch,
    pitchMatch: allowedPitch ? accuracy : null,
    pitchCoverage,
    recognitionState: recognition?.state || 'empty',
    voiced,
    pitchState: !expected ? 'no-reference' : allowedPitch ? 'matched' : 'insufficient'
  }
}

export function practiceLayout(viewportWidth, viewportHeight) {
  const { width, height } = songChoiceLayout(viewportWidth, viewportHeight)
  const rect = (x, y, w, h) => {
    const box = { x: Math.round(x * width / 448), y: Math.round(y * height / 328),
      width: Math.round(w * width / 448), height: Math.round(h * height / 328) }
    return { ...box, style: 'left:' + box.x + 'px;top:' + box.y + 'px;width:' + box.width + 'px;height:' + box.height + 'px;' }
  }
  return {
    width, height, compact: height < 225 || width < 330,
    boxes: [
      rect(12, 260, 121, 42), rect(143, 260, 162, 42), rect(315, 260, 121, 42),
      rect(12, 11, 80, 35), rect(356, 11, 80, 35)
    ],
    pickerBoxes: [
      ...Array.from({ length: PAGE_SIZE }, (_, index) => rect(12, 52 + 38 * index, 424, 34)),
      rect(12, 260, 121, 42), rect(143, 260, 162, 42), rect(315, 260, 121, 42)
    ],
    chart: rect(17, 126, 414, 69)
  }
}

const PHASE_LABELS = {
  ready: '停留确认后开始',
  preparing: '正在定位片段',
  countdown: '准备跟唱',
  starting: '正在启动片段',
  singing: '正在练唱',
  listening: '正在播放示范',
  settling: '正在核对唱词',
  result: '本次练唱完成',
  error: '本次练唱中断'
}

export class PhrasePractice {
  constructor(song, services) {
    this.song = song
    this.services = services
    this.lines = phraseLines(song)
    this.index = 0
    this.history = new Map()
    this.phase = 'ready'
    this.notes = this.lines.length ? phraseNotes(song, this.line) : []
  }

  get line() { return this.lines[this.index] }
  get pageCount() { return Math.ceil(this.lines.length / PAGE_SIZE) }

  view() {
    const line = this.line
    const round = this.round
    const saved = this.history.get(this.index)
    const result = this.phase === 'result' ? saved : null
    const hasAttempt = !!round
    const picker = this.pickerPage != null
    const pickerRows = picker ? Array.from({ length: PAGE_SIZE }, (_, offset) => {
      const index = this.pickerPage * PAGE_SIZE + offset
      const item = this.lines[index]
      return { index, text: item?.text || '', time: item ? clockLabel(item.startMs) : '', current: index === this.index }
    }) : []
    const pct = value => value == null ? '—' : value + '%'
    const recognitionMessage = result?.recognitionState === 'unavailable' ? '语音识别暂不可用'
      : (result?.recognitionState === 'timeout' ? '语音识别超时' : '未识别到有效唱词')
    const livePitch = round?.lastPoint?.midi
    const liveRef = round?.lastPoint?.reference
    const pitchHint = Number.isFinite(livePitch) && Number.isFinite(liveRef)
      ? (Math.abs(livePitch - liveRef) <= 2 ? 'Perfect' : 'Good') : ''
    return {
      songName: this.song.name,
      lineText: line?.text || '这首歌暂无逐句歌词',
      linePosition: line ? '第 ' + (this.index + 1) + ' / ' + this.lines.length + ' 句' : '',
      lineTime: line ? clockLabel(line.startMs, true) + '–' + clockLabel(line.endMs, true) : '',
      phase: this.phase,
      statusText: this.error || PHASE_LABELS[this.phase],
      countdownDots: round?.cue ? Array(round.cue).fill('●').join('  ') : '',
      heardText: result ? (result.lyricMatch == null ? recognitionMessage : result.text)
        : (round?.partial || '跟唱后显示识别结果'),
      lyricScore: pct(result?.lyricMatch),
      pitchScore: pct(result?.pitchMatch),
      pitchDetail: result ? (result.pitchState === 'no-reference' ? '本句无参考音高' :
        '音高覆盖 ' + pct(result.pitchCoverage)) : (pitchHint || '八度对齐'),
      lastAttempt: result ? '第 ' + result.count + ' 次' : '',
      canStop: hasAttempt,
      centerLabel: hasAttempt ? '停止' : saved ? '再练一次' : '开始练唱',
      choiceAvailable: picker
        ? [...pickerRows.map(row => !!row.text), this.pickerPage > 0, true, this.pickerPage < this.pageCount - 1]
        : [this.index > 0, !!line, this.index + 1 < this.lines.length, !!line && !hasAttempt, !!line],
      picker, pickerRows,
      pickerPosition: picker ? (this.pickerPage + 1) + ' / ' + this.pageCount + ' 页' : ''
    }
  }

  emit() { this.services.update(this.view()) }

  activate(target) {
    if (!this.view().choiceAvailable[target]) return
    if (this.pickerPage != null) {
      if (target < PAGE_SIZE) this.select(this.pickerPage * PAGE_SIZE + target)
      else if (target === PAGE_SIZE + 1) this.closePicker()
      else {
        this.pickerPage += target === PAGE_SIZE ? -1 : 1
        this.emit()
      }
      return
    }
    if (target === 0) this.select(this.index - 1)
    else if (target === 1) {
      if (!this.stop()) void this.start(false)
    } else if (target === 2) this.select(this.index + 1)
    else if (target === 3) {
      if (!this.round) void this.start(true)
    } else {
      this.cancel()
      this.phase = this.history.has(this.index) ? 'result' : 'ready'
      this.pickerPage = Math.floor(this.index / PAGE_SIZE)
      this.emit()
    }
  }

  select(index) {
    if (!this.lines[index]) return
    this.cancel()
    this.index = index
    this.pickerPage = null
    this.notes = phraseNotes(this.song, this.line)
    this.phase = this.history.has(index) ? 'result' : 'ready'
    this.error = ''
    this.emit()
  }

  closePicker() {
    if (this.pickerPage == null) return false
    this.select(this.index)
    return true
  }

  stop() {
    if (!this.round) return false
    this.select(this.index)
    return true
  }

  async start(listen) {
    const line = this.line
    const round = { line, listen, frames: new Map(), partial: '', lastClock: -Infinity }
    const isCurrent = () => this.round === round
    this.round = round
    this.error = ''
    this.phase = 'preparing'
    this.emit()
    try {
      round.player = this.services.openPlayer(line.startMs, listen, () => {
        if (isCurrent()) this.onPlaybackEnd(round)
      }, () => {
        if (isCurrent()) this.fail('片段播放失败 · 可以重试')
      })
      const capture = listen ? null : this.services.openInput((text) => {
        if (!isCurrent() || (this.phase !== 'singing' && this.phase !== 'settling')) return
        round.partial = text
        this.emit()
      }, line)
      round.input = capture
      await Promise.all([round.player.ready, capture?.ready])
      if (!isCurrent()) return
      if (listen) {
        this.phase = 'starting'
        void this.playRound(round)
      } else {
        this.phase = 'countdown'
        round.nextCueAt = performance.now() + 1000
        round.cue = COUNTDOWN_SECONDS
      }
      round.timer = setInterval(() => this.tick(round), CHECK_INTERVAL_MS)
      this.emit()
    } catch (error) {
      if (isCurrent()) this.fail(error?.name === 'NotAllowedError' ? '请授权麦克风后重试' : (error?.message || '无法开始练唱'))
    }
  }

  async playRound(round) {
    round.playRequestedAt = performance.now()
    try {
      await round.player.play()
      if (this.round !== round) return
      round.lastMovedAt = performance.now()
      this.phase = round.listen ? 'listening' : 'singing'
      this.emit()
    } catch (error) {
      if (this.round === round) this.fail(error?.message || '片段播放失败 · 可以重试')
    }
  }

  tick(round) {
    if (this.round !== round) return
    const now = performance.now()
    const { line, input } = round
    if (this.phase === 'countdown') {
      if (now < round.nextCueAt) return
      round.nextCueAt = now + 1000
      round.cue--
      if (round.cue === 1) input.begin()
      if (!round.cue) {
        this.phase = 'starting'
        void this.playRound(round)
        if (this.round !== round) return
      }
      this.emit()
      return
    }
    if (this.phase === 'starting') {
      if (now - round.playRequestedAt > PLAYBACK_STALL_MS) this.fail('伴奏启动超时 · 可以重试')
      return
    }
    let clock = round.player.currentTime * 1000
    if (round.stopAt == null) {
      if (clock > round.lastClock + 1) {
        if (Number.isFinite(round.lastClock)) round.runningClock = true
        round.lastClock = clock
        round.lastMovedAt = now
      } else if (now - round.lastMovedAt > PLAYBACK_STALL_MS) {
        this.fail('伴奏播放超时 · 可以重试')
        return
      }
      if (round.runningClock) clock = round.lastClock + Math.min(now - round.lastMovedAt, MAX_CLOCK_INTERPOLATION_MS)
      if (clock >= line.endMs) this.stopAtEnd(round)
    }
    if (this.round !== round) return
    if (round.stopAt != null) clock = line.endMs + Math.max(0, now - round.stopAt)
    round.position = Math.min(clock, line.endMs)
    if (round.listen) return
    const sampleAt = Math.floor((clock - input.offsetMs) / PITCH_STEP_MS) * PITCH_STEP_MS + PITCH_STEP_MS / 2
    if (sampleAt >= line.startMs && sampleAt < line.endMs && !round.frames.has(sampleAt)) {
      const sample = input.sample(sampleAt)
      const reference = this.notes.find(note => note.startMs <= sampleAt && sampleAt < note.endMs)?.midi
      const raw = sample.midi
      // Phrase practice follows the melody in the singer's octave. Full-song scoring keeps its original samples.
      const midi = Number.isFinite(raw) && Number.isFinite(reference) ? raw + 12 * Math.round((reference - raw) / 12) : raw
      round.lastPoint = { timeMs: sampleAt, midi, reference, voiceActive: sample.voiceActive }
      round.frames.set(sampleAt, round.lastPoint)
      if (now >= (round.feedbackAt || 0)) {
        round.feedbackAt = now + 130
        this.emit()
      }
    }
    if (round.stopAt != null && now - round.stopAt >= input.offsetMs + PITCH_STEP_MS) void this.finish(round)
  }

  onPlaybackEnd(round) {
    if (round.stopAt != null || (this.phase !== 'listening' && this.phase !== 'singing')) return
    if (Math.max(round.lastClock, round.player.currentTime * 1000) < round.line.endMs - 350) {
      this.fail('音频在所选句结束前停止')
      return
    }
    this.stopAtEnd(round)
  }

  stopAtEnd(round) {
    round.stopAt = performance.now()
    try { round.player.pause() } catch {
      this.fail('片段停止失败 · 可以重试')
      return
    }
    if (round.listen) {
      this.select(this.index)
    } else if (!round.timer) {
      round.timer = setInterval(() => this.tick(round), CHECK_INTERVAL_MS)
    }
  }

  async finish(round) {
    clearInterval(round.timer)
    this.phase = 'settling'
    this.emit()
    let recognition
    try { recognition = await round.input.finish() } catch { recognition = { state: 'unavailable' } }
    if (this.round !== round) return
    const count = (this.history.get(this.index)?.count || 0) + 1
    const result = scorePhrase(round.line, this.notes, round.frames, recognition, this.song.category)
    this.history.set(this.index, { ...result, count, position: round.line.endMs, frames: round.frames })
    this.cancel()
    this.phase = 'result'
    this.emit()
  }

  fail(message) {
    this.cancel()
    this.error = message
    this.phase = 'error'
    this.emit()
  }

  cancel() {
    const round = this.round
    this.round = null
    if (!round) return
    if (round.timer != null) clearInterval(round.timer)
    try { round.player?.destroy() } catch (error) { console.warn('释放片段播放失败', error) }
    try { round.input?.close() } catch (error) { console.warn('释放练唱录音失败', error) }
  }

  drawPitch(ctx, chart) {
    const line = this.line
    if (!line || this.pickerPage != null || this.phase === 'countdown' || !this.notes.length) return
    const span = line.endMs - line.startMs
    const keys = this.notes.map(note => note.midi)
    const low = Math.min(...keys) - 2
    const high = Math.max(...keys) + 2
    const x = time => chart.x + (time - line.startMs) * chart.width / span
    const y = midi => chart.y + chart.height * (1 - Math.min(1, Math.max(0, (midi - low) / (high - low))))
    ctx.strokeStyle = '#245638'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (const note of this.notes) {
      ctx.moveTo(x(note.startMs), y(note.midi))
      ctx.lineTo(x(note.endMs), y(note.midi))
    }
    ctx.stroke()
    const round = this.round || this.history.get(this.index)
    if (round?.position >= line.startMs) {
      ctx.strokeStyle = '#347649'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x(round.position), chart.y)
      ctx.lineTo(x(round.position), chart.y + chart.height)
      ctx.stroke()
    }
    if (!round?.frames.size) return
    ctx.fillStyle = '#66dc88'
    ctx.beginPath()
    for (const { timeMs, midi } of round.frames.values()) {
      if (Number.isFinite(midi)) {
        ctx.moveTo(x(timeMs) + 1.6, y(midi))
        ctx.arc(x(timeMs), y(midi), 1.6, 0, 2 * Math.PI)
      }
    }
    ctx.fill()
  }
}
