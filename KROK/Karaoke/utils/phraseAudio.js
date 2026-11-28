import { createPitchDetector, createVoiceActivityDetector, hzToMidi } from './pitchEngine.js'

const PREPARE_TIMEOUT_MS = 7000
const POSITION_RETRY_MS = 220
const POSITION_TIMEOUT_MS = 2400
const ASR_PREPARE_TIMEOUT_MS = 1400
const ASR_FINISH_TIMEOUT_MS = 1900
const MAX_PENDING_CHUNKS = 12
const AUDIO_FORMATS = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/wav']
const RECOGNITION_LANGUAGES = { English: 'en-US', 日本語: 'ja-JP', 한국어: 'ko-KR' }
let asrCapabilities

export function createPhrasePlayer(audio, fromMs, onEnd, onError) {
  const native = typeof AudioPlayer === 'function'
  const player = native ? new AudioPlayer() : new Audio()
  const initialTime = fromMs / 1000
  const volume = audio.muted ? 0 : 1
  const nearStart = (tolerance = 0.09) => Math.abs(player.currentTime - initialTime) <= tolerance
  let blobUrl
  let disposed = false
  let playbackRequested = false
  let settled = false
  let sawCanPlay = false
  let timer
  let checkPositionTimer
  let finishStarting
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const settle = error => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (checkPositionTimer != null) clearInterval(checkPositionTimer)
    if (error) rejectReady(error)
    else resolveReady()
  }
  const seeked = () => {
    if (!disposed && sawCanPlay && !player.seeking && nearStart()) settle()
  }
  const canPlay = () => {
    if (disposed || sawCanPlay) return
    sawCanPlay = true
    if (native || initialTime === 0) {
      settle()
      return
    }
    try {
      checkPositionTimer = setInterval(seeked, 30)
      player.currentTime = initialTime
      seeked()
    } catch { settle(new Error('无法定位这句歌词')) }
  }
  const error = () => {
    if (disposed) return
    if (finishStarting) {
      finishStarting(new Error('片段音频不可用'))
      return
    }
    if (settled) onError()
    else settle(new Error('片段音频不可用'))
  }
  const ended = () => { if (!disposed) onEnd() }
  timer = setTimeout(() => settle(new Error('定位片段超时 · 可以重试')), PREPARE_TIMEOUT_MS)

  try {
    player.autoplay = false
    player.volume = volume
    if (native) {
      // Let native playback open at the requested timestamp without a paused seek event.
      try { player.startTime = initialTime } catch (error) {}
      player.onCanplay(canPlay)
      player.onEnded(ended)
      player.onError(error)
      if (audio.bytes) player.setBuffer(audio.bytes, audio.format)
      else player.src = audio.src
    } else {
      player.preload = 'auto'
      player.muted = Boolean(audio.muted)
      player.addEventListener('canplay', canPlay)
      player.addEventListener('seeked', seeked)
      player.addEventListener('ended', ended)
      player.addEventListener('error', error)
      if (audio.bytes) blobUrl = URL.createObjectURL(new Blob([audio.bytes], { type: 'audio/' + audio.format }))
      player.src = blobUrl || audio.src
      player.load()
    }
  } catch { error() }

  function play() {
    playbackRequested = true
    if (!native || initialTime === 0) return player.play()
    // Older runtimes may apply the offset only after play, or require a seek while playing.
    const startedAt = performance.now()
    let triedSeek = false
    let triedCurrentTime = false
    player.volume = 0
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!finishStarting) return
        const elapsed = performance.now() - startedAt
        const time = player.currentTime
        const minimum = triedCurrentTime ? initialTime + 0.005 : initialTime - 0.09
        if (time >= minimum && time <= initialTime + 0.28) {
          finishStarting()
          return
        }
        if (elapsed >= POSITION_TIMEOUT_MS) {
          finishStarting(new Error('定位片段超时 · 可以重试'))
        } else if (!triedSeek && elapsed >= POSITION_RETRY_MS) {
          triedSeek = true
          try { player.seek?.(initialTime) } catch (error) {}
        } else if (!triedCurrentTime && elapsed >= POSITION_RETRY_MS * 2) {
          triedCurrentTime = true
          try { player.currentTime = initialTime } catch (error) {}
        }
      }
      const interval = setInterval(check, 25)
      finishStarting = error => {
        finishStarting = null
        clearInterval(interval)
        if (error) reject(error)
        else {
          player.volume = volume
          resolve()
        }
      }
      try {
        Promise.resolve(player.play()).then(check, error => finishStarting?.(error))
      } catch (error) {
        finishStarting?.(error)
      }
    })
  }

  function pause() {
    if (!playbackRequested) return
    playbackRequested = false
    player.pause()
  }

  return {
    ready,
    get currentTime() { return player.currentTime },
    play,
    pause,
    destroy() {
      if (disposed) return
      disposed = true
      finishStarting?.(new Error('片段已取消'))
      settle(new Error('片段已取消'))
      try { pause() } catch (error) { console.warn('暂停练句播放器失败', error) }
      try {
        if (native) player.destroy()
        else {
          player.removeAttribute('src')
          player.load()
        }
      } catch (error) {
        console.warn('释放练句播放器失败', error)
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl)
      }
    }
  }
}

function readCapabilities() {
  if (!asrCapabilities) {
    asrCapabilities = Promise.resolve().then(() => SpeechRecognitionSession.getCapabilities())
      .catch(error => {
        asrCapabilities = null
        throw error
      })
  }
  return asrCapabilities
}

