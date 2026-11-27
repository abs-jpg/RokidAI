const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const raw = readFileSync(join(__dirname, '../pages/record/record.ink'), 'utf8')
const source = raw.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'page =')

function createPage(overrides = {}) {
  let countdownTick
  let nextId = 0
  const timeouts = new Map()
  const page = vm.runInNewContext(source, {
    performance,
    console: { error() {}, log() {} },
    setInterval(fn) { countdownTick = fn; return 1 },
    clearInterval() {},
    setTimeout(callback) { const id = ++nextId; timeouts.set(id, callback); return id },
    clearTimeout(id) { timeouts.delete(id) },
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    createPitchDetector: () => () => 440,
    createVoiceActivityDetector: () => () => true,
    measureBattleClock() {},
    localBattleStart: () => Date.now(),
    AudioContext: class {
      constructor() {
        this.sampleRate = 48000
        this.baseLatency = 0.01
      }
      async resume() {}
      async close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createAnalyser() { return { fftSize: 4096 } }
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] }
        }
      }
    },
    SpeechRecognitionSession: class {},
    MediaRecorder: class {},
    wx: { setStorageSync() {} },
    ...overrides
  })
  page.setData = (update, callback) => {
    Object.assign(page.data, update)
    callback?.()
  }
  page.player = { play: async () => {}, destroy() {} }
  page.song = {
    id: 'test-song',
    category: '中文',
    durationMs: 1000,
    refNotes: [{ startMs: 0, endMs: 1000, midi: 60 }],
    lyrics: []
  }
  const runScheduled = (callbacks, id) => {
    const callback = callbacks.get(id)
    callbacks.delete(id)
    callback?.()
  }
  return {
    page,
    tick: () => countdownTick?.(),
    runTimeout: id => runScheduled(timeouts, id)
  }
}

