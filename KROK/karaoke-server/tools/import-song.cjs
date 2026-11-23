#!/usr/bin/env node
// 把一首歌的元数据和同步 LRC 写入 catalog-extra.json。
// 用法示例：
// node tools/import-song.cjs --song-id father --name 父亲 --artist 筷子兄弟 \
//   --lrclib-id 17428939 --duration-ms 280335 --chart-version 1
const fs = require('node:fs')
const path = require('node:path')

function option(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function parseLrc(text, durationMs) {
  const lines = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const match = /^\[(\d{2}):(\d{2})\.(\d{2})\]\s?(.*)$/.exec(raw)
    if (!match) continue
    const startMs = (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(match[3]) * 10
    const text = (match[4] || '').trim()
    lines.push({ text: /^\.+$/.test(text) ? '' : text, startMs })
  }
  lines.sort((a, b) => a.startMs - b.startMs)
  return lines.map((line, index) => ({
    text: line.text,
    startMs: line.startMs,
    endMs: index + 1 < lines.length ? lines[index + 1].startMs : durationMs
  })).filter((line, index, all) => {
    const next = all[index + 1]
    return !next || line.endMs > line.startMs
  })
}

async function main() {
  const id = option('song-id')
  const name = option('name')
  const artist = option('artist')
  const lrclibId = option('lrclib-id')
  const durationMs = Number(option('duration-ms'))
  const offsetMs = Number(option('offset-ms', '0'))
  const chartVersion = Number(option('chart-version', '1'))
  const category = option('category', '中文')
  const tag = option('tag', '练习')
  const difficulty = Number(option('difficulty', '2'))
  if (!id || !name || !artist || !lrclibId || !Number.isFinite(durationMs) || !Number.isFinite(offsetMs)) {
    throw new Error('缺少 --song-id、--name、--artist、--lrclib-id 或 --duration-ms')
  }
  if (!Number.isInteger(chartVersion) || chartVersion < 1) throw new Error('chartVersion 无效')

  const response = await fetch('https://lrclib.net/api/get/' + encodeURIComponent(lrclibId), {
    headers: { 'User-Agent': 'KaraokeDev/1.0 (https://example.invalid)' },
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`LRCLIB 请求失败：${response.status}`)
  const lrclib = await response.json()
  if (!lrclib.syncedLyrics) throw new Error('LRCLIB 没有同步歌词')

  const lyrics = parseLrc(lrclib.syncedLyrics, durationMs - offsetMs).map(line => ({
    text: line.text,
    startMs: Math.min(durationMs, line.startMs + offsetMs),
    endMs: Math.min(durationMs, line.endMs + offsetMs)
  }))
  const melodyFile = `melodies/${id}.json`
  const song = {
    id,
    name,
    artist: artist || lrclib.artistName || '',
    album: lrclib.albumName || name,
    category,
    tag,
    difficulty,
    durationMs,
    chartVersion,
    scoringVersion: 5,
    audioSource: `/source/${id}.ogg`,
    instrumentalSource: `/source/${id}-instrumental.ogg`,
    melodyFile,
    lyrics
  }

  const catalogPath = path.join(__dirname, '..', 'catalog-extra.json')
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const index = catalog.songs.findIndex(item => item.id === id)
  if (index >= 0) catalog.songs[index] = song
  else catalog.songs.push(song)
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
  console.log('Imported', id, '·', name, '·', song.lyrics.length, 'lyric lines', '·', melodyFile)
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
