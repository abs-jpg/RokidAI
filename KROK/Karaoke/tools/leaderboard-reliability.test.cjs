const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../utils/leaderboard.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const memory = new Map()
let offline = true
let profileMode = 'error'
let profileId = 'verified-user'
let uploadStatus = 201
const uploads = []
const token = 'a'.repeat(64)

function load() {
  return vm.runInNewContext(source + '\n;({submitScore,flushPendingScores,getPlayerToken})', {
    SCORING_VERSION: 2, LEADERBOARD_API_URL: 'https://example.test',
    AbortController, setTimeout, clearTimeout,
    console: { error() {} },
    wx: {
      getStorageSync: key => memory.has(key) ? JSON.parse(JSON.stringify(memory.get(key))) : undefined,
      setStorageSync: (key, value) => memory.set(key, JSON.parse(JSON.stringify(value)))
    },
    createOpenAPI: async () => {
      if (profileMode === 'hang') return new Promise(() => {})
      if (profileMode === 'error') throw new Error('profile unavailable')
      return { account: { async getProfile() { return { accountId: profileId, code: 'fresh' } } } }
    },
    async fetch(url, options) {
      if (offline) throw new Error('offline')
      if (url.endsWith('/api/players')) {
        return { ok: true, status: 201, async json() { return { token, accountLinked: Boolean(options.body) } } }
      }
      uploads.push(JSON.parse(options.body))
      return { ok: uploadStatus < 400, status: uploadStatus, async json() { return { ok: uploadStatus < 400 } } }
    }
  })
}

async function main() {
  const first = load()
  const entry = {
    attemptId: 'pending-0001', songId: 'test-song', chartVersion: 1, scoringVersion: 2,
    completed: true, score: 80, accuracy: 90, coverage: 90
  }
  const result = await first.submitScore(entry, [[0, 60], [1, null]])
  assert.equal(result.retryable, true)
  assert.match(result.message, /补传/)
  const pendingKey = [...memory.keys()].find(key => key.endsWith(':pending'))
  assert.deepEqual(memory.get(pendingKey)[0].samples, [[0, 60], [1, null]])
  offline = false
  const restarted = load()
  await Promise.all([restarted.flushPendingScores(), restarted.flushPendingScores()])
  assert.equal(uploads.length, 1)
  assert.deepEqual(uploads[0].samples, [[0, 60], [1, null]])
  assert.equal(memory.get(pendingKey).length, 0)
  profileMode = 'success'
  await restarted.getPlayerToken()
  const bindingKey = 'karaoke_server_token:https://example.test:rokid:verified'
  assert.equal(memory.get(bindingKey), 'verified-user')
  profileMode = 'error'
  assert.equal(await restarted.getPlayerToken(), token)
  assert.equal(memory.get(bindingKey), 'verified-user')
  profileMode = 'hang'
  assert.equal(await restarted.getPlayerToken(), token)
  assert.equal(memory.get(bindingKey), 'verified-user')
  console.log('PASS  重启补传去重，身份查询故障和超时保留已绑定歌手')

  profileMode = 'success'
  offline = true
  await restarted.submitScore({ ...entry, attemptId: 'pending-owner' }, [[0, 60]])
  offline = false
  profileId = 'another-user'
  const uploadCount = uploads.length
  await restarted.flushPendingScores()
  assert.equal(uploads.length, uploadCount, 'switching accounts must not attribute old pending scores to the new singer')
  assert.equal(memory.get(pendingKey)[0].owner, 'verified-user')
  profileId = 'verified-user'
  await restarted.getPlayerToken()
  uploadStatus = 503
  await restarted.flushPendingScores()
  assert.equal(memory.get(pendingKey).length, 1, 'temporary server failures must retain the samples')
  uploadStatus = 201
  await restarted.flushPendingScores()
  assert.equal(memory.get(pendingKey).length, 0)
  console.log('PASS  切换账号隔离待传成绩，服务器临时故障后可重试')

  const resultSource = readFileSync(join(__dirname, '../pages/result/result.ink'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*$/gm, '').replace('export default', 'page =')
  let finishSubmit
  const resultPage = vm.runInNewContext(resultSource, {
    console, submitScore: () => new Promise(resolve => { finishSubmit = resolve })
  })
  resultPage.setData = update => {
    assert.equal(Boolean(resultPage.unloaded), false, 'submission must not update an unloaded result page')
    Object.assign(resultPage.data, update)
  }
  resultPage.song = { id: 'test-song' }
  const pendingSubmit = resultPage.doSubmit()
  resultPage.onUnload()
  finishSubmit({ success: true, message: 'uploaded' })
  await pendingSubmit
  console.log('PASS  退出成绩页后，后台提交不会更新已卸载页面')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
