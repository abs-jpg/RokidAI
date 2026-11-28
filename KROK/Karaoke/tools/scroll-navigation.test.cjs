const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const read = path => readFileSync(join(__dirname, '..', path), 'utf8')
const app = JSON.parse(read('app.json'))
const homeScript = pageScript('home')
const downloadScript = pageScript('download')
const choiceScript = pageScript('song-choice', 'choice')
const returnSource = withoutImports(read('utils/downloadReturn.js')).replace(/^export /gm, '')
const previewSource = read('utils/downloadCatalog.js').replace(/^export /gm, '')
const downloadCatalog = vm.runInNewContext(previewSource + '\ndownloadCatalog')
const downloadSource = withoutImports(read('utils/musicDownload.js')).replace('export class', 'class')
const choiceSource = read('utils/songChoice.js').replace(/^export /gm, '')
const voiceSource = withoutImports(read('utils/homeVoiceSelection.js')).replace(/^export /gm, '')
const voiceCaptureSource = withoutImports(read('utils/voiceCommandCapture.js')).replace(/^export /gm, '')
const phraseAudioSource = withoutImports(read('utils/phraseAudio.js')).replace(/^export /gm, '')
const downloadPath = '/pages/download/download'
const choicePath = '/pages/song-choice/choice'
assert.ok(app.pages.includes(downloadPath.slice(1)))
assert.ok(app.pages.includes(choicePath.slice(1)))

function withoutImports(source) {
  return source.replace(/^import .*$/gm, '')
}

