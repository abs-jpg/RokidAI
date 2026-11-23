const { createHash, randomBytes } = require('node:crypto')
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { readFile, rename, unlink, writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { isIP } = require('node:net')
const { basename, dirname, extname, join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.PORT || 3100)
const DB_PATH = resolve(process.env.KARAOKE_DB || join(__dirname, 'data', 'karaoke.sqlite'))
const ROKID_DEVELOPER_SK = process.env.ROKID_DEVELOPER_SK || ''
const CATALOG_PATH = resolve(process.env.KARAOKE_CATALOG || join(__dirname, 'catalog.json'))
const EXTRA_CATALOG_PATH = resolve(process.env.KARAOKE_CATALOG_EXTRA || join(__dirname, 'catalog-extra.json'))
const MEDIA_DIR = resolve(process.env.KARAOKE_MEDIA || join(__dirname, 'media', 'songs'))
const SOURCE_DIR = resolve(process.env.KARAOKE_SOURCE || join(__dirname, 'source'))
const MAX_AUDIO_BYTES = 30 * 1024 * 1024
// 曲库元数据来自 catalog.json：bundled 歌曲使用应用内置伴奏，
// audioSource 歌曲由服务端首次请求时下载并缓存，之后所有用户共用一份。
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
let extraSongs = []
if (existsSync(EXTRA_CATALOG_PATH)) {
  try {
    const extra = JSON.parse(readFileSync(EXTRA_CATALOG_PATH, 'utf8'))
    if (Array.isArray(extra.songs)) extraSongs = extra.songs
  } catch (error) {
    console.error('load extra catalog failed', error.message)
  }
}
const SONGS = [...catalog.songs, ...extraSongs]
const SONGS_BY_ID = new Map(SONGS.map(song => [song.id, song]))
const DEFAULT_SONG = SONGS[0]
const BODY_LIMIT = 4096
const SCORE_BODY_LIMIT = 64 * 1024
const PITCH_STEP_MS = 40
const cacheJobs = new Map()

mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o750 })
mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o755 })
mkdirSync(SOURCE_DIR, { recursive: true, mode: 0o755 })
const db = new DatabaseSync(DB_PATH, { timeout: 5000 })
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES players(id),
    attempt_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    chart_version INTEGER NOT NULL,
    scoring_version INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    accuracy INTEGER NOT NULL CHECK (accuracy BETWEEN 0 AND 100),
    coverage INTEGER NOT NULL CHECK (coverage BETWEEN 1 AND 100),
    created_at TEXT NOT NULL,
    UNIQUE (user_id, attempt_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS scores_by_song_player
  ON scores (song_id, chart_version, scoring_version, user_id, score DESC, id);

  CREATE TABLE IF NOT EXISTS song_cache (
    song_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    file_name TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
`)
const scoreColumns = db.prepare('PRAGMA table_info(scores)').all()
if (!scoreColumns.some(column => column.name === 'calculated')) {
  db.exec('ALTER TABLE scores ADD COLUMN calculated INTEGER NOT NULL DEFAULT 0')
}

// 兼容旧库：players 增加 Rokid 账号 ID，用于跨设备识别同一位歌手。
const playerColumns = db.prepare('PRAGMA table_info(players)').all()
if (!playerColumns.some(column => column.name === 'roku_id')) {
  db.exec('ALTER TABLE players ADD COLUMN roku_id TEXT')
}
if (!playerColumns.some(column => column.name === 'roku_verified')) {
  db.exec('ALTER TABLE players ADD COLUMN roku_verified INTEGER NOT NULL DEFAULT 0')
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS players_by_roku
  ON players (roku_id) WHERE roku_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS player_sessions (
    token_hash TEXT PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id),
    expires_at INTEGER NOT NULL
  ) STRICT;
`)

const insertPlayer = db.prepare('INSERT INTO players (token_hash) VALUES (?)')
const insertPlayerWithRoku = db.prepare('INSERT INTO players (token_hash, roku_id, roku_verified) VALUES (?, ?, 1)')
const findPlayer = db.prepare(`
  SELECT id FROM players WHERE token_hash = ?
  UNION ALL
  SELECT player_id FROM player_sessions WHERE token_hash = ? AND expires_at > ?
`)
const findPlayerByRoku = db.prepare('SELECT id FROM players WHERE roku_id = ? AND roku_verified = 1')
const detachUnverifiedRoku = db.prepare('UPDATE players SET roku_id = NULL WHERE roku_id = ? AND roku_verified = 0')
const insertSession = db.prepare('INSERT INTO player_sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)')
const expireSessions = db.prepare('DELETE FROM player_sessions WHERE expires_at <= ?')
const findSongCache = db.prepare('SELECT * FROM song_cache WHERE song_id = ?')
const upsertSongCache = db.prepare(`
  INSERT INTO song_cache (song_id, status, file_name, bytes, source_url, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (song_id) DO UPDATE SET
    status = excluded.status,
    file_name = excluded.file_name,
    bytes = excluded.bytes,
    source_url = excluded.source_url,
    updated_at = excluded.updated_at
`)
const insertScore = db.prepare(`
  INSERT INTO scores
    (user_id, attempt_id, song_id, chart_version, scoring_version, score, accuracy, coverage, created_at, calculated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (user_id, attempt_id) DO UPDATE SET
    score = excluded.score, accuracy = excluded.accuracy, coverage = excluded.coverage, calculated = 1
  WHERE scores.calculated = 0 AND scores.song_id = excluded.song_id
    AND scores.chart_version = excluded.chart_version AND scores.scoring_version = excluded.scoring_version
`)
const findAttempt = db.prepare(`
  SELECT 1 FROM scores WHERE user_id = ? AND attempt_id = ?
    AND song_id = ? AND chart_version = ? AND scoring_version = ?
    AND score = ? AND accuracy = ? AND coverage = ? AND calculated = 1
`)
const findRanks = db.prepare(`
  WITH attempts AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY score DESC, id ASC) AS best
    FROM scores
    WHERE song_id = ? AND chart_version = ? AND scoring_version = ? AND calculated = 1
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, id ASC) AS rank
    FROM attempts WHERE best = 1
  )
  SELECT ranked.user_id, ranked.score, ranked.accuracy, ranked.coverage,
         ranked.created_at, ranked.rank
  FROM ranked
  WHERE ranked.rank <= 50 OR ranked.user_id = ?
  ORDER BY ranked.rank
`)
const checkDatabase = db.prepare('SELECT 1 FROM players LIMIT 1')

class RequestError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req, optional = false, limit = BODY_LIMIT) {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase()
  if (!type) {
    req.resume()
    if (optional) return {}
    throw new RequestError(415, 'JSON_REQUIRED')
  }
  if (type !== 'application/json') throw new RequestError(415, 'JSON_REQUIRED')
  if (Number(req.headers['content-length']) > limit) {
    throw new RequestError(413, 'BODY_TOO_LARGE')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) throw new RequestError(413, 'BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) {
      if (optional) return {}
      throw new RequestError(400, 'INVALID_JSON')
    }
    return JSON.parse(text)
  } catch {
    if (optional) return {}
    throw new RequestError(400, 'INVALID_JSON')
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function verifyRokuAccount(accountId, code) {
  if (!ROKID_DEVELOPER_SK) throw new RequestError(503, 'ROKID_AUTH_UNAVAILABLE')
  if (typeof code !== 'string' || !code) return false
  try {
    const response = await fetch('https://rcs.rokid.com/metis/openApi/v1/checkAccountCode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, code, developerSk: ROKID_DEVELOPER_SK }),
      signal: AbortSignal.timeout(5000)
    })
    const body = await response.json().catch(() => null)
    return response.ok && body?.code === 1 && body?.data?.checkResult === true
  } catch (error) {
    console.error('Rokid account verification failed', error.message)
    return false
  }
}

