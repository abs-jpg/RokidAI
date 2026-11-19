<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import { downloadSong, loadSongCatalog } from '../../utils/songLibrary.js'

const CATEGORY_ORDER = ['中文', 'English', '日本語', '한국어', '其他']

function prepareSongs(songs) {
  const sorted = [...songs].sort((a, b) => {
    const categoryA = a.category || '其他'
    const categoryB = b.category || '其他'
    const orderA = CATEGORY_ORDER.includes(categoryA) ? CATEGORY_ORDER.indexOf(categoryA) : CATEGORY_ORDER.length
    const orderB = CATEGORY_ORDER.includes(categoryB) ? CATEGORY_ORDER.indexOf(categoryB) : CATEGORY_ORDER.length
    return orderA - orderB || String(a.name).localeCompare(String(b.name), 'zh')
  })
  return sorted.map((song, index) => {
    const category = song.category || '其他'
    const previous = index > 0 ? (sorted[index - 1].category || '其他') : null
    return { ...song, category, showHeader: category !== previous }
  })
}

export default {
  data: {
    phase: 'loading',
    songs: [],
    selectedIdx: 0,
    message: '',
    hintText: '上下选择 · 确认'
  },

  onLoad() {
    this.refreshCatalog()
  },

  onShow() {
    if (this.data.phase === 'ready') this.refreshCatalog(true)
  },

  onUnload() {
    this.unloaded = true
    this.downloadController?.abort()
  },

  onHide() {
    this.downloadController?.abort()
  },

  async refreshCatalog(quiet = false) {
    if (!quiet) this.setData({ phase: 'loading', message: '' })
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      const songs = prepareSongs(result.songs)
      this.setData({
        phase: 'ready',
        songs,
        selectedIdx: Math.max(0, Math.min(this.data.selectedIdx, songs.length - 1)),
        hintText: songs.length ? '上下选择 · 确认下载' : '返回'
      })
    } catch (error) {
      console.error('load download catalog error', error)
      if (!this.unloaded) this.setData({ phase: 'error', message: '曲库加载失败', hintText: '返回' })
    }
  },

  onKeyUp(event) {
    const code = event.code
    if (code !== 'ArrowUp' && code !== 'ArrowDown' && code !== 'Enter') return
    event.preventDefault()
    if (code === 'Enter') {
      this.downloadSelected()
      return
    }
    if (!this.data.songs.length) return
    const offset = code === 'ArrowUp' ? -1 : 1
    this.setData({
      selectedIdx: (this.data.selectedIdx + offset + this.data.songs.length) % this.data.songs.length
    })
  },

  onTapSong(event) {
    const index = Number(event.currentTarget.dataset.idx)
    this.setData({ selectedIdx: index })
    this.downloadSelected(index)
  },

  async downloadSelected(index = this.data.selectedIdx) {
    if (this.downloading) return
    const song = this.data.songs[index]
    if (!song) return
    if (song.bundled) {
      this.setData({ message: '内置歌曲，无需下载' })
      return
    }
    if (song.downloaded) {
      this.setData({ message: '已下载到本机，可以离线演唱' })
      return
    }

    this.downloading = true
    this.downloadController = new AbortController()
    this.setData({ message: '正在下载 · ' + song.name })
    try {
      let lastProgress = ''
      const result = await downloadSong(song.id, {
        signal: this.downloadController.signal,
        onProgress: ({ bytes, total }) => {
          if (this.unloaded) return
          const progress = total > 0 ? Math.floor(100 * bytes / total) + '%' : Math.floor(bytes / 1024) + ' KB'
          if (progress === lastProgress) return
          lastProgress = progress
          this.setData({ message: '正在下载 ' + progress + ' · ' + song.name })
        }
      })
      if (this.unloaded) return
      this.setData({
        songs: this.data.songs.map(item => item.id === song.id
          ? { ...item, cached: true, downloaded: result.offline } : item),
        message: result.offline ? '下载完成 · ' + song.name : '当前环境不支持离线存储 · 可在线播放'
      })
    } catch (error) {
      console.error('download song error', error)
      if (!this.unloaded) this.setData({ message: error.name === 'AbortError' ? '下载已取消' : '下载失败 · 再确认重试' })
    } finally {
      this.downloading = false
      this.downloadController = null
    }
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="title">音乐下载</text>
      <text class="count">{{songs.length}} 首</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'loading'}}">
      <text class="state-text">正在加载曲库</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'error'}}">
      <text class="state-text">{{message}}</text>
    </view>

    <scroll-view
      class="song-list"
      scroll-y="{{true}}"
      scroll-into-view="download-song-{{selectedIdx}}"
      ink:if="{{phase === 'ready'}}"
    >
      <view class="song-group" ink:for="{{songs}}" ink:key="id">
        <view class="category-header" ink:if="{{item.showHeader}}">
          <text class="category-name">{{item.category}}</text>
        </view>
        <view
          id="download-song-{{index}}"
          class="song-row {{selectedIdx === index ? 'row-active' : ''}}"
          bindtap="onTapSong"
          data-idx="{{index}}"
        >
          <view class="song-info">
            <text class="song-name">{{item.name}}</text>
            <text class="song-artist">{{item.artist}}</text>
          </view>
          <text class="song-badge">{{item.bundled ? '内置' : (item.downloaded ? '本机已下载' : '可下载')}}</text>
        </view>
      </view>
      <view class="empty-area" ink:if="{{songs.length === 0}}">
        <text class="state-text">暂无歌曲</text>
      </view>
    </scroll-view>

    <view class="message-bar">
      <text class="message-text">{{message}}</text>
    </view>
    <view class="hintbar">
      <text class="hint-text">{{hintText}}</text>
    </view>
  </view>
</page>

<style>
:root {
  --green-100: #40ff5e;
  --green-72: rgba(64,255,94,0.72);
  --green-48: rgba(64,255,94,0.48);
  --green-24: rgba(64,255,94,0.24);
  --green-12: rgba(64,255,94,0.12);
}

.page-root {
  display: flex;
  flex-direction: column;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
}

.topbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  flex-shrink: 0;
  padding: 0 10px;
  border-bottom: 1px solid var(--green-24);
}

.title {
  font-size: 18px;
  font-weight: bold;
  color: var(--green-100);
}

.count {
  font-size: 11px;
  color: var(--green-48);
}

.body-area {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
}

.state-text {
  font-size: 15px;
  color: var(--green-72);
}

.song-list {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 6px 0;
}

.category-header {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 4px 10px 0;
}

.category-name {
  font-size: 11px;
  color: var(--green-48);
  border-bottom: 1px solid var(--green-24);
}

.song-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 48px;
  padding: 0 10px;
  margin-bottom: 4px;
  border-left: 2px solid transparent;
}

.row-active {
  background-color: var(--green-12);
  border-left: 2px solid var(--green-100);
}

.song-info {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}

.song-name {
  font-size: 16px;
  color: var(--green-72);
}

.row-active .song-name {
  color: var(--green-100);
  font-weight: bold;
}

.song-artist {
  font-size: 11px;
  color: var(--green-48);
}

.song-badge {
  font-size: 11px;
  color: var(--green-48);
  border: 1px solid var(--green-24);
  padding: 2px 6px;
  flex-shrink: 0;
}

.empty-area {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80px;
}

.message-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  flex-shrink: 0;
}

.message-text {
  font-size: 11px;
  color: var(--green-72);
}

.hintbar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 20px;
  flex-shrink: 0;
}

.hint-text {
  font-size: 10px;
  color: var(--green-24);
}
</style>