function pageScript(name, filename = name) {
  return withoutImports(read('pages/' + name + '/' + filename + '.ink').match(/<script setup>([\s\S]*?)<\/script>/)[1])
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
    'isDownloadReturnEcho, isRecentReturn, isReturnKey, rememberDownloadReturn, rememberDownloadConfirm, clearDownloadConfirmEcho, ' +
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
  const appInstance = { globalData: {} }
  const getApp = () => appInstance
  let programmaticBacks = 0
  const current = () => stack.at(-1)
  function hostBack() {
    assert.ok(stack.length > 1, '返回不能把首页从页面栈移除')
    const page = stack.pop()
    page.onHide?.()
    page.onUnload?.()
    current().onShow?.()
  }
  const canvas = {
    beginPath() { this.segments = [] },
    moveTo(x, y) { this.from = [x, y] },
    lineTo(x, y) { this.segments.push([...this.from, x, y]); this.from = [x, y] },
    clearRect() { globals.onChoiceClear?.() },
    stroke() {
      if (this.segments.length === 1) globals.onChoiceLine?.(...this.segments[0])
    },
    fill() {}, flush() {},
    arc(...args) { globals.onChoiceArc?.(...args) }
  }
  const wx = {
    createCanvasContext: () => canvas,
    navigateTo({ url, complete }) {
      const route = new URL(url, 'https://test.invalid')
      const query = Object.fromEntries(route.searchParams)
      current().onHide?.()
      let page
      if (route.pathname === choicePath) {
        page = loadPage(choiceScript, {
          ...runtime, ...choice, ...guards, wx, getApp,
          getSongById: globals.getSongById || (() => null),
          preloadSongAudio: globals.preloadSongAudio
        })
      } else if (route.pathname === downloadPath) {
        page = loadPage(downloadScript, { wx, MusicDownload, ...guards })
      } else {
        assert.ok(['/pages/leaderboard/leaderboard', '/pages/battle/battle'].includes(route.pathname))
        page = { path: route.pathname }
      }
      stack.push(page)
      page.onLoad?.(query)
      page.onShow?.()
      complete?.()
    },
    redirectTo({ url }) {
      const route = new URL(url, 'https://test.invalid')
      assert.ok(['/pages/record/record', '/pages/phrase/phrase'].includes(route.pathname))
      const page = stack.pop()
      page.onHide()
      page.onUnload()
      stack.push({ query: Object.fromEntries(route.searchParams) })
    },
    navigateBack({ delta = 1, success } = {}) {
      assert.equal(delta, 1)
      programmaticBacks++
      hostBack()
      success?.()
    }
  }
  const homeSongs = Array.from({ length: 20 }, (_, i) => ({ id: 'h' + i, bundled: true }))
  const runtime = {
    console,
    performance: { now: () => now },
    setTimeout(run, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id },
    clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame(run) { const id = ++nextTimer; timers.set(id, { at: now + 16, run }); return id },
    cancelAnimationFrame(id) { timers.delete(id) },
    AbsoluteOrientationSensor: globals.AbsoluteOrientationSensor,
    Gyroscope: globals.Gyroscope
  }
  const choice = vm.runInNewContext(choiceSource + '\n;({ SongChoice, songChoiceLayout, phraseAimSession })', runtime)
  const voiceRuntime = {
    ...runtime, SpeechRecognition: globals.SpeechRecognition, SpeechRecognitionSession: globals.SpeechRecognitionSession,
    MediaRecorder: globals.MediaRecorder, navigator: globals.navigator
  }
  const getRecognitionFormat = vm.runInNewContext(phraseAudioSource + '\ngetRecognitionFormat', voiceRuntime)
  const capture = vm.runInNewContext(voiceCaptureSource + '\n;({ captureVoiceCommand, supportsVoiceCommandCapture })', {
    ...voiceRuntime, getRecognitionFormat
  })
  const HomeVoiceSelection = vm.runInNewContext(voiceSource + '\nHomeVoiceSelection', { ...voiceRuntime, ...capture })
  const home = loadPage(homeScript, {
    ...guards, ...runtime, ...choice, wx, getApp, songs: homeSongs, HomeVoiceSelection,
    isServerConnected: () => false,
    preloadSongAudio: async () => ({}),
    loadSongCatalog: globals.loadHomeCatalog || (async () => ({
      songs: [...homeSongs, ...songs],
      connected: globals.homeConnected?.() || false
    }))
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
    if (!pressed && code === 'Backspace' && !event.defaultPrevented) hostBack()
    return !!event.defaultPrevented
  }
  function openDownload() {
    home.data.selectedIdx = home.data.songCount + home.data.navItems.findIndex(item => item.label === '音乐下载')
    assert.equal(key('Enter'), true)
    assert.equal(current().data.phase, 'categories', '首页确认只打开语言选择')
    return current()
  }
  return { home, stack, current, key, advance, openDownload, hostBack,
    get programmaticBacks() { return programmaticBacks },
    phraseAimSession: choice.phraseAimSession, createCanvas: () => canvas,
    createChoice: (page, layout) => new choice.SongChoice(page, layout, () => canvas) }
}

async function checkNavigation() {
  const songs = Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, category: i === 0 ? '英文' : 'English' }))
  const requested = []
  const flow = createTestApp(songs, {
    async downloadSong(id, variant) {
      requested.push([id, variant])
      return { offline: true, downloadedVariants: { guide: false, instrumental: true } }
    }
  })
  const { home, current, key, openDownload } = flow
  key('ArrowDown')
  assert.ok(home.data.scrollTop > 0)
  key('ArrowUp')
  assert.equal(home.data.scrollTop, 0)

  const categories = openDownload()
  await new Promise(setImmediate)
  assert.equal(categories.data.categories[1].label, '英文歌', '语言分类按钮只显示语种')
  assert.equal('countLabel' in categories.data.categories[1], false, '语言分类按钮不显示歌曲数量')
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
  assert.equal(list.data.choiceVisible, true)
  assert.deepEqual(requested, [], '进入下载选项时不发送任何下载请求')
  key('ArrowDown')
  key('Enter')
  await new Promise(setImmediate)
  assert.deepEqual(requested, [['s18', 'instrumental']])
  assert.equal(list.data.songs[18].downloaded, false)
  assert.equal(list.data.songs[18].downloadedVariants.instrumental, true)
  key('Enter')
  assert.equal(requested.length, 1, '已下载的版本不再触发下载')
  assert.equal(key('Backspace'), true)
  assert.equal(list.data.choiceVisible, false)
  assert.equal(current(), list)
  key('Enter')
  assert.equal(list.data.choiceIndex, 0, '重新打开时优先选中尚未下载的版本')
  key('Backspace')
  assert.equal(key('Backspace'), true)
  assert.equal(current(), categories)
  assert.equal(categories.data.categoryIndex, 1)
  assert.equal(categories.data.phase, 'categories')
  assert.equal(key('Backspace'), false)
  assert.equal(current(), home)
}

function checkNativeBack() {
  const flow = createTestApp([])
  const { home, current, key, openDownload, stack } = flow
  const categories = openDownload()
  assert.equal(key('Backspace', { pressed: true }), false)
  assert.equal(key('Backspace'), false, '语种页和联机大厅一样交给宿主返回')
  assert.equal(current(), home)

  openDownload()
  key('Enter')
  assert.equal(current().data.phase, 'songs')
  assert.equal(stack.length, 2, '歌曲列表和语种选择使用同一个页面')
  assert.notEqual(current(), categories)
  assert.equal(key('Backspace'), true, '歌曲列表像排行榜一样拦截返回键并切换状态')
  assert.equal(current().data.phase, 'categories')
  assert.equal(key('Backspace'), false)
  assert.equal(current(), home)
  assert.equal(flow.programmaticBacks, 0, '系统返回键不应额外触发程序返回')
}

async function checkHomeFocusAfterReturning() {
  const downloaded = []
  let connected = false
  const { home, current, hostBack } = createTestApp(downloaded, { homeConnected: () => connected })
  for (const [index, url] of home.data.navItems.map((item, index) => [index, item.url])) {
    home.onTapNav({ currentTarget: { dataset: { idx: index } } })
    if (url === downloadPath) assert.equal(current().data.phase, 'categories')
    else assert.equal(current().path, url)
    downloaded.push({ id: 'downloaded-' + index, downloadedVariants: { guide: true } })
    connected = !connected
    hostBack()
    assert.equal(current(), home)
    assert.equal(home.data.selectedIdx, home.data.songCount + index, '返回时立即选中打开的入口')
    await new Promise(setImmediate)
    assert.equal(home.data.navItems[home.data.selectedIdx - home.data.songCount].url, url,
      '新增曲目或排行榜标签变化后仍选中同一入口')
  }
}

