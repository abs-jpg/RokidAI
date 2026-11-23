const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../utils/scoreEngine.js'), 'utf8')
  .replace(/\bexport function\b/g, 'function')
const api = new Function(source + '\nreturn { calcLyricLengthCompleteness, countLyricCharacters, buildPracticeFeedback };')()

const original = 'ABCDEFGHIJ'
assert.equal(api.countLyricCharacters('A B, C。D'), 4)
assert.equal(api.calcLyricLengthCompleteness('ABCDE', original), 50)
assert.equal(api.calcLyricLengthCompleteness('ABCDEFGHIJKLMN', original), 100)
assert.equal(api.calcLyricLengthCompleteness('', original), 0)

const resultSource = readFileSync(join(__dirname, '../pages/result/result.ink'), 'utf8')
assert.doesNotMatch(resultSource, /完整度 · 80%|音准 · 20%|class="sub-scores"/)
assert.match(resultSource, /class="score-num"/)
assert.match(resultSource, /class="summary-text"/)
assert.match(resultSource, />用户点评</)

const pitchSource = readFileSync(join(__dirname, '../utils/pitchEngine.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/\bexport /g, '')
const getRefNoteAt = (notes, time) => notes.find(note => note.startMs <= time && time < note.endMs)
const calcAccuracyScore = new Function('getRefNoteAt', pitchSource + '\nreturn calcAccuracyScore')(getRefNoteAt)
const refNotes = [{ startMs: 0, endMs: 1200, midi: 60 }]
const profileFor = (deltaAt, frames = 30) => calcAccuracyScore(Array.from({ length: frames }, (_, index) => ({
  timeMs: index * 40 + 20,
  midi: 60 + deltaAt(index)
})), refNotes).pitchProfile

const lines = [
  'The morning birds sing again',
  'I can see the stars tonight',
  'Hold my hand in the rain',
  'Take me back to open fields',
  'We will find our way home'
]
const lyrics = lines.map((text, index) => ({ text, startMs: index * 1000, endMs: (index + 1) * 1000 }))
const matched = lines.join(' ')
const recognizedText = [
  lines[0],
  'I can hear the drums tonight',
  'Hold my hat in the snow',
  'Take me back to quiet roads',
  lines[4]
].join(' ')
const feedbackFor = (pitchProfile, extra = {}) => api.buildPracticeFeedback({
  lyrics, recognizedText: matched, hasRefNotes: true, completed: true, pitchProfile, ...extra
})

const corrected = feedbackFor(profileFor(() => -1), { recognizedText })
assert.match(corrected[0], /第2句 识别.*hear the drums.*原词.*see the stars/)
assert.match(corrected[1], /第3句 识别.*hat in the snow.*原词.*hand in the rain/)
assert.match(corrected[2], /偏低.*往上/)
assert.equal(corrected.length, 3, '差异较大的唱词只对照两句，随后提供一条音准建议')
assert.match(feedbackFor(profileFor(() => 0))[0], /识别.*morning birds.*原词.*morning birds/)
assert.match(feedbackFor(profileFor(() => 1)).at(-1), /偏高.*往下/)
assert.match(feedbackFor(profileFor(i => i % 2 ? -1 : 1)).at(-1), /有时偏高、有时偏低/)
assert.match(feedbackFor(profileFor(() => 12)).at(-1), /高近一个八度/)
assert.match(feedbackFor(profileFor(() => 1, 3)).at(-1), /音高样本较少/)
assert.match(feedbackFor(null, { recognizedText: 'unrelated words' })[0], /识别「unrelated words」。未找到可靠对应的原词/)
assert.equal(feedbackFor(null, { recognizedText: '' }).length, 2, '没有识别结果时不猜测唱错的行')
const incomplete = feedbackFor(profileFor(() => 0), {
  recognizedText: matched, completed: false, sungUntilMs: 2500
})
assert.match(incomplete[0], /^第[12]句 识别.*原词/)
assert.equal(incomplete.length, 2, '提前结束不纠正未唱到的句子')

const chinese = ['山风吹过田野', '白云低低飘来', '夜里听见虫鸣']
const chineseReview = feedbackFor(null, {
  lyrics: chinese.map(text => ({ text })),
  recognizedText: '山风吹过田野 夜里听见虫鸣'
})
assert.match(chineseReview[0], /识别「山风吹过田野」 · 原词「山风吹过田野」/)
assert.doesNotMatch(chineseReview.join(' '), /识别「白云低低飘来」/, '遗漏的歌词不能当作 ASR 原文')
const mixed = feedbackFor(null, {
  lyrics: [{ text: 'Twenty ＯＮＥ' }, { text: '내 마음이 그대를 불러' }, { text: '夢の中で会える' }],
  recognizedText: 'Twenty ＯＮＥ 내마음이 그대를 불러 夢の中で会える'
})
assert.match(mixed[0], /识别「Twenty ＯＮＥ」/, '展示识别原文，保留识别出的字符形态')

const speechSource = readFileSync(join(__dirname, '../utils/feedbackSpeech.js'), 'utf8').replace('export function', 'function')
const setupSource = filename => readFileSync(join(__dirname, filename), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*$/gm, '')
  .replace('export default', 'page =')

async function checkSpeech() {
  const played = []
  const controllers = []
  let destroyed = 0
  let resolveTask
  const speechContext = {
    AbortController,
    console,
    speechSynthesis: {
      synthesize(utterance, options) {
        controllers.push(options.signal)
        return new Promise(resolve => {
          resolveTask = () => resolve({ text: utterance.text, state: 'completed', finished: Promise.resolve() })
        })
      },
      speak() { assert.fail('不能同时调用两条播报路径') }
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
    SpeechAudioPlayer: class {
      constructor(task) { this.task = task }
      play() { played.push(this.task.text) }
      destroy() { destroyed++ }
    }
  }
  const playFeedbackSpeech = vm.runInNewContext(speechSource + '\nplayFeedbackSpeech', speechContext)
  const loop = () => new Promise(setImmediate)
  const webFallback = []
  const fallback = vm.runInNewContext(speechSource + '\nplayFeedbackSpeech', {
    speechSynthesis: { speak(utterance) { webFallback.push(utterance.text) } },
    SpeechSynthesisUtterance: speechContext.SpeechSynthesisUtterance
  })
  fallback(corrected)
  assert.deepEqual(webFallback, [corrected.join(' ')])

  const stop = playFeedbackSpeech(corrected)
  stop()
  resolveTask()
  await loop()
  assert.equal(played.length, 0, '离开页面后才合成好的语音不能继续播放')
  assert.equal(controllers[0].aborted, true)

  const pitchProfile = profileFor(() => -1)
  const recording = { songId: 'example', attemptId: 'solo1', pitchTrack: [], completed: true, recognizedText }
  const page = vm.runInNewContext(setupSource('../pages/result/result.ink'), {
    ...api, playFeedbackSpeech,
    calcAccuracyScore: () => ({ accuracy: 78, coverage: 90, pitchProfile }),
    getGrade: () => ({ grade: 'A', label: '优秀' }),
    submitScore: async () => ({ uploaded: false, message: '当前版本未配置排行榜服务器' }),
    encodePitchTrack: () => [],
    wx: { getStorageSync: () => recording }
  })
  page.song = { id: 'example', lyrics, refNotes }
  page.attemptId = 'solo1'
  page.setData = (patch, callback) => { Object.assign(page.data, patch); callback?.() }
  page.calculateScore()
  page.calculateScore()
  assert.equal(controllers.length, 2, '同一成绩只自动播报一次')
  resolveTask()
  await loop()
  assert.deepEqual(played, [page.data.feedback.join(' ')], '只朗读用户点评，不读分数和按钮')
  page.onHide()
  assert.equal(destroyed, 1)

  const battle = vm.runInNewContext(setupSource('../pages/record/record.ink'), {
    console, performance,
    playFeedbackSpeech() { assert.fail('联机结算不能播报') },
    buildPracticeFeedback() { assert.fail('联机结算不能生成点评') },
    clearTimeout() {}, clearInterval() {}, cancelAnimationFrame() {}
  })
  battle.isBattle = true
  battle.selfId = 'a'
  battle.visible = true
  battle.data.phase = 'battleWaiting'
  battle.setData = (patch, callback) => { Object.assign(battle.data, patch); callback?.() }
  const result = { type: 'battle.result', winner: 'b', players: [{ id: 'a', score: 78 }, { id: 'b', score: 90, name: '对手' }] }
  battle.handleBattleMessage(result)
  battle.handleBattleMessage(result)
  assert.equal(battle.data.phase, 'battleDone')
  assert.equal(battle.data.battleResultText, '我 78 · 对手 90')
  assert.equal(controllers.length, 2, '只有单人练习会自动播报')
  assert.equal(played.length, 1)
  battle.onUnload()
  assert.equal(destroyed, 1)
  console.log('PASS  单人逐句纠正、音准建议与播报，联机仅显示分数')
}

checkSpeech().catch(error => { console.error(error); process.exitCode = 1 })
