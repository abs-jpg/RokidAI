const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../utils/songLibrary.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const base = { id: 'test-song', chartVersion: 1, scoringVersion: 1 }
const storage = new Map()
let ready = false
let offline = false
let storedBytes
let stagedBytes = []
let cancelled = false
let supportsAbort = true
let detailRequests = 0
const bytes = new Uint8Array([1, 2, 3, 4]).buffer
const handle = {
  async getFile() {
    return { size: storedBytes.byteLength, async arrayBuffer() { return storedBytes } }
  },
  async createWritable() {
    stagedBytes = []
    const writable = {
      async write(data) { stagedBytes.push(...new Uint8Array(data)) },
      async close() { storedBytes = new Uint8Array(stagedBytes).buffer },
      async truncate(size) { stagedBytes.length = size; cancelled = true }
    }
    if (supportsAbort) writable.abort = async () => { cancelled = true }
    return writable
  }
}
const api = vm.runInNewContext(source + '\n;({loadSongCatalog,getSongFromLibrary,downloadSong,readDownloadedAudio})', {
  LEADERBOARD_API_URL: 'https://test.invalid',
  bundledSongs: [], getBundledSong: () => null,
  wx: { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v) },
  navigator: { storage: { async getDirectory() {
    return { async getDirectoryHandle() { return { async getFileHandle() { return handle } } } }
  } } },
  console: { error() {} }, AbortController, DOMException, setTimeout, clearTimeout,
  async fetch(url) {
    if (offline) throw new Error('offline')
    if (url.endsWith('/api/songs')) return { ok: true, async json() { return { songs: [{ ...base, cached: ready }] } } }
    if (url.endsWith('/test-song')) detailRequests++
    if (url.endsWith('.ogg')) {
      let cursor = 0
      return { ok: true, headers: { get: () => null }, body: { getReader() {
        return {
          async read() {
            if (cursor >= 4) return { done: true }
            const value = new Uint8Array(bytes.slice(cursor, cursor + 2))
            cursor += 2
            return { done: false, value }
          },
          async cancel() {},
          releaseLock() {}
        }
      } } }
    }
    return { ok: true, async json() { return { song: { ...base, accompaniment: ready ? '/test.ogg' : null } } } }
  }
})

async function main() {
  assert.equal((await api.getSongFromLibrary(base.id)).accompaniment, null)
  ready = true
  assert.equal((await api.loadSongCatalog()).songs[0].downloaded, false)
  assert.equal((await api.getSongFromLibrary(base.id)).accompaniment, 'https://test.invalid/test.ogg')
  assert.equal(detailRequests, 2)
  assert.equal((await api.downloadSong(base.id)).offline, true)
  offline = true
  assert.equal((await api.loadSongCatalog()).songs[0].downloaded, true)
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id))), new Uint8Array(bytes))
  offline = false
  const cancel = new AbortController()
  await assert.rejects(api.downloadSong(base.id, {
    signal: cancel.signal,
    onProgress: () => cancel.abort()
  }), { name: 'AbortError' })
  assert.equal(cancelled, true)
  supportsAbort = false
  cancelled = false
  const subsetCancel = new AbortController()
  await assert.rejects(api.downloadSong(base.id, {
    signal: subsetCancel.signal,
    onProgress: () => subsetCancel.abort()
  }), { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.equal(stagedBytes.length, 0)
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id))), new Uint8Array(bytes))
  console.log('PASS  空缓存恢复、分片下载、断网读取及 AIUI OPFS 子集取消后保留原文件')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