function mockVoiceInput() {
  const sessions = []
  class SpeechRecognition {
    constructor() { sessions.push(this) }
    start() { this.started = true }
    abort() {
      this.aborted = true
      this.onend?.()
    }
    say(transcript, isFinal = true) {
      const result = Object.assign([{ transcript }], { isFinal })
      this.onresult({ results: [result], resultIndex: 0 })
    }
  }
  const wake = (home, keyword) => {
    const event = { keyword, preventDefault() { this.prevented = true } }
    home.onVoiceWakeup(event)
    return event.prevented === true
  }
  return { SpeechRecognition, sessions, wake }
}

async function checkHomeVoiceSelection() {
  const voice = mockVoiceInput()
  const { home, current, key, advance } = createTestApp([
    { id: 'way-back-home', name: 'Way Back Home (feat. Conor Maynard)', downloadedVariants: { instrumental: true } },
    { id: 'cover-1', name: '同名歌曲', artist: '歌手甲', downloadedVariants: { guide: true } },
    { id: 'cover-2', name: '同名歌曲', artist: '歌手乙', downloadedVariants: { guide: true } },
    { id: 'remote', name: '在线歌曲' }
  ], voice)
  home.onShow()
  await new Promise(setImmediate)

  assert.equal(voice.wake(home, '乐奇'), true)
  const first = voice.sessions[0]
  assert.equal(first.started, true)
  assert.equal(voice.wake(home, 'clickAiAssist'), true)
  assert.equal(voice.sessions.length, 1, '重复唤醒不重复打开麦克风')
  first.say('Way Back Home', false)
  assert.equal(current(), home, '临时识别结果不打开页面')
  first.say('我要唱 Way Back Home！')
  assert.equal(current().data.choiceSongName, 'Way Back Home (feat. Conor Maynard)')
  assert.equal(first.aborted, true, '进入选歌页前已释放语音识别')
  assert.equal(voice.wake(home, '乐奇'), false, '首页隐藏时不接管系统唤醒')
  key('Backspace')
  assert.equal(current(), home, '语音选歌仍使用原有返回方式')

  for (const [open, enter, path] of [
    ['打开排行榜', '进入排行榜', '/pages/leaderboard/leaderboard'],
    ['打开多人联机', '进入多人联机', '/pages/battle/battle'],
    ['打开音乐下载', '进入音乐下载', downloadPath]
  ]) {
    for (const text of [open, enter]) {
      assert.equal(voice.wake(home, 'clickAiAssist'), true)
      voice.sessions.at(-1).say(text)
      if (path === downloadPath) assert.equal(current().data.phase, 'categories')
      else assert.equal(current().path, path)
      key('Backspace')
      assert.equal(current(), home)
    }
  }

  voice.wake(home, '乐奇')
  voice.sessions.at(-1).say('在线歌曲')
  await new Promise(setImmediate)
  assert.equal(current(), home)
  assert.match(home.data.voiceHint, /没找到已下载歌曲/)

  voice.wake(home, '乐奇')
  voice.sessions.at(-1).say('同名歌曲')
  assert.equal(current(), home)
  assert.match(home.data.voiceHint, /请说歌手和歌名/)
  voice.wake(home, '乐奇')
  voice.sessions.at(-1).say('歌手乙的同名歌曲')
  assert.equal(current().data.choiceSongName, '同名歌曲')
  assert.equal(current().songId, 'cover-2')
  key('Backspace')

  voice.wake(home, '乐奇')
  const timeout = voice.sessions.at(-1)
  advance(9000)
  assert.equal(timeout.aborted, true)
  assert.match(home.data.voiceHint, /没听清/)
  advance(4500)
  assert.equal(home.data.voiceHint, '', '短暂提示后恢复原有操作提示')
  voice.wake(home, 'clickAiAssist')
  voice.sessions.at(-1).onerror({ error: 'not-allowed' })
  assert.match(home.data.voiceHint, /请允许麦克风/)
}

async function checkHomeVoiceCatalogRace() {
  const voice = mockVoiceInput()
  let resolveCatalog
  const loaded = { id: 'new-song', name: '新下载歌曲', downloadedVariants: { guide: true } }
  const { home, current, key } = createTestApp([], {
    ...voice,
    loadHomeCatalog: () => new Promise(resolve => { resolveCatalog = resolve })
  })
  home.onShow()
  voice.wake(home, '乐奇')
  voice.sessions.at(-1).say('新下载歌曲')
  assert.equal(current(), home)
  assert.match(home.data.voiceHint, /正在查找/)
  resolveCatalog({ songs: [loaded], connected: true })
  await new Promise(setImmediate)
  assert.equal(current().songId, 'new-song', '启动时的语音请求可以等待本机曲库')
  key('Backspace')

  voice.wake(home, '乐奇')
  const session = voice.sessions.at(-1)
  session.say('另一首歌')
  key('Enter', { delay: 500 })
  const manualPage = current()
  assert.equal(manualPage.songId, 'new-song', '语音查找时镜腿仍能照常选歌')
  resolveCatalog({ songs: [loaded, { ...loaded, id: 'another', name: '另一首歌' }], connected: true })
  session.say('打开排行榜')
  await new Promise(setImmediate)
  assert.equal(current(), manualPage, '旧的语音请求不会干扰已经打开的页面')
}

