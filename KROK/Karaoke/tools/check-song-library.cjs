#!/usr/bin/env node
// 曲库自检：新增歌曲后运行，检查元数据、时间轴和伴奏资源是否齐全。
const fs = require('node:fs')
const path = require('node:path')

const karaokeRoot = path.join(__dirname, '..')
const sourcePath = path.join(karaokeRoot, 'utils', 'songData.js')
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(/\bexport (const|function)\b/g, '$1')

const library = new Function(source + '\nreturn { songs };')()
const errors = []
const ids = new Set()

for (const song of library.songs) {
  const label = song.id || '(missing id)'
  if (!song.id || typeof song.id !== 'string') errors.push(`${label}: id 为空`)
  if (ids.has(song.id)) errors.push(`${label}: id 重复`)
  ids.add(song.id)
  if (!song.name) errors.push(`${label}: name 为空`)
  if (!Number.isInteger(song.durationMs) || song.durationMs <= 0) errors.push(`${label}: durationMs 无效`)
  if (!Number.isInteger(song.chartVersion) || song.chartVersion < 1) errors.push(`${label}: chartVersion 无效`)
  if (!Array.isArray(song.lyrics) || song.lyrics.length === 0) errors.push(`${label}: lyrics 为空`)
  if (!Array.isArray(song.refNotes) || song.refNotes.length === 0) errors.push(`${label}: refNotes 为空`)

  if (song.accompaniment) {
    const assetPath = path.join(karaokeRoot, song.accompaniment.replace(/^\//, ''))
    if (!fs.existsSync(assetPath)) errors.push(`${label}: 伴奏不存在 ${song.accompaniment}`)
  }

  for (const [index, lyric] of (song.lyrics || []).entries()) {
    if (!lyric.text) errors.push(`${label}: 歌词 ${index} 文本为空`)
    if (!(lyric.startMs >= 0 && lyric.endMs > lyric.startMs && lyric.endMs <= song.durationMs)) {
      errors.push(`${label}: 歌词 ${index} 时间范围无效`)
    }
  }

  for (const [index, note] of (song.refNotes || []).entries()) {
    if (!Number.isFinite(note.midi) || note.midi < 0 || note.midi > 127) {
      errors.push(`${label}: 音符 ${index} MIDI 无效`)
    }
    if (!(note.startMs >= 0 && note.endMs > note.startMs && note.endMs <= song.durationMs)) {
      errors.push(`${label}: 音符 ${index} 时间范围无效`)
    }
  }
}

if (errors.length) {
  console.error(errors.map(error => `FAIL  ${error}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`PASS  曲库 ${library.songs.length} 首歌曲检查通过`)
  for (const song of library.songs) {
    console.log(`      ${song.name} (${song.id}) · ${song.durationMs}ms · ${song.refNotes.length} 音符`)
  }
}
