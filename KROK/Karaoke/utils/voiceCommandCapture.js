import { getRecognitionFormat } from './phraseAudio.js'

const START_TIMEOUT_MS = 6000
const RECORD_LIMIT_MS = 6000
const FINAL_TIMEOUT_MS = 4000
const MIC_RETRY_MS = 350

export function supportsVoiceCommandCapture() {
  return typeof SpeechRecognitionSession === 'function' &&
    typeof MediaRecorder === 'function' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
}

export function captureVoiceCommand({ onListening, onRecognizing, onResult, onError }) {
  let active = true
  let stage = 'capability'
  let timer
  let stream
  let recorder
  let session
  let writer
  let finalText = ''
  let voiceDetected = false
  const chunks = []

  function releaseMicrophone() {
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }

  function cancel() {
    if (!active) return
    active = false
    clearTimeout(timer)
    if (recorder) {
      recorder.onstop = recorder.ondataavailable = recorder.onerror = null
      try { if (recorder.state !== 'inactive') recorder.stop() } catch {}
    }
    releaseMicrophone()
    if (session) session.onresult = session.onerror = session.onend = null
    if (writer) Promise.resolve().then(() => writer.abort()).catch(() => {})
  }

  function fail(error) {
    if (!active) return
    cancel()
    onError(stage, error)
  }

  function stopRecording() {
    if (!active || recorder.state !== 'recording') return
    stage = 'recognition'
    clearTimeout(timer)
    timer = setTimeout(() => fail('timeout'), FINAL_TIMEOUT_MS)
    onRecognizing()
    try { recorder.stop() } catch (error) { fail(error) }
  }

  async function recognize(mimeType) {
    if (!active) return
    releaseMicrophone()
    if (!chunks.length) {
      cancel()
      onResult([])
      return
    }
    try {
      session = new SpeechRecognitionSession({
        lang: 'zh-CN',
        audio: { mimeType }
      })
      session.onresult = event => {
        if (!active) return
        const text = Array.from(event.results || []).filter(result => result &&
          (result.isFinal ?? result[0]?.isFinal) !== false
        ).map(result => String(result[0]?.transcript || '').trim()).filter(Boolean).join(' ')
        if (text) finalText = text
      }
      session.onerror = fail
      session.onend = () => {
        if (!active) return
        writer = null
        cancel()
        onResult(finalText ? [finalText] : [])
      }
      writer = session.audio.getWriter()
      for (const chunk of chunks) {
        if (!active) return
        await writer.write(chunk)
      }
      if (active) await writer.close()
    } catch (error) {
      fail(error)
    }
  }

  async function openMicrophone() {
    const request = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    try {
      return await request()
    } catch (error) {
      if (!active || !['NotReadableError', 'AbortError', 'InvalidStateError'].includes(error?.name)) throw error
      // Give the host time to release audio capture after the wake event.
      await new Promise(resolve => setTimeout(resolve, MIC_RETRY_MS))
      if (active) return request()
    }
  }

  async function start() {
    timer = setTimeout(() => fail('timeout'), START_TIMEOUT_MS)
    try {
      const format = await getRecognitionFormat()
      if (!active) return
      if (!format) {
        fail('unsupported-format')
        return
      }
      stage = 'microphone'
      const input = await openMicrophone()
      if (!active) {
        input?.getTracks().forEach(track => track.stop())
        return
      }
      stream = input
      stage = 'recording'
      recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        vad: { enabled: true, silenceDurationMs: 650 }
      })
      recorder.ondataavailable = ({ data, voiceActive }) => {
        if (data?.size) chunks.push(data)
        if (voiceActive === true) voiceDetected = true
        else if (voiceActive === false && voiceDetected) stopRecording()
      }
      recorder.onstop = () => {
        if (stage === 'recognition') void recognize(format.mimeType)
        else fail('recorder-stopped')
      }
      recorder.onerror = event => fail(event.error || event)
      clearTimeout(timer)
      timer = setTimeout(stopRecording, RECORD_LIMIT_MS)
      recorder.start(180)
      if (active) onListening()
    } catch (error) {
      fail(error)
    }
  }

  void start()
  return { cancel }
}
