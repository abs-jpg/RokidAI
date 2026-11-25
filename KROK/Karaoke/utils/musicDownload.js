import { downloadSong, getCachedSongCatalog, loadSongCatalog } from './songLibrary.js'
import { submitSongRequest } from './leaderboard.js'
import { downloadCatalog } from './downloadCatalog.js'
import { clearDownloadConfirmEcho, isDownloadReturnEcho, rememberDownloadConfirm, rememberDownloadReturn, takeDownloadInput } from './downloadReturn.js'

const ROW_HEIGHT = 36
const NAVIGATION_REPEAT_MS = 250
const DOUBLE_TAP_MS = 350
const TAP_BOUNCE_MS = 60
const SWIPE_SETTLE_MS = 120
const DOUBLE_TAP_SETTLE_MS = 200
const ADD_MUSIC = 'add-music'
const MAX_REQUEST_CHARS = 160
const CATEGORY_HINT = '滑动选语种 · 单击进入 · 双击返回首页'
const SONG_HINT = '滑动选歌 · 单击选版本 · 双击返回语种'
const CHOICE_HINT = '上下切换 · 返回'
const REQUEST_HINT = '滑动切换 · 单击确认 · 双击返回语种'
const AUDIO_OPTIONS = [
  { variant: 'guide', label: '带歌词版' },
  { variant: 'instrumental', label: '纯音乐版' }
]
const CATEGORIES = [
  { key: 'zh', label: '中文歌' },
  { key: 'en', label: '英文歌' },
  { key: 'ja', label: '日语歌' },
  { key: 'ko', label: '韩文歌' },
  { key: ADD_MUSIC, label: '添加音乐' }
]

function categoryOf(song) {
  switch (String(song.category || '').trim().toLowerCase()) {
    case 'english':
    case '英文':
    case '英语': return 'en'
    case 'japanese':
    case '日本語':
    case '日语': return 'ja'
    case 'korean':
    case '한국어':
    case '韩文':
    case '韩语': return 'ko'
    case 'chinese':
    case '中文':
    case '': return 'zh'
  }
}

function navigationAction(key) {
  switch (key) {
    case 'GlobalHook': return 'temple'
    case 'Backspace':
    case 'Escape': return 'back'
    case 'ArrowUp':
    case 'PageUp':
    case 'ArrowLeft': return 'previous'
    case 'ArrowDown':
    case 'PageDown':
    case 'ArrowRight': return 'next'
    case 'NumpadEnter':
    case 'Space':
    case ' ':
    case 'Enter': return 'confirm'
  }
}

function actionValue(event, kind) {
  const prefix = 'download-' + kind + '-'
  const value = event.currentTarget?.dataset?.value ?? event.target?.dataset?.value
  if (value != null) return String(value)
  const id = event.currentTarget?.id || event.target?.id
  return id?.startsWith(prefix) ? id.slice(prefix.length) : undefined
}

function downloadedVersions(song) {
  return {
    guide: Boolean(song.bundled || song.downloadedVariants?.guide),
    instrumental: Boolean(song.bundled || song.downloadedVariants?.instrumental)
  }
}

export class MusicDownload {
  constructor(page) {
    this.page = page
    this.catalogRevision = 0
  }

  get data() {
    return this.page.data
  }

  setData(patch) {
    this.page.setData(patch)
  }

