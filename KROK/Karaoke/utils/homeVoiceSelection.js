import { captureVoiceCommand, supportsVoiceCommandCapture } from './voiceCommandCapture.js'

const LISTEN_TIMEOUT_MS = 9000
const HINT_TIMEOUT_MS = 4500
const NO_SPEECH_HINT = '没听清 · 唤醒后再说一次'

function recognitionFailure(stage, error) {
  const code = String(error?.error || error?.name || error || '').toLowerCase()
  console.warn('语音点歌失败', stage, code, error?.message || '')
  if (['not-allowed', 'notallowederror', 'securityerror'].includes(code)) {
    return stage === 'recognition' || stage === 'capability'
      ? '语音识别服务权限受限'
      : '请允许麦克风访问后重试'
  }
  if (code === 'no-speech') return NO_SPEECH_HINT
  if (code === 'network' || code === 'networkerror') return '语音服务连接失败 · 请检查网络'
  if (code === 'unsupported-format') return '当前环境不支持点歌录音格式'
  if (stage === 'microphone' || stage === 'recording' || code === 'audio-capture') {
    return '麦克风暂不可用 · 请稍后重试'
  }
  if (code === 'timeout') return '语音识别超时 · 请重试'
  return '语音识别服务暂不可用 · 请重试'
}

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')
}

function songMatches(title, artist, requested) {
  if (!title) return false
  return requested === title || (artist && (
    requested === artist + title || requested === artist + '的' + title || requested === title + artist
  ))
}

function resolveSelection(transcripts, { songs, navItems, songCount }) {
  for (const transcript of transcripts) {
    const command = normalize(transcript).replace(/^(?:乐奇|hirokid)/u, '').replace(/^(?:请|帮我)+/u, '')
    if (!command) continue
    const moduleName = command.replace(/^(?:打开|进入)/u, '')
    const moduleIndex = navItems.findIndex(item =>
      moduleName === item.label || (moduleName === '排行榜' && item.label === '本机排行榜')
    )
    if (moduleIndex >= 0) return { index: songCount + moduleIndex }

    const requested = command.replace(/^(?:我想唱|我要唱|点歌|播放|选择|打开|找|唱)/u, '')
    const exact = []
    const aliases = []
    for (const [index, song] of songs.entries()) {
      const name = song.name || ''
      const title = normalize(name)
      const artist = normalize(song.artist)
      if (songMatches(title, artist, command) || songMatches(title, artist, requested)) {
        exact.push(index)
      } else {
        const baseTitle = normalize(name.replace(/[（(].*$/u, ''))
        if (songMatches(baseTitle, artist, requested)) aliases.push(index)
      }
    }
    const matches = exact.length ? exact : aliases
    if (matches.length === 1) return { index: matches[0] }
    if (matches.length > 1) return { hint: '找到同名歌曲 · 请说歌手和歌名' }
  }
  return null
}

export class HomeVoiceSelection {
  constructor(page) {
    this.page = page
  }

  start() {
    if (this.request) return
    if (supportsVoiceCommandCapture()) {
      const request = {}
      this.request = request
      this.showHint('正在开启麦克风…', false)
      request.capture = captureVoiceCommand({
        onListening: () => this.showHint('正在聆听 · 请说歌名或模块', false),
        onRecognizing: () => this.showHint('正在识别…', false),
        onResult: transcripts => {
          if (this.request !== request) return
          if (transcripts.length) void this.select(request, transcripts)
          else this.finish(request, NO_SPEECH_HINT)
        },
        onError: (stage, error) => this.finish(request, recognitionFailure(stage, error))
      })
      return
    }
    if (typeof SpeechRecognition !== 'function') {
      this.showHint('当前设备不支持语音点歌')
      return
    }
    const request = {}
    this.request = request
    try {
      const recognition = new SpeechRecognition()
      request.recognition = recognition
      recognition.lang = 'zh-CN'
      recognition.interimResults = false
      const isListening = () => this.request === request && request.recognition === recognition

      recognition.onresult = event => {
        if (!isListening()) return
        const result = event.results?.[event.resultIndex ?? 0]
        if (!result || (result.isFinal ?? result[0]?.isFinal) === false) return
        const transcripts = Array.from(result, item => String(item?.transcript || '').trim()).filter(Boolean)
        if (transcripts.length) void this.select(request, transcripts)
      }
      recognition.onend = recognition.onnomatch = () => {
        if (isListening()) this.finish(request, NO_SPEECH_HINT)
      }
      recognition.onerror = event => {
        if (!isListening()) return
        this.finish(request, recognitionFailure('direct', event))
      }

      recognition.onaudiostart = () => {
        if (isListening()) this.showHint('正在聆听 · 请说歌名或模块', false)
      }
      this.showHint('正在开启麦克风…', false)
      request.timer = setTimeout(() => this.finish(request, NO_SPEECH_HINT), LISTEN_TIMEOUT_MS)
      recognition.start()
    } catch (error) {
      this.finish(request, recognitionFailure('direct', error))
    }
  }

  async select(request, transcripts) {
    this.releaseRecognition(request)
    let selection = resolveSelection(transcripts, this.page.data)
    const catalogRefresh = this.page.voiceCatalogRefresh
    if (!selection && catalogRefresh) {
      this.showHint('正在查找已下载歌曲…', false)
      await catalogRefresh
      if (this.request !== request) return
      selection = resolveSelection(transcripts, this.page.data)
    }
    if (this.page.navigating) {
      this.finish(request, '')
      return
    }
    if (selection?.index != null) {
      this.finish(request, '')
      this.page.activate(selection.index)
      return
    }
    this.finish(request, selection?.hint || '没找到已下载歌曲或模块')
  }

  releaseRecognition(request) {
    if (request.timer != null) clearTimeout(request.timer)
    request.timer = null
    request.capture?.cancel()
    request.capture = null
    const recognition = request.recognition
    request.recognition = null
    try { recognition?.abort() } catch { /* 已结束的会话无需再次释放。 */ }
  }

  finish(request, hint) {
    if (this.request !== request) return
    this.request = null
    this.releaseRecognition(request)
    this.showHint(hint)
  }

  showHint(hint, autoClear = true) {
    if (this.hintTimer != null) clearTimeout(this.hintTimer)
    this.hintTimer = null
    this.page.setData({ voiceHint: hint })
    if (hint && autoClear) {
      this.hintTimer = setTimeout(() => this.showHint(''), HINT_TIMEOUT_MS)
    }
  }

  cancel() {
    if (this.request) this.finish(this.request, '')
    else if (this.hintTimer != null) this.showHint('')
  }
}
