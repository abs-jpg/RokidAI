// 优先使用 HTTPS；TLS 被当前网络拦截时回退到已验证的腾讯云内测入口。
const configuredUrls = [
  'https://karaoke-api.palerider6.com',
  'http://110.40.170.159:8100'
]

function resolveOrigin(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    if (url.protocol === 'https:' || ((loopback || ipv4) && url.protocol === 'http:')) return url.origin
  } catch (error) {
    console.error('排行榜服务器地址无效', error)
  }
  return ''
}

export const LEADERBOARD_API_URLS = [...new Set(
  configuredUrls.map(resolveOrigin).filter(Boolean)
)]
export const LEADERBOARD_API_URL = LEADERBOARD_API_URLS[0] || ''
