#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const catalogPath = path.join(root, 'catalog-extra.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const melodyDir = path.join(root, 'melodies')
fs.mkdirSync(melodyDir, { recursive: true })

for (const song of catalog.songs) {
  if (!Array.isArray(song.refNotes) || song.refNotes.length === 0) {
    if (song.melodyFile) continue
    throw new Error(`${song.id} 既没有 refNotes，也没有 melodyFile`)
  }
  const candidates = [
    path.join(root, 'source', `${song.id}-refnotes.json`),
    path.join(root, 'source', `${song.id}.json`)
  ]
  const sourcePath = candidates.find(candidate => fs.existsSync(candidate))
  const targetPath = path.join(melodyDir, `${song.id}.json`)
  if (sourcePath) {
    const melody = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
    if (melody.songId !== song.id || Number(melody.chartVersion) !== Number(song.chartVersion)) {
      throw new Error(`${song.id} 的源旋律与曲库版本不一致`)
    }
    fs.writeFileSync(targetPath, JSON.stringify(melody, null, 2) + '\n')
  } else {
    fs.writeFileSync(targetPath, JSON.stringify({
      songId: song.id,
      chartVersion: song.chartVersion,
      notes: song.refNotes
    }, null, 2) + '\n')
  }
  delete song.refNotes
  song.melodyFile = `melodies/${song.id}.json`
  console.log('Migrated', song.id, '->', song.melodyFile)
}

fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
