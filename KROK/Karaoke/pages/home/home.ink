<script setup>
import wx from 'wx'
import { songs } from '../../utils/songData.js'
import { isServerConnected } from '../../utils/leaderboard.js'
import { loadSongCatalog, preloadSongAudio } from '../../utils/songLibrary.js'
import { isDownloadReturnEcho, isReturnKey, takeDownloadInput } from '../../utils/downloadReturn.js'
import { HomeVoiceSelection } from '../../utils/homeVoiceSelection.js'

const ROW_HEIGHT = 58

function navItems(connected) {
  return [
    { label: connected ? '排行榜' : '本机排行榜', url: '/pages/leaderboard/leaderboard' },
    { label: '多人联机', url: '/pages/battle/battle' },
    { label: '音乐下载', url: '/pages/download/download' }
  ]
}

function availableVersions(song) {
  return [Boolean(song?.bundled || song?.downloadedVariants?.guide),
    Boolean(song?.bundled || song?.downloadedVariants?.instrumental)]
}

export default {
  data: {
    songs,
    selectedIdx: 0,
    scrollTop: 0,
    songCount: songs.length,
    navItems: navItems(isServerConnected()),
    hintText: '上下选择 · 确认',
    voiceHint: ''
  },

  onLoad() {
    this.prewarmDefaultAudio()
  },

  onShow() {
    this.voiceHomeVisible = true
    const refresh = this.refreshCatalog()
    this.voiceCatalogRefresh = refresh
    refresh.finally(() => {
      if (this.voiceCatalogRefresh === refresh) this.voiceCatalogRefresh = null
    })
  },

  onHide() {
    this.voiceHomeVisible = false
    this.voiceSelection?.cancel()
  },

  onUnload() {
    this.unloaded = true
    this.voiceSelection?.cancel()
  },

  onVoiceWakeup(event) {
    if (!this.voiceHomeVisible || this.unloaded || this.navigating) return
    event.preventDefault()
    if (!this.voiceSelection) this.voiceSelection = new HomeVoiceSelection(this)
    this.voiceSelection.start()
  },

  async refreshCatalog() {
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      const playable = result.songs.filter(song => availableVersions(song).some(Boolean))
      const songCount = playable.length
      const destinations = navItems(result.connected || isServerConnected())
      const selectedUrl = this.data.navItems[this.data.selectedIdx - this.data.songCount]?.url
      const navIndex = destinations.findIndex(item => item.url === selectedUrl)
      const selectedSongId = this.data.songs[this.data.selectedIdx]?.id
      const songIndex = playable.findIndex(song => song.id === selectedSongId)
      const selectedIdx = navIndex >= 0
        ? songCount + navIndex
        : songIndex >= 0 ? songIndex : Math.max(0, Math.min(this.data.selectedIdx, songCount - 1))
      this.setData({
        songs: playable,
        songCount,
        selectedIdx,
        scrollTop: navIndex >= 0 ? this.data.scrollTop : selectedIdx * ROW_HEIGHT,
        navItems: destinations
      })
    } catch (e) {
      console.error('load song catalog error', e)
    }
  },

  async prewarmDefaultAudio() {
    const song = this.data.songs[0]
    if (!song) return
    const results = await Promise.allSettled([
      preloadSongAudio(song, 'guide'),
      preloadSongAudio(song, 'instrumental')
    ])
    if (this.unloaded) return
    const ready = results.every(result => result.status === 'fulfilled')
    this.setData({
      hintText: ready ? '默认伴奏已就绪 · 上下选择 · 确认' : '默认伴奏预热失败 · 可在真机重试'
    })
  },

  onKeyDown(event) {
    if (isReturnKey(event) && isDownloadReturnEcho(event)) takeDownloadInput(event)
  },

  onKeyUp(event) {
    if (isDownloadReturnEcho(event)) {
      takeDownloadInput(event)
      return
    }
    const { code } = event
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      event.preventDefault()
      const count = this.data.songCount + this.data.navItems.length
      const offset = code === 'ArrowUp' ? -1 : 1
      const selectedIdx = (this.data.selectedIdx + offset + count) % count
      const patch = { selectedIdx }
      if (selectedIdx < this.data.songCount) patch.scrollTop = selectedIdx * ROW_HEIGHT
      this.setData(patch)
    } else if (code === 'Enter') {
      event.preventDefault()
      event.stopPropagation?.()
      this.activate(this.data.selectedIdx)
    }
  },

  onTapSong(event) {
    this.activate(Number(event.currentTarget.dataset.idx))
  },

  onTapNav(event) {
    this.activate(this.data.songCount + Number(event.currentTarget.dataset.idx))
  },

  activate(index) {
    if (this.navigating) return
    const song = this.data.songs[index]
    const nav = this.data.navItems[index - this.data.songCount]
    if (!song && !nav) return
    this.setData({ selectedIdx: index })
    this.navigating = true

    const state = song ? getApp().globalData : null
    const entry = song ? { songId: song.id, name: song.name, versions: availableVersions(song) } : null
    if (entry) state.songChoiceEntry = entry
    wx.navigateTo({
      url: entry ? '/pages/song-choice/choice' : nav.url,
      fail: () => {
        if (entry && state.songChoiceEntry === entry) delete state.songChoiceEntry
      },
      complete: () => { this.navigating = false }
    })
  }
}
</script>

