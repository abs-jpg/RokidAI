<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import { getLeaderboard, isServerConnected } from '../../utils/leaderboard.js'
import { songs } from '../../utils/songData.js'
import { loadSongCatalog } from '../../utils/songLibrary.js'

export default {
  data: {
    songs,
    songCount: songs.length,
    songIndex: 0,
    focus: 'songs',
    selectedIdx: 0,
    activeSongName: songs[0] ? songs[0].name : '',
    phase: songs.length ? 'loading' : 'error',
    entries: [],
    sourceLabel: '',
    errorMsg: songs.length ? '' : '曲库为空',
    hintText: songs.length ? '上下选歌 · 确认查看' : '返回'
  },

  onLoad() {
    this.requestId = 0
    this.initialize()
  },

  async initialize() {
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      this.setData({
        songs: result.songs,
        songCount: result.songs.length,
        activeSongName: result.songs[0] ? result.songs[0].name : ''
      })
      if (result.songs.length) this.loadLeaderboard(0)
    } catch (e) {
      console.error('load catalog error', e)
      if (!this.unloaded) this.setData({ phase: 'error', errorMsg: '曲库加载失败' })
    }
  },

  onShow() {
    const phase = this.data.phase
    if (this.data.songCount && (phase === 'display' || phase === 'empty' || phase === 'error')) {
      this.loadLeaderboard(this.data.songIndex, true)
    }
  },

  onKeyUp(event) {
    const code = event.code
    if (code === 'Backspace' && this.data.focus === 'entries') {
      event.preventDefault()
      this.setData({ focus: 'songs', hintText: '上下选歌 · 确认查看' })
      return
    }
    if (!this.data.songCount) return
    if (code !== 'ArrowUp' && code !== 'ArrowDown' && code !== 'Enter') return
    event.preventDefault()

    if (code === 'Enter') {
      if (this.data.focus === 'songs') {
        this.setData({ focus: 'entries', hintText: '上下浏览 · 确认刷新 · 返回选歌' })
        if (this.data.phase === 'error') this.loadLeaderboard(this.data.songIndex)
      } else {
        this.loadLeaderboard(this.data.songIndex)
      }
      return
    }

    const offset = code === 'ArrowUp' ? -1 : 1
    if (this.data.focus === 'entries') {
      const selectedIdx = Math.max(0, Math.min(this.data.entries.length - 1, this.data.selectedIdx + offset))
      this.setData({ selectedIdx })
      return
    }
    const nextIndex = (this.data.songIndex + offset + this.data.songCount) % this.data.songCount
    this.loadLeaderboard(nextIndex)
  },

  onTapSong(event) {
    this.setData({ focus: 'entries' })
    this.loadLeaderboard(Number(event.currentTarget.dataset.idx))
  },

  onUnload() {
    this.unloaded = true
  },

  async loadLeaderboard(index, quiet = false) {
    const song = this.data.songs[index]
    if (!song) return
    const requestId = ++this.requestId
    if (index !== this.data.songIndex) this.setData({ selectedIdx: 0 })

    if (quiet) {
      this.setData({ songIndex: index, activeSongName: song.name })
    } else {
      this.setData({
        songIndex: index,
        activeSongName: song.name,
        phase: 'loading',
        entries: [],
        sourceLabel: '',
        errorMsg: ''
      })
    }

    try {
      const result = await getLeaderboard(song.id)
      if (this.unloaded || requestId !== this.requestId) return

      const entries = result.list.map((entry, entryIndex) => ({
        ...entry,
        rank: entry.rank ?? entryIndex + 1,
        userName: entry.userName || (result.connected ? '歌手' : '我')
      }))
      let sourceLabel = isServerConnected() ? '服务器暂不可用 · 本机成绩' : '本机成绩'
      if (result.connected) {
        sourceLabel = result.myRank
          ? '服务器排行榜 · 我的第 ' + result.myRank + ' 名'
          : '服务器排行榜'
      }
      this.setData({
        phase: entries.length ? 'display' : 'empty',
        entries,
        selectedIdx: Math.max(0, Math.min(this.data.selectedIdx, entries.length - 1)),
        sourceLabel,
        hintText: this.data.focus === 'entries' ? '上下浏览 · 确认刷新 · 返回选歌' : '上下选歌 · 确认查看'
      })
    } catch (e) {
      if (this.unloaded || requestId !== this.requestId) return
      console.error('leaderboard load error', e, e && e.message)
      this.setData({
        phase: 'error',
        errorMsg: '加载失败',
        hintText: '确认重试 · 返回选歌'
      })
    }
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="title">排行榜</text>
      <text class="page-indicator" ink:if="{{songCount}}">{{songIndex + 1}} / {{songCount}}</text>
    </view>

    <scroll-view
      class="song-tabs"
      scroll-x="{{true}}"
      scroll-into-view="song-{{songIndex}}"
      ink:if="{{songCount}}"
    >
      <view class="song-tabs-inner">
        <view
          id="song-{{index}}"
          class="song-tab {{songIndex === index ? 'song-tab-active' : ''}}"
          ink:for="{{songs}}"
          ink:key="id"
          bindtap="onTapSong"
          data-idx="{{index}}"
        >
          <text class="song-tab-name {{songIndex === index ? 'song-tab-name-active' : ''}}">{{item.name}}</text>
        </view>
      </view>
    </scroll-view>

    <view class="source-bar" ink:if="{{sourceLabel}}">
      <text class="source-text">{{sourceLabel}}</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'loading'}}">
      <text class="loading-text">加载中</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'error'}}">
      <text class="error-text">{{errorMsg}}</text>
      <text class="error-sub">确认重试</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'empty'}}">
      <text class="empty-text">{{activeSongName}} · 暂无成绩</text>
      <text class="empty-sub">返回选歌可查看其他榜单</text>
    </view>

    <scroll-view class="body-scroll" ink:if="{{phase === 'display'}}" scroll-y="{{true}}" scroll-into-view="entry-{{selectedIdx}}">
      <view class="list">
        <view id="entry-{{index}}" class="row {{focus === 'entries' && selectedIdx === index ? 'row-active' : ''}}" ink:for="{{entries}}" ink:key="rank">
          <text class="rank">{{item.rank}}</text>
          <text class="user-name">{{item.userName}}</text>
          <text class="score">{{item.score}}</text>
        </view>
      </view>
    </scroll-view>

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
  height: 28px;
  flex-shrink: 0;
  padding: 0 8px;
}