function resolvePlayer(token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const hash = tokenHash(token)
  return findPlayer.get(hash, hash, Date.now())?.id ?? null
}

function startRokidSession(rokuUserId, token) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const now = Date.now()
    expireSessions.run(now)
    let playerId = findPlayerByRoku.get(rokuUserId)?.id
    if (!playerId) {
      detachUnverifiedRoku.run(rokuUserId)
      playerId = insertPlayerWithRoku.run(tokenHash(randomBytes(32).toString('hex')), rokuUserId).lastInsertRowid
    }
    insertSession.run(tokenHash(token), playerId, now + 30 * 86400000)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function audioContentType(fileName) {
  switch (extname(fileName).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a':
    case '.aac': return 'audio/mp4'
    default: return 'audio/ogg'
  }
}

function audioVariants(song) {
  const guideSource = song.guideAudioSource || song.audioSource || null
  const instrumentalSource = song.instrumentalSource || song.audioSource || null
  const sharedCache = guideSource && guideSource === instrumentalSource
  return [
    {
      kind: 'guide',
      source: guideSource,
      bundled: song.guideAccompaniment || (!guideSource ? song.accompaniment : null),
      cacheKey: sharedCache ? 'shared' : 'guide'
    },
    {
      kind: 'instrumental',
      source: instrumentalSource,
      bundled: song.instrumentalAccompaniment || (!instrumentalSource ? song.accompaniment : null),
      cacheKey: sharedCache ? 'shared' : 'instrumental'
    }
  ]
}

function uniqueOnlineVariants(song) {
  const seen = new Set()
  return audioVariants(song).filter(variant => {
    if (!variant.source || seen.has(variant.cacheKey)) return false
    seen.add(variant.cacheKey)
    return true
  })
}

function cacheSongId(song, variant) {
  return song.id + '::' + variant.cacheKey
}

