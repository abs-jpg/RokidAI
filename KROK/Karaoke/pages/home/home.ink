<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { songs } from '../../utils/songData.js'
import { isServerConnected } from '../../utils/leaderboard.js'
import { loadSongCatalog, prepareSongDownload } from '../../utils/songLibrary.js'

function navItems(connected) {
  return [
    { label: connected ? '排行榜' : '本机排行榜', url: '/pages/leaderboard/leaderboard' },
    { label: '多人联机', url: '/pages/battle/battle' },
    { label: '音乐下载', url: '/pages/download/download' }
  ]
}

export default {
  data: {
    songs,
    selectedIdx: 0,
    songCount: songs.length,
    navItems: navItems(isServerConnected()),
    hintText: '上下选择 · 确认',
    choiceVisible: false,
    choiceIndex: 0,
    choiceSongId: '',
    choiceSongName: '',
    choiceOptions: [
      { value: 'withMusic', label: '有音乐的版本', desc: '播放伴奏 · 可评分' },
      { value: 'silent', label: '无声版本', desc: '显示歌词和音高 · 不播放伴奏' }
    ]
  },

  onLoad() {
    this.refreshCatalog()
  },

  onUnload() {
    this.unloaded = true
  },

  async refreshCatalog() {
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      this.setData({
        songs: result.songs,
        songCount: result.songs.length,
        selectedIdx: Math.max(0, Math.min(this.data.selectedIdx, result.songs.length - 1)),
        navItems: navItems(result.connected || isServerConnected())
      })
    } catch (e) {
      console.error('load song catalog error', e)
    }
  },

  onKeyUp(event) {
    const { code } = event
    if (this.data.choiceVisible) {
      if (code === 'Backspace') {
        event.preventDefault()
        this.setData({ choiceVisible: false, hintText: '上下选择 · 确认' })
        return
      }
      if (code === 'ArrowUp' || code === 'ArrowDown') {
        event.preventDefault()
        const count = this.data.choiceOptions.length
        const offset = code === 'ArrowUp' ? -1 : 1
        this.setData({ choiceIndex: (this.data.choiceIndex + offset + count) % count })
        return
      }
      if (code === 'Enter') {
        event.preventDefault()
        this.confirmChoice()
      }
      return
    }
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      event.preventDefault()
      const count = this.data.songCount + this.data.navItems.length
      const offset = code === 'ArrowUp' ? -1 : 1
      this.setData({ selectedIdx: (this.data.selectedIdx + offset + count) % count })
    } else if (code === 'Enter') {
      event.preventDefault()
      this.activate(this.data.selectedIdx)
    }
  },

  onTapSong(event) {
    this.activate(Number(event.currentTarget.dataset.idx))
  },

  onTapNav(event) {
    this.activate(this.data.songCount + Number(event.currentTarget.dataset.idx))
  },

  onTapChoice(event) {
    this.setData({ choiceIndex: Number(event.currentTarget.dataset.idx) })
  },

  async activate(index) {
    const song = this.data.songs[index]
    if (song) {
      this.setData({
        selectedIdx: index,
        choiceVisible: true,
        choiceIndex: 0,
        choiceSongId: song.id,
        choiceSongName: song.name,
        hintText: '选择版本 · 确认开始'
      })
      return
    }
    const navIndex = index - this.data.songCount
    const nav = navIndex >= 0 ? this.data.navItems[navIndex] : null
    if (nav) wx.navigateTo({ url: nav.url })
  },

  async confirmChoice() {
    if (this.choosing) return
    const option = this.data.choiceOptions[this.data.choiceIndex]
    const song = this.data.songs.find(item => item.id === this.data.choiceSongId)
    if (!option || !song) return

    this.choosing = true
    try {
      if (option.value === 'withMusic' && song.online && !song.cached && !song.downloaded) {
        this.setData({ hintText: '正在准备 ' + song.name })
        await prepareSongDownload(song.id)
        if (this.unloaded) return
        this.setData({
          songs: this.data.songs.map(item => item.id === song.id ? { ...item, cached: true } : item)
        })
      }
      if (this.unloaded) return
      this.setData({ choiceVisible: false, hintText: '上下选择 · 确认' })
      wx.navigateTo({
        url: '/pages/record/record?songId=' + encodeURIComponent(song.id) + '&mode=' + option.value
      })
    } catch (error) {
      console.error('prepare song version failed', error)
      if (!this.unloaded) this.setData({ hintText: '准备失败 · 再确认重试' })
    } finally {
      this.choosing = false
    }
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="title">K 歌</text>
    </view>

    <scroll-view class="song-list" scroll-y="{{true}}" scroll-into-view="song-item-{{selectedIdx}}">
      <view
        id="song-item-{{index}}"
        class="song-item"
        ink:for="{{songs}}"
        ink:key="id"
        bindtap="onTapSong"
        data-idx="{{index}}"
      >
        <view class="song-marker">
          <view class="song-dot" ink:if="{{selectedIdx === index}}"></view>
        </view>
        <view class="song-info">
          <text class="song-name">{{item.name}}</text>
          <text class="song-artist">{{item.artist}}</text>
        </view>
        <text class="song-badge" ink:if="{{item.online}}">{{item.cached ? '已缓存' : '在线'}}</text>
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
          <view class="nav-dot" ink:if="{{selectedIdx === songCount + index}}"></view>
        </view>
        <text class="nav-label">{{item.label}}</text>
      </view>
    </view>

    <view class="hintbar">
      <text class="hint-text">{{hintText}}</text>
    </view>

    <view class="choice-mask" ink:if="{{choiceVisible}}">
      <view class="choice-panel">
        <text class="choice-title">{{choiceSongName}}</text>
        <text class="choice-sub">选择演唱版本</text>
        <view
          class="choice-option {{choiceIndex === index ? 'choice-active' : ''}}"
          ink:for="{{choiceOptions}}"
          ink:key="value"
          bindtap="onTapChoice"
          data-idx="{{index}}"
        >
          <view class="choice-copy">
            <text class="choice-label">{{item.label}}</text>
            <text class="choice-desc">{{item.desc}}</text>
          </view>
          <view class="choice-dot" ink:if="{{choiceIndex === index}}"></view>
        </view>
        <view class="choice-confirm" bindtap="confirmChoice">
          <text class="choice-confirm-text">确认开始</text>
        </view>
        <text class="choice-hint">上下选择 · 确认开始 · 返回</text>
      </view>
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
  --green-06: rgba(64,255,94,0.06);
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

.topbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(64,255,94,0.40);
}