async function main() {
  const pitchRanges = []
  const detector = {
    createPitchDetector(_analyser, minHz, maxHz) {
      pitchRanges.push([minHz, maxHz])
      return () => 440
    }
  }
  const solo = createPage(detector)
  let soloStarts = 0
  solo.page.startRecognition = () => { soloStarts++ }
  solo.page.playAccompaniment = async () => {}
  await solo.page.requestMicrophone()
  solo.tick()
  assert.equal(soloStarts, 0, '倒数到 2 时不应提前转写')
  solo.tick()
  assert.equal(soloStarts, 1, '单人演唱开始时必须启动 ASR')
  solo.tick()
  assert.equal(soloStarts, 1, '倒计时结束时不得重复启动 ASR')

  const session = {}
  solo.page.recognition = session
  solo.page.recognizedFinalText = ''
  solo.page.applyRecognitionResult({
    resultIndex: 0,
    results: [{ 0: { transcript: '第一句识别文本' }, isFinal: true }]
  }, session)
  assert.equal(solo.page.data.asrDisplayText, '第一句识别文本')
  assert.equal(solo.page.recognizedFinalText, '第一句识别文本')
  solo.page.applyRecognitionResult({
    resultIndex: 1,
    results: [{ 0: { transcript: '第一句识别文本已经完成' }, isFinal: true }]
  }, session)
  assert.equal(solo.page.recognizedFinalText, '第一句识别文本已经完成',
    '累计结果以旧文本为前缀时必须替换而不是重复追加')
  assert.equal(solo.page.data.asrDisplayText, '第一句识别文本已经完成')
  solo.page.applyRecognitionResult({
    resultIndex: 2,
    results: [{ 0: { transcript: '已经完成下一句' }, isFinal: true }]
  }, session)
  assert.equal(solo.page.recognizedFinalText, '第一句识别文本已经完成下一句',
    '普通重叠分句只追加未重复的部分')
  solo.page.applyRecognitionResult({
    resultIndex: 8,
    results: [{ 0: { transcript: '实时内容' }, isFinal: false }]
  }, session)
  solo.page.flushRecognitionDisplay()
  assert.match(solo.page.data.asrDisplayText, /实时内容/)
  const longLine = '这是一段用于测试横向滚动显示的长识别文本'.repeat(12)
  solo.page.applyRecognitionResult({
    resultIndex: 9,
    results: [{ 0: { transcript: longLine }, isFinal: true }]
  }, session)
  assert.ok(longLine.endsWith(solo.page.data.asrDisplayText), '新文本与长句尾部应在同一次更新中显示')
  assert.ok(solo.page.data.asrDisplayText.length <= 15, '中文长句应在一屏内渲染')
  solo.page.applyRecognitionResult({
    resultIndex: 0,
    results: [{ 0: { transcript: '上一句迟到结果' }, isFinal: true }]
  }, session)
  assert.match(solo.page.data.asrDisplayText, /上一句迟到结果$/, 'ASR 必须跨歌词行连续显示最新一句')
  assert.match(solo.page.recognizedFinalText, /上一句迟到结果/, '后台仍须保存完整识别结果')
  assert.ok(solo.page.recognizedFinalText.length > 200)
  assert.ok(Array.from(solo.page.data.asrDisplayText).length <= 16)
  const beforePause = solo.page.data.asrDisplayText
  solo.page.applyRecognitionResult({ results: [{ 0: { transcript: ' ' }, isFinal: false }] }, session)
  solo.page.flushRecognitionDisplay()
  assert.equal(solo.page.data.asrDisplayText, beforePause, '空识别回调要保留上一条字幕')
  solo.page.applyRecognitionResult({ results: [
    { 0: { transcript: '确认当前句' }, isFinal: true },
    { 0: { transcript: '正在说下一句' }, isFinal: false }
  ] }, session)
  assert.match(solo.page.data.asrDisplayText, /正在说下一句$/,
    '同一回调有上一句的最终结果时也应及时显示新临时结果')
  assert.doesNotMatch(solo.page.recognizedFinalText, /正在说下一句/)
  solo.page.applyRecognitionResult({ results: [{ 0: { transcript: 'Words keep coming and this is the newest text' }, isFinal: false }] }, session)
  solo.page.flushRecognitionDisplay()
  assert.match(solo.page.data.asrDisplayText, /the newest text$/, '混合语言更新时应保留最新词')
  assert.ok(solo.page.data.asrDisplayText.length < 30)

  const battle = createPage(detector)
  let battleStarts = 0
  battle.page.isBattle = true
  battle.page.roomId = 'room'
  battle.page.roundId = 'round'
  battle.page.sendRound = () => true
  battle.page.startRecognition = () => { battleStarts++ }
  battle.page.playAccompaniment = async () => {}
  await battle.page.requestMicrophone()
  assert.equal(battle.page.data.phase, 'battleReady')
  assert.deepEqual(pitchRanges, [[40, 1200], [40, 1200]], '单人和联机必须使用同一检测音域')
  battle.page.startAtLocal = Date.now()
  battle.page.scheduleBattleStart()
  assert.equal(battleStarts, 1, '联机同步开唱时必须启动 ASR')
  assert.doesNotMatch(source, /if \(this\.isBattle \|\| !this\.mediaStream\) return/)
  assert.doesNotMatch(source, /options\.phrases/, '不能把长歌词当作 ASR 热词发送')
  assert.match(source, /const stream = this\.mediaStream[\s\S]*new MediaRecorder\(stream/, '必须使用 Rokid 兼容的原始麦克风流')
  assert.doesNotMatch(source, /createMediaStreamDestination/, '不能使用不兼容的派生音频流')
  const resultSource = readFileSync(join(__dirname, '../pages/result/result.ink'), 'utf8')
  assert.doesNotMatch(resultSource, /calcLyricMatchScore/, 'ASR 识别文本不得参与正式评分')
  assert.match(raw, /class="guide-line"/, '演唱页必须保留音高提示线')
  assert.match(raw, /class="song-key"[^>]*>调性/, '演唱页必须显示歌曲调性')
  assert.match(raw, /class="lyric lyric-target"/, '演唱页必须显示一行歌词')
  assert.match(raw, /class="lyric lyric-next"/, '演唱页必须显示下一句歌词')
  assert.match(raw, /class="recognized-label">ASR</, '歌词下方必须有 ASR 行')
  assert.match(raw, /<view class="recognized-viewport[^\"]*">\s*<text class="lyric lyric-recognized">\{\{asrDisplayText\}\}<\/text>/,
    '在视口中直接绘制可见文本，避免滚到未绘制区域')
  assert.doesNotMatch(raw, /lyric-recognized" ink:if="\{\{recognizedText\}\}"/,
    'ASR 内容和占位提示不能通过条件节点互相替换，避免换行闪烁')
  assert.doesNotMatch(raw, /recognizedText \|\| asrStatusText/, '识别中不能和识别文本共用滚动内容')
  assert.match(raw, /\{\{asrDisplayText\}\}/, 'ASR 节点必须始终有不可见占位内容以保持显示')
  assert.match(raw, /border-bottom: 1px solid rgba\(76,199,115,0\.18\)/, 'ASR 显示区域必须有常驻细线')
  assert.match(raw, /\.recognized-viewport\s*\{[^}]*width: 240px;[^}]*height: 24px;/)
  assert.doesNotMatch(raw, /asrLineReady|asrIgnoreUntil|asrLineUnlockTimer/,
    '歌词换行不能清空或暂停 ASR')
  assert.ok(raw.indexOf('lyric-target') < raw.indexOf('lyric-next') &&
    raw.indexOf('lyric-next') < raw.indexOf('recognized-label'), '提词器必须保持当前歌词、下一句、ASR 三行顺序')

  const fitted = createPage({ Canvas: class {
    getContext() {
      return { measureText: text => ({ width: Array.from(text).length * 13 }) }
    }
  } }).page
  fitted.scheduleRecognitionDisplay('这是一段连续显示的中文字幕'.repeat(8), true)
  assert.equal(fitted.data.asrDisplayText.length, 18, '窄字能用满横线内剩余空间')
  assert.equal(fitted.data.asrDisplayFull, true, '满行字幕应靠右对齐')
  fitted.scheduleRecognitionDisplay('短字幕', true)
  assert.equal(fitted.data.asrDisplayFull, false, '未填满时应保留原本的左侧起点')

  await checkRecognitionRecovery()
  checkBattlePitchDisplay()
  console.log('PASS  单人与联机 ASR 启动、长字幕续写、临时结果连续显示和断线恢复')
}

