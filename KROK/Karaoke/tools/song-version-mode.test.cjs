const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const homeSource = readFileSync(join(__dirname, '../pages/home/home.ink'), 'utf8')
assert.match(homeSource, /value: 'guide', label: '带歌词版'/)
assert.match(homeSource, /value: 'instrumental', label: '纯音乐版'/)
assert.doesNotMatch(homeSource, /value: 'silent'|无声版本/)
assert.match(
  homeSource,
  /<view class="main-view" ink:if="\{\{!choiceVisible\}\}">[\s\S]*class="topbar"[\s\S]*class="hintbar"[\s\S]*<\/view>/,
  '打开版本选择后必须隐藏选歌主页'
)
assert.match(homeSource, /data-idx="0"[\s\S]*>带歌词版</, '歌词版按钮必须在首帧静态渲染')
assert.match(homeSource, /data-idx="1"[\s\S]*>纯音乐版</, '纯音乐版按钮必须在首帧静态渲染')

const recordSource = readFileSync(join(__dirname, '../pages/record/record.ink'), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'page =')
assert.doesNotMatch(recordSource, /forcedSilent|无声练习|无声版本/)

function createPage(onInterval) {
  const page = vm.runInNewContext(recordSource, {
    performance,
    console,
    setInterval(callback) {
      if (onInterval) onInterval(callback)
      return 1
    },
    clearInterval() {},
    setTimeout() { return 1 },
    clearTimeout() {},
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    getSongAudio: () => ({ src: '/test.wav', format: 'wav' }),
    getSongFromLibrary: async () => null,
    readDownloadedAudio: async () => null,
    getLyricAt: (lyrics, timeMs) => lyrics.find(line => line.startMs <= timeMs && timeMs < line.endMs),
    getRefNoteAt: (notes, timeMs) => notes.find(note => note.startMs <= timeMs && timeMs < note.endMs),
    sendBattle() { return true },
    localBattleStart() { return Date.now() },
    measureBattleClock() { return true },
    onBattleMessage() { return () => {} }
  })
  page.setData = update => Object.assign(page.data, update)
  page.initializeSong = () => {}
  return page
}

const guide = createPage()
guide.onLoad({ mode: 'guide', songId: 'test' })
assert.equal(guide.mode, 'guide')
assert.equal(guide.data.playbackLabel, '带歌词版')
assert.equal(guide.data.practiceOnly, false)

const instrumental = createPage()
instrumental.onLoad({ mode: 'instrumental', songId: 'test' })
assert.equal(instrumental.mode, 'instrumental')
assert.equal(instrumental.data.playbackLabel, '纯音乐版')
assert.equal(instrumental.data.practiceOnly, false)

let countdownTick
let countdownFinished = false
const countdownPage = createPage(callback => { countdownTick = callback })
countdownPage.player = null
countdownPage.beginFollowing = () => { countdownFinished = true }
const countdownValues = []
countdownPage.setData = update => {
  Object.assign(countdownPage.data, update)
  if (update.statusText != null) countdownValues.push(update.statusText)
}
countdownPage.startCountdown()
countdownTick()
countdownTick()
countdownTick()
assert.equal(countdownValues[0], '●  ●  ●')
assert.deepEqual(countdownValues.slice(0, 3), ['●  ●  ●', '●  ●', '●'])
assert.equal(countdownFinished, true)

countdownPage.song = {
  durationMs: 60000,
  refNotes: [],
  lyrics: [{ text: '第一句', startMs: 23540, endMs: 30770 }]
}
countdownPage.getElapsedMs = () => 20540
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●  ●  ●')
countdownPage.getElapsedMs = () => 21540
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●  ●')
countdownPage.getElapsedMs = () => 23520
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●')

countdownPage.song.lyrics = [{ text: '사랑을 했다', startMs: 3200, endMs: 6800 }]
countdownPage.getElapsedMs = () => 200
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●  ●  ●')
countdownPage.getElapsedMs = () => 1200
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●  ●')
countdownPage.getElapsedMs = () => 3100
countdownPage.updateRecording()
assert.equal(countdownPage.data.cueText, '●')

console.log('PASS  歌词版开唱点阵倒数与首句前三秒点阵提示均有效')
