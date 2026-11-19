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
    MIN_SAMPLE_QUALITY: 95,
    wx: { setStorageSync() { saved = true } },
    AudioContext: class {
      async resume() { throw cardError }
      async close() {}
    }
  })
  page.setData = data => Object.assign(page.data, data)
  let plays = 0
  page.player = { play() { plays++ }, destroy() {} }
  await page.requestMicrophone()
  assert.equal(page.data.practiceOnly, true)
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
  console.log('PASS  伴奏播放、浏览器异步拒绝、全屏恢复和对战断线退出')

  const pitchSource = readFileSync(join(__dirname, '../utils/pitchEngine.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  const getRefNoteAt = (notes, timeMs) => notes.find(note => note.startMs <= timeMs && timeMs < note.endMs)
  const engine = new Function('getRefNoteAt', pitchSource + '\nreturn { calcAccuracyScore, hzToMidi, PITCH_STEP_MS, MIN_SAMPLE_QUALITY };')(getRefNoteAt)
  const intervals = new Map()
  let timerId = 0
  const recording = vm.runInNewContext(source, {
    ...engine, performance, console,
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id },
    clearInterval(id) { intervals.delete(id) }, clearTimeout() {}, cancelAnimationFrame() {},
    wx: { setStorageSync() { throw new Error('unstable samples must not be saved') } }
  })
  recording.setData = update => Object.assign(recording.data, update)
  recording.song = { durationMs: 1000, refNotes: [{ startMs: 0, endMs: 1000, midi: 69 }] }
  recording.captureOffsetMs = 0
  recording.detectPitch = () => 440
  recording.player = { currentTime: 0, destroy() {} }
  recording.drawLoop = () => {} // 完全暂停绘图，采样仍应独立运行。
  recording.beginFollowing()
  for (let ms = 20; ms < 1000; ms += 20) {
    recording.player.currentTime = ms / 1000
    for (const fn of intervals.values()) fn()
  }
  assert.equal(recording.pitchTrack.length, 25)
  assert.equal(engine.calcAccuracyScore(recording.pitchTrack, recording.song.refNotes).sampleQuality, 100)
  assert.equal(engine.calcAccuracyScore(recording.pitchTrack, recording.song.refNotes).score, 100)
  recording.pitchTrack = recording.pitchTrack.filter((_, i) => i % 5)
  recording.finishRecording(true)
  assert.equal(recording.data.phase, 'error')
  assert.match(recording.data.statusText, /采样不稳定/)
  assert.equal(intervals.size, 0)
  console.log('PASS  暂停绘图仍按时采样，缺失采样拒绝计分并清理计时器')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
