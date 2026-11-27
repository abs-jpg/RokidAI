import { LEADERBOARD_API_URLS } from './leaderboardConfig.js'
import { getPlayerToken, invalidatePlayerToken } from './leaderboard.js'

const WS_URLS = (LEADERBOARD_API_URLS || []).map(url => url.replace(/^http/, 'ws'))
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
  if (!WS_URLS.length) throw new Error('联机服务器未配置')
  if (connecting) return connecting
  if (socket && socket.readyState === 1) return socket

  const requestedGeneration = generation
  const pending = (async () => {
    const token = await getPlayerToken()
    if (requestedGeneration !== generation) throw new Error('联机连接已取消')

    let lastError = new Error('联机服务器连接失败')
    for (const wsUrl of WS_URLS) {
      if (requestedGeneration !== generation) throw new Error('联机连接已取消')
      try {
        const ws = await openBattleSocket(wsUrl, token, requestedGeneration)
        if (socket === ws) pingTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)
        return ws
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  })().finally(() => {
    if (connecting === pending) connecting = null
  })
  connecting = pending
  return connecting
}

function openBattleSocket(wsUrl, token, requestedGeneration) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl + '/ws')
    socket = ws
    clockSamples = []
    let welcomed = false
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket === ws) socket = null
      try { ws.close() } catch {}
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('联机服务器连接超时')), 8000)
    ws.addEventListener('open', () => {
      if (socket === ws && requestedGeneration === generation) {
        ws.send(JSON.stringify({ type: 'auth', token }))
      }
    }, { once: true })
    ws.addEventListener('message', event => {
      if (socket !== ws) return
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'welcome') {
          settled = true
          clearTimeout(timer)
          welcomed = true
          lastPongAt = Date.now()
          measureBattleClock()
          resolve(ws)
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
      if (!welcomed) {
        fail(new Error('联机服务器连接失败'))
        return
      }
      if (socket !== ws) return
      if (event.code === 4001) invalidatePlayerToken(token)
      socket = null
      clearInterval(pingTimer)
      emit({ type: 'socket.close', code: event.code })
    }, { once: true })
    ws.addEventListener('error', () => {
      if (!welcomed) {
        fail(new Error('联机服务器连接失败'))
        return
      }
      if (socket === ws) emit({ type: 'socket.error' })
      ws.close()
    }, { once: true })
  })
}

export function sendBattle(type, payload = {}) {
  if (!socket || socket.readyState !== 1) return false
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    // 下一次进度包会包含最新状态；关键消息无法发送时立即结束本轮。
    if (!['battle.progress', 'battle.cheer', 'battle.result.leave', 'ping'].includes(type)) disconnect(socket, 'send buffer full')
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
