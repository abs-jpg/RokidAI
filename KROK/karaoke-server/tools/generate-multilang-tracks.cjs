#!/usr/bin/env node
// 生成英语、日语、韩语三首原创练习伴奏，供多语言曲库分类和下载测试。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 22050
const DURATION_SECONDS = 30
const BEAT_MS = 600

const tracks = [
  {
    id: 'morning-breeze',
    name: 'Morning Breeze',
    category: 'English',
    file: 'morning-breeze.wav',
    transpose: 0,
    phrases: [
      { text: 'Morning breeze is on the road', melody: [60, 62, 64, 65, 64, 62, 60, 59] },
      { text: 'Softly singing as we go', melody: [59, 60, 62, 64, 65, 64, 62, 60] },
      { text: 'Follow every little note', melody: [60, 64, 65, 67, 65, 64, 62, 60] },
      { text: 'Let the happy rhythm flow', melody: [59, 60, 62, 64, 62, 60, 59, 57] }
    ]
  },
  {
    id: 'hikari-no-michi',
    name: '光の小道',
    category: '日本語',
    file: 'hikari-no-michi.wav',
    transpose: 2,
    phrases: [
      { text: '朝の光が道を照らす', melody: [62, 64, 65, 67, 65, 64, 62, 60] },
      { text: '風がそっと歌っている', melody: [60, 62, 64, 65, 64, 62, 60, 59] },
      { text: '小さな声で歩いてく', melody: [62, 65, 67, 69, 67, 65, 64, 62] },
      { text: '明日の空を見上げよう', melody: [60, 62, 64, 65, 64, 62, 60, 59] }
    ]
  },
  {
    id: 'achim-sanchack',
    name: '아침 산책',
    category: '한국어',
    file: 'achim-sanchack.wav',
    transpose: -2,
    phrases: [
      { text: '아침 햇살 길을 비추네', melody: [60, 62, 64, 65, 64, 62, 60, 59] },
      { text: '바람 따라 노래하네', melody: [59, 60, 62, 64, 65, 64, 62, 60] },
      { text: '가벼운 발걸음으로', melody: [60, 64, 65, 67, 65, 64, 62, 60] },
      { text: '오늘도 함께 걸어가', melody: [59, 60, 62, 64, 62, 60, 59, 57] }
    ]
  }
]

const baseChords = [
  { root: 48, notes: [60, 64, 67] },
  { root: 43, notes: [59, 62, 67] },
  { root: 45, notes: [57, 60, 64] },
  { root: 41, notes: [57, 60, 65] }
]

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12)
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

function renderTrack(track, includeGuide = true) {
  const samples = new Float32Array(SAMPLE_RATE * DURATION_SECONDS)
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
      samples[start + i] += (Math.random() * 2 - 1) * amplitude * (1 - i / length)
    }
  }

  for (let beat = 0; beat < 50; beat++) {
    const startMs = beat * BEAT_MS
    const chord = baseChords[Math.floor(beat / 4) % baseChords.length]
    addTone(startMs, startMs + 4 * BEAT_MS, chord.root - 12 + track.transpose, 0.05)
    for (const note of chord.notes) addTone(startMs, startMs + 4 * BEAT_MS, note + track.transpose, 0.016)
    addClick(startMs, 0.015)
  }
  if (includeGuide) {
    for (let p = 0; p < track.phrases.length; p++) {
      const phraseStart = (4 + p * 10) * BEAT_MS
      const melody = track.phrases[p].melody
      melody.forEach((midi, index) => {
        const startMs = phraseStart + index * BEAT_MS
        const lengthMs = index === melody.length - 1 ? BEAT_MS * 2 : BEAT_MS
        addTone(startMs, startMs + lengthMs, midi + track.transpose, 0.11, 'triangle')
        addTone(startMs, startMs + lengthMs, midi + 12 + track.transpose, 0.02)
      })
    }
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
  return Buffer.concat([header, pcm])
}

fs.mkdirSync(path.join(__dirname, '..', 'source'), { recursive: true })
const catalogSongs = []
for (const track of tracks) {
  const guideFile = track.file
  const instrumentalFile = track.file.replace(/\.wav$/i, '-instrumental.wav')
  const guideOgg = guideFile.replace(/\.wav$/i, '.ogg')
  const instrumentalOgg = instrumentalFile.replace(/\.wav$/i, '.ogg')
  const sourceDir = path.join(__dirname, '..', 'source')
  fs.writeFileSync(path.join(sourceDir, guideFile), renderTrack(track, true))
  fs.writeFileSync(path.join(sourceDir, instrumentalFile), renderTrack(track, false))
  encodeOgg(path.join(sourceDir, guideFile), path.join(sourceDir, guideOgg))
  encodeOgg(path.join(sourceDir, instrumentalFile), path.join(sourceDir, instrumentalOgg))
  console.log('Generated', path.join(sourceDir, guideOgg), 'and', path.join(sourceDir, instrumentalOgg))
  catalogSongs.push({
    id: track.id,
    name: track.name,
    artist: 'Rokid Original',
    category: track.category,
    tag: '练习',
    difficulty: 1,
    durationMs: DURATION_SECONDS * 1000,
    chartVersion: 1,
        scoringVersion: 5,
    audioSource: `/source/${guideOgg}`,
    instrumentalSource: `/source/${instrumentalOgg}`,
    lyrics: track.phrases.map((phrase, index) => {
      const startMs = (4 + index * 10) * BEAT_MS
      return { text: phrase.text, startMs, endMs: startMs + 9 * BEAT_MS }
    }),
    refNotes: track.phrases.flatMap((phrase, phraseIndex) => {
      const phraseStart = (4 + phraseIndex * 10) * BEAT_MS
      return phrase.melody.map((midi, noteIndex) => {
        const startMs = phraseStart + noteIndex * BEAT_MS
        return {
          midi: midi + track.transpose,
          startMs,
          endMs: startMs + (noteIndex === phrase.melody.length - 1 ? 2 : 1) * BEAT_MS
        }
      })
    })
  })
}
fs.writeFileSync(
  path.join(__dirname, '..', 'catalog-extra.json'),
  JSON.stringify({ songs: catalogSongs }, null, 2)
)
console.log('Generated catalog-extra.json')