async function checkVoiceCaptureAndRecovery() {
  const { wake } = mockVoiceInput()
  let micAttempts = 0
  let recorder
  let networkError = false
  let trackStopped = false
  let pendingMic
  let delayMic = false
  const chunks = []
  const { home, current, key, advance } = createTestApp([
    { id: 'voice-song', name: '稻香', downloadedVariants: { guide: true } }
  ], {
    SpeechRecognition: class {
      constructor() { assert.fail('支持录音的设备优先走分片识别') }
    },
    navigator: { mediaDevices: {
      async getUserMedia() {
        if (++micAttempts === 1) throw Object.assign(new Error('host mic still busy'), { name: 'NotReadableError' })
        trackStopped = false
        if (delayMic) return new Promise(resolve => { pendingMic = resolve })
        return { getTracks: () => [{ stop() { trackStopped = true } }] }
      }
    } },
    MediaRecorder: class {
      static isTypeSupported(type) { return type === 'audio/wav' }
      constructor(_stream, options) {
        assert.equal(options.mimeType, 'audio/wav')
        assert.equal(options.vad.enabled, true)
        recorder = this
      }
      start() { this.state = 'recording' }
      emit(id, voiceActive) { this.ondataavailable?.({ data: { id, size: 3 }, voiceActive }) }
      stop() {
        this.state = 'inactive'
        this.emit('tail')
        this.onstop?.()
      }
    },
    SpeechRecognitionSession: class {
      static async getCapabilities() {
        return { audioFormats: [{ mimeType: 'audio/ogg;codecs=opus' }, { mimeType: 'audio/wav' }] }
      }
      constructor(options) {
        assert.equal(options.lang, 'zh-CN')
        assert.equal(options.audio.mimeType, 'audio/wav')
        this.audio = { getWriter: () => ({
          write: async chunk => chunks.push(chunk.id),
          close: async () => {
            if (networkError) {
              this.onerror({ error: 'network' })
              return
            }
            this.onresult({ results: [{ isFinal: true, 0: { transcript: '稻香' } }] })
            this.onend()
          },
          abort: async () => {}
        }) }
      }
    }
  })
  home.onShow()
  wake(home, '乐奇')
  assert.match(home.data.voiceHint, /正在开启麦克风/)
  await new Promise(setImmediate)
  assert.equal(micAttempts, 1)
  assert.match(home.data.voiceHint, /正在开启麦克风/, '麦克风被占用时先等释放')
  advance(350)
  await new Promise(setImmediate)
  assert.equal(micAttempts, 2)
  assert.match(home.data.voiceHint, /正在聆听/, '录音成功启动后才提示用户说话')
  recorder.emit('before-speech', false)
  assert.equal(recorder.state, 'recording', '开始时的静音不能让录音提前结束')
  recorder.emit('speech', true)
  recorder.emit('after-speech', false)
  assert.equal(trackStopped, true, '进入识别阶段即释放麦克风')
  await new Promise(setImmediate)
  assert.deepEqual(chunks, ['before-speech', 'speech', 'after-speech', 'tail'], '停止录音后仍发送最后一个分片')
  assert.equal(current().songId, 'voice-song')
  key('Backspace')

  networkError = true
  wake(home, 'clickAiAssist')
  await new Promise(setImmediate)
  recorder.emit('speech-without-vad')
  advance(6000)
  await new Promise(setImmediate)
  assert.match(home.data.voiceHint, /语音服务连接失败/)
  assert.equal(trackStopped, true)
  assert.equal(current(), home)

  delayMic = true
  wake(home, '乐奇')
  await new Promise(setImmediate)
  key('Enter', { delay: 500 })
  const chooser = current()
  assert.equal(chooser.songId, 'voice-song')
  let lateTrackStopped = false
  pendingMic({ getTracks: () => [{ stop() { lateTrackStopped = true } }] })
  await new Promise(setImmediate)
  assert.equal(lateTrackStopped, true, '页面离开后归还迟到的麦克风权限请求')
  assert.equal(current(), chooser)
}

