const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const read = path => readFileSync(join(__dirname, '..', path), 'utf8')
const app = JSON.parse(read('app.json'))
const homeScript = pageScript('home')
const downloadScript = pageScript('download')
const returnSource = withoutImports(read('utils/downloadReturn.js')).replace(/^export /gm, '')
const previewSource = read('utils/downloadCatalog.js').replace(/^export /gm, '')
const downloadCatalog = vm.runInNewContext(previewSource + '\ndownloadCatalog')
const downloadSource = withoutImports(read('utils/musicDownload.js')).replace('export class', 'class')
const downloadPath = '/pages/download/download'
assert.ok(app.pages.includes(downloadPath.slice(1)))

function withoutImports(source) {
  return source.replace(/^import .*$/gm, '')
}

function pageScript(name) {
  return withoutImports(read('pages/' + name + '/' + name + '.ink').match(/<script setup>([\s\S]*?)<\/script>/)[1])
    .replace('export default', 'page =')
}

function loadPage(script, globals) {
  const page = vm.runInNewContext(script, globals)
  page.setData = update => Object.assign(page.data, update)
  return page
}

function createTestApp(songs, globals = {}) {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  const guards = vm.runInNewContext(returnSource + '\n;({ ' +
    'isDownloadReturnEcho, rememberDownloadReturn, rememberDownloadConfirm, clearDownloadConfirmEcho, ' +
    'setDownloadInputPage, clearDownloadInputPage, forwardDownloadInput, takeDownloadInput })', {
    Date: { now: () => now }
  })
  function advance(ms) {
    const until = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, task] = next
      timers.delete(id)
      now = task.at
      task.run()
    }
    now = until
  }
  const MusicDownload = vm.runInNewContext(downloadSource + '\nMusicDownload', {
    ...guards,
    console,
    downloadCatalog,
    getCachedSongCatalog: () => [],
    performance: { now: () => now },
    AbortController,
    setTimeout(run, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id },
    clearTimeout(id) {
      assert.equal(typeof id, 'number', 'Ink 的 clearTimeout 需要数字 ID')
      timers.delete(id)
    },
    loadSongCatalog: async () => ({ songs, connected: true }),
    ...globals
  })

  const stack = []
  const current = () => stack.at(-1)
  const wx = {
    navigateTo({ url, success }) {
      const route = new URL(url, 'https://test.invalid')
      assert.equal(route.pathname, downloadPath)
      current().onHide?.()
      const page = loadPage(downloadScript, { wx, MusicDownload, ...guards })
      stack.push(page)
      page.onLoad(Object.fromEntries(route.searchParams))
      page.onShow()
      success?.()
    },
    navigateBack() {
      assert.ok(stack.length > 1, '返回不能把首页从页面栈移除')
      const page = stack.pop()
      page.onHide()
      page.onUnload()
      current().onShow?.()
    }
  }
  const homeSongs = Array.from({ length: 20 }, (_, i) => ({ id: 'h' + i, bundled: true }))
  const home = loadPage(homeScript, {
    ...guards, console, wx, songs: homeSongs,
    isServerConnected: () => false,
    loadSongCatalog: async () => ({ songs: homeSongs, connected: false })
  })
  stack.push(home)
  function key(code, { delay = 300, pressed = false, appOnly = false, ...fields } = {}) {
    advance(delay)
    const event = {
      code, ...fields,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true }
    }
    if (!appOnly) current()[pressed ? 'onKeyDown' : 'onKeyUp']?.(event)
    if (!event.stopped) guards.forwardDownloadInput(event, pressed)
    return !!event.defaultPrevented
  }
  function openDownload() {
    home.data.selectedIdx = home.data.songCount + home.data.navItems.findIndex(item => item.label === '音乐下载')
    assert.equal(key('Enter'), true)
    assert.equal(current().data.phase, 'categories', '首页确认只打开语言选择')
    return current()
  }
  return { home, stack, current, key, advance, openDownload, hostBack: wx.navigateBack }
}

