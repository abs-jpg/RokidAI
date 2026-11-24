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
assert.match(corrected[0], /歌词跟得很准.*咬字也很清楚.*继续保持/)
assert.match(corrected[1], /低约 1\.0 个半音.*保持.*节奏和长音/)
assert.equal(corrected.length, 2, '只选一个唱词片段点评，随后提供一条音准建议')
assert.match(feedbackFor(profileFor(() => 0))[0], /歌词跟得很准.*清楚/)
assert.match(feedbackFor(profileFor(() => 1)).at(-1), /高约 1\.0 个半音.*保持.*节奏和长音/)
assert.match(feedbackFor(profileFor(i => i % 2 ? -1 : 1)).at(-1), /起伏.*继续保持/)
assert.match(feedbackFor(profileFor(() => 12)).at(-1), /高约 12\.0 个半音.*更合适的音区/)
assert.match(feedbackFor(profileFor(() => 1, 3)).at(-1), /音高轨迹已经记录下来.*起音/)
const typoReview = feedbackFor(null, { recognizedText: 'I can hear the drums tonight' })
assert.match(typoReview[0], /已经跟上.*个别字再唱清楚/)
assert.doesNotMatch(typoReview[0], /I can hear|识别|「|」/)
const unmatchedReview = feedbackFor(null, { recognizedText: 'unrelated words' })
assert.match(unmatchedReview[0], /节奏跟得比较稳.*清楚/)
assert.doesNotMatch(unmatchedReview[0], /unrelated words|识别|「|」/)
assert.equal(feedbackFor(null, { recognizedText: '' }).length, 2, '没有识别结果时仍提供温和的练习建议')
const randomReview = feedbackFor(null, {
  recognizedText: '第一句今天唱得很投入。第二句字尾还可以更清楚。第三句节奏跟得不错。',
  random: () => 0
})
assert.equal(randomReview.length, 2, '只展示一个唱词点评和一条音准建议')
assert.doesNotMatch(randomReview.join(' '), /识别|「|」/)
assert.doesNotMatch(randomReview.join(' '), /\d+\s*分/, '点评不能曝光分数')
assert.doesNotMatch(randomReview.join(' '), /偏差|不完整|未找到|较少|错误|失败|偏低|偏高/, '点评不能出现负面表述')
const noDataReview = feedbackFor(null, {
  recognizedText: '',
  hasRefNotes: false
})
assert.equal(noDataReview.length, 2, '缺少 ASR 或参考音高时仍生成完整的两条正向点评')
const allFeedback = [corrected, typoReview, unmatchedReview, randomReview, noDataReview].flat().join(' ')
assert.doesNotMatch(
  allFeedback,
  /采样较少|音高样本较少|识别较少|无法评估|不能评估|无法评价|不做评价|不计分|未识别|评估不了|缺少参考|不完整|失败|不足/,
  '任何点评分支都不能提示无法评估'
)
const incomplete = feedbackFor(profileFor(() => 0), {
  recognizedText: matched, completed: false, sungUntilMs: 2500
})
assert.match(incomplete[0], /歌词跟得很准/)
assert.equal(incomplete.length, 2, '提前结束不纠正未唱到的句子')

const chinese = ['山风吹过田野', '白云低低飘来', '夜里听见虫鸣']
const chineseReview = feedbackFor(null, {
  lyrics: chinese.map(text => ({ text })),
  recognizedText: '山风吹过田野 夜里听见虫鸣'
})
assert.match(chineseReview[0], /歌词跟得很准.*清楚/)
assert.doesNotMatch(chineseReview.join(' '), /山风吹过田野|识别|「|」/, '点评不展示 ASR 原文')
const mixed = feedbackFor(null, {
  lyrics: [{ text: 'Twenty ＯＮＥ' }, { text: '내 마음이 그대를 불러' }, { text: '夢の中で会える' }],
  recognizedText: 'Twenty ＯＮＥ 내마음이 그대를 불러 夢の中で会える'
})
assert.match(mixed[0], /歌词跟得很准.*清楚/)

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
  assert.equal(battle.data.battleResultOutcome, 'loss')
  assert.equal(battle.data.battleResultTitle, '失败')
  assert.equal(battle.data.hintText, '点按镜腿 · 确认离开')
  battle.data.phase = 'battleWaiting'
  battle.handleBattleMessage({
    type: 'battle.result',
    winner: 'a',
    players: [{ id: 'a', score: 90 }, { id: 'b', score: 78, name: '对手' }]
  })
  assert.equal(battle.data.phase, 'battleDone')
  assert.equal(battle.data.battleResultOutcome, 'win')
  assert.equal(battle.data.battleResultTitle, '胜利')
  assert.equal(controllers.length, 2, '只有单人练习会自动播报')
  assert.equal(played.length, 1)
  battle.onUnload()
  assert.equal(destroyed, 1)
  console.log('PASS  单人逐句纠正、音准建议与播报，联机仅显示分数')
}

checkSpeech().catch(error => { console.error(error); process.exitCode = 1 })
