<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import { getLeaderboard, isServerConnected } from '../../utils/leaderboard.js'
import { songs } from '../../utils/songData.js'
import { loadSongCatalog } from '../../utils/songLibrary.js'

const CATEGORY_OPTIONS = [
  { key: '中文', label: '中文' },
  { key: '英文', label: '英文' },
  { key: '日语', label: '日语' },
  { key: '韩语', label: '韩语' }
]
const SONG_TAB_WIDTH = 104
const SONG_TAB_NAME_WIDTH = 84
const SONG_TAB_GAP = 6
const SONG_VIEW_WIDTH = 432
const NAVIGATION_REPEAT_MS = 250
const SONG_NAME_SCROLL_SPEED = 26
const SONG_NAME_MOVING_FRACTION = 0.64
let songNameMeasureContext

function measureSongName(name, bold) {
  if (songNameMeasureContext === undefined) {
    songNameMeasureContext = null
    if (typeof Canvas === 'function') {
      try {
        songNameMeasureContext = new Canvas(1, 1).getContext('2d')
      } catch (error) {
        console.warn('歌名测宽不可用', error)
      }
    }
  }
  if (songNameMeasureContext) {
    try {
      songNameMeasureContext.font = (bold ? 'bold ' : '') + '13px sans-serif'
      const width = songNameMeasureContext.measureText(name).width
      if (Number.isFinite(width) && (width > 0 || !name)) return width
    } catch (error) {
      console.warn('歌名测宽失败', error)
      songNameMeasureContext = null
    }
  }
  let width = 0
  for (const char of name) {
    if (/[\u0300-\u036f]/.test(char)) continue
    if (/[\s.,\u0027ilI!|]/.test(char)) width += 4
    else if (/[MWmw@%]/.test(char)) width += 11
    else width += char.codePointAt(0) <= 0x024f ? 8 : 13
  }
  return width
}

function songNameScrollStyle(name, bold) {
  const measuredWidth = measureSongName(name, bold)
  if (measuredWidth <= SONG_TAB_NAME_WIDTH) return ''
  const width = Math.ceil(measuredWidth) + 2
  const distance = width - SONG_TAB_NAME_WIDTH
  const duration = Math.max(3200, Math.round(1000 * distance / (SONG_NAME_SCROLL_SPEED * SONG_NAME_MOVING_FRACTION)))
  return 'width: ' + width + 'px; --song-name-end: -' + distance + 'px; animation-duration: ' + duration + 'ms;'
}

function categoryForSong(song) {
  const category = String(song?.category || '').trim()
  if (category === '中文' || category === 'Chinese') return '中文'
  if (category === 'English' || category === '英文' || category === '英语') return '英文'
  if (category === '日本語' || category === '日语' || category === 'Japanese') return '日语'
  if (category === '한국어' || category === '韩语' || category === 'Korean') return '韩语'
  return ''
}

function navigationTime(event) {
  return Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now()
}

