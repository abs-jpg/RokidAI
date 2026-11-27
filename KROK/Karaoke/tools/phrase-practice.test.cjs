const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setImmediate: drain } = require('node:timers/promises')
const vm = require('node:vm')
const realPerformance = globalThis.performance

async function checkPractice() {
  const { PhrasePractice, phraseLines } = await import('../utils/phrasePractice.js')
  let now = 0
  globalThis.performance = { now: () => now }
  const chart = {
    name: '测试歌曲', category: '中文', durationMs: 3600,
    lyrics: [
      { startMs: 2400, endMs: 3800, text: '下一句' },
      { startMs: 2000, endMs: 2400, text: '對這個世界' },
      { startMs: 800, endMs: 1000, text: ' ' }
    ],
    refNotes: [{ startMs: 1950, endMs: 2400, midi: 69 }]
  }
  assert.deepEqual(phraseLines(chart).map(line => [line.startMs, line.endMs]), [[2000, 2400], [2400, 3600]])
  let view, player, input
  let startAt
  let heard
  let releaseResult
  const practice = new PhrasePractice(chart, {
    update(next) { view = next },
    openPlayer(fromMs) {
      startAt = fromMs
      player = { currentTime: fromMs / 1000, ready: Promise.resolve(), play() { this.playedAt = now },
        pause() { this.paused = true }, destroy() { this.destroyed = true } }
      return player
    },
    openInput(onPartial) {
      heard = onPartial
      input = {
        offsetMs: 0, ready: Promise.resolve(), begin() { this.beganAt = now },
        sample() { return { midi: 57, voiceActive: true } },
        finish() { return new Promise(resolve => { releaseResult = resolve }) },
        close() { this.closed = true }
      }
      return input
    }
  })
  const tickAfter = ms => { now += ms; practice.tick(practice.round) }

  async function confirmStart() {
    const startedAt = now
    assert.equal(view.countdownDots, '●  ●  ●')
    tickAfter(999)
    assert.equal(view.countdownDots, '●  ●  ●')
    tickAfter(1)
    assert.equal(view.countdownDots, '●  ●')
    tickAfter(999)
    assert.equal(input.beganAt, undefined)
    tickAfter(1)
    assert.equal(view.countdownDots, '●')
    assert.equal(input.beganAt, startedAt + 2000)
    tickAfter(999)
    assert.equal(player.playedAt, undefined)
    tickAfter(1)
    assert.equal(player.playedAt, startedAt + 3000)
    assert.equal(view.countdownDots, '')
    await drain()
    assert.equal(view.phase, 'singing')
  }

  async function completeTiming() {
    await confirmStart()
    for (let timeMs = 2020; timeMs < 2400; timeMs += 40) {
      player.currentTime = timeMs / 1000
      tickAfter(40)
    }
    player.currentTime = 2.4
    tickAfter(20)
    assert.ok(player.paused)
    practice.round.stopAt -= 60
    practice.tick(practice.round)
    assert.equal(view.phase, 'settling')
  }

  practice.emit()
  assert.equal(view.choiceAvailable[0], false)
  practice.activate(4)
  assert.equal(view.picker, true)
  practice.activate(0)
  assert.equal(view.picker, false)
  await practice.start(false)
  assert.equal(startAt, 2000, '三秒等待后从所选句的开头播放')
  await completeTiming()
  releaseResult({ text: '对这个世界！', state: 'ok' })
  await drain()
  assert.equal(view.lastAttempt, '第 1 次')
  assert.equal(view.lyricScore, '100%')
  assert.equal(view.pitchScore, '100%')
  assert.equal(view.pitchDetail, '音高覆盖 100%')

  await practice.start(false)
  assert.equal(view.lyricScore, '—', '重唱清除上一轮的可见分数')
  await completeTiming()
  const oldInput = input
  const oldPlayer = player
  practice.activate(2)
  assert.ok(oldInput.closed && oldPlayer.destroyed)
  heard('迟到的识别结果')
  releaseResult({ text: '对这个世界', state: 'ok' })
  await drain()
  assert.match(view.lineText, /下一句/)
  assert.equal(view.lyricScore, '—')
  assert.equal(view.choiceAvailable[2], false)
  practice.activate(0)
  assert.equal(view.lastAttempt, '第 1 次', '取消的轮次不能更新上次成绩')
  assert.equal(view.centerLabel, '再练一次')

  await practice.start(false)
  await completeTiming()
  releaseResult({ state: 'timeout' })
  await drain()
  assert.equal(view.lastAttempt, '第 2 次')
  assert.equal(view.lyricScore, '—')
  assert.equal(view.heardText, '语音识别超时')
  assert.equal(view.pitchScore, '100%')

  await practice.start(false)
  await confirmStart()
  player.currentTime = 2.15
  tickAfter(150)
  const interruptedInput = input
  player.destroy = () => { throw new Error('模拟播放器释放失败') }
  const warn = console.warn
  try {
    console.warn = () => {}
    practice.activate(1)
  } finally { console.warn = warn }
  assert.equal(view.canStop, false)
  assert.ok(interruptedInput.closed, '播放释放出错后仍停止麦克风')
  assert.equal(view.phase, 'result')
  assert.equal(view.lastAttempt, '第 2 次', '手动停止取消本次并恢复上次成绩')
  assert.equal(view.centerLabel, '再练一次')

  await practice.start(true)
  await drain()
  assert.equal(startAt, 2000, '示范和练唱从同一个歌词起点播放')
  assert.equal(view.phase, 'listening')
  player.currentTime = 2.36
  practice.tick(practice.round)
  assert.equal(player.paused, undefined, '示范播放到句末前继续播放')
  player.currentTime = 2.4
  practice.tick(practice.round)
  assert.ok(player.paused && player.destroyed, '示范停在选句末尾')
}

