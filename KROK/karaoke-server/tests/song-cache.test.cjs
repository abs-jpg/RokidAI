#!/usr/bin/env node
// 验证同一首在线歌曲在并发下载时只从源站拉取一次，并且媒体文件只保存一份。
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const serverPath = path.join(__dirname, '..', 'server.js')
const audioFixture = path.join(__dirname, '..', '..', 'Karaoke', 'assets', 'morning-light.ogg')

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
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`API server exited with ${code}\n${output}`))
    })
  })
}

async function main() {
  const trialDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'karaoke-cache-'))
  const mediaDir = path.join(trialDir, 'media')
  const dbPath = path.join(trialDir, 'scores.sqlite')
  const catalogPath = path.join(trialDir, 'catalog.json')
  let sourceRequests = 0
  let apiProcess
  let sourceServer

  try {
    const audio = await fsp.readFile(audioFixture)
    sourceServer = http.createServer((req, res) => {
      sourceRequests++
      res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': audio.length })
      res.end(audio)
    })
    await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve))
    const sourcePort = sourceServer.address().port

    const catalog = {
      songs: [{
        id: 'cache-demo',
        name: '缓存测试曲',
        artist: 'test',
        difficulty: 1,
        durationMs: 10000,
        chartVersion: 1,
        scoringVersion: 1,
        audioSource: `http://127.0.0.1:${sourcePort}/cache-demo.ogg`,
        lyrics: [{ text: '测试歌词', startMs: 0, endMs: 5000 }],
        refNotes: [{ midi: 60, startMs: 0, endMs: 5000 }]
      }]
    }
    await fsp.writeFile(catalogPath, JSON.stringify(catalog))

    apiProcess = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: '0',
        KARAOKE_DB: dbPath,
        KARAOKE_MEDIA: mediaDir,
        KARAOKE_CATALOG: catalogPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const base = await waitForBase(apiProcess)

    const [first, second] = await Promise.all([
      fetch(`${base}/api/songs/cache-demo/prepare`, { method: 'POST' }),
      fetch(`${base}/api/songs/cache-demo/prepare`, { method: 'POST' })
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const firstBody = await first.json()
    const secondBody = await second.json()
    assert.equal(firstBody.song.accompaniment, '/media/songs/cache-demo.ogg')
    assert.equal(secondBody.song.accompaniment, '/media/songs/cache-demo.ogg')

    assert.equal(sourceRequests, 1, '源站应该只被请求一次')
    const files = (await fsp.readdir(mediaDir)).filter(name => !name.includes('.part-'))
    assert.deepEqual(files, ['cache-demo.ogg'], '缓存目录应只保留一份音频')

    const range = await fetch(`${base}/media/songs/cache-demo.ogg`, {
      headers: { Range: 'bytes=0-99' }
    })
    assert.equal(range.status, 206)
    assert.equal((await range.arrayBuffer()).byteLength, 100)

    const cached = await fetch(`${base}/api/songs/cache-demo/prepare`, { method: 'POST' })
    assert.equal(cached.status, 200)
    assert.equal(sourceRequests, 1, '已缓存的歌曲不应再次下载')

    console.log('PASS  在线歌曲并发下载只拉取一次，缓存只有一份，Range 播放正常')
  } finally {
    if (apiProcess) {
      const exited = new Promise(resolve => apiProcess.once('exit', resolve))
      apiProcess.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    }
    if (sourceServer) await new Promise(resolve => sourceServer.close(resolve))
    await fsp.rm(trialDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('FAIL ', error.message, error.cause?.message || '')
  process.exitCode = 1
})
