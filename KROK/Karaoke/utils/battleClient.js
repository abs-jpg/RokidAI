import { LEADERBOARD_API_URL } from './leaderboardConfig.js'
import { getPlayerToken, invalidatePlayerToken } from './leaderboard.js'

const SERVER_URL = LEADERBOARD_API_URL.trim().replace(/\/+$/, '')
const WS_URL = SERVER_URL.replace(/^http/, 'ws')
const listeners = new Set()
const HEARTBEAT_INTERVAL_MS = 10000
const HEARTBEAT_TIMEOUT_MS = 30000
const MAX_BUFFERED_BYTES = 64 * 1024
let socket = null
let connecting = null
let generation = 0
let pingTimer
let clockSamples = []
let lastPongAt = 0

function disconnect(ws, reason) {
  if (socket !== ws) return
  socket = null
  clearInterval(pingTimer)
  try { ws.close(4000, reason) } catch {}
  emit({ type: 'socket.close', code: 4000, reason })
}

function heartbeat() {
  if (!socket) return
  if (Date.now() - lastPongAt >= HEARTBEAT_TIMEOUT_MS) {
    disconnect(socket, 'heartbeat timeout')
    return
  }
  measureBattleClock()
}

function emit(message) {
  for (const listener of [...listeners]) {
    try {
      listener(message)
    } catch (error) {
      console.error('battle listener error', error)
    }
  }
}

export function onBattleMessage(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function connectBattle() {
  if (!WS_URL) throw new Error('联机服务器未配置')
  if (connecting) return connecting
  if (socket && socket.readyState === 1) return socket

  const requestedGeneration = generation
  const pending = (async () => {
    const token = await getPlayerToken()
    if (requestedGeneration !== generation) throw new Error('联机连接已取消')
    const ws = new WebSocket(WS_URL + '/ws')
    socket = ws
    clockSamples = []
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('联机服务器连接超时'))
        ws.close()
      }, 8000)
      ws.addEventListener('open', () => {
        if (socket === ws) ws.send(JSON.stringify({ type: 'auth', token }))
      }, { once: true })
      ws.addEventListener('message', event => {
        if (socket !== ws) return
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'welcome') {
            clearTimeout(timer)
            lastPongAt = Date.now()
            measureBattleClock()
            resolve()
          }
          if (message.type === 'pong') {
            const receivedAt = Date.now()
            const delay = receivedAt - message.t0
            if (Number.isFinite(message.t0) && Number.isFinite(message.t1) && delay >= 0) {
              lastPongAt = receivedAt
              if (delay <= 2000) {
                clockSamples.push({ delay, offset: message.t1 - (receivedAt + message.t0) / 2 })
                if (clockSamples.length > 8) clockSamples.shift()
              }
            }
          }
          emit(message)
        } catch (error) {
          console.error('battle message parse failed', error)
        }
      })
      ws.addEventListener('close', event => {
        clearTimeout(timer)
        reject(new Error('联机服务器连接失败'))
        if (socket !== ws) return
        if (event.code === 4001) invalidatePlayerToken(token)
        socket = null
        clearInterval(pingTimer)
        emit({ type: 'socket.close', code: event.code })
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('联机服务器连接失败'))
        if (socket === ws) emit({ type: 'socket.error' })
        ws.close()
      }, { once: true })
    })
    if (socket === ws) pingTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)
    return ws
  })().finally(() => {
    if (connecting === pending) connecting = null
  })
  connecting = pending
  return connecting
}

export function sendBattle(type, payload = {}) {
  if (!socket || socket.readyState !== 1) return false
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    // 下一次进度包会包含最新状态；关键消息无法发送时立即结束本轮。
    if (type !== 'battle.progress' && type !== 'ping') disconnect(socket, 'send buffer full')
    return false
  }
  try {
    socket.send(JSON.stringify({ type, ...payload }))
    return true
  } catch (error) {
    console.error('battle send failed', error)
    disconnect(socket, 'send failed')
    return false
  }
}

export function measureBattleClock() {
  return sendBattle('ping', { t0: Date.now() })
}

export function localBattleStart(time) {
  if (!Number.isFinite(time) || !clockSamples.length) return null
  const best = clockSamples.reduce((a, b) => b.delay < a.delay ? b : a)
  return time - best.offset
}

export function closeBattle() {
  generation++
  connecting = null
  clearInterval(pingTimer)
  const current = socket
  socket = null
  if (current) {
    try {
      current.close()
    } catch (error) {
      console.error('close battle socket failed', error)
    }
  }
}

export function isBattleOpen() {
  return !!socket && socket.readyState === 1
}