export default {
  data: {
    categories: CATEGORY_OPTIONS,
    categoryIndex: 0,
    activeCategoryKey: '',
    activeCategoryLabel: '',
    songs: [],
    songCount: 0,
    songIndex: 0,
    songScrollLeft: 0,
    focus: 'categories',
    selectedIdx: 0,
    activeSongName: '',
    emptyTitle: '',
    phase: 'loading',
    entries: [],
    sourceLabel: '',
    errorMsg: '',
    hintText: '上下选择分类 · 确认进入'
  },

  onLoad() {
    this.requestId = 0
    this.initialize()
  },

  async initialize() {
    try {
      const result = await loadSongCatalog()
      if (this.unloaded) return
      this.allSongs = result.songs
      this.setData({
        phase: 'categories',
        focus: 'categories',
        hintText: '上下选择分类 · 确认进入'
      })
    } catch (e) {
      console.error('load catalog error', e)
      if (!this.unloaded) this.setData({ phase: 'error', errorMsg: '曲库加载失败' })
    }
  },

  onShow() {
    const phase = this.data.phase
    if (this.data.focus !== 'categories' && this.data.songCount &&
        (phase === 'display' || phase === 'empty' || phase === 'error')) {
      this.loadLeaderboard(this.data.songIndex, true)
    }
  },

  onKeyUp(event) {
    const code = event.code
    if (code === 'Backspace' && this.data.focus === 'entries') {
      event.preventDefault()
      this.lastSongNav = null
      this.setData({ focus: 'songs', hintText: '左右滑动切歌 · 确认查看 · 返回分类' })
      return
    }
    if (code === 'Backspace' && this.data.focus === 'songs') {
      event.preventDefault()
      this.setData({
        focus: 'categories',
        phase: 'categories',
        activeCategoryKey: '',
        activeCategoryLabel: '',
        songs: [],
        songCount: 0,
        songIndex: 0,
        songScrollLeft: 0,
        selectedIdx: 0,
        entries: [],
        sourceLabel: '',
        hintText: '上下选择分类 · 确认进入'
      })
      return
    }

    const previous = code === 'ArrowUp' || code === 'ArrowLeft'
    const next = code === 'ArrowDown' || code === 'ArrowRight'
    if (!previous && !next && code !== 'Enter') return

    if (this.data.focus === 'categories') {
      event.preventDefault()
      if (code === 'Enter') {
        this.selectCategory()
      } else {
        const offset = previous ? -1 : 1
        this.stepCategory(offset, event)
      }
      return
    }

    if (!this.data.songCount) return
    event.preventDefault()
    if (code === 'Enter') {
      if (this.data.focus === 'songs') {
        this.setData({ focus: 'entries', hintText: '上下浏览 · 确认刷新 · 返回歌曲栏' })
        if (this.data.phase === 'error') this.loadLeaderboard(this.data.songIndex)
      } else {
        this.loadLeaderboard(this.data.songIndex)
      }
      return
    }

    const offset = previous ? -1 : 1
    if (this.data.focus === 'entries') {
      const selectedIdx = Math.max(0, Math.min(this.data.entries.length - 1, this.data.selectedIdx + offset))
      this.setData({ selectedIdx })
      return
    }
    this.stepSong(offset, event)
  },

  stepCategory(offset, event) {
    const stamp = navigationTime(event)
    if (stamp - (this.lastCategoryNavAt ?? -Infinity) < NAVIGATION_REPEAT_MS) return
    this.lastCategoryNavAt = stamp
    const count = this.data.categories.length
    this.setData({ categoryIndex: (this.data.categoryIndex + offset + count) % count })
  },

  stepSong(offset, event) {
    const stamp = navigationTime(event)
    const last = this.lastSongNav
    // 同一方向可能收到两种键码，按移动方向合并重复事件。
    if (last?.offset === offset && stamp - last.stamp < NAVIGATION_REPEAT_MS) return
    this.lastSongNav = { offset, stamp }
    const { songIndex, songCount } = this.data
    this.loadLeaderboard((songIndex + offset + songCount) % songCount)
  },

  selectCategory() {
    this.lastSongNav = null
    const category = this.data.categories[this.data.categoryIndex]
    const categorySongs = (this.allSongs || [])
      .filter(song => categoryForSong(song) === category.key)
      .map(song => ({
        id: song.id,
        name: song.name,
        nameScrollStyle: songNameScrollStyle(song.name, false),
        activeNameScrollStyle: songNameScrollStyle(song.name, true)
      }))
    if (!categorySongs.length) {
      this.setData({
        focus: 'songs',
        phase: 'empty',
        activeCategoryKey: category.key,
        activeCategoryLabel: category.label,
        songs: [],
        songCount: 0,
        songIndex: 0,
        selectedIdx: 0,
        activeSongName: '',
        emptyTitle: category.label + ' · 暂无歌曲',
        entries: [],
        sourceLabel: '',
        hintText: '该分类暂无歌曲 · 返回分类'
      })
      return
    }
    this.setData({
      focus: 'songs',
      activeCategoryKey: category.key,
      activeCategoryLabel: category.label,
      songs: categorySongs,
      songCount: categorySongs.length,
      songIndex: 0,
      songScrollLeft: 0,
      selectedIdx: 0,
      activeSongName: categorySongs[0].name,
      emptyTitle: categorySongs[0].name + ' · 暂无成绩',
      phase: 'loading',
      entries: [],
      sourceLabel: '',
      hintText: '左右滑动切歌 · 确认查看 · 返回分类'
    })
    this.loadLeaderboard(0)
  },

  onTapCategory(event) {
    this.setData({ categoryIndex: Number(event.currentTarget.dataset.idx) })
    this.selectCategory()
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
      this.setData({
        songIndex: index,
        songScrollLeft: this.songScrollOffset(index),
        activeSongName: song.name
      })
    } else {
      this.setData({
        songIndex: index,
        songScrollLeft: this.songScrollOffset(index),
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
        emptyTitle: song.name + ' · 暂无成绩',
        entries,
        selectedIdx: Math.max(0, Math.min(this.data.selectedIdx, entries.length - 1)),
        sourceLabel,
        hintText: this.data.focus === 'entries'
          ? '上下浏览 · 确认刷新 · 返回歌曲栏'
          : '左右滑动切歌 · 确认查看 · 返回分类'
      })
    } catch (e) {
      if (this.unloaded || requestId !== this.requestId) return
      console.error('leaderboard load error', e, e && e.message)
      this.setData({
        phase: 'error',
        errorMsg: '加载失败',
        hintText: '确认重试 · 返回分类'
      })
    }
  },

  songScrollOffset(index) {
    const centered = index * (SONG_TAB_WIDTH + SONG_TAB_GAP) -
      (SONG_VIEW_WIDTH - SONG_TAB_WIDTH) / 2
    return Math.max(0, Math.round(centered))
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="title">排行榜</text>
      <text class="page-indicator" ink:if="{{focus === 'categories'}}">{{categoryIndex + 1}} / {{categories.length}}</text>
      <text class="page-indicator" ink:elif="{{songCount}}">{{songIndex + 1}} / {{songCount}}</text>
    </view>

    <scroll-view class="category-tabs" ink:if="{{focus === 'categories'}}">
      <view class="category-tabs-inner">
        <view
          class="category-tab {{categoryIndex === 0 ? 'category-tab-active' : ''}}"
          bindtap="onTapCategory"
          data-idx="0"
        >
          <text class="category-tab-name">中文</text>
        </view>
        <view
          class="category-tab {{categoryIndex === 1 ? 'category-tab-active' : ''}}"
          bindtap="onTapCategory"
          data-idx="1"
        >
          <text class="category-tab-name">英文</text>
        </view>
        <view
          class="category-tab {{categoryIndex === 2 ? 'category-tab-active' : ''}}"
          bindtap="onTapCategory"
          data-idx="2"
        >
          <text class="category-tab-name">日语</text>
        </view>
        <view
          class="category-tab {{categoryIndex === 3 ? 'category-tab-active' : ''}}"
          bindtap="onTapCategory"
          data-idx="3"
        >
          <text class="category-tab-name">韩语</text>
        </view>
      </view>
    </scroll-view>

    <scroll-view
      class="song-tabs"
      scroll-x="{{true}}"
      scroll-with-animation="{{true}}"
      scroll-left="{{songScrollLeft}}"
      ink:if="{{focus !== 'categories' && songCount}}"
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
          <view class="song-tab-name-window">
            <text
              class="song-tab-name {{songIndex === index ? 'song-tab-name-active' : ''}} {{(songIndex === index ? item.activeNameScrollStyle : item.nameScrollStyle) ? 'song-tab-name-scroll' : ''}}"
              style="{{songIndex === index ? item.activeNameScrollStyle : item.nameScrollStyle}}"
            >{{item.name}}</text>
          </view>
        </view>
      </view>
    </scroll-view>

    <view class="source-bar" ink:if="{{sourceLabel}}">
      <text class="source-text">{{sourceLabel}}</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'categories'}}">
      <text class="empty-text">选择榜单分类</text>
      <text class="empty-sub">中文 · 英文 · 日语 · 韩语</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'loading'}}">
      <text class="loading-text">加载中</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'error'}}">
      <text class="error-text">{{errorMsg}}</text>
      <text class="error-sub">确认重试</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'empty'}}">
      <text class="empty-text">{{emptyTitle}}</text>
      <text class="empty-sub">{{focus === 'songs' ? '返回分类可查看其他榜单' : '返回歌曲栏可切换歌曲'}}</text>
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
  --green-100: #4cc773;
  --green-72: rgba(76,199,115,0.72);
  --green-48: rgba(76,199,115,0.48);
  --green-24: rgba(76,199,115,0.24);
  --green-12: rgba(76,199,115,0.12);
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

