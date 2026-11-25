<script setup>
import wx from 'wx'
import { songs } from '../../utils/songData.js'
import { isServerConnected } from '../../utils/leaderboard.js'
import { loadSongCatalog, preloadSongAudio } from '../../utils/songLibrary.js'
import { isDownloadReturnEcho, takeDownloadInput } from '../../utils/downloadReturn.js'

const ROW_HEIGHT = 58
const DOWNLOAD_PAGE = '/pages/download/download'

function navItems(connected) {
  return [
    { label: connected ? '排行榜' : '本机排行榜', url: '/pages/leaderboard/leaderboard' },
    { label: '多人联机', url: '/pages/battle/battle' },
    { label: '音乐下载', url: DOWNLOAD_PAGE }
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
    choiceVisible: false,
    choiceIndex: 0,
    choiceAvailable: [false, false],
    choiceSongId: '',
    choiceSongName: '',
    defaultAudioReady: false,
    choiceOptions: [
      { value: 'guide', label: '带歌词版', desc: '伴奏与跟唱引导' },
      { value: 'instrumental', label: '纯音乐版', desc: '纯伴奏 · 自己唱' }
    ]
  },

  onLoad() {
    this.prewarmDefaultAudio()
  },

  onShow() {
    this.refreshCatalog()
  },

  onUnload() {
    this.unloaded = true
  },

  async refreshCatalog() {
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      const playable = result.songs.filter(song => availableVersions(song).some(Boolean))
      const songCount = playable.length
      const selectedIdx = songCount
        ? Math.max(0, Math.min(this.data.selectedIdx, songCount - 1))
        : 0
      const patch = {
        songs: playable,
        songCount,
        selectedIdx,
        scrollTop: selectedIdx * ROW_HEIGHT,
        navItems: navItems(result.connected || isServerConnected())
      }
      if (this.data.choiceVisible) {
        const choiceAvailable = availableVersions(playable.find(song => song.id === this.data.choiceSongId))
        if (choiceAvailable.some(Boolean)) {
          patch.choiceAvailable = choiceAvailable
          if (!choiceAvailable[this.data.choiceIndex]) patch.choiceIndex = choiceAvailable.indexOf(true)
        } else {
          patch.choiceVisible = false
          patch.hintText = '音频还未下载 · 上下选择'
        }
      }
      this.setData(patch)
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
      defaultAudioReady: ready,
      hintText: ready ? '默认伴奏已就绪 · 上下选择 · 确认' : '默认伴奏预热失败 · 可在真机重试'
    })
  },

  onKeyUp(event) {
    if (isDownloadReturnEcho(event)) {
      takeDownloadInput(event)
      return
    }
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
        this.selectChoice((this.data.choiceIndex + offset + count) % count)
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

  onTapChoice(event) {
    this.selectChoice(Number(event.currentTarget.dataset.idx))
  },

  selectChoice(index) {
    if (this.data.choiceAvailable[index]) this.setData({ choiceIndex: index })
  },

  async activate(index) {
    const song = this.data.songs[index]
    if (song) {
      const choiceAvailable = availableVersions(song)
      this.setData({
        selectedIdx: index,
        choiceVisible: true,
        choiceAvailable,
        choiceIndex: choiceAvailable.indexOf(true),
        choiceSongId: song.id,
        choiceSongName: song.name,
        hintText: '选择版本 · 确认开始'
      })
      return
    }
    const navIndex = index - this.data.songCount
    const nav = navIndex >= 0 ? this.data.navItems[navIndex] : null
    if (!nav) return
    wx.navigateTo({
      url: nav.url,
      success: () => {
        if (nav.url === DOWNLOAD_PAGE) this.setData({ selectedIdx: 0, scrollTop: 0 })
      }
    })
  },

  async confirmChoice() {
    if (this.choosing || !this.data.choiceAvailable[this.data.choiceIndex]) return
    const option = this.data.choiceOptions[this.data.choiceIndex]
    const song = this.data.songs.find(item => item.id === this.data.choiceSongId)
    if (!option || !song) return

    this.choosing = true
    try {
      if (song.bundled && !this.data.defaultAudioReady) {
        this.setData({ hintText: '正在预热默认伴奏' })
        await this.prewarmDefaultAudio()
        if (this.unloaded) return
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
    <view class="main-view" ink:if="{{!choiceVisible}}">
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
      <text class="hint-text">{{hintText}}</text>
    </view>
    </view>

    <view class="choice-mask" ink:if="{{choiceVisible}}">
      <view class="choice-panel">
        <view class="choice-header">
          <text class="choice-sub">选择演唱版本</text>
          <text class="choice-title">{{choiceSongName}}</text>
        </view>
        <view class="choice-options">
          <view
            class="choice-option choice-option-first {{choiceIndex === 0 ? 'choice-active' : ''}} {{choiceAvailable[0] ? '' : 'choice-disabled'}}"
            bindtap="onTapChoice"
            data-idx="0"
          >
            <view class="choice-radio"><view class="choice-radio-dot" ink:if="{{choiceIndex === 0}}"></view></view>
            <view class="choice-copy">
              <text class="choice-label">带歌词版</text>
              <text class="choice-desc">{{choiceAvailable[0] ? choiceOptions[0].desc : '还未下载此音频'}}</text>
            </view>
            <text class="choice-selected" ink:if="{{choiceIndex === 0}}">已选</text>
          </view>
          <view
            class="choice-option {{choiceIndex === 1 ? 'choice-active' : ''}} {{choiceAvailable[1] ? '' : 'choice-disabled'}}"
            bindtap="onTapChoice"
            data-idx="1"
          >
            <view class="choice-radio"><view class="choice-radio-dot" ink:if="{{choiceIndex === 1}}"></view></view>
            <view class="choice-copy">
              <text class="choice-label">纯音乐版</text>
              <text class="choice-desc">{{choiceAvailable[1] ? choiceOptions[1].desc : '还未下载此音频'}}</text>
            </view>
            <text class="choice-selected" ink:if="{{choiceIndex === 1}}">已选</text>
          </view>
        </view>
        <view class="choice-footer">
          <text class="choice-hint">上下切换 · 返回</text>
          <view class="choice-confirm" bindtap="confirmChoice">
            <text class="choice-confirm-text">确认开始 ›</text>
          </view>
        </view>
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

.choice-mask {
  display: flex;
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  max-width: calc(100vw - 32px);
  height: 100%;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  z-index: 10;
}

.choice-panel {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0 12px;
}

.choice-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 86px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--green-24);
}

.choice-title {
  max-width: 100%;
  font-size: 24px;
  font-weight: bold;
  color: var(--green-100);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.choice-sub {
  font-size: 14px;
  color: var(--green-72);
  margin-bottom: 6px;
  flex-shrink: 0;
}

.choice-options {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  justify-content: center;
}

.choice-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  box-sizing: border-box;
  height: 72px;
  flex-shrink: 0;
  padding: 0 16px;
  border: 2px solid var(--green-24);
  border-radius: 8px;
  background-color: transparent;
}

.choice-option-first {
  margin-bottom: 12px;
}

.choice-active {
  border-color: var(--green-100);
  background-color: var(--green-12);
}

.choice-disabled {
  border-color: var(--green-12);
}

.choice-disabled .choice-label, .choice-disabled .choice-desc, .choice-disabled .choice-radio {
  opacity: 0.6;
}

.choice-radio {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  margin-right: 12px;
  flex-shrink: 0;
  border: 1px solid var(--green-48);
  border-radius: 9px;
}

.choice-active .choice-radio {
  border-color: var(--green-100);
}

.choice-radio-dot {
  width: 8px;
  height: 8px;
  border-radius: 4px;
  background-color: var(--green-100);
}

.choice-copy {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}

.choice-label {
  font-size: 20px;
  font-weight: bold;
  color: var(--green-72);
}

.choice-desc {
  margin-top: 4px;
  font-size: 14px;
  color: var(--green-72);
}

.choice-active .choice-label, .choice-selected {
  color: var(--green-100);
}

.choice-active .choice-desc {
  color: var(--green-72);
}

.choice-selected {
  flex-shrink: 0;
  margin-left: 8px;
  font-size: 12px;
  font-weight: bold;
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

.choice-footer {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  height: 58px;
  flex-shrink: 0;
  border-top: 1px solid var(--green-24);
}

.choice-confirm {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 136px;
  height: 40px;
  background-color: var(--green-12);
  border: 1px solid var(--green-72);
  border-radius: 6px;
}

.choice-confirm-text {
  font-size: 17px;
  font-weight: bold;
  color: var(--green-100);
}

.choice-hint {
  font-size: 14px;
  color: var(--green-72);
}

@media (max-height: 200px) {
  .choice-mask {
    height: calc(100vh - 24px);
  }

  .choice-header {
    flex-direction: row;
    justify-content: flex-start;
    height: 32px;
  }

  .choice-sub {
    margin: 0 10px 0 0;
    font-size: 12px;
  }

  .choice-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 16px;
  }

  .choice-options {
    flex-direction: row;
    align-items: center;
  }

  .choice-option {
    flex: 1 1 0;
    height: 46px;
    padding: 0 8px;
  }

  .choice-option-first {
    margin: 0 8px 0 0;
  }

  .choice-radio {
    margin-right: 8px;
  }

  .choice-label {
    font-size: 16px;
  }

  .choice-desc {
    margin-top: 2px;
    font-size: 12px;
  }

  .choice-footer {
    height: 33px;
  }

  .choice-confirm {
    width: 104px;
    height: 28px;
  }

  .choice-hint, .choice-confirm-text {
    font-size: 13px;
  }
}

</style>
