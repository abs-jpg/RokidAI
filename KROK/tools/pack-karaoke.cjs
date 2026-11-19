const { spawnSync } = require('node:child_process')
const { cpSync, existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const [mode, address, ...rest] = process.argv.slice(2)
if (rest.length || (mode === '--api' ? !address : address || !['--local', '--offline'].includes(mode))) {
  throw new Error('Usage: node tools/pack-karaoke.cjs --local | --offline | --api https://api.example.com')
}

let url = ''
let output = 'Karaoke.aix'
if (mode === '--local') {
  url = 'http://127.0.0.1:3100'
  output = 'Karaoke-Studio.aix'
} else if (mode === '--api') {
  const api = new URL(address)
  if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
    throw new Error('使用 HTTPS 服务器根地址')
  }
  url = api.origin
}

const stage = mkdtempDisposableSync(join(tmpdir(), 'karaoke-pack-'))
try {
  const source = join(root, 'Karaoke')
  for (const path of ['assets', 'pages', 'utils', 'app.json', 'app.js', 'AGENTS.md', '.aix']) {
    const from = join(source, path)
    if (existsSync(from)) cpSync(from, join(stage.path, basename(path)), { recursive: true })
  }
  const config = join(stage.path, 'utils', 'leaderboardConfig.js')
  const content = readFileSync(config, 'utf8')
  const pattern = /^const configuredUrl = .*$/m
  if (!pattern.test(content)) throw new Error('leaderboardConfig.js 缺少 configuredUrl')
  writeFileSync(config, content.replace(pattern, 'const configuredUrl = ' + JSON.stringify(url)))
  const cli = join(root, 'node_modules', '@yodaos-pkg', 'aix-cli', 'dist', 'cli.js')
  const run = spawnSync(process.execPath, [cli, 'pack', stage.path, '-o', join(root, output)], {
    cwd: root, stdio: 'inherit'
  })
  if (run.error) throw run.error
  process.exitCode = run.status ?? 1
} finally {
  stage.remove()
}