export async function getRecognitionFormat() {
  if (typeof SpeechRecognitionSession !== 'function' || typeof MediaRecorder !== 'function') return null
  const capabilities = await readCapabilities()
  const supported = capabilities.audioFormats.map(format => format.mimeType.toLowerCase())
  const mimeType = AUDIO_FORMATS.find(format => supported.includes(format) && MediaRecorder.isTypeSupported(format))
  return mimeType ? { mimeType, interimResults: capabilities.interimResults } : null
}

function attachRecognizer(stream, format, lang, onPartial) {
  let recorder
  let writer
  let recognition
  let stopReason
  let finalText = ''
  let finishTimer
  let ending = false
  let queue = Promise.resolve()
  let pending = 0
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const settle = (state, abort = false) => {
    if (stopReason) return
    stopReason = state
    clearTimeout(finishTimer)
    if (recorder) {
      recorder.onstop = null
      recorder.ondataavailable = null
      recorder.onerror = null
      try { if (recorder.state !== 'inactive') recorder.stop() } catch (error) {}
    }
    if (recognition) recognition.onresult = recognition.onend = recognition.onerror = null
    if (abort && writer) Promise.resolve().then(() => writer.abort()).catch(() => {})
    resolveResult({ text: state === 'ok' ? finalText : '', state })
  }
  try {
    recognition = new SpeechRecognitionSession({
      lang, interimResults: format.interimResults,
      audio: { mimeType: format.mimeType }
    })
    recognition.onresult = event => {
      if (stopReason) return
      const items = Array.from(event.results || [])
      finalText = items.filter(item => item.isFinal).map(item => item[0]?.transcript || '').join(' ').trim()
      onPartial(items.map(item => item[0]?.transcript || '').join(' ').trim())
    }
    recognition.onend = () => settle(ending ? (finalText ? 'ok' : 'empty') : 'unavailable')
    recognition.onerror = () => settle('unavailable', true)
    writer = recognition.audio.getWriter()
    recorder = new MediaRecorder(stream, { mimeType: format.mimeType })
    recorder.ondataavailable = ({ data }) => {
      if (!data?.size || stopReason) return
      if (pending >= MAX_PENDING_CHUNKS) {
        settle('unavailable', true)
        return
      }
      pending++
      queue = queue.then(() => stopReason ? undefined : writer.write(data))
        .catch(() => settle('unavailable', true)).finally(() => { pending-- })
    }
    recorder.onstop = () => {
      if (!ending) {
        settle('unavailable', true)
        return
      }
      // Closing the writer follows the final recorded chunk. The ASR end event completes the result.
      queue.then(() => stopReason ? undefined : writer.close()).catch(() => settle('unavailable', true))
    }
    recorder.onerror = () => settle('unavailable', true)
    recorder.start(180)
  } catch {
    settle('unavailable', true)
  }
  return {
    finish() {
      if (!stopReason && !ending) {
        ending = true
        finishTimer = setTimeout(() => settle('timeout', true), ASR_FINISH_TIMEOUT_MS)
        try { recorder.stop() } catch { settle('unavailable', true) }
      }
      return result
    },
    close() { settle('cancelled', true) }
  }
}

export function openPhraseCapture(onPartial, category) {
  let closed = false
  let context
  let stream
  let source
  let format
  let recognition
  let detectPitch
  let detectVoice
  let offsetMs = 0
  let formatTimer
  let finishFormat
  const formatReady = new Promise(resolve => {
    finishFormat = resolve
    formatTimer = setTimeout(resolve, ASR_PREPARE_TIMEOUT_MS)
    getRecognitionFormat().then(resolve, () => resolve())
  }).then(value => {
    clearTimeout(formatTimer)
    format = value
  })

  const micReady = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    if (closed) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    context = new AudioContext()
    source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 4096
    source.connect(analyser)
    if (context.state !== 'running') await context.resume()
    if (closed) return
    if (context.state !== 'running') throw new Error('音准检测不可用 · 可以重试')
    detectPitch = createPitchDetector(analyser, 40, 1200)
    detectVoice = createVoiceActivityDetector(analyser)
    const playbackLatency = Number.isFinite(context.baseLatency) ? context.baseLatency * 1000 : 0
    offsetMs = Math.min(260, 500 * analyser.fftSize / context.sampleRate + 25 + playbackLatency)
  })()

  return {
    ready: Promise.all([micReady, formatReady]),
    get offsetMs() { return offsetMs },
    begin() {
      if (!closed && format) recognition = attachRecognizer(stream, format, RECOGNITION_LANGUAGES[category] || 'zh-CN', onPartial)
    },
    sample() {
      return { midi: hzToMidi(detectPitch()), voiceActive: detectVoice() }
    },
    finish() { return recognition?.finish() || Promise.resolve({ state: 'unavailable' }) },
    close() {
      if (closed) return
      closed = true
      finishFormat()
      clearTimeout(formatTimer)
      try { recognition?.close() } catch (error) { console.warn('停止练句识别失败', error) }
      try { source?.disconnect() } catch (error) { console.warn('断开练句采音失败', error) }
      try { stream?.getTracks().forEach(track => track.stop()) } finally {
        if (context) Promise.resolve().then(() => context.close()).catch(() => {})
      }
    }
  }
}