function mediaFileName(song, variant, source) {
  let ext = '.ogg'
  try {
    const parsed = new URL(source, 'http://localhost')
    ext = extname(parsed.pathname) || '.ogg'
  } catch {}
  if (!/^\.(ogg|mp3|wav|m4a|aac)$/i.test(ext)) ext = '.ogg'
  const suffix = variant.cacheKey === 'shared' ? '' : '-' + variant.cacheKey
  return song.id + suffix + ext.toLowerCase()
}

function songSummary(song) {
  const onlineVariants = uniqueOnlineVariants(song)
  const online = onlineVariants.length > 0
  const cached = !online || onlineVariants.every(variant => Boolean(readySongCache(song, variant)))
  return {
    id: song.id,
    name: song.name,
    artist: song.artist || '',
    category: song.category || '其他',
    tag: song.tag || '',
    difficulty: song.difficulty ?? 1,
    durationMs: song.durationMs,
    chartVersion: song.chartVersion,
    scoringVersion: song.scoringVersion,
    online,
    cached
  }
}

function readySongCache(song, variant) {
  const cache = findSongCache.get(cacheSongId(song, variant))
  if (cache?.status !== 'ready' || cache.source_url !== variant.source ||
      cache.file_name !== mediaFileName(song, variant, variant.source)) return null
  return existsSync(join(MEDIA_DIR, cache.file_name)) ? cache : null
}

function variantUrl(song, variant) {
  if (!variant.source) return variant.bundled || null
  const cache = readySongCache(song, variant)
  return cache ? '/media/songs/' + encodeURIComponent(cache.file_name) : null
}

function publicSong(song) {
  const [guide, instrumental] = audioVariants(song)
  const guideAccompaniment = variantUrl(song, guide)
  const instrumentalAccompaniment = variantUrl(song, instrumental)
  return {
    ...songSummary(song),
    guideAccompaniment,
    instrumentalAccompaniment,
    // 旧客户端继续使用纯伴奏入口。
    accompaniment: instrumentalAccompaniment || guideAccompaniment,
    lyrics: song.lyrics,
    refNotes: song.refNotes
  }
}

async function ensureSongCached(song) {
  await Promise.all(uniqueOnlineVariants(song).map(variant => ensureAudioVariantCached(song, variant)))
  return publicSong(song)
}

async function ensureAudioVariantCached(song, variant) {
  if (readySongCache(song, variant)) return
  const cacheId = cacheSongId(song, variant)
  const fileName = mediaFileName(song, variant, variant.source)
  const targetPath = join(MEDIA_DIR, fileName)
  if (cacheJobs.has(cacheId)) return cacheJobs.get(cacheId)

  const job = (async () => {
    upsertSongCache.run(cacheId, 'downloading', fileName, 0, variant.source, new Date().toISOString())
    let tempPath = null
    try {
      const buffer = await readSongSource(variant.source)
      if (buffer.length === 0) throw new RequestError(502, 'EMPTY_AUDIO')
      if (buffer.length > MAX_AUDIO_BYTES) throw new RequestError(413, 'AUDIO_TOO_LARGE')
      tempPath = targetPath + '.part-' + randomBytes(4).toString('hex')
      await writeFile(tempPath, buffer)
      await rename(tempPath, targetPath)
      upsertSongCache.run(cacheId, 'ready', fileName, buffer.length, variant.source, new Date().toISOString())
    } catch (error) {
      if (tempPath) await unlink(tempPath).catch(() => {})
      upsertSongCache.run(cacheId, 'failed', fileName, 0, variant.source, new Date().toISOString())
      if (error instanceof RequestError) throw error
      console.error('song download failed', song.id, variant.kind, error.message)
      throw new RequestError(502, 'DOWNLOAD_FAILED')
    }
  })().finally(() => cacheJobs.delete(cacheId))

  cacheJobs.set(cacheId, job)
  return job
}

async function readSongSource(source) {
  const local = /^\/source\/([a-z0-9_-]+\.(?:ogg|wav|mp3|m4a|aac))$/i.exec(source)
  if (local) {
    const file = join(SOURCE_DIR, local[1])
    if (statSync(file).size > MAX_AUDIO_BYTES) throw new RequestError(413, 'AUDIO_TOO_LARGE')
    return readFile(file)
  }
  const url = new URL(source)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError(400, 'INVALID_SOURCE')
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok || !response.body) throw new RequestError(502, 'DOWNLOAD_FAILED')
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) {
    await response.body.cancel()
    throw new RequestError(502, 'NOT_AUDIO')
  }
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
    await response.body.cancel()
    throw new RequestError(413, 'AUDIO_TOO_LARGE')
  }
  const blocks = []
  let size = 0
  for await (const block of response.body) {
    size += block.byteLength
    if (size > MAX_AUDIO_BYTES) throw new RequestError(413, 'AUDIO_TOO_LARGE')
    blocks.push(block)
  }
  return Buffer.concat(blocks, size)
}