async function checkChooserNativeAndLogicalBack() {
  const flow = createTestApp([
    { id: 'cached', name: '稻香 %20 & 梦', downloadedVariants: { guide: true } }
  ])
  const { home, current, key, advance } = flow
  await home.refreshCatalog()
  const index = home.data.songs.findIndex(song => song.id === 'cached')
  home.activate(index)
  assert.equal(current().data.choiceSongName, '稻香 %20 & 梦', '歌名不通过 URL 编码传递')
  assert.equal(key('Backspace', { delay: 40, pressed: true, appOnly: true }), false)
  assert.notEqual(current(), home, '按下返回键时仍停留在当前页')
  assert.equal(key('Backspace', { delay: 40 }), false)
  assert.equal(current(), home, '转场过程中也能返回首页')
  assert.equal(key('Backspace', { delay: 270, appOnly: true }), true, '吞掉迟到的宿主返回')
  assert.equal(home.data.songs[home.data.selectedIdx].id, 'cached')

  advance(300)
  home.activate(index)
  assert.equal(key('GlobalHook'), false, '原始镜腿按键交给宿主识别')
  key('GlobalHook', { delay: 150 })
  assert.equal(key('Backspace', { delay: 100 }), false)
  advance(500)
  assert.equal(current(), home, '宿主弹出准星页后，取消待执行的双击返回')
  assert.equal(flow.programmaticBacks, 0, '收到系统返回键时不主动调用页面返回')

  home.activate(index)
  assert.equal(key('Unidentified', { key: 'BrowserBack', delay: 10 }), false)
  advance(450)
  assert.equal(current(), home, '只有备用返回键时也可以回到首页')
}

async function checkBackDuringAudioPreload() {
  let preloaded
  const { home, current, key, advance } = createTestApp([], {
    getSongById: id => ({ id, bundled: true }),
    preloadSongAudio: () => new Promise(resolve => { preloaded = resolve })
  })
  home.activate(0)
  advance(850)
  const chooser = current()
  key('Enter')
  assert.ok(preloaded, '确认后等待伴奏预热')
  key('GlobalHook')
  key('GlobalHook', { delay: 150 })
  preloaded()
  await new Promise(setImmediate)
  assert.equal(current(), chooser, '双击待处理时即使伴奏就绪也不进入演唱页')
  advance(450)
  assert.equal(current(), home)
}

async function checkChooserTitleOverflow() {
  const longTitle = 'Way Back Home (feat. Conor Maynard) [Sam Feldt Edit]'
  const { home, current, key } = createTestApp([
    { id: 'short-title', name: '稻香', downloadedVariants: { guide: true } },
    { id: 'long-title', name: longTitle, downloadedVariants: { guide: true } }
  ])
  await home.refreshCatalog()

  home.activate(home.data.songs.findIndex(song => song.id === 'short-title'))
  assert.equal(current().data.choiceTitleScrollStyle, '', '放得下的标题保持静止')
  key('Backspace')

  home.activate(home.data.songs.findIndex(song => song.id === 'long-title'))
  const { choiceSongName, choiceTitleWidth, choiceTitleScrollStyle, choiceWidth, choiceHeight } = current().data
  assert.equal(choiceSongName, longTitle, '保留整首歌名')
  const [, textWidth, distance] = choiceTitleScrollStyle.match(/width: (\d+)px; --choice-title-end: -(\d+)px/)
  assert.ok(Number(distance) > 0, '超出标题区域的名字需要滚动')
  assert.equal(Number(textWidth) - Number(distance), choiceTitleWidth, '末尾停留时完整显示歌名最后一段')
  assert.equal(choiceWidth, 448)
  assert.equal(choiceHeight, 328)
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
  advance(450)
  assert.equal(current(), categories, '双击只退到语种选择')
  assert.equal(categories.data.phase, 'categories')
  assert.equal(key('Backspace', { delay: 120 }), true)
  assert.equal(current(), categories, '双击补发的返回键不能再退一层')
  assert.deepEqual(selected, [], '双击不能提交下载')
  key('GlobalHook')
  key('GlobalHook', { delay: 180 })
  assert.equal(key('Backspace', { delay: 50, pressed: true }), false)
  assert.equal(current(), categories)
  assert.equal(key('Backspace', { delay: 50, appOnly: true }), false, '宿主产生返回键后直接由宿主处理')
  assert.equal(current(), home)
  advance(150)
  assert.equal(key('Backspace', { delay: 100 }), true, '返回首页后仍会拦住双击补发的返回键')
  key('Enter', { delay: 500 })
  assert.equal(current().data.phase, 'categories', '返回后保留音乐下载选中，确认可重新进入')
  key('GlobalHook')
  key('GlobalHook', { delay: 180 })
  advance(450)
  assert.equal(current(), home, '只有镜腿触摸事件时也能从语种页返回首页')
}

