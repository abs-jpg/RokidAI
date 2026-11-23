#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog-extra.json'), 'utf8'))
const melody = JSON.parse(fs.readFileSync(path.join(root, 'source', 'red-high-heels-refnotes.json'), 'utf8'))
const song = catalog.songs.find(item => item.id === 'red-high-heels')

assert.ok(song, 'catalog must contain red-high-heels')
assert.equal(song.refNotes.length, melody.notes.length, 'catalog and melody file note counts differ')
assert.ok(song.refNotes.length >= 150, 'melody is unexpectedly sparse')
assert.ok(melody.lyricCoverage >= 0.6, 'melody covers too little of the sung lyrics')
assert.equal(melody.songId, song.id)
assert.equal(melody.chartVersion, song.chartVersion)

let previousEnd = -1
let latestLyricMs = 0
for (const line of song.lyrics) {
  if (line.text.trim()) latestLyricMs = Math.max(latestLyricMs, line.endMs)
}

for (const [index, note] of song.refNotes.entries()) {
  assert.equal(Number.isInteger(note.midi), true, `note ${index} has invalid midi`)
  assert.ok(note.midi >= 52 && note.midi <= 84, `note ${index} is outside the lead-vocal range`)
  assert.equal(Number.isInteger(note.startMs), true, `note ${index} has invalid startMs`)
  assert.equal(Number.isInteger(note.endMs), true, `note ${index} has invalid endMs`)
  assert.ok(note.startMs >= 0 && note.endMs <= song.durationMs, `note ${index} is outside duration`)
  assert.ok(note.endMs - note.startMs >= 100, `note ${index} is too short`)
  assert.ok(note.startMs >= previousEnd, `note ${index} overlaps its predecessor`)
  assert.ok(note.startMs < latestLyricMs, `note ${index} starts after the final lyric`)
  previousEnd = note.endMs
}

for (const line of song.lyrics.filter(item => item.text.trim())) {
  const count = song.refNotes.filter(note => note.startMs < line.endMs && note.endMs > line.startMs).length
  assert.ok(count >= 4, `lyric line "${line.text}" has too few melody notes`)
}

assert.deepEqual(song.refNotes[0], melody.notes[0])
assert.deepEqual(song.refNotes.at(-1), melody.notes.at(-1))
console.log(
  'PASS  红色高跟鞋旋律', song.refNotes.length, '个音符 ·',
  melody.estimatedKey, '·', Math.round(melody.lyricCoverage * 100) + '% 歌词覆盖'
)