function serveMedia(req, res, filePath) {
  const total = statSync(filePath).size
  res.setHeader('Content-Type', audioContentType(filePath))
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'public, max-age=86400')

  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : total - 1
      if (!match[1] && match[2]) {
        start = Math.max(0, total - Number(match[2]))
        end = total - 1
      }
      if (start >= 0 && start < total && end >= start) {
        end = Math.min(end, total - 1)
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1
        })
        sendMediaFile(res, filePath, { start, end })
        return
      }
    }
    res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
    return
  }

  res.writeHead(200, { 'Content-Length': total })
  sendMediaFile(res, filePath)
}

function sendMediaFile(res, path, range) {
  const source = createReadStream(path, range)
  source.on('error', error => res.destroy(error))
  res.once('close', () => source.destroy())
  source.pipe(res)
}

function getPlayerId(req) {
  const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')
  return match ? resolvePlayer(match[1]) : null
}

function checkScore(input) {
  if (!input || typeof input.attemptId !== 'string' || !/^[a-z0-9_-]{8,64}$/.test(input.attemptId)) {
    throw new RequestError(400, 'INVALID_ATTEMPT')
  }
  const song = SONGS_BY_ID.get(input.songId)
  if (!song) throw new RequestError(404, 'SONG_NOT_FOUND')
  if (input.chartVersion !== song.chartVersion || input.scoringVersion !== song.scoringVersion) {
    throw new RequestError(409, 'VERSION_MISMATCH')
  }
  if (input.completed !== true) throw new RequestError(422, 'NOT_ELIGIBLE')
  return song
}

