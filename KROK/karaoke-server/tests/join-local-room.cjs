#!/usr/bin/env node
// 为本地 AIX Preview 模拟第二个玩家：自动加入第一个单人房间、选晨光小路并上报实时分数。
const assert = require('node:assert/strict')
const WebSocket = require('ws')

const base = process.argv[2] || 'http://127.0.0.1:3100'
const wsBase = base.replace(/^http/, 'ws')

async function main() {
  const { song } = await (await fetch(base + '/api/songs/morning-light')).json()
  const response = await fetch(base + '/api/players', { method: 'POST' })
  assert.equal(response.status, 201)
  const token = (await response.json()).token
  const ws = new WebSocket(wsBase + '/ws')
  ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })))
  const pingTimer = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }))
  }, 10000)
  let joined = false
  let selected = false
  let battleTimer = null
  let finishTimer = null

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'welcome') console.log('JOINER', message.name)
    if (message.type === 'lobby' && !joined) {
      const room = message.rooms.find(item => item.playerCount === 1)
      if (room) {
        joined = true
        console.log('JOIN', room.id)
        ws.send(JSON.stringify({ type: 'room.join', roomId: room.id }))
      }
    }
    if (message.type === 'room' && message.room.players.length === 2 && !selected) {
      selected = true
      ws.send(JSON.stringify({ type: 'room.select', songId: 'morning-light' }))
    }
    if (message.type === 'battle.prepare') {
      ws.send(JSON.stringify({ type: 'battle.ready', roomId: message.roomId, roundId: message.roundId }))
    }
    if (message.type === 'battle.start') {
      console.log('BATTLE_START', message.startAt)
      const round = { roomId: message.roomId, roundId: message.roundId }
      let score = 0
      battleTimer = setInterval(() => {
        if (Date.now() < message.startAt) return
        score += 37
        ws.send(JSON.stringify({
          type: 'battle.progress',
          ...round,
          score,
          midi: 60 + (score % 5),
          note: 'C4',
          cents: 8
        }))
      }, 1000)
      finishTimer = setTimeout(() => {
        if (battleTimer) clearInterval(battleTimer)
        const samples = Array.from({ length: Math.ceil(song.durationMs / 40) }, (_, i) => {
          const timeMs = i * 40 + 20
          return [i, song.refNotes.find(note => note.startMs <= timeMs && timeMs < note.endMs)?.midi ?? null]
        })
        ws.send(JSON.stringify({ type: 'battle.finish', ...round, samples }))
      }, Math.max(0, message.startAt + song.durationMs + 100 - Date.now()))
    }
    if (message.type === 'battle.result') {
      console.log('RESULT', JSON.stringify(message))
      ws.close()
    }
    if (message.type === 'battle.cancelled') ws.close()
  })
  ws.on('close', () => {
    clearInterval(pingTimer)
    if (battleTimer) clearInterval(battleTimer)
    if (finishTimer) clearTimeout(finishTimer)
    process.exit(0)
  })
  setTimeout(() => {
    if (!joined) {
      console.error('ROOM_NOT_FOUND')
      ws.close()
    }
  }, 15000)
}

main().catch(error => {
  console.error('FAIL ', error.message)
  process.exitCode = 1
})