  start(categoryKey, songId) {
    const categoryIndex = CATEGORIES.findIndex(category => category.key === categoryKey)
    if (categoryIndex < 0) {
      this.catalog = this.mergeCachedCatalog(getCachedSongCatalog())
      this.setData({
        ...this.categoryPreview(0),
        phase: 'categories', title: '音乐下载', categories: this.categoryOptions(), hintText: CATEGORY_HINT
      })
      this.refreshCatalog()
      return
    }
    const title = CATEGORIES[categoryIndex].label
    if (categoryKey === ADD_MUSIC) {
      this.setData({ phase: 'request', title, requestPhase: 'idle', requestAction: 0, requestText: '', requestMessage: '', hintText: REQUEST_HINT })
      return
    }
    this.catalog = this.mergeCachedCatalog(getCachedSongCatalog())
    const songs = this.categorySongs(categoryIndex)
    const selectedIdx = songs.length ? Math.max(0, songs.findIndex(song => song.id === songId)) : -1
    this.setData({
      phase: 'songs', title, songs, categoryIndex,
      selectedIdx,
      scrollTop: Math.max(0, selectedIdx) * ROW_HEIGHT,
      downloadProgress: 0,
      downloadLabel: songs.length + ' 首',
      catalogConnected: false,
      catalogLoading: true,
      message: '正在连接曲库',
      hintText: SONG_HINT
    })
    if (songId && songs[selectedIdx]?.id === songId) this.openChoice(selectedIdx)
    this.refreshCatalog()
  }

  dispose() {
    this.closed = true
    this.clearTempleTaps()
    this.cancelDownload()
    this.cancelRequestRecognition()
  }

  async refreshCatalog() {
    if (this.refreshing) return
    this.refreshing = true
    const revision = this.catalogRevision
    if (this.data.phase === 'songs') this.setData({ catalogLoading: true, message: '正在连接曲库' })
    try {
      const result = await loadSongCatalog()
      if (this.closed || revision !== this.catalogRevision) return
      this.useCatalog(result.songs, result.connected)
    } catch (error) {
      console.error('load download catalog error', error)
      if (!this.closed && revision === this.catalogRevision) this.useCatalog(this.catalog, false)
    } finally {
      this.refreshing = false
    }
  }

  useCatalog(songs, connected) {
    this.catalog = connected ? songs : this.mergeCachedCatalog(songs)
    if (this.data.phase === 'categories') {
      this.setData({
        ...this.categoryPreview(this.data.categoryIndex),
        categories: this.categoryOptions(), catalogConnected: connected, catalogLoading: false
      })
      return
    }
    const list = this.categorySongs(this.data.categoryIndex)
    const selectedId = this.data.songs[this.data.selectedIdx]?.id
    const existingIdx = list.findIndex(song => song.id === selectedId)
    const selectedIdx = list.length ? Math.max(0, existingIdx) : -1
    const patch = {
      songs: list,
      selectedIdx,
      scrollTop: Math.max(0, selectedIdx) * ROW_HEIGHT,
      downloadLabel: list.length + ' 首',
      catalogConnected: connected,
      catalogLoading: false,
      message: connected ? '' : (list.length ? '暂未连接曲库 · 显示已有曲目' : '')
    }
    if (this.data.choiceVisible) {
      const song = list.find(item => item.id === this.data.choiceSongId)
      if (song) patch.choiceDownloaded = downloadedVersions(song)
      else if (!this.downloadController) patch.choiceVisible = false
      else return
    }
    this.setData(patch)
  }

  mergeCachedCatalog(songs) {
    return [...new Map([...downloadCatalog, ...songs].map(song => [song.id, song])).values()]
  }

  categorySongs(index) {
    return (this.catalog || downloadCatalog).filter(song => categoryOf(song) === CATEGORIES[index].key)
  }

  categoryOptions() {
    return CATEGORIES.map(category => ({ ...category }))
  }

  categoryPreview(index) {
    const songs = this.categorySongs(index)
    return {
      categoryIndex: index,
      songs,
      addingMusic: CATEGORIES[index].key === ADD_MUSIC,
      scrollTop: 0
    }
  }

  openCategory(index, songId) {
    if (this.data.phase !== 'categories' || !CATEGORIES[index]) return
    this.setData(this.categoryPreview(index))
    this.page.openCategory(CATEGORIES[index].key, songId)
  }

  clearTempleTaps() {
    // Ink requires a numeric timer ID, including when handling a gesture before any tap.
    if (this.tapConfirmTimer != null) clearTimeout(this.tapConfirmTimer)
    if (this.doubleTapTimer != null) clearTimeout(this.doubleTapTimer)
    this.tapConfirmTimer = null
    this.doubleTapTimer = null
    this.lastTempleTapAt = -Infinity
  }

