import wx from 'wx'
import { LEADERBOARD_API_URL } from './leaderboardConfig.js'
import { songs as bundledSongs, getSongById as getBundledSong } from './songData.js'

const SERVER_URL = LEADERBOARD_API_URL.trim().replace(/\/+$/, '')
const CATALOG_KEY = 'karaoke_remote_catalog:' + SERVER_URL
const DETAIL_KEY = CATALOG_KEY + ':song:'
const DOWNLOAD_KEY = CATALOG_KEY + ':download:'
const MAX_AUDIO_BYTES = 30 * 1024 * 1024
let catalogPromise
let latestCatalog = new Map()

async function request(path, options, timeout = 7000) {
  if (!SERVER_URL) throw new Error('曲库服务器未配置')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const signal = options?.signal
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(SERVER_URL + path, { ...options, signal: controller.signal })
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error || '曲库请求失败')
    return body
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function sameVersion(a, b) {
  return a?.id === b?.id && a?.chartVersion === b?.chartVersion && a?.scoringVersion === b?.scoringVersion
}

async function audioFile(song, create) {
  const root = await navigator.storage.getDirectory()
  const folder = await root.getDirectoryHandle('karaoke-audio', { create })
  const key = encodeURIComponent(SERVER_URL) + '-' + song.id + '-' + song.chartVersion + '-' + song.scoringVersion + '.ogg'
  return folder.getFileHandle(key, { create })
}

async function localFile(song) {
  try {
    const saved = wx.getStorageSync(DOWNLOAD_KEY + song.id)
    if (!saved || !sameVersion(saved, song)) return null
    const file = await (await audioFile(song, false)).getFile()
    return file.size > 0 && file.size <= MAX_AUDIO_BYTES ? file : null
  } catch {
    return null
  }
}

export async function readDownloadedAudio(song) {
  const file = await localFile(song)
  return file ? file.arrayBuffer() : null
}

function absoluteUrl(url) {
  if (!url) return url
  return url.startsWith('/') ? SERVER_URL + url : url
}

function readCachedCatalog() {
  try {
    const list = wx.getStorageSync(CATALOG_KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

async function fetchCatalog() {
  if (!/^https?:\/\//.test(SERVER_URL)) return { songs: [], connected: false }
  try {
    const body = await request('/api/songs')
    if (Array.isArray(body?.songs)) {
      try {
        wx.setStorageSync(CATALOG_KEY, body.songs)
      } catch (e) {
        console.error('cache catalog error', e)
      }
      return { songs: body.songs, connected: true }
    }
  } catch (e) {
    console.error('fetch song catalog error', e)
  }
  return { songs: readCachedCatalog(), connected: false }
}

/**
 * 线上曲库 + 内置曲库合并。内置曲目优先，线上新增曲目追加在后面。
 */
export async function loadSongCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const remote = await fetchCatalog()
      latestCatalog = new Map(remote.songs.map(song => [song.id, song]))
      const merged = bundledSongs.map(local => {
        const online = remote.songs.find(item => item.id === local.id)
        return { ...(online || {}), ...local, bundled: true, online: false }
      })
      for (const item of remote.songs) {
        if (merged.some(song => song.id === item.id)) continue
        merged.push({ ...item, bundled: false, online: true })
      }
      const songs = await Promise.all(merged.map(async song => ({
        ...song,
        downloaded: song.bundled || Boolean(await localFile(song))
      })))
      return { songs, connected: remote.connected }
    })().finally(() => { catalogPromise = null })
  }
  return catalogPromise
}

async function fetchSongDetail(id) {
  const body = await request('/api/songs/' + encodeURIComponent(id))
  if (body?.song?.id !== id) throw new Error('无法加载歌曲')
  try {
    wx.setStorageSync(DETAIL_KEY + id, body.song)
  } catch (e) {
    console.error('cache song detail error', e)
  }
  return body.song
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
  let song = usable && cached.accompaniment ? cached : null
  if (!song) {
    try {
      song = await fetchSongDetail(id)
    } catch (error) {
      if (!usable) throw error
      song = cached
    }
  }
  return { ...song, accompaniment: absoluteUrl(song.accompaniment) }
}

/**
 * 请求服务器准备歌曲。服务器只会从源站下载一次，并发请求共享同一次下载。
 */
export async function prepareSongDownload(id, options = {}) {
  const body = await request('/api/songs/' + encodeURIComponent(id) + '/prepare', {
    method: 'POST',
    signal: options.signal
  }, 40000)
  if (body?.song?.id !== id || !body.song.accompaniment) throw new Error('伴奏不可用')
  latestCatalog.set(id, body.song)
  try {
    wx.setStorageSync(DETAIL_KEY + id, body.song)
  } catch (e) {
    console.error('cache prepared song error', e)
  }
  return { ...body.song, accompaniment: absoluteUrl(body.song.accompaniment) }
}

export async function downloadSong(id, options = {}) {
  const song = await prepareSongDownload(id, options)
  let handle
  try {
    handle = await audioFile(song, true)
  } catch (error) {
    if (!navigator.storage || error.name === 'NotSupportedError') return { offline: false }
    throw error
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), 40000)
  let reader
  let writer
  const cancelRead = () => { if (reader) reader.cancel().catch(() => {}) }
  controller.signal.addEventListener('abort', cancelRead, { once: true })
  try {
    const response = await fetch(song.accompaniment, { signal: controller.signal })
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
      throw new Error('伴奏下载失败')
    }
    const total = Number(response.headers.get('content-length')) || 0
    if (!response.body) throw new Error('伴奏响应为空')
    reader = response.body.getReader()
    writer = await handle.createWritable()
    let bytes = 0
    for (;;) {
      if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError')
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_AUDIO_BYTES) throw new Error('伴奏文件过大')
      await writer.write(chunk.value)
      options.onProgress?.({ bytes, total })
    }
    if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError')
    if (!bytes || (total > 0 && bytes !== total)) throw new Error('伴奏文件不完整')
    await writer.close()
    writer = null
    wx.setStorageSync(DOWNLOAD_KEY + id, song)
    return { offline: true }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', cancelRead)
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (writer) {
      // AIUI 的 OPFS 子集没有声明 abort；取消时丢弃缓冲，不能 close 提交残缺文件。
      if (typeof writer.abort === 'function') await writer.abort().catch(() => {})
      else await writer.truncate(0).catch(() => {})
    }
  }
}
