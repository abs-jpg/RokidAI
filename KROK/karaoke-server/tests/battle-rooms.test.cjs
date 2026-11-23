#!/usr/bin/env node
// 联机房间集成测试：并发多房间、同曲确认、同步开始、实时分数和统一结算。
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const WebSocket = require('ws')

const serverPath = path.join(__dirname, '..', 'server.js')

function waitForBase(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('server start timeout\n' + output)), 10000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      const match = /Karaoke API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server exited ${code}\n${output}`))
    })
  })
}

function makeClient(url, token, heartbeat = true) {
  const ws = new WebSocket(url)
  ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })))
  const pingTimer = heartbeat ? setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }))
  }, 10000) : null
  ws.once('close', () => clearInterval(pingTimer))
  const messages = []
  const waiters = []
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString())
    messages.push(message)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(message)) {
        const waiter = waiters.splice(i, 1)[0]
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    }
  })
  return {
    ws,
    messages,
    send(type, payload = {}) {
      ws.send(JSON.stringify({ type, ...payload }))
    },
    waitFor(type, timeout = 5000, extra) {
      const predicate = message => message.type === type && (!extra || extra(message))
      const existing = messages.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`timeout waiting for ${type}`))
        }, timeout)
        waiters.push(waiter)
      })
    },
    close() {
      ws.close()
    }
  }
}

async function createToken(base) {
  const response = await fetch(base + '/api/players', { method: 'POST' })
  assert.equal(response.status, 201)
  const body = await response.json()
  return body.token
}

async function main() {
  const trialDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'karaoke-battle-'))
  let child
  const clients = []
  try {
    const catalogPath = path.join(trialDir, 'catalog.json')
    const catalog = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'catalog.json'), 'utf8'))
    catalog.songs.push({
      id: 'test-duet', name: '对战测试', bundled: true, durationMs: 1200,
      chartVersion: 1, scoringVersion: 5,
      lyrics: [{ text: '테스트가사', startMs: 0, endMs: 1200 }],
      refNotes: [{ startMs: 0, endMs: 1200, midi: 60 }]
    })
    catalog.songs.push({
      id: 'test-long-score', name: '长歌曲成绩测试', bundled: true, durationMs: 300000,
      chartVersion: 1, scoringVersion: 5,
      lyrics: [{ text: '테스트가사', startMs: 0, endMs: 300000 }],
      refNotes: [{ startMs: 0, endMs: 300000, midi: 60 }]
    })
    await fsp.writeFile(catalogPath, JSON.stringify(catalog))
    child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: '0',
        ROKID_DEVELOPER_SK: '',
        KARAOKE_DB: path.join(trialDir, 'db.sqlite'),
        KARAOKE_MEDIA: path.join(trialDir, 'media'),
        KARAOKE_CATALOG: catalogPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const base = await waitForBase(child)
    const wsBase = base.replace('http://', 'ws://')

    const impersonation = await fetch(base + '/api/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rokuUserId: 'someone-else' })
    })
    assert.equal(impersonation.status, 503)
    assert.equal((await impersonation.json()).token, undefined)
    const tokens = await Promise.all([createToken(base), createToken(base), createToken(base), createToken(base)])
    const submit = payload => fetch(base + '/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[0] },
      body: JSON.stringify(payload)
    })
    const attempt = {
      attemptId: 'test-round-001', songId: 'test-duet', chartVersion: 1,
      scoringVersion: 5, completed: true, score: 99, accuracy: 0, coverage: 1,
      recognizedText: '테스트가사'
    }
    assert.equal((await submit(attempt)).status, 400)
    assert.equal((await submit({ ...attempt, samples: [[0, 57], [0, 57]] })).status, 400)
    const sampleNotes = catalog.songs[0].refNotes
    const samplesForSong = Array.from({ length: 30 }, (_, i) => {
      const timeMs = i * 40 + 20
      return [i, sampleNotes.find(note => note.startMs <= timeMs && timeMs < note.endMs)?.midi ?? null]
    })
    assert.equal((await submit({
      ...attempt,
      attemptId: 'test-round-partial',
      samples: [[0, 57]]
    })).status, 201)
    const valid = { ...attempt, samples: samplesForSong }
    assert.equal((await submit(valid)).status, 201)
    assert.equal((await submit(valid)).status, 200)
    const shiftedSamples = samplesForSong.map(([frame, midi]) => [frame, midi === null ? null : midi + 1])
    const shiftedAttempt = {
      ...attempt,
      attemptId: 'test-round-002',
      samples: shiftedSamples
    }
    const shiftedResponse = await fetch(base + '/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[1] },
      body: JSON.stringify(shiftedAttempt)
    })
    assert.equal(shiftedResponse.status, 201)
    const longSamples = Array.from({ length: 7500 }, (_, index) => [index, 60, 1])
    const longAttempt = {
      ...attempt,
      attemptId: 'test-long-score-001',
      songId: 'test-long-score',
      samples: longSamples
    }
    const longBody = JSON.stringify(longAttempt)
    assert.ok(Buffer.byteLength(longBody) > 64 * 1024, '回归用例必须超过旧版 64KB 上限')
    assert.ok(Buffer.byteLength(longBody) < 256 * 1024, '完整歌曲请求必须低于新版 256KB 上限')
    assert.equal((await submit(longAttempt)).status, 201, '完整长歌曲成绩必须成功上传')
    const oversizedAsrAttempt = {
      ...valid,
      attemptId: 'test-round-asr-replace',
      recognizedText: '테스트가사 ' + '가'.repeat(8200)
    }
    assert.equal((await submit(oversizedAsrAttempt)).status, 201, '超过 8000 字符的 ASR 不能被直接拒绝')
    const replacedAsrAttempt = {
      ...valid,
      attemptId: 'test-round-asr-normalized',
      recognizedText: '테스트가사 확장'
    }
    assert.equal((await submit(replacedAsrAttempt)).status, 201)
    assert.equal((await submit({
      ...replacedAsrAttempt,
      recognizedText: '   테스트가사    확장   '
    })).status, 200)
    const scoreDb = new DatabaseSync(path.join(trialDir, 'db.sqlite'))
    const asrRow = scoreDb.prepare(`
      SELECT a.song_id, a.attempt_id, a.recognized_text,
        (SELECT COUNT(*) FROM scores history WHERE history.user_id = a.user_id) AS score_count
      FROM player_asr_results a
      WHERE a.user_id = (SELECT user_id FROM scores WHERE attempt_id = ?)
    `).get(replacedAsrAttempt.attemptId)
    const scoreCountBeforeBattle = scoreDb.prepare('SELECT COUNT(*) AS count FROM scores').get().count
    scoreDb.close()
    assert.equal(asrRow.song_id, 'test-duet')
    assert.equal(asrRow.attempt_id, replacedAsrAttempt.attemptId)
    assert.equal(asrRow.recognized_text, '테스트가사 확장', '每个用户只保存最新一份 ASR')
    assert.equal(asrRow.score_count, 5, '替换 ASR 不能删除该用户的历史成绩')
    const ranking = await (await fetch(base + '/api/leaderboard')).json()
    assert.equal(ranking.list[0].score, 100)
    assert.equal(ranking.list[0].accuracy, 100)
    assert.equal(ranking.list[1].score, 99)
    assert.equal(ranking.list[1].accuracy, 95)
    assert.equal(ranking.list[1].coverage, 100)
    assert.equal(ranking.list[0].rokuId, undefined)
    const [a, b, c, d] = tokens.map(token => {
      const client = makeClient(wsBase + '/ws', token)
      clients.push(client)
      return client
    })

    await Promise.all([a, b, c, d].map(client => client.waitFor('welcome')))
    await Promise.all([a, b, c, d].map(client => client.waitFor('lobby')))
    a.ws.send('null')
    assert.equal((await a.waitFor('error')).code, 'BAD_MESSAGE')
    assert.equal((await fetch(base + '/healthz')).status, 200)

    a.send('room.create')
    const roomA = await a.waitFor('room')
    b.send('room.join', { roomId: roomA.room.id })
    await b.waitFor('room', 5000, message => message.room.id === roomA.room.id && message.room.players.length === 2)

    // 第二个房间同时存在，互不阻塞。
    c.send('room.create')
    const roomC = await c.waitFor('room')
    d.send('room.join', { roomId: roomC.room.id })
    await d.waitFor('room', 5000, message => message.room.id === roomC.room.id && message.room.players.length === 2)
    const lobby = await c.waitFor('lobby', 5000, message => message.rooms.length >= 2)
    assert.ok(lobby.rooms.some(room => room.id === roomA.room.id))
    assert.ok(lobby.rooms.some(room => room.id === roomC.room.id))

    a.send('battle.finish', { score: 1000000 })
    await a.waitFor('error', 5000, message => message.code === 'INVALID_ROUND')
    a.send('room.select', { songId: 'test-duet' })
    b.send('room.select', { songId: 'test-duet' })
    const [prepareA, prepareB] = await Promise.all([a.waitFor('battle.prepare'), b.waitFor('battle.prepare')])
    assert.equal(prepareA.roundId, prepareB.roundId)
    const round = { roomId: prepareA.roomId, roundId: prepareA.roundId }
    a.send('battle.ready', round)
    a.send('battle.finish', { ...round, score: 1000000 })
    await a.waitFor('error', 5000, message => message.code === 'ROUND_NOT_STARTED')
    assert.equal(a.messages.some(message => message.type === 'battle.start'), false)
    b.send('battle.ready', round)
    const [startA, startB] = await Promise.all([
      a.waitFor('battle.start'),
      b.waitFor('battle.start')
    ])
    assert.equal(startA.startAt, startB.startAt, '双方应收到同一个开始时间')
    assert.ok(startA.startAt > Date.now())

    const waitUntil = timestamp => new Promise(resolve => setTimeout(resolve, Math.max(0, timestamp - Date.now())))
    await waitUntil(startA.startAt + 25)
    a.send('battle.progress', { ...round, score: 120, midi: 62.2, note: 'D4', cents: 12 })
    const progress = await b.waitFor('opponent.progress')
    assert.equal(progress.score, 100)
    assert.equal(progress.note, 'D4')

    await waitUntil(startA.startAt + 1200)
    const samples = Array.from({ length: 30 }, (_, index) => [index, 60])
    a.send('battle.finish', {
      ...round,
      samples: samples.slice(1),
      recognizedText: '테스트가사',
      score: 1000000
    })
    a.send('battle.finish', { ...round, samples: [[0, 60]], recognizedText: '테스트가사' })
    b.send('battle.finish', {
      ...round,
      samples: samples.map(([frame, midi]) => [frame, frame < 20 ? midi : null]),
      recognizedText: '테스트가'
    })
    const [resultA, resultB] = await Promise.all([
      a.waitFor('battle.result'),
      b.waitFor('battle.result')
    ])
    assert.equal(resultA.winner, resultB.winner)
    assert.notEqual(resultA.winner, 'draw')
    assert.deepEqual(
      resultA.players.map(player => player.score).sort((x, y) => x - y),
      [84, 100]
    )
    assert.deepEqual(
      resultA.players.map(player => player.coverage).sort((x, y) => x - y),
      [80, 100]
    )
    const dbAfterBattle = new DatabaseSync(path.join(trialDir, 'db.sqlite'))
    try {
      assert.equal(dbAfterBattle.prepare('SELECT COUNT(*) AS count FROM scores').get().count,
        scoreCountBeforeBattle, '联机结算不得写入排行榜成绩')
    } finally {
      dbAfterBattle.close()
    }

    c.send('room.select', { songId: 'test-duet' })
    d.send('room.select', { songId: 'test-duet' })
    const prepared = await d.waitFor('battle.prepare')
    c.close()
    await d.waitFor('battle.cancelled', 5000, message => message.roundId === prepared.roundId)
    console.log('PASS  账号防冒用、恶意消息隔离、重新计分、双方就绪、重复结算和断线取消')
    const idle = makeClient(wsBase + '/ws', await createToken(base), false)
    clients.push(idle)
    await idle.waitFor('welcome')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('idle connection did not expire')), 45000)
      idle.ws.once('close', () => { clearTimeout(timer); resolve() })
    })
    assert.equal(d.ws.readyState, 1, 'active players must survive the heartbeat sweep')
    assert.equal((await fetch(base + '/healthz')).status, 200)
    console.log('PASS  服务端清理无心跳连接，正常心跳保持在线')
  } finally {
    for (const client of clients) client.close()
    if (child) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    }
    await fsp.rm(trialDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('FAIL ', error.message, error.cause || '')
  process.exitCode = 1
})