async function checkDownloadCancellation() {
  let pending
  const { current, key, openDownload } = createTestApp([{ id: 'first', category: '中文' }], {
    downloadSong(id, variant, options) {
      return new Promise(resolve => { pending = { id, variant, ...options, resolve } })
    }
  })
  const categories = openDownload()
  categories.onTapDownloadCategory({ target: { id: 'download-category-zh' } })
  await new Promise(setImmediate)
  const list = current()
  list.onTapDownloadSong({ currentTarget: { id: 'download-song-first' } })
  assert.equal(list.data.choiceVisible, true)
  assert.equal(pending, undefined)
  list.onConfirmDownload()
  assert.equal(pending.variant, 'guide')
  pending.onProgress({ bytes: 1, total: 2 })
  assert.equal(list.data.downloadProgress, 50)
  assert.equal(key('Backspace'), true)
  assert.equal(pending.signal.aborted, true)
  pending.resolve({ offline: true, downloadedVariants: { guide: true, instrumental: false } })
  await new Promise(setImmediate)
  assert.equal(current(), categories)
  assert.equal(list.data.downloadProgress, 0)
  assert.equal(list.data.phase, 'songs')
  key('Backspace')
}

async function checkPartiallyDownloadedHome() {
  const { home, current, key, openDownload, advance, stack } = createTestApp([
    { id: 'red-high-heels', name: '红色高跟鞋', category: '中文', downloadedVariants: { guide: false, instrumental: true } }
  ])
  const categories = openDownload()
  await new Promise(setImmediate)
  categories.onTapDownloadSong({ currentTarget: { id: 'download-song-red-high-heels' } })
  const list = current()
  assert.equal(list.data.choiceVisible, true, '点击语种预览中的歌曲直接打开版本选择')
  await new Promise(setImmediate)
  assert.equal(list.data.choiceDownloaded.instrumental, true)
  key('Backspace')
  key('Backspace')
  key('Backspace')
  await new Promise(setImmediate)
  const index = home.data.songs.findIndex(song => song.id === 'red-high-heels')
  assert.ok(index >= 0, '只下载一版的歌曲也应出现在首页')
  home.onTapSong({ currentTarget: { dataset: { idx: index } } })
  const chooser = current()
  assert.notEqual(chooser, home)
  assert.equal(chooser.data.choiceReady, false)
  advance(850)
  assert.equal(chooser.data.choiceFallback, true)
  assert.equal(chooser.data.choiceIndex, 1)
  assert.equal(chooser.data.choiceAvailable[0], false)
  chooser.onTapChoice({ currentTarget: { dataset: { idx: 0 } } })
  assert.equal(chooser.data.choiceIndex, 1, '点按不可用版本不生效')
  key('ArrowUp')
  assert.equal(chooser.data.choiceIndex, 2, '备用按键导航会跳过未下载的版本')
  key('ArrowUp')
  key('Enter')
  assert.deepEqual(current().query, { songId: 'red-high-heels', mode: 'instrumental' })
  assert.equal(stack.length, 2, '从演唱页返回时直接进入首页')
}

