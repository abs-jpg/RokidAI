const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../pages/record/record.ink'), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'page =')

async function main() {
  let tick
  let saved = false
  let backCount = 0
  let micConnected = false
  let trackStopped = false
  const cardError = Object.assign(new Error('AudioContext.resume is unavailable while InkView target is _current'), { name: 'InvalidStateError' })
  const page = vm.runInNewContext(source, {
    performance, console: { error() {} },
    setInterval(fn) { tick = fn; return 1 },
    clearInterval() {},
    setTimeout() { return 2 },
    clearTimeout() {},
    requestAnimationFrame() { return 3 },
    cancelAnimationFrame() {},
    encodePitchTrack: samples => samples,
    calcAccuracyScore: () => ({ sampleQuality: 100 }),
    countExpectedFrames: () => 25,
    calcLiveScoreIncrement: () => 0,
    getLyricAt: (lyrics, timeMs) => lyrics.find(line => line.startMs <= timeMs && timeMs < line.endMs),
    getRefNoteAt: (notes, timeMs) => notes.find(note => note.startMs <= timeMs && timeMs < note.endMs),
    wx: {
      setStorageSync() { saved = true },
      navigateBack() { backCount++ }
    },
    AudioContext: class {
      createMediaStreamSource() {
        return { connect() { micConnected = true }, disconnect() {} }
      }
      createAnalyser() { return {} }
      async resume() {
        assert.equal(micConnected, true, '应先连接采集流与分析器，再启动音频上下文')
        throw cardError
      }
      async close() {}
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() { return { getTracks: () => [{ stop() { trackStopped = true } }] } }
      }
    }
  })
  page.setData = data => Object.assign(page.data, data)
  let plays = 0
  page.player = { play() { plays++ }, destroy() {} }
  page.song = {
    durationMs: 6000,
    refNotes: [],
    lyrics: [
      { text: '第一句歌词', startMs: 1000, endMs: 2000 },
      { text: '第二句歌词', startMs: 4000, endMs: 5000 }
    ]
  }
  assert.equal(page.getDisplayLyric(0), '第一句歌词')
  assert.equal(page.getDisplayLyric(2500), '第二句歌词')
  assert.equal(page.getDisplayLyric(4500), '第二句歌词')
  const firstPair = page.getLyricPair(1500)
  const lastPair = page.getLyricPair(4500)
  assert.equal(firstPair.current, '第一句歌词')
  assert.equal(firstPair.next, '第二句歌词')
  assert.equal(lastPair.current, '第二句歌词')
  assert.equal(lastPair.next, '')

  const shortLyrics = page.song.lyrics
  const longCurrent = '当前歌词完整显示'.repeat(3) + '（句尾）'
  const longNext = '下一句歌词完整显示'.repeat(4) + '（句尾）'
  page.song.lyrics = [
    { text: longCurrent, startMs: 1000, endMs: 2000 },
    { text: longNext, startMs: 4000, endMs: 5000 }
  ]
  page.getElapsedMs = () => 1500
  page.updateRecording()
  assert.equal(page.data.currentLyric, longCurrent)
  assert.equal(page.data.nextLyric, longNext)
  assert.ok(page.data.currentLyricFontSize < 20, '单人长歌词应缩放')
  assert.ok(page.data.nextLyricFontSize < 14, '单人长预告句应缩放')
  const soloCurrentSize = page.data.currentLyricFontSize
  const soloNextSize = page.data.nextLyricFontSize

  page.isBattle = true
  page.updateRecording()
  assert.equal(page.data.currentLyric, longCurrent)
  assert.equal(page.data.nextLyric, longNext)
  assert.ok(page.data.currentLyricFontSize < soloCurrentSize, '联机应使用更窄的歌词区')
  assert.ok(page.data.nextLyricFontSize <= soloNextSize)
  page.song.lyrics = shortLyrics
  page.updateRecording()
  assert.equal(page.data.currentLyricFontSize, 20, '回到短歌词时恢复原字号')
  assert.equal(page.data.nextLyricFontSize, 14)
  page.isBattle = false

  page.asrLineStartMs = 1000
  page.asrLineText = '上一句屏幕文本'
  page.asrCaptureEnabled = true
  page.recognizedFinalText = '后台保存的完整识别文本'
  page.data.asrDisplayText = '上一句屏幕文本'
  page.data.asrDisplayText = '上一句屏幕文本'
  page.data.asrScrollLeft = 40
  page.getElapsedMs = () => 2500
  page.updateRecording()
  assert.equal(page.data.asrDisplayText, '上一句屏幕文本', '歌词换行或进入间奏时 ASR 不能清空')
  assert.equal(page.data.asrScrollLeft, 40, '歌词换行不能重置滚动位置')
  assert.equal(page.data.asrDisplayText, '上一句屏幕文本')
  assert.equal(page.recognizedFinalText, '后台保存的完整识别文本')
  page.getElapsedMs = () => 4500
  page.updateRecording()
  assert.equal(page.data.asrDisplayText, '上一句屏幕文本', '进入下一句后 ASR 文本继续保留')
  page.song.lyrics = [
    { text: '重复歌词', startMs: 1000, endMs: 2000 },
    { text: '重复歌词', startMs: 4000, endMs: 5000 }
  ]
  page.displayedLyricStartMs = 1000
  page.asrLineStartMs = 1000
  page.data.currentLyric = '重复歌词'
  page.data.asrDisplayText = '上一行 ASR'
  page.asrLineText = '上一行 ASR'
  page.asrCaptureEnabled = true
  page.getElapsedMs = () => 4500
  page.updateRecording()
  assert.equal(page.data.asrDisplayText, '上一行 ASR', '连续歌词文字相同时也必须保持 ASR')
  assert.equal(page.asrLineText, '上一行 ASR')
  page.getElapsedMs = () => 0
  page.data.phase = 'recording'
  page.onKeyUp({ code: 'Backspace', preventDefault() {} })
  assert.equal(backCount, 1, '双击镜腿返回键必须离开录音页')
  page.data.phase = 'loading'
  page.player = { play() { plays++ }, destroy() {} }
  await page.requestMicrophone()
  assert.equal(page.data.practiceOnly, true)
  assert.equal(trackStopped, true, '采集链路启动失败时必须释放麦克风')
  assert.match(page.practiceReason, /双击展开全屏可显示音准/)
  tick()
  tick()
  tick()
  assert.equal(plays, 1, 'blocked mic must still allow an attempt to play the backing track')
  page.beginFollowing()
  page.finishRecording(true)
  assert.equal(page.data.phase, 'practiceDone')
  assert.equal(saved, false)

  page.player = {
    async play() { throw Object.assign(new Error('autoplay rejected'), { name: 'NotAllowedError' }) },
    destroy() {}
  }
  await page.playAccompaniment()
  assert.equal(page.data.phase, 'error')
  assert.match(page.data.statusText, /浏览器阻止播放/)

  page.data.practiceOnly = true
  page.visible = true
  page.song = { id: 'test' }
  let prepared = false
  page.prepareAudio = () => { prepared = true }
  page.onTargetChanged('_blank', '_current')
  assert.equal(prepared, true)

  page.isBattle = true
  page.data.phase = 'recording'
  page.data.practiceOnly = false
  page.pitchTrack = []
  page.sendRound = () => true
  page.finishRecording(true)
  assert.equal(page.data.phase, 'battleWaiting')
  page.handleBattleMessage({ type: 'socket.close' })
  assert.equal(page.data.phase, 'battleDone')
  assert.equal(page.data.statusText, '联机已断开')
  page.leaving = false
  const resultBackCount = backCount
  page.onConfirm()
  page.onConfirm()
  assert.equal(backCount, resultBackCount + 1, '结算页单次确认只能返回一次')
  console.log('PASS  伴奏播放、浏览器异步拒绝、全屏恢复和对战断线退出')

  const pitchSource = readFileSync(join(__dirname, '../utils/pitchEngine.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  const getRefNoteAt = (notes, timeMs) => notes.find(note => note.startMs <= timeMs && timeMs < note.endMs)
  const engine = new Function('getRefNoteAt', pitchSource + '\nreturn { createPitchDetector, calcAccuracyScore, calcLiveScoreIncrement, countExpectedFrames, hzToMidi, PITCH_STEP_MS, SCORING_VERSION };')(getRefNoteAt)
  const intervals = new Map()
  let timerId = 0
  let partialSaved = false
  let resultOpened = false
  let savedRecording
  let nextFrame
  let pitchDot
  let pitchFeedback
  const canvas = {
    clearRect() { pitchDot = null; pitchFeedback = null }, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, flush() {},
    arc(x, y) { pitchDot = { x, y } },
    fillText(text, x, y) { pitchFeedback = { text, x, y } }
  }
  const recording = vm.runInNewContext(source, {
    ...engine, getRefNoteAt, performance, console,
    getLyricAt: (lyrics, timeMs) => lyrics.find(line => line.startMs <= timeMs && timeMs < line.endMs),
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id },
    clearInterval(id) { intervals.delete(id) }, clearTimeout() {}, cancelAnimationFrame() {},
    setTimeout() { return 2 },
    requestAnimationFrame(fn) { nextFrame = fn; return 1 },
    wx: {
      createCanvasContext() { return canvas },
      setStorageSync(key, value) { partialSaved = true; savedRecording = value },
      navigateTo() { resultOpened = true }
    }
  })
  recording.setData = update => Object.assign(recording.data, update)
  recording.song = { durationMs: 1000, refNotes: [{ startMs: 0, endMs: 1000, midi: 69 }] }
  recording.captureOffsetMs = 0
  recording.detectPitch = () => 440
  recording.player = { currentTime: 0, destroy() {} }
  const drawLoop = recording.drawLoop
  recording.drawLoop = () => {} // 完全暂停绘图，采样仍应独立运行。
  recording.beginFollowing()
  for (let ms = 20; ms < 1000; ms += 20) {
    recording.player.currentTime = ms / 1000
    for (const fn of intervals.values()) fn()
  }
  assert.equal(recording.pitchTrack.length, 25)
  assert.equal(recording.selfPitch.points.length, 50, '实时显示应以评分两倍的频率采样')
  assert.equal(engine.calcAccuracyScore(recording.pitchTrack, recording.song.refNotes).sampleQuality, 100)
  assert.equal(engine.calcAccuracyScore(recording.pitchTrack, recording.song.refNotes).score, 100)
  recording.pitchTrack = recording.pitchTrack.filter((_, i) => i % 5)
  recording.finishRecording(true)
  assert.equal(partialSaved, true, '只使用实际记录到的采样继续评分')
  assert.equal(resultOpened, true)
  assert.equal(recording.data.phase, 'settling')
  assert.equal(intervals.size, 0)
  console.log('PASS  暂停绘图仍按时采样，缺失采样按实际记录评分并清理计时器')

  let voiceHz = 440
  recording.minMidi = 60
  recording.maxMidi = 80
  recording.detectPitch = () => voiceHz
  recording.player = { currentTime: 0, destroy() {} }
  recording.beginFollowing()
  const sing = (timeMs, midi) => {
    voiceHz = midi == null ? null : 440 * 2 ** ((midi - 69) / 12)
    recording.player.currentTime = timeMs / 1000
    recording.samplePitch()
  }
  sing(20, 57)
  recording.drawPitch(canvas, 448, 180, 20, recording.selfPitch)
  const referenceY = 8 + (80 - 69) * (180 - 16) / (80 - 60)
  assert.equal(pitchDot.y, referenceY, '第一拍的低八度圆点立即绘制在参考线上')
  assert.deepEqual(pitchFeedback, { text: 'Perfect', x: pitchDot.x, y: pitchDot.y - 8 }, '提示随圆点绘制在上方')
  sing(40, 69)
  assert.equal(recording.data.selfOctaveShift, 0, '单次低八度识别不能触发音区切换')
  for (let timeMs = 60; timeMs <= 200; timeMs += 20) sing(timeMs, 58)
  assert.equal(recording.data.selfOctaveShift, 12)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 200) - 70) < 0.001, '抬高一个八度后仍应显示一个半音的偏差')
  assert.ok(Math.abs(recording.pitchTrack.at(-1).midi - 58) < 0.001, '评分应记录原始音高')
  assert.equal(recording.getPitchDotMidi(recording.selfPitch, 280), null, '过期采样不应停留在屏幕上')
  sing(220, 58.6)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 210) - 70.3) < 0.001, '绿点在识别帧之间连续移动')
  sing(240, null)
  assert.equal(recording.getPitchDotMidi(recording.selfPitch, 240), null, '停唱后隐藏绿点')
  sing(260, 69)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 260) - 69) < 0.001, '回到原音区的第一帧就不应过度抬高')
  for (let timeMs = 280; timeMs <= 400; timeMs += 20) sing(timeMs, 69)
  assert.equal(recording.data.selfOctaveShift, 0, '回到参考音区后应解除偏移')
  sing(420, 53)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 420) - 65) < 0.001, '音高偏离超过旧阈值时仍抬到画面内，并留下半音偏差')
  recording.drawPitch(canvas, 448, 180, 444, recording.selfPitch)
  assert.equal(pitchFeedback.text, 'Good', '圆点超过宽松范围时显示 Good')
  sing(460, 45)
  const lowSample = recording.pitchTrack.at(-1)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 460) - 69) < 0.001, '低两个八度时显示到参考线附近')
  recording.drawPitch(canvas, 448, 180, 484, recording.selfPitch)
  assert.equal(pitchFeedback.text, 'Perfect', '提示根据圆点所在的显示音区判断')
  assert.ok(Math.abs(lowSample.midi - 45) < 0.001)
  assert.equal(engine.calcAccuracyScore([lowSample], recording.song.refNotes).accuracy, 0, '显示对齐不抵消评分中的两个八度偏差')
  recording.song.refNotes[0].endMs = 480
  sing(480, 45)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 480) - 69) < 0.001, '参考线间隙沿用当前显示音区')
  recording.drawPitch(canvas, 448, 180, 504, recording.selfPitch)
  assert.equal(pitchFeedback.text, 'Good', '没有参考音符时跟随可见圆点显示 Good')
  recording.song.refNotes[0].endMs = 1000
  sing(500, 50.9)
  sing(520, 51.1)
  assert.ok(Math.abs(recording.getPitchDotMidi(recording.selfPitch, 520) - 75.1) < 0.001, '八度交界处的轻微波动不能让圆点跳一个八度')
  sing(560, 70.75)
  recording.drawPitch(canvas, 448, 180, 584, recording.selfPitch)
  assert.equal(pitchFeedback.text, 'Perfect', '偏差超过一个半音但仍在宽松范围内')
  recording.releaseAudio()
  console.log('PASS  单人音高显示高频采样、八度稳定切换、保留音准偏差和停唱隐藏')

  recording.drawLoop = drawLoop
  recording.minMidi = 55
  recording.maxMidi = 80
  let amplitude = 0.12
  recording.detectPitch = engine.createPitchDetector({
    fftSize: 4096,
    context: { sampleRate: 48000 },
    getFloatTimeDomainData(buffer) {
      for (let i = 0; i < buffer.length; i++) buffer[i] = amplitude * Math.sin(2 * Math.PI * 440 * i / 48000)
    }
  }, 55)
  recording.player = { currentTime: 0, destroy() {} }
  recording.beginFollowing()
  nextFrame()
  recording.player.currentTime = 0.1
  nextFrame() // 播放位置可能先更新，采样稍后才到。
  assert.equal(pitchDot, null)
  recording.samplePitch()
  nextFrame()
  assert.ok(Number.isFinite(pitchDot?.x) && Number.isFinite(pitchDot?.y), '播放进度未再变化时，新采集的音高也必须绘制')
  amplitude = 0
  recording.player.currentTime = 0.2
  recording.samplePitch()
  nextFrame()
  assert.equal(pitchDot, null, '静音不能沿用上一个过期的圆点')
  assert.equal(pitchFeedback, null, '停唱后文字与圆点同时消失')
  recording.releaseAudio()
  console.log('PASS  播放时钟以 100ms 更新时，真实波形采样仍可绘制和隐藏音准圆点')

  const finalOrder = []
  recording.song = {
    id: 'last-lyric', durationMs: 2000,
    lyrics: [{ text: '最后一句', endMs: 1400 }],
    refNotes: [{ midi: 69, startMs: 1000, endMs: 1500 }]
  }
  recording.player = { currentTime: 1.45, destroy() {} }
  assert.equal(recording.reachedSingingEnd(), false, '参考音符没结束，仍算提前结束')
  recording.player.currentTime = 1.5
  assert.equal(recording.reachedSingingEnd(), true, '唱完最后一句和最后一个参考音即可结束')
  recording.beginFollowing()
  recording.recognizedFinalText = '已经确认的前一句'
  recording.asrPendingDisplayText = recording.recognizedFinalText
  recording.recognitionFeed = {
    queue: Promise.resolve().then(() => finalOrder.push('write')),
    recorder: {
      state: 'recording',
      stop() { this.state = 'inactive'; this.onstop() }
    },
    writer: {
      async close() {
        finalOrder.push('close')
        recording.asrPendingDisplayText = '已经确认的前一句 最后一句'
      },
      async abort() {}
    }
  }
  recording.onConfirm()
  assert.equal(recording.data.phase, 'finalizing')
  await new Promise(setImmediate)
  assert.deepEqual(finalOrder, ['write', 'close'])
  assert.equal(savedRecording.recognizedText, '已经确认的前一句 最后一句')
  recording.recognizedFinalText = '后台最终结果'
  recording.asrPendingDisplayText = '后台最终结果最后临时结果'
  assert.equal(recording.getRecordingRecognitionText(), '后台最终结果最后临时结果')
  recording.recognizedFinalText = ''
  recording.asrPendingDisplayText = ''
  recording.data.asrDisplayText = '屏幕上仍在显示的识别内容'
  assert.equal(recording.getRecordingRecognitionText(), '屏幕上仍在显示的识别内容')
  assert.equal(savedRecording.completed, true)
  assert.equal(recording.data.phase, 'settling')
  recording.song.lyrics = [{ text: '最后一句', startMs: 1000, endMs: 2000 }]
  recording.getElapsedMs = () => 1450
  assert.equal(recording.reachedSingingEnd(), false, '尾句仍在唱时不能记为完整演唱')
  recording.getElapsedMs = () => 1550
  assert.equal(recording.reachedSingingEnd(), true, '字幕留到曲终时，尾奏期间可以提交已唱完的成绩')
  console.log('PASS  唱完尾句可以直接结束，最后一个 ASR 分片进入评分与上传的数据')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
