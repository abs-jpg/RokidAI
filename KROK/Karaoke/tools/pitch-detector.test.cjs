#!/usr/bin/env node
// 无需真机即可校验基频检测：直接加载 utils/pitchEngine.js 的源码并喂合成波形。
const fs = require('node:fs')
const path = require('node:path')

const sourcePath = path.join(__dirname, '..', 'utils', 'pitchEngine.js')
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(
    "import { getRefNoteAt } from './songData.js'",
    'const getRefNoteAt = (notes, timeMs) => notes.find(n => n.startMs <= timeMs && timeMs < n.endMs)'
  )
  .replace(/\bexport (function|const)\b/g, '$1')

const engine = new Function(source + '\nreturn { createPitchDetector, createVoiceActivityDetector, hzToMidi, calcAccuracyScore, calcLiveScoreIncrement, calcVocalCompleteness, countExpectedFrames, PITCH_STEP_MS };')()

const SAMPLE_RATE = 48000
const FFT_SIZE = 4096

function makeAnalyser(sampleAt) {
  return {
    fftSize: FFT_SIZE,
    context: { sampleRate: SAMPLE_RATE },
    getFloatTimeDomainData(buffer) {
      for (let i = 0; i < buffer.length; i++) buffer[i] = sampleAt(i)
    }
  }
}

function sine(freq, amp = 0.2, noise = 0, harmonics = []) {
  const samples = []
  for (let i = 0; i < 1 << 20; i++) {
    const t = i / SAMPLE_RATE
    let value = amp * Math.sin(2 * Math.PI * freq * t)
    for (const h of harmonics) value += h.amp * Math.sin(2 * Math.PI * freq * h.order * t)
    if (noise) value += noise * (Math.random() * 2 - 1)
    samples.push(value)
  }
  let cursor = 0
  return () => samples[cursor++ % samples.length]
}

function detect(sampleAt) {
  return engine.createPitchDetector(makeAnalyser(sampleAt))()
}

const cases = [
  { name: '440 Hz 准音', freq: 440, tolerance: 0.02, signal: sine(440) },
  { name: '466.16 Hz 偏一个半音', freq: 440 * 2 ** (1 / 12), tolerance: 0.02, signal: sine(440 * 2 ** (1 / 12)) },
  { name: '196 Hz 低音', freq: 196, tolerance: 0.02, signal: sine(196) },
  { name: '弱声 262 Hz', freq: 261.63, tolerance: 0.03, signal: sine(261.63, 0.008) },
  { name: '带噪 440 Hz', freq: 440, tolerance: 0.03, signal: sine(440, 0.2, 0.05) },
  { name: '二次泛音强的 262 Hz', freq: 261.63, tolerance: 0.03, signal: sine(261.63, 0.08, 0, [{ order: 2, amp: 0.12 }]) }
]

let failed = 0
for (const item of cases) {
  const measured = detect(item.signal)
  const error = measured == null ? Infinity : Math.abs(measured - item.freq) / item.freq
  const ok = error <= item.tolerance
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(20)} expected=${item.freq.toFixed(2)}Hz` +
    ` measured=${measured == null ? 'null' : measured.toFixed(2) + 'Hz'}`
  )
}

const silence = detect(() => 0)
const silenceOk = silence === null
if (!silenceOk) failed++
console.log(`${silenceOk ? 'PASS' : 'FAIL'}  静音                 expected=null measured=${silence}`)

{
  const frequencies = [55, 65.41, 73.42, 98]
  const measured = frequencies.map(freq => {
    const signal = index => {
      const angle = 2 * Math.PI * freq * index / SAMPLE_RATE
      return 0.12 * Math.sin(angle) + 0.10 * Math.sin(2 * angle)
    }
    return engine.createPitchDetector(makeAnalyser(signal), 55)()
  })
  const standard = detect(index => 0.2 * Math.sin(2 * Math.PI * 65.41 * index / SAMPLE_RATE))
  const ok = standard === null && measured.every((hz, index) =>
    hz != null && Math.abs(hz - frequencies[index]) / frequencies[index] < 0.02)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  55 Hz 下限检测        measured=${measured.map(hz => hz?.toFixed(2) ?? 'null').join(', ')}`)
}

{
  const frequencies = [43.65, 49, 1046.5, 1174.66]
  const measured = frequencies.map(freq => {
    const signal = index => 0.15 * Math.sin(2 * Math.PI * freq * index / SAMPLE_RATE)
    return engine.createPitchDetector(makeAnalyser(signal), 40, 1200)()
  })
  const ok = measured.every((hz, index) => hz != null && Math.abs(hz - frequencies[index]) / frequencies[index] < 0.02)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  单人曲库音域           measured=${measured.map(hz => hz?.toFixed(2) ?? 'null').join(', ')}`)
}

const noise = detect(() => 0.05 * (Math.random() * 2 - 1))
const noiseOk = noise === null
if (!noiseOk) failed++
console.log(`${noiseOk ? 'PASS' : 'FAIL'}  白噪声               expected=null measured=${noise}`)

{
  const levels = [0.1, 0, -0.1, 0]
  const active = engine.createVoiceActivityDetector({
    fftSize: 4,
    getFloatTimeDomainData(buffer) { buffer.set(levels) }
  })
  levels.fill(0)
  const silent = active()
  levels[0] = 0.1
  levels[2] = -0.1
  const voiced = active()
  const ok = silent === false && voiced === true
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  人声活动检测         silent=${silent} voiced=${voiced}`)
}

