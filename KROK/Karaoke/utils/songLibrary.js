import wx from 'wx'
import { LEADERBOARD_API_URL, LEADERBOARD_API_URLS } from './leaderboardConfig.js'
import { songs as bundledSongs, getSongById as getBundledSong } from './songData.js'

const SERVER_URL = LEADERBOARD_API_URL.trim().replace(/\/+$/, '')
const SERVER_URLS = (typeof LEADERBOARD_API_URLS !== 'undefined' && LEADERBOARD_API_URLS) ||
  (SERVER_URL ? [SERVER_URL] : [])
const CATALOG_KEY = 'karaoke_remote_catalog:' + SERVER_URL
const DETAIL_KEY = CATALOG_KEY + ':song:'
const DOWNLOAD_KEY = CATALOG_KEY + ':download:'
const MAX_AUDIO_BYTES = 30 * 1024 * 1024
const DOWNLOAD_CHUNK_BYTES = 64 * 1024
const AUDIO_VARIANTS = ['guide', 'instrumental']
const preloadPromises = new Map()
const preloadedAudio = new Map()
let catalogPromise
let latestCatalog = new Map()
let activeOrigin

function requestWithWx(url, { method = 'GET', headers, signal, timeout }, responseType = 'text') {
  return new Promise((resolve, reject) => {
    let task
    const finish = (callback, value) => {
      signal?.removeEventListener('abort', cancel)
      callback(value)
    }
    const cancel = () => {
      finish(reject, new DOMException('请求已取消', 'AbortError'))
      task?.abort?.()
    }
    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      task = wx.request({
        url, method, header: headers, timeout, responseType, dataType: 'text',
        success: result => finish(resolve, result),
        fail: error => finish(reject, new Error(error?.errMsg || '曲库连接失败'))
      })
    } catch (error) {
      finish(reject, error)
    }
  })
}

async function request(path, options, timeout = 7000, validate) {
  if (!SERVER_URLS.length) throw new Error('曲库服务器未配置')
  let lastError = new Error('曲库服务器不可用')
  const signal = options?.signal
  const origins = activeOrigin
    ? [activeOrigin, ...SERVER_URLS.filter(origin => origin !== activeOrigin)]
    : SERVER_URLS
  for (const baseUrl of origins) {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(), timeout)
    let result
    try {
      const response = await fetch(baseUrl + path, { ...options, signal: controller.signal, timeout })
      result = { ok: response.ok, body: await response.json() }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    if (!result && !signal?.aborted && typeof wx.request === 'function') {
      try {
        const { statusCode, data } = await requestWithWx(baseUrl + path, { ...options, timeout })
        result = { ok: statusCode >= 200 && statusCode < 300, body: typeof data === 'string' ? JSON.parse(data) : data }
      } catch (error) {
        lastError = error
      }
    }
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    if (!result) continue
    if (!result.ok || (validate && !validate(result.body))) {
      lastError = new Error(result.body?.error || '曲库响应无效')
      continue
    }
    activeOrigin = baseUrl
    return { body: result.body, baseUrl }
  }
  throw lastError
}

function sameVersion(a, b) {
  return a?.id === b?.id && a?.chartVersion === b?.chartVersion
}