.category-tabs {
  height: 50px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--green-24);
}

.category-tabs-inner {
  display: flex;
  flex-direction: row;
  box-sizing: border-box;
  height: 50px;
  padding: 4px 8px 10px;
}

.category-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  margin-right: 6px;
  border: 1px solid var(--green-24);
  border-radius: 4px;
  background-color: transparent;
  transition: border-color 140ms ease-out;
}

.category-tab:last-child {
  margin-right: 0;
}

.category-tab-active,
.category-tab:active {
  border-color: var(--green-100);
}

.category-tab-name {
  font-size: 14px;
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
  box-sizing: border-box;
  height: 31px;
  width: 104px;
  min-width: 104px;
  padding: 0 10px;
  margin-right: 6px;
  flex-shrink: 0;
  border-bottom: 2px solid transparent;
}

.song-tab-active {
  background-color: var(--green-12);
  border-bottom: 2px solid var(--green-100);
}

.song-tab-name-window {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 84px;
  height: 29px;
  overflow: hidden;
}

.song-tab-name {
  font-family: sans-serif;
  font-size: 13px;
  color: var(--green-48);
  text-align: center;
  white-space: nowrap;
}

.song-tab-name-active {
  color: var(--green-100);
  font-weight: bold;
}

.song-tab-name-scroll {
  text-align: left;
  animation-name: song-name-scroll;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

@keyframes song-name-scroll {
  0%, 18% { transform: translateX(0px); }
  82%, 100% { transform: translateX(var(--song-name-end)); }
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