  handleTempleTouch(pressed) {
    const now = performance.now()
    const pairedRelease = !pressed && now - (this.templeDownAt ?? -Infinity) <= DOUBLE_TAP_MS
    this.templeDownAt = pressed ? now : -Infinity
    if (pairedRelease || this.doubleTapTimer != null) return
    if (now - (this.lastSwipeAt ?? -Infinity) < SWIPE_SETTLE_MS) return
    const gap = now - (this.lastTempleTapAt ?? -Infinity)
    if (gap < TAP_BOUNCE_MS) return
    clearDownloadConfirmEcho()
    if (gap > DOUBLE_TAP_MS) {
      this.lastTempleTapAt = now
      this.tapConfirmTimer = setTimeout(() => {
        rememberDownloadConfirm()
        this.confirmSelection()
      }, DOUBLE_TAP_MS)
      return
    }
    this.clearTempleTaps()
    // 方向键有短暂的补发窗口；真正的返回键仍由 handleInput 立即处理。
    this.doubleTapTimer = setTimeout(() => {
      this.clearTempleTaps()
      rememberDownloadReturn()
      this.back()
    }, DOUBLE_TAP_SETTLE_MS)
  }

  handleInput(event, pressed) {
    const action = navigationAction(event.code) || navigationAction(event.key)
    if (pressed && action !== 'temple') return
    if (!action || !takeDownloadInput(event)) return
    if (isDownloadReturnEcho(event) || event.repeat || this.closed || this.page.navigating) return
    if (action === 'temple') {
      this.handleTempleTouch(pressed)
      return
    }
    if (action === 'back') {
      this.clearTempleTaps()
      this.back()
      return
    }

    const at = performance.now()
    if (action !== 'confirm') {
      this.lastSwipeAt = at
      this.clearTempleTaps()
      clearDownloadConfirmEcho()
    }
    if (this.lastNavigation?.action === action && at - this.lastNavigation.at < NAVIGATION_REPEAT_MS) return
    this.lastNavigation = { action, at }

    if (action === 'confirm') {
      if (this.doubleTapTimer == null && this.tapConfirmTimer == null) {
        this.confirmSelection()
      }
      return
    }
    this.stepSelection(action === 'previous' ? -1 : 1)
  }

  stepSelection(direction) {
    const { phase, categoryIndex, selectedIdx, songs } = this.data
    if (this.data.choiceVisible) {
      this.selectChoice(1 - this.data.choiceIndex)
      return
    }
    if (phase === 'request') {
      this.setData({ requestAction: direction < 0 ? 0 : 1 })
      return
    }
    if (phase === 'categories') {
      const count = CATEGORIES.length
      this.setData(this.categoryPreview((categoryIndex + direction + count) % count))
      return
    }
    const next = selectedIdx + direction
    if (next >= 0 && next < songs.length) this.setData({ selectedIdx: next, scrollTop: next * ROW_HEIGHT })
  }

  confirmSelection() {
    if (this.closed) return
    this.clearTempleTaps()
    const { phase, requestAction, categoryIndex, selectedIdx } = this.data
    if (this.data.choiceVisible) {
      this.downloadSelected()
    } else if (phase === 'request') {
      if (requestAction === 0) this.onRequestRecord()
      else this.onRequestSend()
    } else if (phase === 'categories') {
      this.openCategory(categoryIndex)
    } else if (!this.data.songs.length && !this.data.catalogConnected) {
      this.refreshCatalog()
    } else {
      this.openChoice(selectedIdx)
    }
  }

  onTapSong(event) {
    if (this.page.navigating || this.data.choiceVisible) return
    const id = actionValue(event, 'song')
    const selectedIdx = this.data.songs.findIndex(song => song.id === id)
    if (selectedIdx < 0) return
    this.clearTempleTaps()
    if (this.data.phase === 'categories') {
      this.openCategory(this.data.categoryIndex, id)
      return
    }
    this.openChoice(selectedIdx)
  }