async function checkNavigation() {
  const songs = Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, category: i === 0 ? '英文' : 'English' }))
  const requested = []
  const flow = createTestApp(songs, {
    async downloadSong(id) {
      requested.push(id)
      return { offline: true }
    }
  })
  const { home, current, key, openDownload } = flow
  key('ArrowDown')
  assert.ok(home.data.scrollTop > 0)
  key('ArrowUp')
  assert.equal(home.data.scrollTop, 0)

  const categories = openDownload()
  await new Promise(setImmediate)
  assert.equal(categories.data.categories[1].countLabel, '20 首', '音乐下载入口显示在线曲库的语种数量')
  key('ArrowDown', { pressed: true })
  assert.equal(categories.data.categoryIndex, 0, '常规手势在抬起时执行')
  assert.equal(key('ArrowDown', { delay: 50, appOnly: true }), true)
  assert.equal(key('ArrowRight', { delay: 40 }), true)
  assert.equal(categories.data.categoryIndex, 1, '两种滑动键码只移动一项')
  assert.equal(categories.data.songs[0].id, 's0', '当前语种在确认前就预览歌名')
  assert.equal(categories.data.selectedIdx, -1, '预览时尚未选中歌曲')
  key('Enter')
  const list = current()
  await new Promise(setImmediate)
  assert.equal(list.data.phase, 'songs')
  assert.equal(list.data.title, '英文歌')
  assert.equal(list.data.selectedIdx, 0)
  assert.equal(list.data.songs.length, 20)
  assert.deepEqual(requested, [])
  key('ArrowUp')
  assert.equal(current(), list)
  assert.equal(list.data.selectedIdx, 0, '滑到第一项时仍留在歌曲列表')
  for (let index = 1; index < songs.length; index++) {
    key('ArrowDown')
    key('ArrowRight', { delay: 40 })
    assert.equal(list.data.selectedIdx, index)
    assert.equal(list.data.scrollTop, index * 36, '列表滚动到当前选中的歌曲')
  }
  key('ArrowDown')
  assert.equal(list.data.selectedIdx, 19, '滑到最后一项时仍留在歌曲列表')
  key('Unidentified', { key: 'ArrowLeft' })
  assert.equal(list.data.selectedIdx, 18)
  assert.equal(key('Enter'), true)
  await new Promise(setImmediate)
  assert.deepEqual(requested, ['s18'])
  assert.equal(list.data.songs[18].downloaded, true)
  assert.equal(key('Backspace'), true)
  assert.equal(current(), categories)
  assert.equal(categories.data.categoryIndex, 1)
  assert.equal(key('Backspace'), true)
  assert.equal(current(), home)
}

function checkNativeBack() {
  const { home, current, key, openDownload, hostBack } = createTestApp([])
  const categories = openDownload()
  key('Enter')
  assert.equal(current().data.phase, 'songs')
  hostBack()
  assert.equal(current(), categories, '宿主直接返回也应退到语言选择')
  hostBack()
  assert.equal(current(), home, '宿主再返回应显示首页')
}

async function checkTempleFallback() {
  const selected = []
  const { home, current, key, advance, openDownload } = createTestApp(
    [{ id: 'first', category: '中文' }], {
      async downloadSong(id) { selected.push(id); return { offline: true } }
    }
  )
  const categories = openDownload()
  key('GlobalHook', { pressed: true, appOnly: true })
  key('GlobalHook', { delay: 75 })
  advance(275)
  const list = current()
  assert.equal(list.data.phase, 'songs', '同一次触碰的按下和抬起只确认一次')
  assert.equal(key('Enter', { delay: 100 }), true)
  assert.deepEqual(selected, [], '迟到的确认不能跨页触发下载')
  await new Promise(setImmediate)

  key('GlobalHook')
  key('Enter', { delay: 90 })
  key('GlobalHook', { delay: 90 })
  advance(200)
  assert.equal(current(), categories, '双击只退到语种选择')
  assert.equal(key('Backspace', { delay: 120 }), true)
  assert.equal(current(), categories, '双击补发的返回键不能再退一层')
  assert.deepEqual(selected, [], '双击不能提交下载')
  key('GlobalHook')
  key('GlobalHook', { delay: 180 })
  advance(200)
  assert.equal(current(), home)
  assert.equal(key('Backspace', { delay: 100 }), true, '返回首页后仍会拦住双击补发的返回键')
  key('Enter', { delay: 500 })
  assert.equal(home.data.choiceVisible, true, '双击结束后，首页可以正常确认')
}