async function audioFile(song, variant, create) {
  const root = await navigator.storage.getDirectory()
  const folder = await root.getDirectoryHandle('karaoke-audio', { create })
  const url = audioUrl(song, variant)
  const extension = (url?.split(/[?#]/)[0].match(/\.(ogg|mp3|wav|m4a|aac)$/i)?.[1] || 'ogg').toLowerCase()
  const storageVariant = audioUrl(song, 'guide') === audioUrl(song, 'instrumental') ? 'shared' : variant
  const key = encodeURIComponent(SERVER_URL) + '-' + song.id + '-' + song.chartVersion + '-' +
    storageVariant + '.' + extension
  return folder.getFileHandle(key, { create })
}

async function localFile(song, variant) {
  try {
    const saved = wx.getStorageSync(DOWNLOAD_KEY + song.id)
    if (!saved || !sameVersion(saved, song)) return null
    const file = await (await audioFile({ ...song, ...saved }, variant, false)).getFile()
    return file.size > 0 && file.size <= MAX_AUDIO_BYTES ? file : null
  } catch {
    return null
  }
}

export function getSongAudio(song, mode = 'instrumental') {
  const variant = mode === 'guide' ? 'guide' : 'instrumental'
  const src = variant === 'guide'
    ? song.guideAccompaniment || song.accompaniment
    : song.instrumentalAccompaniment || song.accompaniment
  if (!src) return null
  const extension = (src.split(/[?#]/)[0].match(/\.(ogg|mp3|wav|m4a|aac)$/i)?.[1] || 'ogg').toLowerCase()
  return { variant, src, format: extension === 'm4a' || extension === 'aac' ? 'm4a' : extension }
}

function preloadKey(song, mode) {
  const audio = getSongAudio(song, mode)
  return audio
    ? [song.id, song.chartVersion, audio.variant, audio.src].join('|')
    : ''
}

export function preloadSongAudio(song, mode = 'instrumental') {
  const key = preloadKey(song, mode)
  if (!key) return Promise.reject(new Error('伴奏不可用'))
  if (preloadedAudio.has(key)) return Promise.resolve({ ready: true })
  if (preloadPromises.has(key)) return preloadPromises.get(key)

  const audio = getSongAudio(song, mode)
  const promise = (async () => {
    try {
      if (/^https?:\/\//i.test(audio.src)) {
        const response = await fetch(audio.src, { timeout: 30000 })
        if (!response.ok) throw new Error('伴奏预热失败')
        if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) throw new Error('伴奏文件过大')
        const bytes = await response.arrayBuffer()
        if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('伴奏文件无效')
        preloadedAudio.set(key, bytes)
        return { ready: true, bytes: bytes.byteLength, format: audio.format }
      }
      await prewarmMediaSource(audio.src)
      preloadedAudio.set(key, null)
      return { ready: true, bytes: 0, format: audio.format }
    } catch (error) {
      console.error('preload song audio error', song.id, mode, error)
      throw error
    }
  })()
  preloadPromises.set(key, promise)
  return promise
}

function prewarmMediaSource(src) {
  return new Promise((resolve, reject) => {
    let player = null
    let media = null
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      if (player && typeof player.destroy === 'function') {
        try { player.destroy() } catch (error) {}
      }
      if (media) {
        try {
          media.pause()
          media.src = ''
        } catch (error) {}
      }
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('伴奏预热超时')), 10000)

    try {
      if (typeof AudioPlayer !== 'undefined') {
        player = new AudioPlayer()
        player.autoplay = false
        player.onCanplay(() => finish())
        player.onError(error => finish(error || new Error('伴奏预热失败')))
        player.src = src
      } else if (typeof Audio !== 'undefined') {
        media = new Audio(src)
        media.preload = 'auto'
        media.addEventListener('canplay', () => finish(), { once: true })
        media.addEventListener('canplaythrough', () => finish(), { once: true })
        media.addEventListener('error', () => finish(new Error('伴奏预热失败')), { once: true })
        media.load()
      } else {
        finish(new Error('播放器不可用'))
      }
    } catch (error) {
      finish(error)
    }
  })
}

export function getPreloadedSongAudio(song, mode = 'instrumental') {
  const key = preloadKey(song, mode)
  return key ? preloadedAudio.get(key) || null : null
}

function audioUrl(song, variant) {
  return getSongAudio(song, variant)?.src || null
}

export async function readDownloadedAudio(song, mode = 'instrumental') {
  const file = await localFile(song, mode === 'guide' ? 'guide' : 'instrumental')
  if (file) return file.arrayBuffer()
  const preloaded = getPreloadedSongAudio(song, mode)
  return preloaded ? preloaded.slice(0) : null
}

function absoluteUrl(url, baseUrl = SERVER_URL) {
  if (!url) return url
  return url.startsWith('/') ? baseUrl + url : url
}

function normalizeSongUrls(song, baseUrl = SERVER_URL) {
  return {
    ...song,
    guideAccompaniment: absoluteUrl(song.guideAccompaniment, baseUrl) || null,
    instrumentalAccompaniment: absoluteUrl(song.instrumentalAccompaniment, baseUrl) || null,
    accompaniment: absoluteUrl(song.accompaniment, baseUrl) || null
  }
}

function readCachedCatalog() {
  try {
    const list = wx.getStorageSync(CATALOG_KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function mergeCatalog(remoteSongs) {
  const merged = bundledSongs.map(local => {
    const online = remoteSongs.find(song => song.id === local.id)
    return { ...online, ...local, bundled: true, online: false }
  })
  for (const song of remoteSongs) {
    if (!merged.some(item => item.id === song.id)) merged.push({ ...song, bundled: false, online: true })
  }
  return merged
}

export function getCachedSongCatalog() {
  return mergeCatalog(readCachedCatalog())
}

async function fetchCatalog() {
  if (!/^https?:\/\//.test(SERVER_URL)) return { songs: [], connected: false }
  try {
    const { body } = await request('/api/songs', undefined, 7000, data => Array.isArray(data?.songs))
    try {
      wx.setStorageSync(CATALOG_KEY, body.songs)
    } catch (e) {
      console.error('cache catalog error', e)
    }
    return { songs: body.songs, connected: true }
  } catch (e) {
    console.error('fetch song catalog error', e)
  }
  const cached = readCachedCatalog()
  return {
    songs: cached,
    connected: false
  }
}

/**
 * 线上曲库 + 内置曲库合并。内置曲目优先，线上新增曲目追加在后面。
 */
export async function loadSongCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const remote = await fetchCatalog()
      const remoteSongs = remote.songs
      latestCatalog = new Map(remoteSongs.map(song => [song.id, song]))
      const songs = await Promise.all(mergeCatalog(remoteSongs).map(async song => {
        let saved = null
        try {
          const candidate = wx.getStorageSync(DOWNLOAD_KEY + song.id)
          saved = candidate && sameVersion(candidate, song) ? candidate : null
        } catch (e) {
          saved = null
        }
        const effective = saved ? { ...song, ...saved } : song
        const variants = [...new Set(AUDIO_VARIANTS.map(variant => audioUrl(effective, variant)).filter(Boolean))]
        const localFiles = await Promise.all(AUDIO_VARIANTS.map(variant => localFile(effective, variant)))
        const downloaded = song.bundled || (variants.length > 0 && variants.every((url, index) => Boolean(localFiles[index])))
        return { ...song, downloaded }
      }))
      return { songs, connected: remote.connected }
    })().finally(() => { catalogPromise = null })
  }
  return catalogPromise
}

async function fetchSongDetail(id) {
  const { body, baseUrl } = await request('/api/songs/' + encodeURIComponent(id))
  if (body?.song?.id !== id) throw new Error('无法加载歌曲')
  const song = normalizeSongUrls(body.song, baseUrl)
  try {
    wx.setStorageSync(DETAIL_KEY + id, song)
  } catch (e) {
    console.error('cache song detail error', e)
  }
  return song
}

/**
 * 按 id 取完整谱面：内置曲目直接返回，线上曲目从服务器下载详情并缓存。
 */
export async function getSongFromLibrary(id) {
  const bundled = getBundledSong(id)
  if (bundled) return bundled

  let cached = null
  try {
    cached = wx.getStorageSync(DETAIL_KEY + id)
  } catch (e) {
    cached = null
  }
  const latest = latestCatalog.get(id)
  const usable = cached?.id === id && (!latest || sameVersion(cached, latest))
  let song = usable && (cached.guideAccompaniment || cached.instrumentalAccompaniment || cached.accompaniment) ? cached : null
  if (!song) {
    try {
      song = await fetchSongDetail(id)
    } catch (error) {
      if (!usable) throw error
      song = cached
    }
  }
  return normalizeSongUrls(song, activeOrigin)
}

/**
 * 请求服务器准备歌曲。服务器只会从源站下载一次，并发请求共享同一次下载。
 */
export async function prepareSongDownload(id, options = {}) {
  const { body, baseUrl } = await request('/api/songs/' + encodeURIComponent(id) + '/prepare', {
    method: 'POST',
    signal: options.signal
  }, 40000)
  if (body?.song?.id !== id ||
      !(body.song.guideAccompaniment || body.song.instrumentalAccompaniment || body.song.accompaniment)) {
    throw new Error('伴奏不可用')
  }
  const song = normalizeSongUrls(body.song, baseUrl)
  latestCatalog.set(id, song)
  try {
    wx.setStorageSync(DETAIL_KEY + id, song)
  } catch (e) {
    console.error('cache prepared song error', e)
  }
  return song
}

export async function downloadSong(id, options = {}) {
  const song = await prepareSongDownload(id, options)
  const variants = [...new Set(AUDIO_VARIANTS.map(variant => audioUrl(song, variant)).filter(Boolean))]
  if (!variants.length) throw new Error('伴奏不可用')
  try {
    for (let index = 0; index < variants.length; index++) {
      const url = variants[index]
      const variant = AUDIO_VARIANTS.find(name => audioUrl(song, name) === url)
      await downloadAudio(song, variant, url, options, index, variants.length)
    }
  } catch (error) {
    if (!navigator.storage || error.name === 'NotSupportedError') return { offline: false }
    throw error
  }
  wx.setStorageSync(DOWNLOAD_KEY + id, song)
  return { offline: true }
}

// 单个分片使用独立的 AbortController 和 8 秒超时，失败重试一次。
// 这样每一片的超时预算互不影响，也不会被整文件下载的超时拖累。
async function fetchAudioChunk(url, start, end, outerSignal, useNative) {
  let lastError
  const headers = { Range: 'bytes=' + start + '-' + end }
  const timeout = 8000
  for (let attempt = 0; attempt < 2; attempt++) {
    if (outerSignal.aborted) throw new DOMException('下载已取消', 'AbortError')
    const chunkController = new AbortController()
    const onOuterAbort = () => chunkController.abort()
    outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => chunkController.abort(), timeout)
    try {
      const options = { signal: chunkController.signal, headers, timeout }
      if (useNative) {
        const { statusCode, header, data } = await requestWithWx(url, options, 'arraybuffer')
        if (statusCode !== 200 && statusCode !== 206) throw new Error('伴奏下载失败')
        const contentRange = Object.entries(header || {}).find(([key]) => key.toLowerCase() === 'content-range')?.[1]
        return { status: statusCode, contentRange, bytes: new Uint8Array(data), useNative }
      }
      const response = await fetch(url, options)
      if (response.status !== 200 && response.status !== 206) throw new Error('伴奏下载失败')
      const contentRange = response.headers.get('content-range') || response.headers.get('Content-Range')
      return { status: response.status, contentRange, bytes: new Uint8Array(await response.arrayBuffer()), useNative }
    } catch (error) {
      lastError = error
      if (outerSignal.aborted) throw new DOMException('下载已取消', 'AbortError')
      if (attempt === 1) throw error.name === 'AbortError' ? new Error('下载超时') : error
      if (typeof wx.request === 'function') useNative = true
    } finally {
      clearTimeout(timer)
      outerSignal.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastError || new Error('伴奏下载失败')
}

async function downloadAudio(song, variant, url, options, index, count) {
  const handle = await audioFile(song, variant, true)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), 180000)
  let writer
  try {
    // AIUI fetch 默认约 5 秒超时且可能忽略 timeout 参数。
    // 64KB Range 分片，每片单独计时和重试。
    const chunks = []
    let total = 0
    let loaded = 0
    let start = 0
    let guard = 0
    let useNative = false
    while (guard++ < 4000) {
      if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError')
      const end = total > 0
        ? Math.min(start + DOWNLOAD_CHUNK_BYTES - 1, total - 1)
        : start + DOWNLOAD_CHUNK_BYTES - 1
      const result = await fetchAudioChunk(url, start, end, controller.signal, useNative)
      const { status, contentRange, bytes: chunk } = result
      useNative = result.useNative
      if (start === 0) {
        const match = /\/(\d+)\s*$/.exec(contentRange || '')
        if (match) {
          total = Number(match[1])
          if (total > MAX_AUDIO_BYTES) throw new Error('伴奏文件过大')
        }
        if (status === 200) {
          // 服务端不支持 Range 时退化为整文件读取。
          chunks.push(chunk)
          loaded = chunk.byteLength
          total = chunk.byteLength
          options.onProgress?.({ bytes: loaded, total, variant, index, count })
          break
        }
        if (!total) throw new Error('伴奏响应缺少长度')
      }
      if (status !== 206) throw new Error('伴奏分片响应无效')
      if (!chunk.byteLength) break
      chunks.push(chunk)
      loaded += chunk.byteLength
      start += chunk.byteLength
      if (loaded > MAX_AUDIO_BYTES) throw new Error('伴奏文件过大')
      options.onProgress?.({ bytes: loaded, total: total || loaded, variant, index, count })
      if (start >= total) break
    }
    if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError')
    if (!loaded) throw new Error('伴奏响应为空')
    if (total > 0 && loaded !== total) throw new Error('伴奏文件不完整')
    if (loaded > MAX_AUDIO_BYTES) throw new Error('伴奏文件过大')
    const bytes = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (/\.ogg(?:[?#]|$)/i.test(url) &&
        !(bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53)) {
      throw new Error('伴奏文件无效')
    }
    writer = await handle.createWritable()
    await writer.write(bytes)
    if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError')
    await writer.close()
    writer = null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    if (writer) {
      // AIUI 的 OPFS 子集没有声明 abort；取消时丢弃缓冲，不能 close 提交残缺文件。
      if (typeof writer.abort === 'function') await writer.abort().catch(() => {})
      else await writer.truncate(0).catch(() => {})
    }
  }
}
