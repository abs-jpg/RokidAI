<script setup>
import wx from 'wx'
import { MusicDownload } from '../../utils/musicDownload.js'
import { clearDownloadInputPage, setDownloadInputPage } from '../../utils/downloadReturn.js'

export default {
  data: {
    phase: 'categories',
    title: '音乐下载',
    categories: [],
    songs: [],
    addingMusic: false,
    selectedIdx: -1,
    scrollTop: 0,
    catalogLoading: true,
    catalogConnected: false,
    requestText: '',
    requestPhase: 'idle'
  },

  onLoad(query) {
    this.download = new MusicDownload(this)
    this.download.start(query?.category, query?.song)
  },

  onShow() {
    this.navigating = false
    setDownloadInputPage(this.download)
  },

  onHide() {
    clearDownloadInputPage(this.download)
    this.download?.clearTempleTaps()
  },

  onUnload() {
    clearDownloadInputPage(this.download)
    this.download?.dispose()
  },

  onKeyDown(event) {
    this.download?.handleInput(event, true)
  },

  onKeyUp(event) {
    this.download?.handleInput(event, false)
  },

  openCategory(key, songId) {
    if (this.navigating) return
    this.navigating = true
    const song = songId ? '&song=' + encodeURIComponent(songId) : ''
    wx.navigateTo({
      url: '/pages/download/download?category=' + encodeURIComponent(key) + song,
      fail: () => { this.navigating = false }
    })
  },

  goBack() {
    if (this.navigating) return
    this.navigating = true
    wx.navigateBack({ fail: () => { this.navigating = false } })
  },

  onTapDownloadCategory(event) {
    this.download.onTapCategory(event)
  },

  onTapDownloadSong(event) {
    this.download.onTapSong(event)
  },

  onDownloadRequestRecord() {
    this.download.onRequestRecord()
  },

  onDownloadRequestSend() {
    this.download.onRequestSend()
  }
}
</script>

<page>
  <view class="download-panel">
    <view class="download-topbar">
      <text class="download-title">{{title}}</text>
      <text class="download-count" ink:if="{{phase === 'songs'}}">{{downloadLabel}}</text>
    </view>

    <view class="download-category-bar" ink:if="{{phase === 'categories'}}">
      <view
        class="download-category-tab {{categoryIndex === index ? 'download-tab-active' : ''}}"
        ink:for="{{categories}}"
        ink:key="key"
        id="download-category-{{item.key}}"
        bindtap="onTapDownloadCategory"
        data-value="{{item.key}}"
      >
        <text class="download-category-tab-label">{{item.label}}</text>
        <text class="download-category-count" ink:if="{{item.countLabel}}">{{item.countLabel}}</text>
      </view>
    </view>

    <view class="download-request-entry" ink:if="{{phase === 'categories' && addingMusic}}">
      <text class="download-state-text">单击后可录制想添加的歌曲</text>
    </view>

    <view class="download-request-panel" ink:if="{{phase === 'request'}}">
      <text class="download-request-intro">自建demo曲库音乐有限，如果有想添加的请留言。</text>
      <scroll-view class="download-request-preview" scroll-y="{{true}}">
        <text class="download-request-text">{{requestText || '录制留言后，识别出的文字会显示在这里'}}</text>
      </scroll-view>
      <text class="download-request-message">{{requestMessage}}</text>
      <view class="download-request-actions">
        <view class="download-request-btn {{requestAction === 0 ? 'download-request-btn-active' : ''}}" bindtap="onDownloadRequestRecord">
          <text class="download-request-btn-label">{{requestPhase === 'listening' ? '结束录音' : (requestPhase === 'ready' ? '重录' : '录制留言')}}</text>
        </view>
        <view class="download-request-btn {{requestPhase === 'ready' ? (requestAction === 1 ? 'download-request-btn-active' : '') : 'download-request-btn-disabled'}}" bindtap="onDownloadRequestSend">
          <text class="download-request-btn-label">发送留言</text>
        </view>
      </view>
    </view>

    <scroll-view
      class="download-song-list"
      scroll-y="{{true}}"
      scroll-top="{{scrollTop}}"
      ink:if="{{phase === 'songs' || (phase === 'categories' && !addingMusic)}}"
    >
      <view
        class="download-song-row {{phase === 'songs' && selectedIdx === index ? 'download-row-active' : ''}}"
        ink:for="{{songs}}"
        ink:key="id"
        id="download-song-{{item.id}}"
        bindtap="onTapDownloadSong"
        data-value="{{item.id}}"
      >
        <view class="download-song-marker">
          <view class="download-song-dot {{phase === 'songs' && selectedIdx === index ? 'download-dot-on' : ''}}"></view>
        </view>
        <view class="download-song-info">
          <text class="download-song-name">{{item.name}}</text>
          <text class="download-song-artist">{{item.artist}}</text>
        </view>
        <text class="download-song-badge">{{item.bundled ? '内置' : (item.downloaded ? '本机已下载' : (catalogConnected ? '可下载' : '联网下载'))}}</text>
      </view>
      <view class="download-empty-area" ink:if="{{songs.length === 0}}">
        <text class="download-state-text">{{catalogLoading ? '正在加载曲库…' : (catalogConnected ? '该语种暂无歌曲' : (phase === 'songs' ? '曲库连接失败 · 单击重试' : '曲库暂时无法连接'))}}</text>
      </view>
    </scroll-view>

    <view class="download-progress-track" ink:if="{{phase === 'songs' && downloadProgress > 0}}">
      <view class="download-progress-fill" style="width: {{downloadProgress}}%;"></view>
    </view>

    <view class="download-message-bar" ink:if="{{phase === 'songs' && songs.length > 0 && message}}">
      <text class="download-message-text">{{message}}</text>
    </view>
    <view class="download-hintbar">
      <text class="download-hint-text" ink:if="{{hintText}}">{{hintText}}</text>
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

