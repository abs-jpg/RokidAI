#!/usr/bin/env node
// 对已有服务器做一次真实联机冒烟测试。
// 用法：node battle-smoke.cjs https://karaoke-api.example.com
const assert = require('node:assert/strict')
const WebSocket = require('ws')

const base = (process.argv[2] || 'http://127.0.0.1:3100').replace(/\/+$/, '')
const wsBase = base.replace(/^http/, 'ws')

function makeClient(token) {
  const ws = new WebSocket(wsBase + '/ws')
  ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })))
  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }))
  }, 10000)
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
    send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })) },
    waitFor(type, predicate = () => true, timeout = 8000) {
      const full = message => message.type === type && predicate(message)
      const existing = messages.find(full)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate: full, resolve }
        waiter.timer = setTimeout(() => reject(new Error(`timeout ${type}`)), timeout)
        waiters.push(waiter)
      })
    }
  }
}

async function createToken() {
  const response = await fetch(base + '/api/players', { method: 'POST' })
  assert.equal(response.status, 201)
  return (await response.json()).token
}

async function main() {
  const [tokenA, tokenB] = await Promise.all([createToken(), createToken()])
  const a = makeClient(tokenA)
  const b = makeClient(tokenB)
  try {
    await Promise.all([a.waitFor('welcome'), b.waitFor('welcome')])
    a.send('room.create')
    const room = await a.waitFor('room')
    b.send('room.join', { roomId: room.room.id })
    await b.waitFor('room', message => message.room.players.length === 2)

    const { song } = await (await fetch(base + '/api/songs/morning-light')).json()
    const samples = Array.from({ length: Math.ceil(song.durationMs / 40) }, (_, i) => {
      const timeMs = i * 40 + 20
      return [i, song.refNotes.find(note => note.startMs <= timeMs && timeMs < note.endMs)?.midi ?? null]
    })
    const until = target => new Promise(resolve => setTimeout(resolve, Math.max(0, target - Date.now())))
    a.send('room.select', { songId: 'morning-light' })
    b.send('room.select', { songId: 'morning-light' })
    const preparation = await a.waitFor('battle.prepare')
    await b.waitFor('battle.prepare')
    const round = { roomId: preparation.roomId, roundId: preparation.roundId }
    a.send('battle.ready', round)
    b.send('battle.ready', round)
    const [startA, startB] = await Promise.all([
      a.waitFor('battle.start'),
      b.waitFor('battle.start')
    ])
    assert.equal(startA.startAt, startB.startAt)

    // 房间已经开始时必须拒绝重复选歌，避免重复 battle.start。
    a.send('room.select', { songId: 'morning-light' })
    await a.waitFor('error', message => message.code === 'ROOM_STARTED')

    await until(startA.startAt + 100)
    a.send('battle.progress', { ...round, score: 50, midi: 60, note: 'C4', cents: 5 })
    const progress = await b.waitFor('opponent.progress')
    assert.equal(progress.score, 50)

    await until(startA.startAt + song.durationMs + 100)
    a.send('battle.finish', { ...round, samples })
    b.send('battle.finish', { ...round, samples: samples.map(([frame, midi]) => [frame, frame % 5 ? midi : null]) })
    const [resultA, resultB] = await Promise.all([
      a.waitFor('battle.result'),
      b.waitFor('battle.result')
    ])
    assert.equal(resultA.winner, resultB.winner)
    console.log(`PASS  ${base} 联机冒烟通过，winner=${resultA.winner}`)
  } finally {
    a.ws.close()
    b.ws.close()
  }
}

main().catch(error => {
  console.error('FAIL ', error.message)
  process.exitCode = 1
})
