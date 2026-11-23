#!/usr/bin/env node
// 生成《晨光小路》的“带歌词版”引导伴奏。
// 与纯音乐版使用完全相同的和弦底轨与固定噪声种子，再叠加按谱面 MIDI 的主旋律，
// 归一化后编码为 Ogg/Opus。两个版本音乐一致，引导版旋律靠前、清晰可辨。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 22050
const DURATION_SECONDS = 30
const BEAT_MS = 600
const assetsDir = path.join(__dirname, '..', '..', 'Karaoke', 'assets')
const sourceDir = path.join(__dirname, '..', 'source')
const guideWav = path.join(sourceDir, 'morning-light-guide.wav')
const guideOgg = path.join(assetsDir, 'morning-light-guide.ogg')
const songDataPath = path.join(__dirname, '..', '..', 'Karaoke', 'utils', 'songData.js')

const songDataSource = fs.readFileSync(songDataPath, 'utf8')
  .replace(/\bexport (const|function)\b/g, '$1')
const { songs } = new Function(songDataSource + '\nreturn { songs };')()
const song = songs.find(item => item.id === 'morning-light')
if (!song || !Array.isArray(song.refNotes) || song.refNotes.length === 0) {
  throw new Error('morning-light 未在 songData.js 中找到有效 refNotes')
}

const baseChords = [
  { root: 48, notes: [60, 64, 67] },
  { root: 43, notes: [59, 62, 67] },
  { root: 45, notes: [57, 60, 64] },
  { root: 41, notes: [57, 60, 65] }
]

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function encodeOgg(wavPath, oggPath) {
  const ffmpeg = process.env.FFMPEG || 'ffmpeg'
  const result = spawnSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', wavPath,
    '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '1',
    oggPath
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('ffmpeg 编码失败: ' + oggPath)
}

function renderGuide() {
  const samples = new Float32Array(SAMPLE_RATE * DURATION_SECONDS)
  const rand = mulberry32(0x51A7) // 与 morning-light-instrumental 的点击噪声同一序列
  const addTone = (startMs, endMs, midi, amplitude, waveform = 'sine') => {
    const start = Math.floor(startMs * SAMPLE_RATE / 1000)
    const end = Math.min(samples.length, Math.floor(endMs * SAMPLE_RATE / 1000))
    const frequency = midiToHz(midi)
    const attack = Math.min(end - start, Math.floor(0.025 * SAMPLE_RATE))
    const release = Math.min(end - start, Math.floor(0.07 * SAMPLE_RATE))
    for (let i = start; i < end; i++) {
      const local = i - start
      const wave = waveform === 'triangle'
        ? 2 * Math.abs(2 * ((frequency * local / SAMPLE_RATE) % 1) - 1) - 1
        : Math.sin(2 * Math.PI * frequency * local / SAMPLE_RATE)
      let gain = amplitude
      if (local < attack) gain *= local / attack
      if (end - i < release) gain *= (end - i) / release
      samples[i] += wave * gain
    }
  }
  const addClick = (timeMs, amplitude) => {
    const start = Math.floor(timeMs * SAMPLE_RATE / 1000)
    const length = Math.floor(0.015 * SAMPLE_RATE)
    for (let i = 0; i < length && start + i < samples.length; i++) {
      samples[start + i] += (rand() * 2 - 1) * amplitude * (1 - i / length)
    }
  }

  for (let beat = 0; beat < 50; beat++) {
    const startMs = beat * BEAT_MS
    const chord = baseChords[Math.floor(beat / 4) % baseChords.length]
    addTone(startMs, startMs + 4 * BEAT_MS, chord.root - 12, 0.05)
    for (const note of chord.notes) addTone(startMs, startMs + 4 * BEAT_MS, note, 0.016)
    addClick(startMs, 0.015)
  }
  for (const note of song.refNotes) {
    addTone(note.startMs, note.endMs, note.midi, 0.13, 'triangle')
    addTone(note.startMs, note.endMs, note.midi + 12, 0.025)
  }

  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  const gain = peak > 0 ? 0.8 / peak : 1
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const fade = Math.min(1, i / SAMPLE_RATE / 0.5, (samples.length - i) / SAMPLE_RATE / 1.2)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * gain * fade)) * 32767), i * 2)
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

  fs.mkdirSync(path.dirname(guideWav), { recursive: true })
  fs.writeFileSync(guideWav, Buffer.concat([header, pcm]))
  encodeOgg(guideWav, guideOgg)
  console.log('Generated', guideOgg)
}

renderGuide()
