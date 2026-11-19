// 发布时填入 HTTPS 站点根地址。本机联调包由 tools/pack-karaoke.cjs 生成。
const configuredUrl = ''

function resolveOrigin(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    if (url.protocol === 'https:' || (loopback && url.protocol === 'http:')) return url.origin
  } catch (error) {
    console.error('排行榜服务器地址无效', error)
  }
  return ''
}

export const LEADERBOARD_API_URL = resolveOrigin(configuredUrl)
