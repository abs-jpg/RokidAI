const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

async function main() {
  let now = 100000
  let timerId = 0
  const intervals = new Map()
  const sockets = []
  class FakeSocket {
    constructor() {
      this.readyState = 0
      this.bufferedAmount = 0
      this.events = new Map()
      this.sent = []
      sockets.push(this)
    }
    addEventListener(type, callback, options = {}) {
      const events = this.events.get(type) || []
      events.push({ callback, once: options.once })
      this.events.set(type, events)
    }
    dispatch(type, event = {}) {
      for (const item of [...(this.events.get(type) || [])]) {
        if (item.once) this.events.set(type, this.events.get(type).filter(x => x !== item))
        item.callback(event)
      }
    }
    message(data) { this.dispatch('message', { data: JSON.stringify(data) }) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close(code = 1000) { this.readyState = 3; this.dispatch('close', { code }) }
  }
  const source = readFileSync(join(__dirname, '../utils/battleClient.js'), 'utf8')
    .replace(/^import .*$/gm, '').replace(/\bexport /g, '')
  const api = vm.runInNewContext(source + '\n({ connectBattle, sendBattle, onBattleMessage, isBattleOpen, closeBattle, localBattleStart })', {
    console: { error() {} },
    LEADERBOARD_API_URL: 'https://example.invalid',
    LEADERBOARD_API_URLS: ['https://example.invalid'],
    getPlayerToken: async () => 'test-token', invalidatePlayerToken() {},
    WebSocket: FakeSocket,
    Date: class extends Date { static now() { return now } },
    setTimeout: () => ++timerId, clearTimeout() {},
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id },
    clearInterval(id) { intervals.delete(id) }
  })
  const messages = []
  api.onBattleMessage(message => messages.push(message))
  async function connect() {
    const pending = api.connectBattle()
    await new Promise(setImmediate)
    const ws = sockets.at(-1)
    ws.readyState = 1
    ws.dispatch('open')
    assert.equal(ws.sent[0].type, 'auth')
    ws.message({ type: 'welcome' })
    await pending
    return ws
  }
  const tick = () => { for (const fn of [...intervals.values()]) fn() }
  const ws = await connect()
  assert.equal(ws.sent[1].type, 'ping')
  now += 20
  ws.message({ type: 'pong', t0: 100000, t1: 100510 })
  assert.equal(api.localBattleStart(200000), 199500)
  now += 20000
  tick()
  ws.message({ type: 'pong', t0: now, t1: now + 500 })
  now += 29999
  tick()
  assert.equal(api.isBattleOpen(), true, 'a recent pong must keep the connection alive')
  now++
  tick()
  assert.equal(api.isBattleOpen(), false, '30 seconds without a pong must end a half-open connection')
  assert.equal(intervals.size, 0)
  assert.equal(messages.filter(message => message.type === 'socket.close').length, 1)

  const blocked = await connect()
  blocked.bufferedAmount = 65537
  assert.equal(api.sendBattle('battle.progress', { score: 100 }), false)
  assert.equal(api.isBattleOpen(), true)
  assert.equal(api.sendBattle('ping', { t0: now }), false)
  assert.equal(api.sendBattle('battle.finish', { samples: [] }), false)
  assert.equal(api.isBattleOpen(), false, 'a lost critical message must surface as disconnection')
  assert.equal(blocked.sent.length, 2, 'congested connections must not keep growing the send queue')

  const broken = await connect()
  broken.send = () => { throw new Error('transport failed') }
  assert.equal(api.sendBattle('room.create'), false)
  assert.equal(api.isBattleOpen(), false)

  await connect()
  const closes = messages.filter(message => message.type === 'socket.close').length
  api.closeBattle()
  assert.equal(intervals.size, 0)
  assert.equal(messages.filter(message => message.type === 'socket.close').length, closes)
  console.log('PASS  联机心跳超时、时钟同步、发送拥塞、发送异常及主动退出')

  const serverSource = readFileSync(join(__dirname, '../../karaoke-server/server.js'), 'utf8')
  const players = new Map()
  let sweep
  const send = vm.runInNewContext(serverSource.slice(serverSource.indexOf('const MAX_ROOMS'), serverSource.indexOf('function roomSummary')) + '\nwsSend', {
    console, playerSockets: players,
    Date: class extends Date { static now() { return now } },
    setInterval(fn) { sweep = fn; return { unref() {} } }
  })
  const client = () => ({
    readyState: 1, bufferedAmount: 0, lastMessageAt: now, messages: [],
    send(data) { this.messages.push(JSON.parse(data)) },
    terminate() { this.readyState = 3 }
  })
  const slow = client()
  send(slow, { type: 'room' })
  slow.bufferedAmount = 65537
  send(slow, { type: 'opponent.progress' })
  send(slow, { type: 'lobby' })
  assert.equal(slow.messages.length, 1)
  assert.equal(slow.readyState, 1)
  send(slow, { type: 'battle.result' })
  assert.equal(slow.readyState, 3)
  const idle = client()
  const active = client()
  players.set('idle', idle)
  players.set('active', active)
  now += 35000
  active.lastMessageAt = now
  sweep()
  assert.equal(idle.readyState, 3)
  assert.equal(active.readyState, 1)
  console.log('PASS  服务端发送拥塞限流、关键消息失败断开及掉线清理')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