<page>
  <view class="page-root">
    <view class="main-view">
    <view class="topbar">
      <text class="title">K 歌</text>
    </view>

    <scroll-view class="song-list" scroll-y="{{true}}" scroll-top="{{scrollTop}}">
      <view
        id="song-item-{{index}}"
        class="song-item"
        ink:for="{{songs}}"
        ink:key="id"
        bindtap="onTapSong"
        data-idx="{{index}}"
      >
        <view class="song-marker">
          <view class="song-dot {{selectedIdx === index ? 'dot-on' : ''}}"></view>
        </view>
        <view class="song-info">
          <text class="song-name">{{item.name}}</text>
          <text class="song-artist">{{item.artist}}</text>
        </view>
        <text class="song-badge" ink:if="{{item.online}}">已下载</text>
        <text class="song-tag" ink:if="{{item.tag}}">{{item.tag}}</text>
        <text class="song-diff">
          <text ink:if="{{item.difficulty === 1}}">★☆☆</text>
          <text ink:elif="{{item.difficulty === 2}}">★★☆</text>
          <text ink:else>★★★</text>
        </text>
      </view>
    </scroll-view>

    <view class="nav-row">
      <view
        class="nav-item"
        ink:for="{{navItems}}"
        ink:key="label"
        bindtap="onTapNav"
        data-idx="{{index}}"
      >
        <view class="nav-marker">
          <view class="nav-dot {{selectedIdx === songCount + index ? 'dot-on' : ''}}"></view>
        </view>
        <text class="nav-label">{{item.label}}</text>
      </view>
    </view>

    <view class="hintbar">
      <text class="hint-text">{{voiceHint || hintText}}</text>
    </view>
    </view>
  </view>
</page>

<style>
:root {
  --green-100: #4cc773;
  --green-72: rgba(76,199,115,0.72);
  --green-48: rgba(76,199,115,0.48);
  --green-24: rgba(76,199,115,0.24);
  --green-12: rgba(76,199,115,0.12);
  --green-06: rgba(76,199,115,0.06);
}

.page-root {
  display: flex;
  flex-direction: column;
  position: relative;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
  padding: 0;
}

.main-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.topbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(76,199,115,0.40);
}

.title {
  font-size: 20px;
  font-weight: bold;
  color: var(--green-100);
}

.song-list {
  flex: 1 1 auto;
  min-height: 0;
  padding: 16px 12px;
}

.song-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 54px;
  padding: 0 8px;
  margin-bottom: 4px;
}

.song-marker {
  width: 16px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.song-dot {
  width: 6px;
  height: 6px;
  background-color: var(--green-100);
}

.song-info {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 8px;
}

.song-name {
  font-size: 22px;
  color: var(--green-100);
}

.song-artist {
  font-size: 14px;
  color: var(--green-72);
  margin-top: 1px;
}

.song-diff {
  font-size: 12px;
  color: var(--green-48);
  flex-shrink: 0;
}

.song-badge {
  font-size: 10px;
  color: var(--green-48);
  border: 1px solid var(--green-24);
  padding: 1px 4px;
  margin-right: 6px;
  flex-shrink: 0;
}

.song-tag {
  font-size: 10px;
  color: #041006;
  background-color: var(--green-72);
  padding: 1px 5px;
  margin-right: 6px;
  flex-shrink: 0;
}

.nav-row {
  display: flex;
  flex-direction: row;
  height: 40px;
  padding: 0 12px;
  flex-shrink: 0;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  height: 40px;
}

.nav-marker {
  width: 100%;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-dot {
  width: 5px;
  height: 5px;
  background-color: var(--green-100);
}

.nav-label {
  font-size: 16px;
  color: var(--green-72);
  margin-top: 2px;
}

.hintbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 24px;
  flex-shrink: 0;
  padding: 0 12px;
}

.hint-text {
  font-size: 14px;
  color: var(--green-72);
}

.song-dot, .nav-dot {
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 190ms ease, transform 190ms ease;
}

.song-dot.dot-on, .nav-dot.dot-on {
  opacity: 1;
  transform: scale(1);
}

</style>