.title {
  font-size: 20px;
  font-weight: bold;
  color: var(--green-100);
}

.song-list {
  display: flex;
  flex-direction: column;
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

.choice-mask {
  display: flex;
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  background-color: rgba(0,0,0,0.86);
  z-index: 10;
}

.choice-panel {
  display: flex;
  flex-direction: column;
  width: 360px;
  padding: 14px;
  background-color: #050805;
  border: 1px solid var(--green-48);
}

.choice-title {
  font-size: 19px;
  font-weight: bold;
  color: var(--green-100);
}

.choice-sub {
  font-size: 11px;
  color: var(--green-48);
  margin: 2px 0 10px;
}

.choice-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 52px;
  margin-bottom: 6px;
  padding: 0 10px;
  border: 1px solid var(--green-24);
}

.choice-active {
  border-color: var(--green-100);
  background-color: var(--green-12);
}

.choice-copy {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
}

.choice-label {
  font-size: 15px;
  color: var(--green-100);
}

.choice-desc {
  font-size: 10px;
  color: var(--green-48);
}

.choice-dot {
  width: 7px;
  height: 7px;
  background-color: var(--green-100);
}

.choice-confirm {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  margin-top: 2px;
  background-color: var(--green-72);
}

.choice-confirm-text {
  font-size: 15px;
  font-weight: bold;
  color: #041006;
}

.choice-hint {
  font-size: 10px;
  color: var(--green-24);
  text-align: center;
  margin-top: 6px;
}
</style>
