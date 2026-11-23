#!/usr/bin/env node
// 生成一首 30 秒原创练习伴奏（WAV），用于验证在线曲库下载和缓存流程。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 44100
const DURATION_SECONDS = 30
const BEAT_MS = 600
const outputPath = path.join(__dirname, '..', 'source', 'afternoon-practice.wav')

const samples = new Float32Array(SAMPLE_RATE * DURATION_SECONDS)

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function addTone(startMs, endMs, midi, amplitude, waveform = 'sine') {
  const start = Math.floor(startMs * SAMPLE_RATE / 1000)
  const end = Math.min(samples.length, Math.floor(endMs * SAMPLE_RATE / 1000))
  const frequency = midiToHz(midi)
  const attack = Math.min(end - start, Math.floor(0.03 * SAMPLE_RATE))
  const release = Math.min(end - start, Math.floor(0.08 * SAMPLE_RATE))
  for (let i = start; i < end; i++) {
    const local = i - start
    const phase = 2 * Math.PI * frequency * local / SAMPLE_RATE
    const wave = waveform === 'triangle'
      ? 2 * Math.abs(2 * ((frequency * local / SAMPLE_RATE) % 1) - 1) - 1
      : Math.sin(phase)
    let gain = amplitude
    if (local < attack) gain *= local / attack
    if (end - i < release) gain *= (end - i) / release
    samples[i] += wave * gain
  }
}

function addClick(timeMs, amplitude) {
  const start = Math.floor(timeMs * SAMPLE_RATE / 1000)
  const length = Math.floor(0.018 * SAMPLE_RATE)
  for (let i = 0; i < length && start + i < samples.length; i++) {
    samples[start + i] += (Math.random() * 2 - 1) * amplitude * (1 - i / length)
  }
}

const phrases = [
  { text: '午后阳光落在窗边', melody: [60, 62, 64, 65, 64, 62, 60, 59] },
  { text: '风把心事吹得很远', melody: [59, 60, 62, 64, 65, 64, 62, 60] },
  { text: '我跟着节拍轻轻唱', melody: [60, 64, 65, 67, 65, 64, 62, 60] },
  { text: '把这一刻留在心间', melody: [59, 60, 62, 64, 62, 60, 59, 57] }
]
const introBeats = 4
const phraseBeats = 10
const chords = [
  { root: 48, notes: [60, 64, 67] },
  { root: 43, notes: [59, 62, 67] },
  { root: 45, notes: [57, 60, 64] },
  { root: 41, notes: [57, 60, 65] }
]

for (let beat = 0; beat < 50; beat++) {
  const startMs = beat * BEAT_MS
  const chord = chords[Math.floor(beat / 4) % chords.length]
  addTone(startMs, startMs + 4 * BEAT_MS, chord.root - 12, 0.055)
  for (const note of chord.notes) addTone(startMs, startMs + 4 * BEAT_MS, note, 0.018)
  addClick(startMs, 0.018)
  if (beat % 2 === 1) addClick(startMs, 0.01)
}

for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
  const phrase = phrases[phraseIndex]
  const phraseStart = (introBeats + phraseIndex * phraseBeats) * BEAT_MS
  phrase.melody.forEach((midi, noteIndex) => {
    const startMs = phraseStart + noteIndex * BEAT_MS
    const lengthMs = noteIndex === phrase.melody.length - 1 ? BEAT_MS * 2 : BEAT_MS
    addTone(startMs, startMs + lengthMs, midi, 0.12, 'triangle')
    addTone(startMs, startMs + lengthMs, midi + 12, 0.025)
  })
}

let peak = 0
for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
const gain = peak > 0 ? 0.82 / peak : 1
const pcm = Buffer.alloc(samples.length * 2)
for (let i = 0; i < samples.length; i++) {
  const fade = Math.min(1, i / SAMPLE_RATE / 0.5, (samples.length - i) / SAMPLE_RATE / 1.2)
  const value = Math.max(-1, Math.min(1, samples[i] * gain * fade))
  pcm.writeInt16LE(Math.round(value * 32767), i * 2)
}

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(SAMPLE_RATE, 24)
header.writeUInt32LE(SAMPLE_RATE * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, Buffer.concat([header, pcm]))
const oggPath = outputPath.replace(/\.wav$/i, '.ogg')
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const encoded = spawnSync(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-i', outputPath,
  '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '1',
  oggPath
], { stdio: 'inherit' })
if (encoded.error) throw encoded.error
if (encoded.status !== 0) throw new Error('ffmpeg 编码失败: ' + oggPath)
console.log('Generated', oggPath, (pcm.length + 44) + ' bytes WAV source')
