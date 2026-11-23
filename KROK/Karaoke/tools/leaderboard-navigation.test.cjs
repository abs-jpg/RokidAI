const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

async function main() {
  const leaderboardSource = readFileSync(join(__dirname, '../pages/leaderboard/leaderboard.ink'), 'utf8')
  for (const label of ['中文', '英文', '日语', '韩语']) {
    assert.match(leaderboardSource, new RegExp('category-tab-name[^>]*>' + label + '</'), `分类 ${label} 必须静态渲染`)
  }
  assert.match(leaderboardSource, /scroll-left="\{\{songScrollLeft\}\}"/, '歌曲栏必须使用数值滚动位置')
  assert.doesNotMatch(leaderboardSource, /scroll-into-view="song-/, '不能只依赖 scroll-into-view')
  assert.match(leaderboardSource, /\.category-tabs-inner\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*padding:\s*4px 8px 10px/,
    '分类按钮底部必须与横线留出间距')
  const source = leaderboardSource
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, '')
    .replace('export default', 'page =')
  const songs = [
    { id: 'zh-1', name: '中文一', category: '中文' },
    { id: 'zh-2', name: '中文二', category: '中文' },
    { id: 'en-1', name: 'English One', category: 'English' },
    { id: 'en-2', name: 'What Makes You Beautiful', category: 'English' },
    { id: 'en-3', name: 'Love Story', category: 'English' },
    { id: 'ja-1', name: '日语一', category: '日本語' },
    { id: 'ko-1', name: '韩语一', category: '한국어' }
  ]
  const requests = []
  const resolvers = []
  const page = vm.runInNewContext(source, {
    console,
    songs,
    isServerConnected: () => true,
    loadSongCatalog: async () => ({ songs, connected: true }),
    getLeaderboard: id => {
      requests.push(id)
      return new Promise(resolve => resolvers.push(resolve))
    }
  })
  page.setData = update => Object.assign(page.data, update)
  page.requestId = 0
  let pressTime = 0
  assert.equal(page.songScrollOffset(0), 0)
  assert.ok(page.songScrollOffset(7) > 0, '选中屏幕外歌曲时必须产生横向滚动偏移')
  const press = (code, timeStamp) => {
    const at = timeStamp ?? pressTime
    pressTime = Math.max(pressTime, at) + 300
    let prevented = false
    page.onKeyUp({ code, timeStamp: at, preventDefault() { prevented = true } })
    return prevented
  }

  await page.initialize()
  assert.equal(page.data.focus, 'categories')
  assert.equal(page.data.phase, 'categories')
  assert.equal(page.data.categories.length, 4)
  assert.equal(requests.length, 0, '未选择分类前不得直接加载排行榜')

  press('ArrowRight', 1000)
  assert.equal(page.data.categoryIndex, 1)
  press('ArrowRight', 1050)
  assert.equal(page.data.categoryIndex, 1, '一次滑动产生的重复方向事件只能移动一格')
  page.setData({ categoryIndex: 1 })
  press('Enter')
  assert.equal(page.data.focus, 'songs')
  assert.equal(page.data.activeCategoryKey, '英文')
  assert.equal(page.data.songCount, 3)
  assert.deepEqual(page.data.songs.map(song => song.id), ['en-1', 'en-2', 'en-3'])
  assert.equal(page.data.songs[0].nameScrollStyle, '', '能放下的歌名应静止')
  assert.equal(page.data.songs[0].activeNameScrollStyle, '')
  const longSong = page.data.songs[1]
  assert.equal(longSong.name, 'What Makes You Beautiful')
  for (const style of [longSong.nameScrollStyle, longSong.activeNameScrollStyle]) {
    const [, width, distance, duration] = style.match(/width: (\d+)px; --song-name-end: -(\d+)px; animation-duration: (\d+)ms;/)
    assert.equal(Number(width) - Number(distance), 84, '滚到末尾时应露出歌名最后一个字')
    assert.ok(Number(duration) >= 3200)
  }
  assert.equal(requests[0], 'en-1')

  resolvers[0]({ list: [{ score: 80 }, { score: 70 }], connected: true })
  await new Promise(setImmediate)
  assert.equal(page.data.phase, 'display')

  const firstSwipeAt = pressTime
  assert.equal(press('ArrowDown', firstSwipeAt), true)
  assert.equal(press('ArrowDown', firstSwipeAt + 50), true, '重复事件也必须拦截宿主默认滚动')
  assert.equal(press('ArrowRight', firstSwipeAt + 80), true)
  assert.equal(page.data.songIndex, 1)
  assert.deepEqual(requests, ['en-1', 'en-2'], '一次镜腿滑动只切换并请求下一首歌')

  press('ArrowDown', firstSwipeAt + 300)
  assert.equal(page.data.songIndex, 2, '下一次滑动应继续移到相邻歌曲')
  assert.equal(requests[2], 'en-3')

  const previousSwipeAt = firstSwipeAt + 400
  press('ArrowUp', previousSwipeAt)
  press('ArrowLeft', previousSwipeAt + 50)
  assert.equal(page.data.songIndex, 1, '反向滑动的重复事件也只能移动一格')
  assert.deepEqual(requests, ['en-1', 'en-2', 'en-3', 'en-2'])

  resolvers[3]({ list: [{ score: 90 }], connected: true })
  resolvers[2]({ list: [{ score: 60 }], connected: true })
  resolvers[1]({ list: [{ score: 50 }], connected: true })
  await new Promise(setImmediate)
  assert.equal(page.data.entries[0].score, 90, '切歌后应显示当前歌曲的榜单')

  press('Enter')
  assert.equal(page.data.focus, 'entries')
  page.data.entries = Array.from({ length: 50 }, (_, i) => ({ rank: i + 1 }))
  for (let i = 0; i < 60; i++) press('ArrowDown')
  assert.equal(page.data.selectedIdx, 49)
  press('ArrowUp')
  assert.equal(page.data.selectedIdx, 48)

  assert.equal(press('Backspace'), true)
  assert.equal(page.data.focus, 'songs')
  assert.equal(press('Backspace'), true)
  assert.equal(page.data.focus, 'categories')
  assert.equal(page.data.phase, 'categories')
  assert.equal(press('Backspace'), false, '分类页返回应由平台处理')

  press('ArrowDown')
  press('ArrowDown')
  assert.equal(page.data.categoryIndex, 3)
  press('Enter')
  assert.deepEqual(page.data.songs.map(song => song.id), ['ko-1'])
  resolvers[4]({ list: [], connected: true })
  await new Promise(setImmediate)
  assert.equal(page.data.phase, 'empty')
  assert.equal(page.data.emptyTitle, '韩语一 · 暂无成绩')

  console.log('PASS  分类选择、镜腿滑动去重、长歌名滚动、榜单滚动、逐级返回和空分类状态')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
