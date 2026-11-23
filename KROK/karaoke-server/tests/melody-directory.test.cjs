#!/usr/bin/env node
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

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
  const trialDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'karaoke-melodies-'))
  const melodyDir = path.join(trialDir, 'melodies')
  const catalogPath = path.join(trialDir, 'catalog.json')
  let api
  let source
  try {
    await fsp.mkdir(melodyDir)
    await fsp.writeFile(path.join(melodyDir, 'external.json'), JSON.stringify({
      songId: 'external',
      chartVersion: 3,
      notes: [
        { midi: 60, startMs: 0, endMs: 500 },
        { midi: 62, startMs: 500, endMs: 1000 }
      ]
    }))
    source = http.createServer((req, res) => {
      const body = Buffer.from('OggS-test')
      res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': body.length })
      res.end(body)
    })
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
    const sourceUrl = `http://127.0.0.1:${source.address().port}/song.ogg`
    await fsp.writeFile(catalogPath, JSON.stringify({
      songs: [{
        id: 'external',
        name: '外置旋律测试',
        durationMs: 1000,
        chartVersion: 3,
        scoringVersion: 2,
        audioSource: sourceUrl,
        instrumentalSource: sourceUrl,
        melodyFile: 'melodies/external.json',
        lyrics: [{ text: '测试', startMs: 0, endMs: 1000 }]
      }]
    }))
    api = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: '0',
        KARAOKE_DB: path.join(trialDir, 'scores.sqlite'),
        KARAOKE_MEDIA: path.join(trialDir, 'media'),
        KARAOKE_MELODIES: melodyDir,
        KARAOKE_CATALOG: catalogPath,
        KARAOKE_CATALOG_EXTRA: path.join(trialDir, 'missing.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const base = await waitForBase(api)
    const response = await fetch(`${base}/api/songs/external`)
    assert.equal(response.status, 200)
    const { song } = await response.json()
    assert.equal(song.refNotes.length, 2)
    assert.deepEqual(song.refNotes[1], { midi: 62, startMs: 500, endMs: 1000 })
    console.log('PASS  melodies 目录按 melodyFile 加载并在详情接口返回 refNotes')
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
