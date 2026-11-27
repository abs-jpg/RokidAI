const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const app = path.resolve(__dirname, '../Karaoke')
const files = new Map([
  ['/phrase-practice-preview.html', [path.join(__dirname, 'phrase-practice-preview.html'), 'text/html; charset=utf-8']],
  ['/phrase-screen.css', [path.join(app, 'pages', 'phrase', 'phrase.wxss'), 'text/css; charset=utf-8']],
  ...['daoXiangSong', 'phraseAudio', 'phraseChinese', 'phrasePractice', 'pitchEngine', 'scoreEngine', 'songChoice', 'songData']
    .map(name => ['/utils/' + name + '.js', [path.join(app, 'utils', name + '.js'), 'text/javascript; charset=utf-8']]),
  ...['guide', 'instrumental'].map(variant => {
    const name = 'dao-xiang-' + variant + '.ogg'
    return ['/assets/songs/' + name, [path.join(app, 'assets', 'songs', name), 'audio/ogg']]
  })
])

http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }
  const requestPath = request.url.split('?')[0]
  response.setHeader('Cache-Control', 'no-store')
  const entry = files.get(requestPath)
  if (!entry) {
    response.writeHead(404).end()
    return
  }
  const [file, type] = entry
  const { size } = fs.statSync(file)
  response.setHeader('Content-Type', type)
  response.setHeader('Accept-Ranges', 'bytes')
  let start = 0
  let end = size - 1
  if (request.headers.range) {
    const range = request.headers.range.match(/^bytes=(\d*)-(\d*)$/)
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(end, Number(range[2]))
      } else start = Math.max(0, size - Number(range[2]))
    } else start = size
    if (start > end) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + size }).end()
      return
    }
    response.statusCode = 206
    response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
  }
  response.setHeader('Content-Length', end - start + 1)
  if (request.method === 'HEAD') response.end()
  else fs.createReadStream(file, { start, end }).pipe(response)
}).listen(8767, '127.0.0.1', () => {
  console.log('Phrase preview: http://127.0.0.1:8767/phrase-practice-preview.html')
})