function checkBattlePitchDisplay() {
  let now = 500
  let elapsed = 500
  let midi = 64
  const messages = []
  const scoreNotes = []
  const { page } = createPage({
    performance: { now: () => now },
    PITCH_STEP_MS: 40,
    hzToMidi: detected => detected,
    getRefNoteAt: (notes, timeMs) => notes.find(n => n.startMs <= timeMs && timeMs < n.endMs),
    calcLiveScoreIncrement: sampleMidi => { scoreNotes.push(sampleMidi); return 1 },
    countExpectedFrames: () => 75,
    countLyricCharacters: text => text.length
  })
  Object.assign(page, {
    isBattle: true, roomId: 'room', roundId: 'round', battleExpectedLyricChars: 20,
    captureOffsetMs: 0, minMidi: 53, maxMidi: 74,
    guideMinMidi: 60, guideMaxMidi: 67,
    sendRound(type, payload) { messages.push({ type, ...payload }); return true },
    getElapsedMs: () => elapsed,
    detectPitch: () => midi
  })
  page.song.durationMs = 3000
  page.song.refNotes[0].endMs = 3000
  page.beginFollowing()
  assert.equal(page.data.battleSelfNote, 'E4')
  assert.equal(page.battlePitchExact, 1, '首个有效评分帧加分')
  assert.equal(messages.at(-1).note, 'E4')
  assert.equal(page.getPitchDotMidi(page.selfPitch, elapsed), 64)
  elapsed += 10
  midi = 64.4
  page.samplePitch()
  assert.equal(page.pitchTrack.length, 1, '图上的补充采样不增加打分帧数')
  assert.equal(page.battlePitchExact, 1)
  assert.ok(Math.abs(page.getPitchDotMidi(page.selfPitch, 505) - 64.2) < 0.001)
  now += 120
  elapsed += 110
  page.samplePitch()
  assert.equal(page.data.battleSelfNote, 'E4')
  assert.equal(page.battlePitchExact, 2, '音准分随有效帧累加')
  assert.equal(messages.at(-1).midi, 64.4, '联机进度消息及时发送原始音高')

  now += 400
  const session = {}
  page.recognition = session
  page.applyRecognitionResult({ results: [{ 0: { transcript: '本次唱词' }, isFinal: true }] }, session)
  assert.equal(messages.at(-1).note, 'E4', '识别到唱词时不能把对手眼镜的实时音高清空')
  const score = page.data.battleSelfScore
  assert.equal(score, 18, '唱词覆盖增加的分数叠加在音准累计分上')

  now += 400
  elapsed = 750
  midi = null
  page.samplePitch()
  assert.equal(page.data.battleSelfNote, '--')
  assert.equal(page.getPitchDotMidi(page.selfPitch, elapsed), null, '停唱时隐藏圆点')
  assert.equal(messages.at(-1).note, '--', '停止发声时对手也应收到空音高')
  assert.equal(page.data.battleSelfScore, score)

  const receivePitch = (timeMs, opponentMidi) => {
    elapsed = timeMs
    now += 120
    page.handleBattleMessage({ type: 'opponent.progress', roomId: 'room', roundId: 'round', score: 30, midi: opponentMidi })
  }
  receivePitch(820, 35)
  assert.equal(page.getPitchDotMidi(page.opponentPitch, 820), 59, '首个远端采样就能向上对齐两个八度')
  receivePitch(940, 35)
  assert.equal(page.data.battleOpponentNote, 'B1')
  assert.equal(page.data.opponentOctaveShift, 24)
  assert.equal(page.data.selfOctaveShift, 0, '对手的音区补偿与自己的独立')
  assert.equal(page.data.battleOpponentScore, 30)
  assert.equal(page.getPitchDotMidi(page.opponentPitch, 940), 59, '抬高对手低音之后仍显示偏低')
  midi = 64.4
  elapsed = 1076
  page.samplePitch()
  function mockCanvas() {
    return {
      arc(x, y) { this.dot = { x, y } },
      fillText(text, x, y) { this.feedback = { text, x, y } },
      clearRect() { this.dot = null; this.feedback = null },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, flush() {}
    }
  }
  page.battleSelfCanvas = mockCanvas()
  page.battleOpponentCanvas = mockCanvas()
  page.drawPitchGraphs(1100)
  const self = page.battleSelfCanvas
  const opponent = page.battleOpponentCanvas
  const referenceY = 8 + (74 - 60) * 114 / (74 - 53)
  assert.ok(self.dot.y < referenceY)
  assert.ok(opponent.dot.y > referenceY)
  assert.deepEqual(self.feedback, { text: 'Good', x: self.dot.x, y: self.dot.y - 8 })
  assert.deepEqual(opponent.feedback, { text: 'Perfect', x: opponent.dot.x, y: opponent.dot.y - 8 })
  midi = 38
  elapsed = 1120
  now += 120
  page.samplePitch()
  page.drawPitchGraphs(1144)
  assert.equal(page.getPitchDotMidi(page.selfPitch, 1120), 62)
  assert.equal(self.feedback.text, 'Perfect', '联机己方偏差恰好两个半音也应显示 Perfect')
  assert.equal(messages.at(-1).midi, 38, '同步给对手的仍是原始音高')
  assert.deepEqual(scoreNotes, [64, 64.4, 64.4, 38], '评分链路只接收自己的原始音高')
  receivePitch(1200, null)
  assert.equal(page.getPitchDotMidi(page.opponentPitch, 1200), null, '对手停唱后隐藏圆点')
  page.drawPitchGraphs(1360)
  assert.equal(opponent.dot, null)
  assert.equal(opponent.feedback, null, '对手停唱后圆点与反馈应同时消失')
  receivePitch(1320, 47)
  now += 1201
  elapsed = 2100
  page.updateRecording()
  assert.equal(page.data.battleOpponentNote, '--', '长时间没有新数据时清除过期音高')
  assert.equal(page.getPitchDotMidi(page.opponentPitch, 1940), null)
  assert.equal(page.data.battleOpponentScore, 30)
  assert.equal(page.data.guideNote, 'C4', '参考音高来自谱面')
  console.log('PASS  联机双方滚动音高、八度对齐、绿点反馈、停唱隐藏与原始音高计分')
}

