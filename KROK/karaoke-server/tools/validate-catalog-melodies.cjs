#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog-extra.json'), 'utf8'))
assert.ok(Array.isArray(catalog.songs) && catalog.songs.length > 0, 'catalog-extra.json 没有歌曲')

for (const song of catalog.songs) {
  assert.equal(song.melodyFile, `melodies/${song.id}.json`, `${song.id} 的 melodyFile 不符合约定`)
  const melodyPath = path.join(root, song.melodyFile)
  assert.ok(fs.existsSync(melodyPath), `${song.id} 缺少旋律文件`)
  const melody = JSON.parse(fs.readFileSync(melodyPath, 'utf8'))
  assert.equal(melody.songId, song.id, `${song.id} 的旋律 songId 不一致`)
  assert.equal(Number(melody.chartVersion), Number(song.chartVersion), `${song.id} 的谱面版本不一致`)
  assert.ok(Array.isArray(melody.notes) && melody.notes.length > 50, `${song.id} 的旋律过少`)
  assert.ok(melody.lyricCoverage >= 0.55, `${song.id} 的旋律歌词覆盖不足`)

  let previousEnd = -1
  let lastLyricMs = 0
  for (const line of song.lyrics || []) {
    if (String(line.text || '').trim()) lastLyricMs = Math.max(lastLyricMs, line.endMs)
  }
  for (const [index, note] of melody.notes.entries()) {
    assert.ok(Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127,
      `${song.id} note ${index} MIDI 无效`)
    assert.ok(Number.isInteger(note.startMs) && Number.isInteger(note.endMs),
      `${song.id} note ${index} 时间无效`)
    assert.ok(note.startMs >= 0 && note.endMs <= song.durationMs,
      `${song.id} note ${index} 超出歌曲时长`)
    assert.ok(note.endMs - note.startMs >= 50, `${song.id} note ${index} 过短`)
    assert.ok(note.startMs >= previousEnd, `${song.id} note ${index} 与前一个音符重叠`)
    assert.ok(note.startMs < lastLyricMs, `${song.id} note ${index} 位于最后歌词之后`)
    previousEnd = note.endMs
  }
  console.log(`PASS  ${song.id} · ${melody.notes.length} 个音符 · ${melody.estimatedKey || '调性未估算'}`)
}