  openChoice(index) {
    const song = this.data.songs[index]
    if (!song) return
    const choiceDownloaded = downloadedVersions(song)
    this.setData({
      selectedIdx: index,
      scrollTop: index * ROW_HEIGHT,
      choiceVisible: true,
      choiceSongId: song.id,
      choiceSongName: song.name,
      choiceDownloaded,
      choiceIndex: choiceDownloaded.guide && !choiceDownloaded.instrumental ? 1 : 0,
      choiceHint: CHOICE_HINT,
      downloadProgress: 0
    })
  }

  selectChoice(index) {
    if (!this.data.choiceVisible || this.downloadController || !AUDIO_OPTIONS[index]) return
    this.setData({ choiceIndex: index, choiceHint: CHOICE_HINT })
  }

  back() {
    if (this.data.choiceVisible) {
      this.cancelDownload()
      this.setData({ choiceVisible: false, choiceDownloading: false, downloadProgress: 0 })
      return
    }
    this.page.goBack()
  }

  onTapCategory(event) {
    const key = actionValue(event, 'category')
    this.clearTempleTaps()
    this.openCategory(CATEGORIES.findIndex(category => category.key === key))
  }

  onRequestRecord() {
    if (this.data.phase !== 'request' || this.data.requestPhase === 'sending' ||
        this.data.requestPhase === 'recognizing') return
    if (this.requestRecognition) {
      this.stopRequestRecording()
      return
    }
    if (typeof SpeechRecognition !== 'function') {
      this.setData({ requestMessage: '当前设备不支持语音识别' })
      return
    }
    try {
      const recognition = new SpeechRecognition()
      recognition.lang = 'zh-CN'
      recognition.interimResults = true
      this.requestRecognition = recognition
      this.requestId = null
      this.setData({ requestPhase: 'listening', requestAction: 0, requestText: '', requestMessage: '正在聆听 · 说出歌名和歌手' })
      recognition.onresult = event => {
        if (this.requestRecognition !== recognition) return
        const results = event.results || []
        const transcripts = Array.from(results, result => String(result?.[0]?.transcript || '').trim())
        const characters = Array.from(transcripts.filter(Boolean).join(' '))
        this.requestTextTooLong = characters.length > MAX_REQUEST_CHARS
        this.setData({ requestText: characters.slice(0, MAX_REQUEST_CHARS).join('') })
      }
      recognition.onend = () => this.completeRequestRecognition(recognition)
      recognition.onerror = event => {
        if (this.requestRecognition !== recognition) return
        this.cancelRequestRecognition()
        const message = event.error === 'not-allowed' ? '请允许麦克风访问后重试' : '语音识别失败，请重试'
        this.setData({ requestPhase: 'idle', requestText: '', requestMessage: message })
      }
      this.requestTextTooLong = false
      this.requestTimer = setTimeout(() => this.stopRequestRecording(), 25000)
      recognition.start()
    } catch (error) {
      this.cancelRequestRecognition()
      this.setData({ requestPhase: 'idle', requestText: '', requestMessage: '无法开始录音，请重试' })
    }
  }

  stopRequestRecording() {
    const recognition = this.requestRecognition
    if (!recognition || this.data.requestPhase !== 'listening') return
    this.clearRequestTimer()
    this.setData({ requestPhase: 'recognizing', requestMessage: '正在整理留言' })
    this.requestTimer = setTimeout(() => {
      if (this.completeRequestRecognition(recognition)) {
        try { recognition.abort() } catch {}
      }
    }, 5000)
    try {
      recognition.stop()
    } catch (error) {
      this.cancelRequestRecognition()
      this.setData({ requestPhase: 'idle', requestText: '', requestMessage: '语音识别已中断，请重试' })
    }
  }