async function checkHeadAiming() {
  let sensor
  let largestArc = 0
  let arcProgress = 0
  let renderedReticle
  let bar
  class OrientationSensor {
    constructor() { sensor = this; this.listeners = new Map() }
    start() { this.running = true }
    stop() { this.running = false }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    removeEventListener(type) { this.listeners.delete(type) }
    read(quaternion) {
      this.quaternion = quaternion
      this.hasReading = true
      this.listeners.get('reading')?.()
    }
  }
  const { home, key, current, advance, phraseAimSession, createCanvas } = createTestApp([
    { id: 'aim-song', name: '测试歌曲', downloadedVariants: { guide: false, instrumental: true } }
  ], {
    AbsoluteOrientationSensor: OrientationSensor,
    onChoiceClear() {
      bar = null
      arcProgress = 0
    },
    onChoiceLine(x1, y1, x2, y2) { bar = { x1, y1, x2, y2 } },
    onChoiceArc(x, y, radius, start, end) {
      if (radius === 12 && start === -Math.PI / 2) {
        largestArc = Math.max(largestArc, end - start)
        arcProgress = (end - start) / (2 * Math.PI)
      }
      if (radius === 2) renderedReticle = { x, y }
    }
  })
  await home.refreshCatalog()
  const selectSong = () => {
    home.activate(home.data.songs.findIndex(song => song.id === 'aim-song'))
    return current()
  }
  let chooser = selectSong()
  assert.equal(chooser.data.choiceWidth, 448)
  assert.equal(chooser.data.choiceHeight, 328)
  advance(780)
  assert.equal(chooser.data.choiceReady, false)
  advance(40)
  assert.equal(chooser.data.choiceReady, true)
  assert.equal(chooser.data.choiceFallback, false)
  sensor.read([0, 0, 0, 1])
  const [guide, instrumental, phrase] = chooser.data.choiceBoxes
  assert.equal(guide.y, instrumental.y)
  assert.ok(phrase.y > guide.y)

  function aim(box, duration) {
    const { choiceWidth: width, choiceHeight: height } = chooser.data
    const yaw = box ? (box.x + box.width / 2 - width / 2) * 0.65 / width : 0
    const pitch = box ? (height / 2 - box.y - box.height / 2) * 0.50 / height : 0
    const a = Math.sin(pitch / 2), b = -Math.sin(yaw / 2)
    const c = Math.cos(pitch / 2), d = Math.cos(yaw / 2)
    for (let time = 0; time < duration && sensor.running; time += 32) {
      sensor.read([a * d, b * c, -b * a, c * d])
      advance(32)
    }
  }
  function centeredBarWidth(box) {
    assert.ok(bar, '停留瞄准时绘制按钮进度')
    assert.ok(Math.abs((bar.x1 + bar.x2) / 2 - (box.x + box.width / 2)) < 1e-6, '进度以按钮中心对称展开')
    assert.equal(bar.y1, bar.y2)
    assert.ok(bar.y1 > box.y + box.height * 0.8 && bar.y1 < box.y + box.height, '进度位于按钮底部内侧')
    return bar.x2 - bar.x1
  }
  aim(guide, 1200)
  assert.equal(chooser.data.choiceIndex, -1, '未下载版本无法瞄准确认')
  assert.equal(largestArc, 0)
  assert.equal(bar, null, '不可选的按钮不绘制进度')
  aim(instrumental, 540)
  assert.equal(current(), chooser, '只停留半圈不会进入演唱')
  const firstWidth = centeredBarWidth(instrumental)
  const firstProgress = arcProgress
  aim(instrumental, 160)
  const nextWidth = centeredBarWidth(instrumental)
  assert.ok(nextWidth > firstWidth)
  assert.ok(Math.abs(nextWidth / firstWidth - arcProgress / firstProgress) < 1e-6, '按钮横条和圆环以相同比例增长')
  aim(null, 210)
  assert.equal(chooser.data.choiceIndex, -1)
  assert.equal(bar, null, '视线移开时清除按钮进度')
  aim(instrumental, 590)
  assert.equal(current(), chooser, '离开按钮后应重新计算停留时间')
  advance(500)
  assert.equal(chooser.data.choiceIndex, -1, '传感器断流后取消等待')
  assert.equal(current(), chooser)
  key('GlobalHook', { pressed: true, appOnly: true })
  key('GlobalHook', { delay: 100 })
  assert.equal(current(), chooser, '按下和抬起属于一次点按')
  key('GlobalHook', { delay: 100, pressed: true, appOnly: true })
  advance(450)
  assert.equal(current(), home, '双击镜腿回到选歌')
  assert.equal(sensor.running, false, '离开选择时停止姿态采样')

  chooser = selectSong()
  advance(850)
  sensor.read([0, 0, 0, 1])
  aim(phrase, 1240)
  assert.deepEqual(current().query, { songId: 'aim-song', guide: '0', instrumental: '1' })
  assert.ok(largestArc >= Math.PI * 2 - 1e-6, '确认前进度沿圆周填满')
  assert.equal(sensor.running, true, '进入练句继续使用同一传感器')
  const { aim: practice } = phraseAimSession.current
  const previousX = practice.x
  const previousY = practice.y
  assert.ok(Math.abs(previousY - phrase.y - phrase.height / 2) < 1, '准星留在已确认按钮的位置')
  const sameSensor = sensor
  const lastPose = sensor.quaternion
  const width = 480
  const height = 352
  let confirmations = 0
  const practicePage = {
    data: { choiceAvailable: [true] }, showChoiceControls() {}, setChoiceFocus() {},
    confirmChoice() { confirmations++ }
  }
  const practiceBox = { x: 0, y: 0, width, height }
  practice.bindPage(practicePage, { width, height, boxes: [practiceBox] }, createCanvas)
  advance(16)
  assert.equal(sensor, sameSensor, '转移画布不重启姿态会话')
  assert.equal(practice.x, previousX)
  assert.equal(practice.y, previousY, '第一帧沿用原来的屏幕坐标，即使接收画布尺寸不同')
  for (let index = 0; index < 35; index++) {
    sensor.read(lastPose)
    advance(32)
  }
  assert.ok(Math.abs(practice.y - previousY) < 1, '相同头部姿态继续指向原位置')
  assert.equal(confirmations, 0, '跨页停留没有自动确认')
  assert.equal(bar, null, '切到练句后不会沿用上一页的进度')
  aim(instrumental, 630)
  assert.ok(Math.abs(practice.y - previousY) > 30, '接收页面能够继续跟随头部姿态')
  assert.equal(confirmations, 0, '移动到新位置后需重新停留一圈')
  assert.ok(centeredBarWidth(practiceBox) > 0)
  aim(instrumental, 580)
  assert.equal(confirmations, 1)

  aim({ x: 355, y: 11, width: 80, height: 35 }, 480)
  const pickerEntry = { x: practice.x, y: practice.y }
  assert.ok(pickerEntry.x > 390 && pickerEntry.y < 30, '练唱的选句按钮位于右上角')
  const pickerBox = { x: 80, y: 200, width: 100, height: 70 }
  const pickerPage = { data: { choiceAvailable: [true] }, showChoiceControls() {}, setChoiceFocus() {} }
  practice.bindPage(pickerPage, { width: 416, height: 304, boxes: [pickerBox] }, createCanvas)
  practice.unbindPage(practicePage)
  advance(16)
  assert.deepEqual(renderedReticle, pickerEntry, '第一帧准星画在同一个右上角坐标')

  aim({ x: 105, y: 225, width: 50, height: 30 }, 480)
  assert.ok(centeredBarWidth(pickerBox) > 0, '选句页使用相同的停留进度')
  const pickerExit = { x: practice.x, y: practice.y }
  practice.unbindPage(pickerPage)
  sensor.read([0, 0, 0, 1])
  practice.bindPage(practicePage, { width, height, boxes: [] }, createCanvas)
  advance(16)
  assert.deepEqual(renderedReticle, pickerExit, '返回时第一帧仍绘制在选句页最后的位置')
  advance(16)
  assert.ok(Math.abs(renderedReticle.x - pickerExit.x) <= 18 && Math.abs(renderedReticle.y - pickerExit.y) <= 18,
    '切换发生在转头期间时，后续帧平滑追上最新姿态')
  practice.stop()
  assert.equal(sameSensor.running, false, '结束练句流程后释放同一个传感器')

  chooser = selectSong()
  advance(850)
  sensor.read([0, 0, 0, 1])
  aim(instrumental, 1250)
  assert.equal(sensor.running, false, '开始伴奏后停止使用传感器')
  assert.deepEqual(current().query, { songId: 'aim-song', mode: 'instrumental' })
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

function checkGyroAimingHandoff() {
  let sensor
  class Gyroscope extends EventTarget {
    constructor() { super(); sensor = this }
    start() {}
    stop() {}
    read(y) {
      Object.assign(this, { x: 0, y, z: 0, hasReading: true })
      this.dispatchEvent(new Event('reading'))
    }
  }
  const { advance, createCanvas, createChoice } = createTestApp([], { Gyroscope })
  const page = { data: { choiceAvailable: [] }, showChoiceControls() {}, setChoiceFocus() {} }
  const layout = { width: 448, height: 328, boxes: [] }
  const first = createChoice(page, layout)
  first.start({ transition: false })
  for (let index = 0; index < 18; index++) {
    sensor.read(-0.55)
    advance(16)
  }
  const { x, yaw } = first
  const sameSensor = sensor
  assert.ok(x > layout.width * 0.6)
  first.unbindPage(page)
  advance(600)

  first.bindPage({ ...page }, layout, createCanvas)
  advance(16)
  assert.equal(sensor, sameSensor)
  assert.equal(first.x, x)
  sensor.read(-0.55)
  assert.equal(first.yaw, yaw, '不会把陀螺仪停止更新的时间算进积分')
  for (let index = 0; index < 10; index++) {
    advance(16)
    sensor.read(-0.55)
  }
  assert.ok(first.x > x + 20, '接续陀螺仪角度后准星继续响应转头')
  first.stop()
}

function checkPageSensorAimingHandoff() {
  class Orientation extends EventTarget {
    read(yaw) {
      this.quaternion = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
      this.hasReading = true
      this.dispatchEvent(new Event('reading'))
    }
  }
  const createPage = () => ({
    data: { choiceAvailable: [] }, showChoiceControls() {}, setChoiceFocus() {},
    enableWorldAwareness() { this.orientationSensor = new Orientation() },
    disableWorldAwareness() { this.disabled = true }
  })
  const { advance, createCanvas, createChoice } = createTestApp([])
  const layout = { width: 448, height: 328, boxes: [] }
  const first = createPage()
  const aim = createChoice(first, layout)
  aim.start({ transition: false })
  first.orientationSensor.read(0)
  for (let index = 0; index < 18; index++) {
    advance(16)
    first.orientationSensor.read(-0.2)
  }
  const x = aim.x
  assert.ok(x > 350)

  const second = createPage()
  aim.bindPage(second, layout, createCanvas)
  assert.ok(first.disabled, '宿主只支持页面传感器时释放上一页实例')
  for (let index = 0; index < 11; index++) {
    second.orientationSensor.read(1.5)
    advance(16)
  }
  assert.equal(aim.x, x, '新传感器基准不同也继续显示在原处')
  for (let index = 0; index < 11; index++) {
    second.orientationSensor.read(1.6)
    advance(16)
  }
  assert.ok(aim.x < x - 50, '在当前屏幕坐标基础上应用后续转头')
  aim.stop()
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
  await checkHomeFocusAfterReturning()
  await checkHomeVoiceSelection()
  await checkHomeVoiceCatalogRace()
  await checkVoiceCaptureAndRecovery()
  await checkChooserNativeAndLogicalBack()
  await checkBackDuringAudioPreload()
  await checkChooserTitleOverflow()
  await checkTempleFallback()
  await checkDownloadCancellation()
  await checkPartiallyDownloadedHome()
  await checkHeadAiming()
  checkGyroAimingHandoff()
  checkPageSensorAimingHandoff()
  await checkUnavailableCatalog()
  await checkSongRequests()
  console.log('PASS  穿越转场、跨页准星续接、头动停留确认、镜腿双击返回、音乐下载和留言')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
