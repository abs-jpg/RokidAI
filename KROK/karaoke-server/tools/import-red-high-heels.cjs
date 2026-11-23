#!/usr/bin/env node
// 将《红色高跟鞋》导入在线曲库：解析 LRCLIB 同步歌词，并读取由原唱提取的旋律音符。
// 音频已由 ffmpeg 转成 source/red-high-heels.ogg（原唱）与
// source/red-high-heels-instrumental.ogg（伴奏）。
const fs = require('node:fs')
const path = require('node:path')

const DURATION_MS = 206590
const CHART_VERSION = 2

const lrc = [
  '[00:22.26] 該怎麼去形容你最貼切',
  '[00:27.47] 拿什麼跟你作比較才算特別',
  '[00:33.05] 對你的感覺 強烈',
  '[00:35.96] 卻又不太瞭解 只憑直覺',
  '[00:42.00] 你像窩在被子裡的舒服',
  '[00:47.37] 卻又像風 琢磨不住',
  '[00:52.63] 像手腕上散發的香水味',
  '[00:58.20] 像愛不釋手的 紅色高跟鞋',
  '[01:07.24]',
  '[01:16.97] 該怎麼去形容你最貼切',
  '[01:22.15] 拿什麼跟你作比較才算特別',
  '[01:27.62] 對你的感覺 強烈',
  '[01:30.40] 卻又不太瞭解 只憑直覺',
  '[01:36.85] 你像窩在被子裡的舒服',
  '[01:42.01] 卻又像風 琢磨不住',
  '[01:47.27] 像手腕上散發的香水味',
  '[01:52.91] 像愛不釋手的 紅色高跟鞋',
  '[02:04.56] 哦 啊',
  '[02:10.08] 哦 耶',
  '[02:14.99] 你像窩在被子裡的舒服',
  '[02:20.17] 卻又像風 琢磨不住',
  '[02:25.50] 像手腕上散發的香水味',
  '[02:30.94] 像愛不釋手的',
  '[02:36.31] 我愛你有種左燈右行的衝突',
  '[02:41.91] 瘋狂卻怕沒有退路',
  '[02:47.18] 你能否讓我停止這種追逐',
  '[02:53.30] 就這麼雙 最後唯一的 紅色高跟鞋',
  '[02:59.85]'
].join('\n')

function parseLrc(lrcText, durationMs) {
  const lines = []
  for (const raw of lrcText.split('\n')) {
    const match = /^\[(\d{2}):(\d{2})\.(\d{2})\]\s?(.*)$/.exec(raw)
    if (!match) continue
    const startMs = (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(match[3]) * 10
    lines.push({ text: (match[4] || '').trim(), startMs })
  }
  lines.sort((a, b) => a.startMs - b.startMs)
  return lines.map((line, index) => ({
    text: line.text,
    startMs: line.startMs,
    endMs: index + 1 < lines.length ? lines[index + 1].startMs : durationMs
  }))
}

const melodyPath = path.join(__dirname, '..', 'source', 'red-high-heels-refnotes.json')
const melody = JSON.parse(fs.readFileSync(melodyPath, 'utf8'))
if (melody.songId !== 'red-high-heels' || !Array.isArray(melody.notes) || !melody.notes.length) {
  throw new Error('红色高跟鞋旋律文件无效或没有音符')
}
if (melody.chartVersion !== CHART_VERSION) {
  throw new Error(`旋律谱面版本不一致：${melody.chartVersion} != ${CHART_VERSION}`)
}

const song = {
  id: 'red-high-heels',
  name: '红色高跟鞋',
  artist: '蔡健雅',
  album: '红色高跟鞋',
  category: '中文',
  tag: '练习',
  difficulty: 2,
  durationMs: DURATION_MS,
  chartVersion: CHART_VERSION,
  scoringVersion: 5,
  audioSource: '/source/red-high-heels.ogg',
  instrumentalSource: '/source/red-high-heels-instrumental.ogg',
  lyrics: parseLrc(lrc, DURATION_MS),
  refNotes: melody.notes
}

const catalogPath = path.join(__dirname, '..', 'catalog-extra.json')
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const index = catalog.songs.findIndex(item => item.id === song.id)
if (index >= 0) catalog.songs[index] = song
else catalog.songs.push(song)
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
console.log('Imported', song.id, '·', song.name, '·', song.lyrics.length, 'lyric lines')