.title {
  font-size: 16px;
  font-weight: bold;
  color: var(--green-100);
}

.page-indicator {
  font-size: 11px;
  color: var(--green-48);
}

.song-tabs {
  height: 32px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--green-24);
}

.song-tabs-inner {
  display: flex;
  flex-direction: row;
  height: 31px;
  padding: 0 6px;
}

.song-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 31px;
  padding: 0 10px;
  margin-right: 4px;
  flex-shrink: 0;
  border-bottom: 2px solid transparent;
}

.song-tab-active {
  background-color: var(--green-12);
  border-bottom: 2px solid var(--green-100);
}

.song-tab-name {
  font-size: 13px;
  color: var(--green-48);
}

.song-tab-name-active {
  color: var(--green-100);
  font-weight: bold;
}

.source-bar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 16px;
  flex-shrink: 0;
}

.source-text {
  font-size: 9px;
  color: var(--green-72);
}

.body-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 0;
}

.loading-text {
  font-size: 14px;
  color: var(--green-48);
}

.error-text {
  font-size: 14px;
  color: var(--green-72);
}

.error-sub {
  font-size: 12px;
  color: var(--green-48);
  margin-top: 8px;
}

.empty-text {
  font-size: 16px;
  font-weight: bold;
  color: var(--green-48);
}

.empty-sub {
  font-size: 12px;
  color: var(--green-24);
  margin-top: 8px;
}

.body-scroll {
  flex: 1 1 auto;
  min-height: 0;
}

.list {
  display: flex;
  flex-direction: column;
  padding: 0 6px;
}

.row {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 34px;
  flex-shrink: 0;
}

.row-active {
  background-color: var(--green-12);
  border-left: 2px solid var(--green-100);
}

.rank {
  font-size: 14px;
  font-weight: bold;
  color: var(--green-100);
  width: 30px;
  flex-shrink: 0;
}

.user-name {
  font-size: 13px;
  color: var(--green-72);
  flex: 1 1 auto;
  min-width: 0;
}

.score {
  font-size: 16px;
  font-weight: bold;
  color: var(--green-100);
  width: 48px;
  text-align: right;
  flex-shrink: 0;
}

.hintbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 18px;
  flex-shrink: 0;
}

.hint-text {
  font-size: 10px;
  color: var(--green-24);
}
</style>
