const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } = require('node:fs')
const { isIP } = require('node:net')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const [mode, address, ...rest] = process.argv.slice(2)
if (rest.length || (mode === '--api' ? !address : address || !['--local', '--offline'].includes(mode))) {
  throw new Error('Usage: node tools/pack-karaoke.cjs --local | --offline | --api https://api.example.com | --api http://IPv4:port')
}

let url = ''
let output = 'Karaoke.aix'
if (mode === '--local') {
  url = 'http://127.0.0.1:3100'
  output = 'Karaoke-Studio.aix'
} else if (mode === '--api') {
  const api = new URL(address)
  const insecureTestApi = api.protocol === 'http:' && isIP(api.hostname) === 4
  if ((api.protocol !== 'https:' && !insecureTestApi) ||
      api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
    throw new Error('使用 HTTPS 域名，内测可使用 IPv4 HTTP 根地址')
  }
  url = api.origin
}

const stage = mkdtempDisposableSync(join(tmpdir(), 'karaoke-pack-'))
try {
  const source = join(root, 'Karaoke')
  for (const path of ['assets', 'components', 'pages', 'utils', 'app.json', 'app.js', 'AGENTS.md', '.aix']) {
    const from = join(source, path)
    if (existsSync(from)) cpSync(from, join(stage.path, basename(path)), { recursive: true })
  }
  const config = join(stage.path, 'utils', 'leaderboardConfig.js')
  let content = readFileSync(config, 'utf8')
  if (/^const configuredUrl = .*$/m.test(content)) {
    content = content.replace(/^const configuredUrl = .*$/m, 'const configuredUrl = ' + JSON.stringify(url))
  } else if (/const configuredUrls = \[[\s\S]*?\]/m.test(content)) {
    content = content.replace(/const configuredUrls = \[[\s\S]*?\]/m,
      'const configuredUrls = [' + (url ? JSON.stringify(url) : '') + ']')
  } else {
    throw new Error('leaderboardConfig.js 缺少 configuredUrl / configuredUrls')
  }
  writeFileSync(config, content)
  const cli = join(root, 'node_modules', '@yodaos-pkg', 'aix-cli', 'dist', 'cli.js')
  const run = spawnSync(process.execPath, [cli, 'pack', stage.path, '-o', join(root, output)], {
    cwd: root, stdio: 'inherit'
  })
  if (run.error) throw run.error
  process.exitCode = run.status ?? 1
} finally {
  stage.remove()
}