function calculatePerformance(song, samples) {
  const maxFrames = Math.ceil(song.durationMs / PITCH_STEP_MS)
  if (!Array.isArray(samples) || samples.length > maxFrames) {
    throw new RequestError(400, 'INVALID_PITCH_TRACK')
  }
  let expected = 0
  for (const note of song.refNotes) {
    expected += Math.ceil((note.endMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS) -
      Math.ceil((note.startMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
  }
  let lastFrame = -1
  let voiced = 0
  let captured = 0
  let points = 0
  let battleScore = 0
  let noteIndex = 0
  for (const sample of samples) {
    if (!Array.isArray(sample) || sample.length !== 2) throw new RequestError(400, 'INVALID_PITCH_TRACK')
    const [frame, midi] = sample
    if (!Number.isInteger(frame) || frame <= lastFrame || frame >= maxFrames ||
        (midi !== null && (!Number.isFinite(midi) || midi < 0 || midi > 127))) {
      throw new RequestError(400, 'INVALID_PITCH_TRACK')
    }
    lastFrame = frame
    const time = frame * PITCH_STEP_MS + PITCH_STEP_MS / 2
    while (song.refNotes[noteIndex]?.endMs <= time) noteIndex++
    const note = song.refNotes[noteIndex]
    if (!note || note.startMs > time) continue
    captured++
    if (midi === null) continue
    const difference = Math.abs(midi - note.midi)
    points += Math.max(0, 100 - difference * 20)
    battleScore += difference <= 0.25 ? 10 : difference <= 0.5 ? 6 : difference <= 1 ? 2 : 0
    voiced++
  }
  if (song.scoringVersion >= 2 && (!expected || captured / expected < 0.95)) {
    throw new RequestError(422, 'INSUFFICIENT_SAMPLES')
  }
  const denominator = song.scoringVersion >= 2 ? captured : expected
  return {
    score: denominator ? Math.min(100, Math.round(points / denominator)) : 0,
    accuracy: voiced ? Math.round(points / voiced) : 0,
    coverage: denominator ? Math.min(100, Math.round(100 * voiced / denominator)) : 0,
    battleScore: song.scoringVersion >= 2 && captured ? Math.round(battleScore * expected / captured) : battleScore,
    voiced
  }
}

function saveScore(userId, input) {
  const song = checkScore(input)
  const { attemptId } = input
  const { score, accuracy, coverage } = calculatePerformance(song, input.samples)
  if (!coverage) throw new RequestError(422, 'NOT_ELIGIBLE')
  const values = [song.id, song.chartVersion, song.scoringVersion, score, accuracy, coverage]
  const result = insertScore.run(userId, attemptId, ...values, new Date().toISOString())
  if (result.changes) return true

  if (!findAttempt.get(userId, attemptId, ...values)) {
    throw new RequestError(409, 'ATTEMPT_CONFLICT')
  }
  return false
}

let rateMinute
const limits = new Map()
function limitRequests(req, res, kind, max) {
  const now = Date.now()
  const minute = Math.floor(now / 60000)
  if (rateMinute !== minute) {
    limits.clear()
    rateMinute = minute
  }
  // Nginx sets X-Real-IP to $remote_addr. Node only accepts loopback connections.
  const proxyIp = req.headers['x-real-ip']
  const ip = typeof proxyIp === 'string' && isIP(proxyIp) ? proxyIp : req.socket.remoteAddress
  const key = kind + ':' + ip
  const count = limits.get(key) || 0
  if (count >= max || (count === 0 && limits.size >= 10000)) {
    res.setHeader('Retry-After', Math.ceil((60000 - now % 60000) / 1000))
    throw new RequestError(429, 'RATE_LIMITED')
  }
  limits.set(key, count + 1)
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
    res.setHeader('Access-Control-Max-Age', '600')
    res.writeHead(204).end()
    return
  }
  if (req.method === 'GET' && path === '/healthz') {
    checkDatabase.get()
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && path === '/api/players') {
    limitRequests(req, res, 'players', 20)
    const input = await readJson(req, true)
    const rokuUserId = input?.rokuUserId == null ? null : input.rokuUserId
    if (rokuUserId !== null && (typeof rokuUserId !== 'string' || !/^[A-Za-z0-9_@.:-]{1,128}$/.test(rokuUserId))) {
      throw new RequestError(400, 'INVALID_USER')
    }
    const rokuCode = typeof input?.rokuCode === 'string' ? input.rokuCode : null
    if (rokuUserId && !(await verifyRokuAccount(rokuUserId, rokuCode))) {
      throw new RequestError(403, 'ROKU_AUTH_FAILED')
    }
    const token = randomBytes(32).toString('hex')
    if (rokuUserId) startRokidSession(rokuUserId, token)
    else insertPlayer.run(tokenHash(token))
    send(res, 201, { token, accountLinked: Boolean(rokuUserId) })
    return
  }
  if (req.method === 'POST' && path === '/api/scores') {
    limitRequests(req, res, 'scores', 60)
    const userId = getPlayerId(req)
    if (!userId) throw new RequestError(401, 'INVALID_TOKEN')
    const created = saveScore(userId, await readJson(req, false, SCORE_BODY_LIMIT))
    send(res, created ? 201 : 200, { ok: true, duplicate: !created })
    return
  }
  if (req.method === 'GET' && path === '/api/songs') {
    limitRequests(req, res, 'songs', 180)
    send(res, 200, { songs: SONGS.map(songSummary) })
    return
  }
  const prepareMatch = /^\/api\/songs\/([A-Za-z0-9_-]+)\/prepare$/.exec(path)
  if (req.method === 'POST' && prepareMatch) {
    limitRequests(req, res, 'songPrepare', 120)
    const song = SONGS_BY_ID.get(prepareMatch[1])
    if (!song) throw new RequestError(404, 'SONG_NOT_FOUND')
    const prepared = await ensureSongCached(song)
    send(res, 200, { song: prepared })
    return
  }
  const songDetailMatch = /^\/api\/songs\/([A-Za-z0-9_-]+)$/.exec(path)
  if (req.method === 'GET' && songDetailMatch) {
    limitRequests(req, res, 'songDetail', 180)
    const song = SONGS_BY_ID.get(songDetailMatch[1])
    if (!song) throw new RequestError(404, 'SONG_NOT_FOUND')
    send(res, 200, { song: publicSong(song) })
    return
  }
  if (req.method === 'GET' && path.startsWith('/media/songs/')) {
    const name = decodeURIComponent(path.slice('/media/songs/'.length))
    const filePath = join(MEDIA_DIR, name)
    if (!name || name !== basename(name) || !existsSync(filePath)) {
      throw new RequestError(404, 'NOT_FOUND')
    }
    serveMedia(req, res, filePath)
    return
  }
  if (req.method === 'GET' && path.startsWith('/source/')) {
    const name = decodeURIComponent(path.slice('/source/'.length))
    const filePath = join(SOURCE_DIR, name)
    if (!name || name !== basename(name) || !existsSync(filePath)) {
      throw new RequestError(404, 'NOT_FOUND')
    }
    serveMedia(req, res, filePath)
    return
  }
  if (req.method === 'GET' && path === '/api/leaderboard') {
    limitRequests(req, res, 'leaderboard', 180)
    const songId = url.searchParams.get('songId') ?? DEFAULT_SONG.id
    const song = SONGS_BY_ID.get(songId)
    if (!song) throw new RequestError(404, 'SONG_NOT_FOUND')
    const userId = getPlayerId(req)
    const rows = findRanks.all(song.id, song.chartVersion, song.scoringVersion, userId ?? null)
    const list = rows.filter(row => row.rank <= 50).map(row => ({
      rank: row.rank,
      userName: '歌手 ' + row.user_id,
      songId: song.id,
      songName: song.name,
      score: row.score,
      accuracy: row.accuracy,
      coverage: row.coverage,
      date: row.created_at.slice(0, 10)
    }))
    const myRank = rows.find(row => row.user_id === userId)?.rank ?? null
    send(res, 200, { list, myRank })
    return
  }
  throw new RequestError(404, 'NOT_FOUND')
}

const server = createServer({ requestTimeout: 15000 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    await route(req, res)
  } catch (error) {
    req.resume()
    if (res.destroyed) return
    if (error instanceof RequestError) {
      send(res, error.status, { error: error.message })
    } else {
      console.error('API request failed', error)
      send(res, 500, { error: 'INTERNAL_ERROR' })
    }
  }
})

// ---------------------------------------------------------------------------
// 联机对战：单进程内存房间，不写排行榜数据库。每个房间最多两人，房间之间独立。
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 })
const rooms = new Map()
const playerSockets = new Map()
const playerRooms = new Map()
const MAX_ROOMS = 100
const MAX_WS_BUFFERED_BYTES = 64 * 1024
const WS_HEARTBEAT_TIMEOUT_MS = 35000
const wsHeartbeat = setInterval(() => {
  const now = Date.now()
  for (const ws of playerSockets.values()) {
    if (now - ws.lastMessageAt >= WS_HEARTBEAT_TIMEOUT_MS) ws.terminate()
  }
}, 10000)
wsHeartbeat.unref()