async function checkDownloadCancellation() {
  let pending
  const { current, key, openDownload, hostBack } = createTestApp([{ id: 'first', category: '中文' }], {
    downloadSong(id, options) {
      return new Promise(resolve => { pending = { ...options, resolve } })
    }
  })
  const categories = openDownload()
  categories.onTapDownloadCategory({ target: { id: 'download-category-zh' } })
  await new Promise(setImmediate)
  const list = current()
  list.onTapDownloadSong({ currentTarget: { id: 'download-song-first' } })
  pending.onProgress({ bytes: 1, total: 2, count: 1 })
  assert.equal(list.data.downloadLabel, '50%')
  hostBack()
  assert.equal(pending.signal.aborted, true)
  pending.resolve({ offline: true })
  await new Promise(setImmediate)
  assert.equal(current(), categories)
  assert.equal(list.data.downloadLabel, '50%')
  key('Backspace')
}

async function checkUnavailableCatalog() {
  let connected = false
  const { current, key, openDownload } = createTestApp([], {
    async loadSongCatalog() {
      return { connected, songs: connected ? [{ id: 'ja-song', category: '日本語' }] : [] }
    }
  })
  const categories = openDownload()
  key('Enter')
  const chinese = current()
  assert.ok(chinese.data.songs.some(song => song.id === 'dao-xiang'), '联网失败前应立即显示包内曲目摘要')
  await new Promise(setImmediate)
  assert.ok(chinese.data.songs.some(song => song.id === 'dao-xiang'), '联网失败后保留曲目摘要')
  key('Backspace')
  assert.equal(current(), categories)
  key('ArrowDown')
  key('ArrowDown')
  key('Enter')
  const japanese = current()
  await new Promise(setImmediate)
  assert.equal(japanese.data.catalogConnected, false)
  assert.equal(japanese.data.catalogLoading, false)
  assert.equal(japanese.data.songs.length, 0)
  connected = true
  key('Enter')
  await new Promise(setImmediate)
  assert.equal(japanese.data.songs[0].id, 'ja-song', '空歌单连接失败时可单击重试')
}

async function checkSongRequests() {
  const sends = []
  let recognition
  const { current, key, openDownload } = createTestApp([], {
    SpeechRecognition: class {
      constructor() { recognition = this }
      start() {}
      stop() { this.onend() }
      abort() { this.aborted = true }
    },
    async submitSongRequest(id, text) {
      sends.push({ id, text })
      if (sends.length === 1) throw Error('模拟网络中断')
    }
  })
  const categories = openDownload()
  key('ArrowLeft')
  assert.equal(categories.data.categoryIndex, 4)
  key('Enter')
  const request = current()
  assert.equal(request.data.phase, 'request')
  key('Enter')
  assert.equal(request.data.requestPhase, 'listening')
  recognition.onresult({ results: [[{ transcript: '想添加一首海阔天空' }]] })
  assert.equal(sends.length, 0)
  key('Enter')
  assert.equal(request.data.requestPhase, 'ready')
  await request.download.onRequestSend()
  assert.equal(request.data.requestPhase, 'ready')
  await request.download.onRequestSend()
  assert.equal(request.data.requestPhase, 'sent')
  assert.equal(sends[0].id, sends[1].id)
  assert.equal(sends[1].text, '想添加一首海阔天空')
  key('Enter')
  key('Backspace')
  assert.equal(current(), categories)
  assert.equal(recognition.aborted, true)
}

async function main() {
  await checkNavigation()
  checkNativeBack()
  await checkTempleFallback()
  await checkDownloadCancellation()
  await checkUnavailableCatalog()
  await checkSongRequests()
  console.log('PASS  音乐下载两层返回、滑动选歌、下载和留言')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
