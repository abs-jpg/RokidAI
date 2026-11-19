const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

async function main() {
  const source = readFileSync(join(__dirname, '../pages/leaderboard/leaderboard.ink'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, '')
    .replace('export default', 'page =')
  let resolveRequest
  const songs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const page = vm.runInNewContext(source, {
    console, songs, isServerConnected: () => true,
    getLeaderboard: () => new Promise(resolve => { resolveRequest = resolve })
  })
  page.setData = update => Object.assign(page.data, update)
  page.requestId = 0
  page.data.phase = 'display'
  page.data.entries = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1 }))
  const press = code => {
    let prevented = false
    page.onKeyUp({ code, preventDefault() { prevented = true } })
    return prevented
  }
  assert.equal(press('Enter'), true)
  assert.equal(page.data.focus, 'entries')
  for (let i = 0; i < 60; i++) press('ArrowDown')
  assert.equal(page.data.selectedIdx, 49)
  assert.equal(page.data.songIndex, 0)
  press('ArrowUp')
  assert.equal(page.data.selectedIdx, 48)
  press('Enter')
  resolveRequest({ list: [{ score: 80 }], connected: true })
  await new Promise(setImmediate)
  assert.equal(page.data.selectedIdx, 0, 'a shorter refreshed list must clamp selection')
  assert.equal(press('Backspace'), true)
  assert.equal(page.data.focus, 'songs')
  press('ArrowDown')
  assert.equal(page.data.songIndex, 1)
  assert.equal(page.data.selectedIdx, 0)
  assert.equal(press('Backspace'), false, 'return from song selection must reach platform navigation')
  const snapshot = JSON.stringify(page.data)
  page.onUnload()
  resolveRequest({ list: [{ score: 90 }], connected: true })
  await new Promise(setImmediate)
  assert.equal(JSON.stringify(page.data), snapshot, 'late requests must not update an unloaded page')
  console.log('PASS  排行榜 50 项按键浏览、刷新收缩、返回选歌及退出保护')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
