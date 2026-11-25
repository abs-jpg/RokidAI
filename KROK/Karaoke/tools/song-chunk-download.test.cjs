const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../utils/songLibrary.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const base = { id: 'big-song', chartVersion: 1, scoringVersion: 1 }
const storage = new Map()
const primary = 'https://test.invalid'
const backup = 'http://127.0.0.1:3100'
const audio = new Uint8Array(700000)
audio.set([0x4f, 0x67, 0x67, 0x53])
for (let i = 4; i < audio.length; i++) audio[i] = i % 251

let storedBytes
const ranges = []
const timeouts = []
const progress = []
const nativeRequests = []
let useFallback = false
const handle = {
  async getFile() {
    return { size: storedBytes.byteLength, async arrayBuffer() { return storedBytes } }
  },
  async createWritable() {
    const parts = []
    return {
      async write(data) { parts.push(new Uint8Array(data).slice()) },
      async close() {
        const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const part of parts) {
          merged.set(part, offset)
          offset += part.byteLength
        }
        storedBytes = merged.buffer
      },
      async truncate(size) { parts.length = 0; parts.push(new Uint8Array(size)) }
    }
  }
}

const api = vm.runInNewContext(source + '\n;({downloadSong,readDownloadedAudio,getSongFromLibrary,loadSongCatalog})', {
  LEADERBOARD_API_URL: primary,
  LEADERBOARD_API_URLS: [primary, backup],
  bundledSongs: [], getBundledSong: () => null,
  wx: {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    request(options) {
      nativeRequests.push(options)
      assert.ok(options.url.startsWith(backup))
      if (options.url.endsWith('/api/songs')) {
        options.success({ statusCode: 200, data: JSON.stringify({ songs: [base] }) })
      } else if (options.url.endsWith('/prepare?variant=instrumental')) {
        assert.equal(options.method, 'POST')
        options.success({ statusCode: 200, data: { song: { ...base, accompaniment: '/big.ogg' } } })
      } else {
        assert.equal(options.responseType, 'arraybuffer')
        const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.header.Range)
        const start = Number(startText)
        const end = Number(endText)
        options.success({
          statusCode: 206,
          header: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + audio.length },
          data: audio.slice(start, end + 1).buffer
        })
      }
    }
  },
  navigator: { storage: { async getDirectory() {
    return { async getDirectoryHandle() { return { async getFileHandle() { return handle } } } }
  } } },
  console: { error() {} }, AbortController, DOMException, setTimeout, clearTimeout,
  async fetch(url, options = {}) {
    if (useFallback) {
      if (url === primary + '/api/songs') return { ok: true, async json() { return {} } }
      throw new TypeError('模拟 fetch 在眼镜运行环境无法连接')
    }
    if (url.endsWith('/prepare?variant=instrumental')) {
      return {
        ok: true,
        async json() {
          return { song: { ...base, guideAccompaniment: '/big.ogg', instrumentalAccompaniment: '/big.ogg', accompaniment: '/big.ogg' } }
        }
      }
    }
    if (url.endsWith('.ogg')) {
      const range = options.headers?.Range || options.headers?.range || ''
      ranges.push(range)
      timeouts.push(options.timeout)
      const match = /bytes=(\d+)-(\d+)/.exec(range)
      const start = match ? Number(match[1]) : 0
      const end = match ? Math.min(Number(match[2]), audio.length - 1) : audio.length - 1
      const slice = audio.subarray(start, end + 1)
      return {
        ok: true,
        status: 206,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'content-range'
              ? `bytes ${start}-${end}/${audio.length}`
              : null
          }
        },
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
        }
      }
    }
    throw new Error('unexpected request ' + url)
  }
})

async function main() {
  const result = await api.downloadSong(base.id, 'instrumental', { onProgress: event => progress.push(event) })
  assert.equal(result.offline, true)

  const chunkSize = 64 * 1024
  assert.equal(ranges.length, Math.ceil(audio.length / chunkSize))
  for (let i = 0; i < ranges.length; i++) {
    const start = i * chunkSize
    const end = Math.min(audio.length - 1, start + chunkSize - 1)
    assert.equal(ranges[i], `bytes=${start}-${end}`, '每个分片应有独立的 Range')
    assert.equal(timeouts[i], 8000, '每个分片应有独立的 8 秒超时')
  }
  assert.ok(progress.length >= 2, '下载过程应持续报告进度')
  assert.equal(progress[progress.length - 1].bytes, audio.length)
  assert.equal(progress[progress.length - 1].total, audio.length)

  const saved = await api.readDownloadedAudio(await api.getSongFromLibrary(base.id))
  assert.deepEqual(new Uint8Array(saved), audio, '拼装后的文件应与源文件完全一致')
  console.log('PASS  每个分片独立 Range/超时，拼装后的 OGG 与源文件完全一致')

  useFallback = true
  storage.clear()
  const catalog = await api.loadSongCatalog()
  assert.equal(catalog.connected, true)
  assert.equal(catalog.songs[0].id, base.id)
  assert.equal((await api.downloadSong(base.id, 'instrumental')).offline, true)
  const song = await api.getSongFromLibrary(base.id)
  assert.equal(song.accompaniment, backup + '/big.ogg', '缓存保留备用服务器的实际音频地址')
  assert.deepEqual(new Uint8Array(await api.readDownloadedAudio(song)), audio)
  assert.equal(nativeRequests[0].url, backup + '/api/songs')
  assert.equal(nativeRequests[1].url, backup + '/api/songs/' + base.id + '/prepare?variant=instrumental')
  assert.equal(nativeRequests.length, 2 + Math.ceil(audio.length / chunkSize))
  console.log('PASS  主入口响应无效时切到备用服务器，原生网络取曲库及下载全部音频分片')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