async function checkRecognitionRecovery() {
  const sessions = []
  const recorders = []
  const fixture = createPage({
    SpeechRecognitionSession: class {
      static async getCapabilities() {
        return { audioFormats: [{ mimeType: 'audio/ogg;codecs=opus' }], interimResults: true }
      }
      constructor() {
        this.writes = []
        this.audio = { getWriter: () => ({
          write: async chunk => {
            this.writes.push(chunk)
            if (chunk.fail) throw Error('音频写入失败')
          },
          abort: async () => { this.aborted = true }
        }) }
        sessions.push(this)
      }
    },
    MediaRecorder: class {
      static isTypeSupported() { return true }
      constructor() { recorders.push(this) }
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.onstop?.() }
    }
  })
  const { page } = fixture
  page.mediaStream = {}
  page.data.phase = 'recording'
  await page.startRecognition()
  sessions[0].onresult({ results: [{ 0: { transcript: '中断前的内容' }, isFinal: true }] })
  recorders[0].ondataavailable({ data: { size: 10, fail: true } })
  await page.recognitionFeed.queue
  assert.equal(recorders[0].state, 'inactive')
  assert.equal(sessions[0].aborted, true)
  assert.equal(page.data.asrDisplayText, '中断前的内容')
  assert.equal(page.data.asrStatusText, '识别重连中')
  fixture.runTimeout(page.asrRetryTimer)
  await Promise.resolve()
  assert.equal(sessions.length, 2)
  recorders[1].ondataavailable({ data: { size: 10 } })
  await page.recognitionFeed.queue
  assert.equal(sessions[1].writes.length, 1)
  sessions[1].onresult({ results: [{ 0: { transcript: '恢复后继续转写' }, isFinal: true }] })
  assert.equal(page.recognizedFinalText, '中断前的内容 恢复后继续转写')
  assert.equal(page.data.asrDisplayText, page.recognizedFinalText)
  sessions[0].onend()
  assert.equal(page.recognition, sessions[1], '旧识别会话不能结束当前会话')
  sessions[1].onend()
  const retry = page.asrRetryTimer
  assert.ok(retry != null)
  page.stopRecognition()
  fixture.runTimeout(retry)
  assert.equal(sessions.length, 2, '返回或结束时必须取消重连')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