function wsSend(ws, message) {
  if (!ws || ws.readyState !== 1) return
  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    if (message.type !== 'opponent.progress' && message.type !== 'lobby') ws.terminate()
    return
  }
  try {
    ws.send(JSON.stringify(message))
  } catch (error) {
    console.error('ws send failed', error.message)
    ws.terminate()
  }
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    hostName: room.hostName,
    playerCount: room.players.size,
    status: room.status
  }
}

function lobbyRooms() {
  return [...rooms.values()]
    .filter(room => room.status !== 'finished')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 50)
    .map(roomSummary)
}

function broadcastLobby() {
  for (const ws of playerSockets.values()) {
    wsSend(ws, { type: 'lobby', rooms: lobbyRooms() })
  }
}

function roomView(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    status: room.status,
    songId: room.songId,
    startAt: room.startAt,
    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      selectedSongId: player.selectedSongId,
      score: player.score,
      finished: player.finished
    }))
  }
}

function sendRoom(room) {
  for (const player of room.players.values()) {
    wsSend(player.ws, { type: 'room', room: roomView(room), selfId: player.id })
  }
}

function sendRoomError(player, code, message) {
  wsSend(player.ws, { type: 'error', code, message })
}

function leaveRoom(playerId, notice = '对手已离开房间') {
  const roomId = playerRooms.get(playerId)
  if (!roomId) return
  const room = rooms.get(roomId)
  playerRooms.delete(playerId)
  if (!room) return
  if (room.status === 'preparing' || room.status === 'playing') {
    cancelBattle(room, notice)
    return
  }

  const player = room.players.get(playerId)
  room.players.delete(playerId)

  if (room.players.size === 0) {
    rooms.delete(room.id)
  } else {
    const remaining = [...room.players.values()]
    room.hostId = remaining[0].id
    room.hostName = remaining[0].name
    room.name = room.hostName + ' 的房间'
    room.status = 'waiting'
    room.songId = null
    room.startAt = 0
    for (const other of remaining) {
      other.selectedSongId = null
      other.finished = false
      other.score = 0
      wsSend(other.ws, { type: 'notice', message: notice })
    }
    sendRoom(room)
  }
  if (player) wsSend(player.ws, { type: 'left', roomId: roomId })
  broadcastLobby()
}

function createRoom(player) {
  if (playerRooms.has(player.id)) return sendRoomError(player, 'ALREADY_IN_ROOM', '你已经在房间中')
  if (rooms.size >= MAX_ROOMS) return sendRoomError(player, 'ROOM_LIMIT', '房间数量已满，请稍后再试')
  const room = {
    id: 'room_' + randomBytes(4).toString('hex'),
    name: player.name + ' 的房间',
    hostId: player.id,
    hostName: player.name,
    status: 'waiting',
    players: new Map(),
    songId: null,
    startAt: 0,
    createdAt: Date.now()
  }
  room.players.set(player.id, {
    id: player.id,
    name: player.name,
    ws: player.ws,
    selectedSongId: null,
    score: 0,
    finished: false
  })
  rooms.set(room.id, room)
  playerRooms.set(player.id, room.id)
  sendRoom(room)
  broadcastLobby()
}

function startBattle(room, song) {
  room.status = 'preparing'
  room.songId = song.id
  room.roundId = randomBytes(12).toString('hex')
  const players = [...room.players.values()]
  for (const player of players) {
    const opponent = players.find(item => item.id !== player.id)
    wsSend(player.ws, {
      type: 'battle.prepare',
      roomId: room.id,
      roundId: room.roundId,
      songId: song.id,
      chartVersion: song.chartVersion,
      scoringVersion: song.scoringVersion,
      selfId: player.id,
      opponent: { id: opponent.id, name: opponent.name }
    })
  }
  room.timer = setTimeout(() => cancelBattle(room, '准备超时 · 对战已取消'), 30000)
  broadcastLobby()
}

