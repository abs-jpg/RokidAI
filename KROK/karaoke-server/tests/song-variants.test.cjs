#!/usr/bin/env node
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const serverPath = path.join(__dirname, '..', 'server.js')

function waitForBase(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('API server start timeout\n' + output)), 10000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      const match = /Karaoke API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.stderr.on('data', chunk => { output += chunk.toString() })
  })
}

async function main() {
  const trialDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'karaoke-variants-'))
  const mediaDir = path.join(trialDir, 'media')
  const catalogPath = path.join(trialDir, 'catalog.json')
  const dbPath = path.join(trialDir, 'scores.sqlite')
  let api
  let source
  try {
    source = http.createServer((req, res) => {
      const wav = req.url.includes('instrumental')
      const body = Buffer.from(wav ? 'RIFF-test' : 'OggS-test')
      res.writeHead(200, {
        'Content-Type': wav ? 'audio/wav' : 'audio/ogg',
        'Content-Length': body.length
      })
      res.end(body)
    })
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
    const port = source.address().port
    await fsp.writeFile(catalogPath, JSON.stringify({
      songs: [{
        id: 'variants',
        name: '双版本测试',
        durationMs: 1000,
        chartVersion: 1,
        scoringVersion: 5,
        audioSource: `http://127.0.0.1:${port}/guide.ogg`,
        instrumentalSource: `http://127.0.0.1:${port}/instrumental.wav`,
        lyrics: [{ text: '测试', startMs: 0, endMs: 1000 }],
        refNotes: [{ midi: 60, startMs: 0, endMs: 1000 }]
      }]
    }))
    api = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: '0',
        KARAOKE_DB: dbPath,
        KARAOKE_MEDIA: mediaDir,
        KARAOKE_CATALOG: catalogPath,
        KARAOKE_CATALOG_EXTRA: path.join(trialDir, 'missing.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const base = await waitForBase(api)
    const response = await fetch(`${base}/api/songs/variants/prepare`, { method: 'POST' })
    assert.equal(response.status, 200)
    const { song } = await response.json()
    assert.equal(song.guideAccompaniment, '/media/songs/variants-guide.ogg')
    assert.equal(song.instrumentalAccompaniment, '/media/songs/variants-instrumental.wav')
    assert.equal(song.accompaniment, song.instrumentalAccompaniment)
    assert.equal(song.cached, true)

    const guide = await fetch(`${base}${song.guideAccompaniment}`)
    const instrumental = await fetch(`${base}${song.instrumentalAccompaniment}`)
    assert.equal(guide.headers.get('content-type'), 'audio/ogg')
    assert.equal(instrumental.headers.get('content-type'), 'audio/wav')

    console.log('PASS  带唱版和纯音乐版独立缓存并通过不同 MIME 返回')

    const tokenResponse = await fetch(base + '/api/players', { method: 'POST' })
    const { token } = await tokenResponse.json()
    assert.equal(tokenResponse.status, 201)
    const leaderboardSource = (await fsp.readFile(path.join(__dirname, '../../Karaoke/utils/leaderboard.js'), 'utf8'))
      .replace(/^import .*$/gm, '').replace(/^export /gm, '')
    const storage = new Map([['karaoke_server_token:' + base, token]])
    let payload
    const { submitScore, getLeaderboard } = vm.runInNewContext(leaderboardSource + '\n;({ submitScore, getLeaderboard })', {
      LEADERBOARD_API_URL: base, SCORING_VERSION: 5, console, AbortController, setTimeout, clearTimeout,
      createOpenAPI: async () => ({ account: { async getProfile() { return null } } }),
      async fetch() { throw Error('模拟 fetch 不可用') },
      wx: {
        getStorageSync: key => storage.get(key),
        setStorageSync: (key, value) => storage.set(key, value),
        request({ url, method, header, data, success, fail }) {
          if (url.endsWith('/api/scores')) payload = JSON.parse(data)
          fetch(url, { method, headers: header, body: data }).then(async response => {
            success({ statusCode: response.status, data: await response.text() })
          }).catch(fail)
        }
      }
    })
    const outcome = await submitScore({
      attemptId: 'solo-check-001', songId: song.id, chartVersion: song.chartVersion, scoringVersion: 5,
      completed: true, recognizedText: '测试', score: 20, coverage: 0
    }, [[0, 60.00001, 1], [1, null, 0], [2, null, 1]])
    assert.equal(outcome.uploaded, true)
    assert.deepEqual(payload.samples, [[0, 60.00001], [2, null, 1]], '省略静音时仍须保留实际音高精度和发声帧')
    const leaderboard = await getLeaderboard(song.id)
    assert.equal(leaderboard.source, 'server')
    assert.equal(leaderboard.myRank, 1)
    assert.equal(leaderboard.list[0].score, 100, '榜单读取服务端重算的成绩')
    assert.equal(leaderboard.list[0].coverage, 100)
    console.log('PASS  fetch 中断后，用 wx.request 提交单人成绩并从真实榜单读取')

    const endpoint = base + '/api/song-requests'
    const request = (entry, authenticated = true) => fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: 'Bearer ' + token } : {})
      },
      body: JSON.stringify(entry)
    })
    const entry = { id: 'test-song-request-01', text: ' 想添加海阔天空\nBeyond ' }
    assert.equal((await request(entry, false)).status, 401)
    assert.equal((await request({ ...entry, text: '' })).status, 400)
    assert.equal((await request({ ...entry, text: '歌'.repeat(161) })).status, 400)
    const results = await Promise.all([request(entry), request(entry)])
    assert.deepEqual(results.map(item => item.status).sort(), [200, 201])
    assert.equal((await request({ ...entry, text: '换成另一首歌' })).status, 409)
    assert.equal((await request({ id: 'test-song-request-02', text: '想添加第二首歌曲' })).status, 201)
    const file = await fsp.readFile(path.join(trialDir, 'song-requests', 'requests.txt'), 'utf8')
    const messages = file.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(messages.map(item => item.text), ['想添加海阔天空 Beyond', '想添加第二首歌曲'])
    assert.ok(messages.every(item => Number.isFinite(Date.parse(item.receivedAt))))
    assert.equal((await fetch(endpoint)).status, 404, '留言文件不提供公开读取入口')
    console.log('PASS  留言鉴权、长度检查、多次提交去重及独立 TXT 存储')
  } finally {
    if (api) {
      const exited = new Promise(resolve => api.once('exit', resolve))
      api.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    }
    if (source) await new Promise(resolve => source.close(resolve))
    await fsp.rm(trialDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('FAIL ', error.message)
  process.exitCode = 1
})