{
  const g440 = sine(440)
  const g880 = sine(880)
  let active = g440
  const detector = engine.createPitchDetector(makeAnalyser(() => active()))
  const first = detector()
  const steady = detector()
  active = g880
  const held = detector()
  const moved = detector()
  active = g440
  const heldDown = detector()
  const back = detector()
  const ok = Math.abs(first - 440) / 440 < 0.03 &&
    Math.abs(steady - 440) / 440 < 0.03 &&
    Math.abs(held - 440) / 440 < 0.03 &&
    Math.abs(moved - 880) / 880 < 0.03 &&
    Math.abs(heldDown - 880) / 880 < 0.03 &&
    Math.abs(back - 440) / 440 < 0.03
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  换八度双向两帧确认   ` +
    `up=${held?.toFixed(2)}->${moved?.toFixed(2)} down=${heldDown?.toFixed(2)}->${back?.toFixed(2)}`
  )
}

{
  const refNotes = [
    { midi: 69, startMs: 0, endMs: 1000 },
    { midi: 70, startMs: 1000, endMs: 2000 }
  ]
  const samples = []
  for (let timeMs = 20; timeMs < 2000; timeMs += engine.PITCH_STEP_MS) {
    samples.push({ timeMs, midi: timeMs < 1000 ? 69 : 70 })
  }
  const perfect = engine.calcAccuracyScore(samples, refNotes)
  const shifted = engine.calcAccuracyScore(samples.map(s => ({ ...s, midi: s.midi + 1 })), refNotes)
  const empty = engine.calcAccuracyScore([], refNotes)
  const skipped = engine.calcAccuracyScore(samples.filter((_, i) => i % 5 !== 4), refNotes)
  const halfSong = engine.calcAccuracyScore(samples.slice(0, samples.length / 2), refNotes)
  const silence = engine.calcAccuracyScore(samples.map(sample => ({ ...sample, midi: null })), refNotes)
  const voiceWithoutPitch = engine.calcAccuracyScore(
    samples.map(sample => ({ ...sample, midi: null, voiceActive: true })),
    refNotes
  )
  const lyricCompleteness = engine.calcVocalCompleteness(samples, [
    { text: '任意标准歌词', startMs: 0, endMs: 2000 }
  ])
  const silentLyricCompleteness = engine.calcVocalCompleteness(
    samples.map(sample => ({ ...sample, midi: null })),
    [{ text: '任意标准歌词', startMs: 0, endMs: 2000 }]
  )
  const expectedFrames = engine.countExpectedFrames(refNotes)
  const livePerfect = samples.reduce((sum, sample) => {
    const ref = refNotes.find(note => note.startMs <= sample.timeMs && sample.timeMs < note.endMs)
    return sum + engine.calcLiveScoreIncrement(sample.midi, ref.midi, expectedFrames)
  }, 0)
  const liveShifted = samples.reduce((sum, sample) => {
    const ref = refNotes.find(note => note.startMs <= sample.timeMs && sample.timeMs < note.endMs)
    return sum + engine.calcLiveScoreIncrement(sample.midi + 1, ref.midi, expectedFrames)
  }, 0)
  const ok = perfect.score === 100 && perfect.accuracy === 100 && perfect.coverage === 100 &&
    shifted.accuracy === 95 && shifted.coverage === 100 && shifted.score === 99 &&
    empty.score === 0 && empty.coverage === 0 &&
    skipped.score === 84 && skipped.sampleQuality === 80 &&
    halfSong.score === 60 && halfSong.coverage === 50 &&
    silence.score === 0 && silence.sampleQuality === 100 &&
    voiceWithoutPitch.score === 80 && voiceWithoutPitch.coverage === 100 &&
    lyricCompleteness === 100 && silentLyricCompleteness === 0 &&
    Math.round(livePerfect + 80) === 100 && Math.round(liveShifted + 80) === 99
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  评分：完整度 80% + 音准 20% ` +
    `perfect=${perfect.score} shifted=${shifted.score} half=${halfSong.score} ` +
    `live=${Math.round(livePerfect + 80)}/${Math.round(liveShifted + 80)}`
  )
}

console.log(failed === 0 ? '\nAll pitch detector checks passed.' : `\n${failed} pitch detector check(s) failed.`)
process.exitCode = failed === 0 ? 0 : 1