  completeRequestRecognition(recognition) {
    if (this.requestRecognition !== recognition) return false
    this.requestRecognition = null
    this.clearRequestTimer()
    if (this.requestTextTooLong) {
      this.setData({ requestPhase: 'idle', requestAction: 0, requestMessage: '留言最多 160 字，请重录' })
    } else if (this.data.requestText) {
      this.setData({ requestPhase: 'ready', requestAction: 1, requestMessage: '确认识别内容后发送' })
    } else {
      this.setData({ requestPhase: 'idle', requestAction: 0, requestMessage: '没有识别到文字，请重录' })
    }
    return true
  }

  cancelRequestRecognition() {
    this.clearRequestTimer()
    const recognition = this.requestRecognition
    this.requestRecognition = null
    if (!recognition) return false
    try { recognition.abort() } catch {}
    return true
  }

  clearRequestTimer() {
    if (this.requestTimer != null) clearTimeout(this.requestTimer)
    this.requestTimer = null
  }

  async onRequestSend() {
    if (this.data.phase !== 'request' || this.data.requestPhase !== 'ready') return
    const id = this.requestId || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))
    this.requestId = id
    const text = this.data.requestText
    this.setData({ requestPhase: 'sending', requestAction: 1, requestMessage: '正在发送留言' })
    try {
      await submitSongRequest(id, text)
      if (!this.closed && this.data.phase === 'request' && this.requestId === id) {
        this.setData({ requestPhase: 'sent', requestAction: 0, requestMessage: '留言已发送' })
      }
    } catch (error) {
      if (!this.closed && this.data.phase === 'request' && this.requestId === id) {
        this.setData({ requestPhase: 'ready', requestMessage: error.message || '发送失败，请重试' })
      }
    }
  }

  cancelDownload() {
    const controller = this.downloadController
    this.downloadController = null
    controller?.abort()
  }

  async downloadSelected() {
    if (!this.data.choiceVisible || this.downloadController) return
    const { variant, label } = AUDIO_OPTIONS[this.data.choiceIndex]
    if (this.data.choiceDownloaded[variant]) return
    const song = this.data.songs.find(item => item.id === this.data.choiceSongId)
    if (!song) return

    const controller = new AbortController()
    this.downloadController = controller
    this.setData({ choiceDownloading: true, downloadProgress: 0, choiceHint: '正在准备' + label + '…' })
    try {
      const result = await downloadSong(song.id, variant, {
        signal: controller.signal,
        onProgress: ({ bytes, total }) => {
          if (this.downloadController !== controller) return
          const percent = total > 0 ? Math.min(100, Math.floor(100 * bytes / total)) : 0
          if (percent === this.data.downloadProgress) return
          this.setData({
            downloadProgress: percent,
            choiceHint: '正在下载 · ' + percent + '%'
          })
        }
      })
      if (this.downloadController !== controller) return
      if (!result.offline) {
        this.setData({ choiceHint: '当前环境不支持离线存储' })
        return
      }
      this.catalogRevision++
      const choiceDownloaded = result.downloadedVariants
      const mark = item => item.id === song.id ? {
        ...item,
        downloadedVariants: choiceDownloaded,
        downloaded: choiceDownloaded.guide && choiceDownloaded.instrumental
      } : item
      this.catalog = (this.catalog || downloadCatalog).map(mark)
      this.setData({
        catalogConnected: true,
        catalogLoading: false,
        songs: this.data.songs.map(mark),
        choiceDownloaded,
        choiceHint: label + '已下载'
      })
    } catch (error) {
      if (this.downloadController === controller) {
        if (error.name !== 'AbortError') console.error('download song error', error)
        this.setData({
          choiceHint: error.name === 'AbortError'
            ? '下载已取消'
            : '下载失败 · ' + (error.message || '再确认重试')
        })
      }
    } finally {
      if (this.downloadController === controller) {
        this.downloadController = null
        this.setData({ choiceDownloading: false, downloadProgress: 0 })
      }
    }
  }
}