async function checkPhrasePage() {
  const { PhrasePractice, practiceLayout } = await import('../utils/phrasePractice.js')
  const chart = {
    category: '中文', durationMs: 8000,
    lyrics: Array.from({ length: 7 }, (_, index) => ({
      text: `第 ${index + 1} 句`, startMs: (index + 1) * 1000, endMs: (index + 2) * 1000
    }))
  }
  const pickerMarkup = fs.readFileSync(path.join(__dirname, '../pages/phrase-picker/picker.ink'), 'utf8')
  const controls = [...pickerMarkup.matchAll(/style="{{controls\[(\d)\]}}" bindtap="onTapControl" data-index="\1"/g)]
  assert.deepEqual(controls.map(match => Number(match[1])), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.match(pickerMarkup, /<style>\s*\.picker-screen\s*\{/)
  let now = 0
  let nextTimer = 0
  let programBacks = 0
  const pending = new Map()
  const app = { globalData: {} }
  const phraseAimSession = { current: null }
  const home = {}
  const stack = [home]
  const current = () => stack.at(-1)
  const guardSource = fs.readFileSync(path.join(__dirname, '../utils/downloadReturn.js'), 'utf8')
    .replace(/^export /gm, '')
  const guards = vm.runInNewContext(guardSource + '\n;({ clearDownloadInputPage, isDownloadReturnEcho, ' +
    'isReturnKey, isRecentReturn, rememberDownloadReturn, setDownloadInputPage, takeDownloadInput, forwardDownloadInput })',
    { Date: { now: () => now } })
  const runtime = {
    ...guards,
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++nextTimer
      pending.set(id, { callback, due: now + delay })
      return id
    },
    clearTimeout(id) { pending.delete(id) },
    getApp: () => app,
    phraseAimSession,
    wx: {
      navigateTo({ url }) {
        assert.equal(url, '/pages/phrase-picker/picker')
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'))
        assert.ok(manifest.pages.includes(url.slice(1)))
        current().onHide()
        const picker = createPage('phrase-picker/picker')
        stack.push(picker)
        picker.onLoad()
        picker.onShow()
      },
      navigateBack({ delta, success, fail }) {
        programBacks++
        assert.equal(delta, 1)
        if (stack.length === 1) fail()
        else {
          hostPop()
          success()
        }
      },
      redirectTo({ url, success }) {
        assert.equal(url, '/pages/home/home')
        current().onHide()
        current().onUnload()
        stack.splice(0, stack.length, home)
        success()
      }
    },
    async getSongFromLibrary() { return chart },
    getSongAudio(_song, mode) { return { src: mode + '.ogg' } },
    async readDownloadedAudio() { return null },
    practiceLayout,
    createPhrasePlayer: source => source,
    SongChoice: class {
      constructor(page, layout) { this.page = page; this.layout = layout }
      start() {}
      bindPage(page, layout) { this.page = page; this.layout = layout }
      unbindPage(page) { if (this.page === page) this.page = null }
      stop() {}
      requireMove() {}
    },
    PhrasePractice
  }
  const navigation = fs.readFileSync(path.join(__dirname, '../utils/phraseNavigation.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  Object.assign(runtime, vm.runInNewContext(navigation + '\n;({ PHRASE_PICKER_URL, PhraseBackInput, leavePhrasePage })', runtime))

  function createPage(route = 'phrase/phrase') {
    const pageSource = fs.readFileSync(path.join(__dirname, '../pages', route + '.ink'), 'utf8')
      .match(/<script setup>([\s\S]*?)<\/script>/)[1]
      .replace(/^import[^\n]*\n/gm, '').replace('export default', 'const page =')
    const options = vm.runInNewContext(pageSource + '\npage', { ...runtime })
    return { ...options, data: { ...options.data }, setData(update) { Object.assign(this.data, update) } }
  }

  function hostPop() {
    assert.ok(stack.length > 1, '宿主返回不能在同一手势中关闭首页')
    const old = stack.pop()
    old.onHide()
    old.onUnload()
    current().onShow?.()
  }

  function advance(ms) {
    const until = now + ms
    for (;;) {
      const next = [...pending].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
      if (!next) break
      const [id, { due, callback }] = next
      now = due
      pending.delete(id)
      callback()
    }
    now = until
  }

  function press(code, { pressed = false, appOnly = false, hostDefault = false, delay = 0 } = {}) {
    advance(delay)
    const event = {
      code,
      preventDefault() { this.prevented = true },
      stopPropagation() { this.stopped = true }
    }
    if (!appOnly) current()[pressed ? 'onKeyDown' : 'onKeyUp']?.(event)
    if (!event.stopped) guards.forwardDownloadInput(event, pressed)
    if (hostDefault && !event.prevented) hostPop()
    return !!event.prevented
  }

  const page = createPage()
  const aim = new runtime.SongChoice(null)
  Object.assign(aim, { x: 224, y: 228 })
  phraseAimSession.current = { songId: 'test-song', aim }
  stack.push(page)
  await page.onLoad({ songId: 'test-song', guide: '1', instrumental: '1' })
  assert.equal(page.model.services.openPlayer(2000, false).src, 'guide.ogg')
  assert.equal(page.model.services.openPlayer(2000, true).src, 'guide.ogg')
  assert.equal(page.model.services.openPlayer(2000, false).muted, undefined)
  page.onShow()
  assert.equal(page.aim, aim, '练唱直接绑定版本选择的准星控制器')
  assert.equal(aim.page, page)
  assert.equal(phraseAimSession.current.aim, aim, '准星留在共享会话里')
  page.data.canStop = true
  page.model.stop = () => { page.model.stopped = true }
  page.onTapControl({ currentTarget: { dataset: { index: 1 } } })
  assert.ok(page.model.stopped, '准星模式下直接点按停止也生效')

  Object.assign(aim, { x: 396, y: 28 })
  page.confirmChoice(4)
  const picker = current()
  assert.equal(picker.aim, aim, '打开选句页时复用同一个准星')
  assert.equal(aim.page, picker)
  assert.equal(aim.x, 396, '选句页从原先右上角的位置开始')
  assert.equal(aim.y, 28)
  assert.equal(stack.length, 3)
  assert.equal(picker.data.pickerRows.length, 5)
  assert.equal(picker.data.emptyText, '')
  assert.equal(picker.data.controls[0], 'left:12px;top:52px;width:424px;height:34px;')
  assert.equal(picker.data.controls[6], 'left:143px;top:260px;width:162px;height:42px;')
  assert.equal(picker.data.pickerRows[0].text, '第 1 句')
  assert.equal(picker.data.pickerRows[0].time, '0:01')
  assert.equal(picker.data.pickerRows[0].current, true)
  assert.equal(picker.data.choiceAvailable[5], false, '第一页显示禁用的上一页按钮')
  picker.confirmChoice(7)
  assert.equal(picker.data.pickerPosition, '2 / 2 页')
  assert.equal(picker.data.pickerRows[0].text, '第 6 句')
  assert.equal(picker.data.choiceAvailable[2], false, '尾页隐藏无歌词的空行')
  assert.equal(picker.data.choiceAvailable[6], true, '翻页后返回练唱按钮仍然可用')
  assert.equal(picker.data.choiceAvailable[7], false, '尾页显示禁用的下一页按钮')
  picker.confirmChoice(5)
  assert.equal(picker.data.pickerRows[0].text, '第 1 句')
  press('GlobalHook', { pressed: true, appOnly: true })
  press('GlobalHook', { delay: 70 })
  assert.equal(pending.size, 0, '镜腿单击留在选句')
  press('GlobalHook', { pressed: true, delay: 100, appOnly: true })
  assert.equal(pending.size, 1)
  Object.assign(aim, { x: 270, y: 76 })
  assert.equal(press('Backspace', { delay: 60, hostDefault: true }), false, '让宿主先返回一层')
  assert.equal(current(), page, '宿主默认返回从选句回到原练唱实例')
  assert.equal(page.aim, aim, '返回练唱时仍使用同一个准星')
  assert.equal(aim.page, page)
  assert.equal(aim.x, 270)
  assert.equal(aim.y, 76)
  assert.equal(press('Backspace', { appOnly: true, hostDefault: true }), true, '拦截宿主重复返回')
  advance(1000)
  assert.equal(programBacks, 0, '宿主已退页，取消应用的备用返回')
  assert.equal(app.globalData.phrasePicker, undefined)

  page.confirmChoice(4)
  Object.assign(aim, { x: 235, y: 108 })
  current().confirmChoice(1)
  assert.equal(current(), page)
  assert.equal(page.model.index, 1, '从独立选句页回传选择，复用练唱状态')
  assert.equal(aim.page, page)
  assert.equal(aim.x, 235)
  assert.equal(aim.y, 108, '确认歌词后也在上一帧的位置续接')

  page.confirmChoice(4)
  current().onTapControl({ currentTarget: { dataset: { index: 6 } } })
  assert.equal(current(), page, '选句页上的返回练唱按钮只退一层')
  assert.equal(page.model.index, 1)

  advance(400)
  const beforePracticeBack = programBacks
  press('GlobalHook')
  press('GlobalHook', { delay: 150, appOnly: true })
  press('Backspace', { delay: 100, appOnly: true, hostDefault: true })
  assert.equal(current(), home)
  assert.equal(phraseAimSession.current, null, '离开练唱时清理共享准星会话')
  assert.equal(press('Backspace', { appOnly: true, hostDefault: true }), true)
  advance(1000)
  assert.equal(programBacks, beforePracticeBack, '练唱退到首页后不会继续退出应用')

  const instrumentalOnly = createPage()
  await instrumentalOnly.onLoad({ instrumental: '1' })
  assert.equal(instrumentalOnly.model.services.openPlayer(2000, false).src, 'instrumental.ogg')
  assert.match(instrumentalOnly.data.audioHint, /未下载歌词版/)
  stack.push(instrumentalOnly)
  instrumentalOnly.onShow()
  instrumentalOnly.confirmChoice(4)
  hostPop()
  assert.equal(current(), instrumentalOnly, '即使宿主返回没派发按键，也按实际页面栈退一级')
  advance(400)
  const beforeRawBack = programBacks
  press('GlobalHook')
  press('GlobalHook', { delay: 150 })
  advance(500)
  assert.equal(current(), home, '只派发镜腿触摸的宿主由备用返回处理')
  assert.equal(programBacks, beforeRawBack + 1)
}

async function checkNativeAudio() {
  const { createPhrasePlayer, openPhraseCapture } = await import('../utils/phraseAudio.js')
  let sourcePlayer
  let sourceStreamStopped = false
  global.AudioPlayer = class {
    constructor() { this.currentTime = 0; sourcePlayer = this }
    onCanplay(callback) { this.canPlay = callback }
    onEnded() {}
    onError() {}
    set src(path) {
      this.path = path
      this.requestedAtLoad = this.startTime
      queueMicrotask(this.canPlay)
    }
    setBuffer(_bytes, format) { this.format = format; queueMicrotask(this.canPlay) }
    play() {
      this.playing = true
      this.volumeDuringStart = this.volume
      if (this.path) this.currentTime = this.requestedAtLoad
    }
    seek(time) {
      assert.equal(this.playing, true, '支持播放中的定位，暂停时不发出定位事件')
      this.currentTime = time
    }
    pause() { this.playing = false }
    destroy() {
      assert.equal(this.playing, false, '释放正在播放的片段前先暂停')
      this.destroyed = true
    }
  }
  const demo = createPhrasePlayer({ src: '/assets/songs/dao-xiang-guide.ogg' },
    29400, () => {}, () => assert.fail('不应触发播放错误'))
  await demo.ready
  assert.equal(sourcePlayer.requestedAtLoad, 29.4)
  await demo.play()
  assert.equal(demo.currentTime, 29.4)
  assert.equal(sourcePlayer.volume, 1)
  demo.destroy()

  const playback = createPhrasePlayer({ bytes: new ArrayBuffer(3), format: 'ogg', muted: true },
    2450, () => {}, () => assert.fail('不应触发播放错误'))
  await playback.ready
  assert.equal(playback.currentTime, 0, '加载完成可以开始倒数，无需等待暂停定位')
  await playback.play()
  assert.equal(playback.currentTime, 2.45)
  assert.equal(sourcePlayer.format, 'ogg')
  assert.equal(sourcePlayer.volume, 0)
  playback.destroy()
  assert.equal(sourcePlayer.destroyed, true)

  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: { async getUserMedia() { return { getTracks: () => [{ stop() { sourceStreamStopped = true } }] } } }
  })
  global.AudioContext = class {
    state = 'running'
    sampleRate = 16000
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createAnalyser() {
      return { context: this, getFloatTimeDomainData(buffer) {
        for (let i = 0; i < buffer.length; i++) buffer[i] = 0.1 * Math.sin(i * 2 * Math.PI * 440 / 16000)
      } }
    }
    async close() {}
  }
  let recognition
  let abortAttempts = 0
  const writes = []
  global.SpeechRecognitionSession = class {
    static async getCapabilities() {
      return { audioFormats: [{ mimeType: 'audio/ogg;codecs=opus' }], interimResults: true }
    }
    constructor(options) {
      recognition = this
      assert.equal(options.lang, 'zh-CN')
      this.audio = { getWriter: () => ({
        abort() { abortAttempts++; throw new Error('模拟原生取消识别失败') },
        async write(chunk) { writes.push(chunk) },
        close: async () => {
          assert.equal(writes.length, 1, 'ASR 关闭前必须发送最后一个录音块')
          this.onresult({ results: [{ isFinal: true, 0: { transcript: '对这个世界' } }] })
          this.onend()
        }
      }) }
    }
  }
  global.MediaRecorder = class {
    static isTypeSupported() { return true }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: { size: 3 } })
      this.onstop?.()
    }
  }
  let interim
  const capture = openPhraseCapture(text => { interim = text }, '中文')
  await capture.ready
  capture.begin()
  recognition.onresult({ results: [{ isFinal: false, 0: { transcript: '对这个' } }] })
  assert.equal(interim, '对这个')
  assert.ok(Math.abs(capture.sample().midi - 69) < 0.1)
  assert.deepEqual(await capture.finish(), { text: '对这个世界', state: 'ok' })
  capture.close()
  assert.ok(sourceStreamStopped)

  sourceStreamStopped = false
  const cancelled = openPhraseCapture(() => {}, '中文')
  await cancelled.ready
  cancelled.begin()
  cancelled.close()
  assert.ok(sourceStreamStopped, '取消 ASR 出错时仍释放麦克风')
  await drain()
  assert.equal(abortAttempts, 1)
}

checkPractice().finally(() => { globalThis.performance = realPerformance }).then(checkPhrasePage).then(checkNativeAudio).then(() => {
  console.log('PASS  逐级返回、歌词版练唱、播放中停止、三点倒数、逐句定位与 ASR 尾包')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