.download-panel {
  display: flex;
  flex-direction: column;
  width: 448px;
  max-width: calc(100vw - 32px);
  height: 328px;
  margin: 12px 16px;
}

.download-topbar {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid rgba(76,199,115,0.40);
}

.download-title {
  font-size: 20px;
  font-weight: bold;
  color: var(--green-100);
}

.download-count {
  font-size: 14px;
  color: var(--green-72);
}

.download-state-text {
  font-size: 15px;
  color: var(--green-72);
}

.download-song-list {
  flex: 1 1 auto;
  min-height: 0;
  padding: 6px 12px 0;
  overflow: hidden;
}

.download-song-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  flex-shrink: 0;
  padding: 0 8px;
  margin-bottom: 2px;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 0;
  background-color: transparent;
}

.download-row-active {
  background-color: var(--green-12);
  border-left-color: var(--green-100);
}

.download-song-marker {
  width: 16px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.download-song-dot {
  width: 6px;
  height: 6px;
  background-color: var(--green-100);
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 190ms ease, transform 190ms ease;
}

.download-song-dot.download-dot-on {
  opacity: 1;
  transform: scale(1);
}

.download-song-info {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  margin-left: 6px;
}

.download-song-name {
  font-size: 17px;
  line-height: 19px;
  color: var(--green-72);
}

.download-row-active .download-song-name {
  color: var(--green-100);
  font-weight: bold;
}

.download-song-artist {
  font-size: 12px;
  line-height: 14px;
  color: var(--green-72);
}

.download-song-name, .download-song-artist, .download-message-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.download-song-badge {
  font-size: 12px;
  color: var(--green-72);
  border: 1px solid var(--green-24);
  padding: 2px 6px;
  flex-shrink: 0;
}

.download-empty-area {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
}

.download-category-bar {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-shrink: 0;
  height: 74px;
  padding: 0 10px;
}

.download-progress-track {
  height: 3px;
  flex-shrink: 0;
  background-color: var(--green-12);
}

.download-progress-fill {
  height: 100%;
  background-color: var(--green-72);
}

.download-category-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  height: 48px;
  box-sizing: border-box;
  margin: 0 2px;
  border: 1px solid var(--green-24);
}

.download-category-tab-label {
  font-size: 15px;
  color: var(--green-72);
}

.download-category-count {
  margin-top: 2px;
  font-size: 12px;
  color: var(--green-72);
}

.download-tab-active {
  background-color: var(--green-12);
  border-bottom-color: var(--green-100);
}

.download-tab-active .download-category-tab-label {
  color: var(--green-100);
  font-weight: bold;
}

.download-request-entry {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
}

.download-request-panel {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  padding: 16px 12px 8px;
}

.download-request-intro {
  font-size: 15px;
  color: rgba(76,199,115,0.84);
  line-height: 20px;
  flex-shrink: 0;
}

.download-request-preview {
  flex: 1 1 auto;
  overflow: hidden;
  min-height: 0;
  margin-top: 12px;
  padding: 9px 10px;
  border: 1px solid rgba(76,199,115,0.24);
}

.download-request-text {
  width: 100%;
  font-size: 14px;
  line-height: 19px;
  color: #4cc773;
}

.download-request-message {
  height: 24px;
  flex-shrink: 0;
  margin-top: 5px;
  font-size: 12px;
  line-height: 24px;
  color: rgba(76,199,115,0.80);
}

.download-request-actions {
  display: flex;
  flex-direction: row;
  height: 42px;
  flex-shrink: 0;
}

.download-request-btn {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  border-radius: 0;
  padding: 0;
  margin: 0 4px;
  border: 1px solid rgba(76,199,115,0.40);
}

.download-request-btn-active {
  background-color: rgba(76,199,115,0.12);
  border-color: #4cc773;
}

.download-request-btn-label {
  font-size: 14px;
  color: #4cc773;
}

.download-request-btn-disabled .download-request-btn-label {
  color: rgba(76,199,115,0.32);
}

.download-message-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  flex-shrink: 0;
}

.download-message-text {
  font-size: 13px;
  color: var(--green-72);
}

.download-hintbar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  flex-shrink: 0;
  border-top: 1px solid var(--green-24);
}

.download-hint-text {
  font-size: 14px;
  color: var(--green-72);
}

@media (max-height: 200px) {
  .download-panel {
    height: 100vh;
    margin: 0 16px;
  }

  .download-topbar { height: 26px; }
  .download-title { font-size: 17px; }
  .download-category-bar { height: 32px; }
  .download-category-tab { height: 30px; }
  .download-category-tab-label { font-size: 13px; }
  .download-category-count { font-size: 10px; }
  .download-song-list { padding-top: 2px; }
  .download-song-artist { display: none; }
  .download-empty-area { height: 38px; }
  .download-hintbar { height: 20px; }
  .download-hint-text { font-size: 11px; }
  .download-request-panel { padding: 4px 12px; }
  .download-request-preview { margin-top: 4px; padding: 2px 6px; }
  .download-request-actions { height: 28px; }
  .download-request-message { height: 16px; line-height: 16px; margin-top: 0; }
}

</style>