function startCountdown(room) {
  clearTimeout(room.timer)
  room.status = 'playing'
  room.startAt = Date.now() + 3000
  const song = SONGS_BY_ID.get(room.songId)
  room.endAt = room.startAt + song.durationMs
  room.timer = setTimeout(() => cancelBattle(room, '结算超时 · 对战已取消'), song.durationMs + 23000)
  const players = [...room.players.values()]
  for (const player of players) {
    wsSend(player.ws, {
      type: 'battle.start',
      roomId: room.id,
      roundId: room.roundId,
      songId: song.id,
      startAt: room.startAt
    })
  }
  broadcastLobby()
}

function cancelBattle(room, reason) {
  clearTimeout(room.timer)
  rooms.delete(room.id)
  for (const player of room.players.values()) {
    playerRooms.delete(player.id)
    wsSend(player.ws, { type: 'battle.cancelled', roomId: room.id, roundId: room.roundId, reason })
  }
  broadcastLobby()
}

function finishBattle(room) {
  const players = [...room.players.values()]
  if (players.length < 2 || !players.every(player => player.finished)) return
  clearTimeout(room.timer)
  room.status = 'finished'
  const [a, b] = players
  const winner = a.score === b.score ? 'draw' : (a.score > b.score ? a.id : b.id)
  const resultPlayers = players.map(player => ({
    id: player.id,
    name: player.name,
    score: player.score
  }))
  for (const player of players) {
    playerRooms.delete(player.id)
    wsSend(player.ws, {
      type: 'battle.result',
      roomId: room.id,
      roundId: room.roundId,
      winner,
      players: resultPlayers
    })
  }
  broadcastLobby()
  setTimeout(() => {
    rooms.delete(room.id)
    broadcastLobby()
  }, 15000)
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/ws' || wss.clients.size >= 512) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})

function parseWsMessage(raw, binary) {
  if (binary) return null
  try {
    const message = JSON.parse(raw.toString())
    return message && !Array.isArray(message) && typeof message.type === 'string' ? message : null
  } catch {
    return null
  }
}

wss.on('connection', ws => {
  const timer = setTimeout(() => ws.close(4001, 'authentication timeout'), 5000)
  ws.on('error', error => console.error('ws client error', error.message))
  ws.once('close', () => clearTimeout(timer))
  ws.once('message', (raw, binary) => {
    clearTimeout(timer)
    const message = parseWsMessage(raw, binary)
    try {
      const id = message?.type === 'auth' && typeof message.token === 'string' ? resolvePlayer(message.token) : null
      if (id) attachPlayer(ws, id)
      else ws.close(4001, 'unauthorized')
    } catch (error) {
      console.error('ws login failed', error.message)
      ws.close(1011, 'authentication failed')
    }
  })
})

function attachPlayer(ws, id) {
  ws.lastMessageAt = Date.now()
  const player = {
    id,
    name: '歌手 ' + id,
    ws
  }
  const previous = playerSockets.get(player.id)
  if (previous && previous !== ws) {
    try { previous.close(4002, 'replaced') } catch {}
  }
  playerSockets.set(player.id, ws)

  const roomId = playerRooms.get(player.id)
  const room = roomId ? rooms.get(roomId) : null
  if (room && room.players.has(player.id)) {
    room.players.get(player.id).ws = ws
    if (room.status === 'preparing' || room.status === 'playing') cancelBattle(room, '设备重新连接 · 对战已取消')
    else sendRoom(room)
  }
  wsSend(ws, { type: 'welcome', playerId: player.id, name: player.name })
  wsSend(ws, { type: 'lobby', rooms: lobbyRooms() })

  ws.on('message', (raw, binary) => {
    const message = parseWsMessage(raw, binary)
    if (!message) return sendRoomError(player, 'BAD_MESSAGE', '消息格式错误')
    if (playerSockets.get(player.id) !== ws) return
    ws.lastMessageAt = Date.now()
    try {
      handleBattleMessage(player, message)
    } catch (error) {
      console.error('ws message failed', error.message)
      sendRoomError(player, 'INTERNAL_ERROR', '处理消息失败')
    }
  })

  ws.on('close', () => {
    if (playerSockets.get(player.id) !== ws) return
    playerSockets.delete(player.id)
    leaveRoom(player.id, '对手已掉线')
  })
}

function handleBattleMessage(player, message) {
  const ws = player.ws
    if (message.type === 'ping') {
      wsSend(ws, { type: 'pong', t0: Number(message.t0) || 0, t1: Date.now() })
      return
    }
    if (message.type === 'lobby') {
      wsSend(ws, { type: 'lobby', rooms: lobbyRooms() })
      return
    }
    if (message.type === 'room.create') {
      createRoom(player)
      return
    }

    if (message.type === 'room.join') {
      const target = rooms.get(String(message.roomId || ''))
      if (!target) return sendRoomError(player, 'ROOM_NOT_FOUND', '房间不存在')
      if (playerRooms.has(player.id)) return sendRoomError(player, 'ALREADY_IN_ROOM', '你已经在房间中')
      if (target.status !== 'waiting' || target.players.size >= 2) {
        return sendRoomError(player, 'ROOM_FULL', '房间已满或已开始')
      }
      target.players.set(player.id, {
        id: player.id,
        name: player.name,
        ws,
        selectedSongId: null,
        score: 0,
        finished: false
      })
      playerRooms.set(player.id, target.id)
      target.status = 'selecting'
      sendRoom(target)
      broadcastLobby()
      return
    }

    if (message.type === 'room.leave') {
      leaveRoom(player.id, '对手已取消房间')
      return
    }

    if (message.type === 'room.select') {
      const roomId = playerRooms.get(player.id)
      const target = roomId ? rooms.get(roomId) : null
      if (!target) return sendRoomError(player, 'NOT_IN_ROOM', '你不在房间中')
      if (target.status !== 'selecting') {
        return sendRoomError(player, 'ROOM_STARTED', '房间已开始或已结束')
      }
      if (target.players.size < 2) return sendRoomError(player, 'WAITING_OPPONENT', '等待对手加入')
      const song = SONGS_BY_ID.get(String(message.songId || ''))
      if (!song) return sendRoomError(player, 'SONG_NOT_FOUND', '歌曲不存在')
      const cached = song.bundled || songSummary(song).cached
      if (!cached) return sendRoomError(player, 'SONG_NOT_CACHED', '歌曲尚未缓存')
      const member = target.players.get(player.id)
      member.selectedSongId = song.id
      sendRoom(target)
      const players = [...target.players.values()]
      if (players.length === 2 && players.every(item => item.selectedSongId)) {
        if (players[0].selectedSongId !== players[1].selectedSongId) {
          for (const item of players) {
            wsSend(item.ws, { type: 'notice', message: '双方选择的歌曲不同，请选择同一首歌' })
          }
        } else {
          startBattle(target, song)
        }
      }
      return
    }

    if (message.type.startsWith('battle.')) {
      const target = rooms.get(playerRooms.get(player.id))
      if (!target || message.roomId !== target.id || !target.roundId || message.roundId !== target.roundId) {
        return sendRoomError(player, 'INVALID_ROUND', '当前对战场次无效')
      }
      const member = target.players.get(player.id)
      if (message.type === 'battle.cancel') {
        cancelBattle(target, '有歌手退出 · 对战已取消')
        return
      }
      if (message.type === 'battle.ready') {
        if (target.status !== 'preparing') return
        member.ready = true
        if ([...target.players.values()].every(item => item.ready)) startCountdown(target)
        return
      }
      const now = Date.now()
      if (target.status !== 'playing' || now < target.startAt) {
        return sendRoomError(player, 'ROUND_NOT_STARTED', '比赛尚未开唱')
      }
      if (message.type === 'battle.finish') {
        if (member.finished) return
        if (now < target.endAt - 750) {
          return sendRoomError(player, 'ROUND_NOT_ENDED', '比赛尚未结束')
        }
        let performance
        try {
          performance = calculatePerformance(SONGS_BY_ID.get(target.songId), message.samples)
        } catch (error) {
          if (!(error instanceof RequestError)) throw error
          cancelBattle(target, '音高采样无效 · 对战已取消')
          return
        }
        if (!performance.voiced) {
          cancelBattle(target, '未检测到有效演唱 · 对战已取消')
          return
        }
        member.score = performance.battleScore
        member.finished = true
        finishBattle(target)
        return
      }
      if (message.type !== 'battle.progress' || member.finished || now - (member.lastProgressAt || 0) < 100) return
      member.lastProgressAt = now
      const other = [...target.players.values()].find(item => item.id !== player.id)
      if (!other) return
      wsSend(other.ws, {
        type: 'opponent.progress',
        roomId: target.id,
        roundId: target.roundId,
        score: Math.max(0, Math.min(1000000, Number(message.score) || 0)),
        midi: Number.isFinite(message.midi) ? message.midi : null,
        note: String(message.note || '').slice(0, 8),
        cents: Math.max(-1200, Math.min(1200, Number(message.cents) || 0))
      })
      return
    }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('Karaoke API listening on http://127.0.0.1:' + server.address().port)
})

function shutdown() {
  clearInterval(wsHeartbeat)
  for (const ws of wss.clients) {
    try { ws.terminate() } catch {}
  }
  wss.close()
  server.close(() => db.close())
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
