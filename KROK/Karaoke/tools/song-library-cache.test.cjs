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
let detailRequests = 0
let cancelDuringWrite
const files = new Map()
const requests = []
const key = 'karaoke_remote_catalog:https://test.invalid:download:' + base.id
const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]).buffer
function handle(name) {
  return {
    async getFile() {
      const stored = files.get(name)
      return { size: stored.byteLength, async arrayBuffer() { return stored } }
    },
    async createWritable() {
      let staged
      return {
        async write(data) { staged = data.slice().buffer; cancelDuringWrite?.abort() },
        async close() { files.set(name, staged) },
        async truncate(size) { staged = staged.slice(0, size) }
      }
    }
  }
}
const api = vm.runInNewContext(source + '\n;({loadSongCatalog,getSongFromLibrary,downloadSong,readDownloadedAudio,getSongAudio})', {
  LEADERBOARD_API_URL: 'https://test.invalid',
  bundledSongs: [], getBundledSong: () => null,
  wx: { getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v) },
  navigator: { storage: { async getDirectory() {
    return { async getDirectoryHandle() { return { async getFileHandle(name) { return handle(name) } } } }
  } } },
  console: { error() {} }, AbortController, DOMException, setTimeout, clearTimeout,
  async fetch(url) {
    if (offline) throw new Error('offline')
    if (url.endsWith('/api/songs')) return { ok: true, async json() { return { songs: [{ ...base, cached: ready }] } } }
    if (url.endsWith('/test-song')) detailRequests++
    if (url.endsWith('.ogg')) {
      requests.push(url.split('/').at(-1))
      return { ok: true, status: 200, headers: { get: () => null }, async arrayBuffer() { return bytes } }
    }
    const guideAccompaniment = ready ? '/guide.ogg' : null
    const instrumentalAccompaniment = url.endsWith('variant=instrumental') ? '/instrumental.ogg' : null
    return { ok: true, async json() { return { song: {
      ...base, guideAccompaniment, instrumentalAccompaniment,
      accompaniment: instrumentalAccompaniment || guideAccompaniment
    } } } }
  }
})

async function main() {
  assert.equal((await api.getSongFromLibrary(base.id)).accompaniment, null)
  ready = true
  assert.equal((await api.loadSongCatalog()).songs[0].downloaded, false)
  const guideOnly = await api.getSongFromLibrary(base.id)
  assert.equal(guideOnly.accompaniment, 'https://test.invalid/guide.ogg')
  assert.equal(api.getSongAudio(guideOnly, 'instrumental'), null, '纯音乐版不以带歌词音频替代')
  assert.equal(detailRequests, 2)
  assert.equal((await api.downloadSong(base.id, 'guide')).offline, true)
  assert.deepEqual(requests, ['guide.ogg'])
  offline = true
  const partial = (await api.loadSongCatalog()).songs[0]
  assert.equal(partial.downloaded, false)
  assert.equal(partial.downloadedVariants.guide, true)
  assert.equal(partial.downloadedVariants.instrumental, false)
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id), 'guide')), new Uint8Array(bytes))
  assert.equal(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id), 'instrumental'), null)
  offline = false
  const cancel = new AbortController()
  await assert.rejects(api.downloadSong(base.id, 'instrumental', {
    signal: cancel.signal,
    onProgress: () => cancel.abort()
  }), { name: 'AbortError' })
  cancelDuringWrite = new AbortController()
  await assert.rejects(api.downloadSong(base.id, 'instrumental', {
    signal: cancelDuringWrite.signal
  }), { name: 'AbortError' })
  cancelDuringWrite = null
  assert.equal((await api.loadSongCatalog()).songs[0].downloadedVariants.instrumental, false)
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id), 'guide')), new Uint8Array(bytes))
  const complete = await api.downloadSong(base.id, 'instrumental')
  assert.equal(complete.downloadedVariants.guide, true)
  assert.equal(complete.downloadedVariants.instrumental, true)
  assert.equal((await api.loadSongCatalog()).songs[0].downloaded, true)
  assert.deepEqual(requests, ['guide.ogg', 'instrumental.ogg', 'instrumental.ogg', 'instrumental.ogg'])

  storage.delete(key + ':guide')
  storage.delete(key + ':instrumental')
  storage.set(key, { ...base, accompaniment: 'https://test.invalid/legacy.ogg' })
  files.set(encodeURIComponent('https://test.invalid') + '-' + base.id + '-1-shared.ogg', bytes)
  assert.equal((await api.loadSongCatalog()).songs[0].downloaded, true, '旧版共享音频仍可识别')
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(await api.getSongFromLibrary(base.id))), new Uint8Array(bytes))
  console.log('PASS  独立下载、断网读取、取消下载及兼容旧版音频文件')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
