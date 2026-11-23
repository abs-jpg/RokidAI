const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../utils/songLibrary.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
const storage = new Map()
let fetchCount = 0
class FakeAudio {
  constructor(src) {
    this.src = src
    this.listeners = new Map()
  }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  load() { setTimeout(() => this.listeners.get('canplay')?.(), 0) }
  pause() {}
}
const api = vm.runInNewContext(
  source + '\n;({ preloadSongAudio, getPreloadedSongAudio, readDownloadedAudio })',
  {
    LEADERBOARD_API_URL: 'https://test.invalid',
    bundledSongs: [],
    getBundledSong: () => null,
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value)
    },
    navigator: {
      storage: {
        async getDirectory() {
          throw Object.assign(new Error('OPFS unavailable'), { name: 'NotSupportedError' })
        }
      }
    },
    console: { error() {} },
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    Audio: FakeAudio,
    async fetch() {
      fetchCount++
      return {
        ok: true,
        headers: { get: () => null },
        async arrayBuffer() { return bytes.buffer.slice(0) }
      }
    }
  }
)

const song = {
  id: 'default',
  chartVersion: 1,
  scoringVersion: 2,
  instrumentalAccompaniment: 'https://test.invalid/default.wav'
}

async function main() {
  assert.equal(api.getPreloadedSongAudio(song, 'instrumental'), null)
  const result = await api.preloadSongAudio(song, 'instrumental')
  assert.equal(result.ready, true)
  assert.equal(api.getPreloadedSongAudio(song, 'instrumental').byteLength, bytes.byteLength)
  assert.deepEqual(api.getPreloadedSongAudio(song, 'instrumental'), bytes.buffer)
  assert.deepEqual(await api.readDownloadedAudio(song, 'instrumental'), bytes.buffer)

  const localSong = {
    id: 'bundled',
    chartVersion: 1,
    scoringVersion: 2,
    instrumentalAccompaniment: '/assets/bundled.wav'
  }
  assert.equal((await api.preloadSongAudio(localSong, 'instrumental')).ready, true)
  assert.equal(fetchCount, 1, '本地资源不得使用 fetch 相对 URL')
  assert.equal(api.getPreloadedSongAudio(localSong, 'instrumental'), null)

  const app = readFileSync(join(__dirname, '../app.js'), 'utf8')
  assert.match(app, /onLaunch\(\)[\s\S]*preloadDefaultAudio/)
  console.log('PASS  默认歌曲在应用启动阶段预热，录制页可读取预热音频')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
