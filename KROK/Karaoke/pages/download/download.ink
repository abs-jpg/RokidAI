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
    choiceVisible: false,
    choiceDownloading: false,
    requestText: '',
    requestPhase: 'idle'
  },

  onLoad(query) {
    this.download = new MusicDownload(this)
    this.download.start(query?.category, query?.song)
  },

  onShow() {
    const returning = this.navigating
    this.navigating = false
    setDownloadInputPage(this.download)
    if (returning) this.download.refreshCatalog()
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

  onTapDownloadChoice(event) {
    this.download.selectChoice(Number(event.currentTarget.dataset.idx))
  },

  onConfirmDownload() {
    this.download.downloadSelected()
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
    <view class="choice-panel" ink:if="{{choiceVisible}}">
      <view class="choice-header">
        <text class="choice-sub">选择下载版本</text>
        <text class="choice-title">{{choiceSongName}}</text>
      </view>

      <view class="choice-options">
        <view class="choice-option choice-option-first {{choiceIndex === 0 ? 'choice-active' : ''}}" bindtap="onTapDownloadChoice" data-idx="0">
          <view class="choice-radio"><view class="choice-radio-dot" ink:if="{{choiceIndex === 0}}"></view></view>
          <view class="choice-copy">
            <text class="choice-label">带歌词版</text>
            <text class="choice-desc">伴奏与跟唱引导，适合练习</text>
          </view>
          <text class="choice-marker" ink:if="{{choiceDownloaded.guide || choiceIndex === 0}}">{{choiceDownloaded.guide ? '已下载' : '已选'}}</text>
        </view>
        <view class="choice-option {{choiceIndex === 1 ? 'choice-active' : ''}}" bindtap="onTapDownloadChoice" data-idx="1">
          <view class="choice-radio"><view class="choice-radio-dot" ink:if="{{choiceIndex === 1}}"></view></view>
          <view class="choice-copy">
            <text class="choice-label">纯音乐版</text>
            <text class="choice-desc">只有背景伴奏，适合熟悉歌词的你</text>
          </view>
          <text class="choice-marker" ink:if="{{choiceDownloaded.instrumental || choiceIndex === 1}}">{{choiceDownloaded.instrumental ? '已下载' : '已选'}}</text>
        </view>
      </view>

      <view class="choice-footer">
        <text class="choice-hint">{{choiceHint}}</text>
        <view class="choice-confirm {{choiceDownloading || (choiceIndex === 0 ? choiceDownloaded.guide : choiceDownloaded.instrumental) ? 'choice-confirm-disabled' : ''}}" bindtap="onConfirmDownload">
          <text class="choice-confirm-text">{{choiceDownloading ? '下载中…' : ((choiceIndex === 0 ? choiceDownloaded.guide : choiceDownloaded.instrumental) ? '已下载' : '确认下载 ›')}}</text>
        </view>
        <view class="download-progress-track" ink:if="{{downloadProgress > 0}}">
          <view class="download-progress-fill" style="width: {{downloadProgress}}%;"></view>
        </view>
      </view>
    </view>

    <block ink:else>
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
        <text class="download-song-badge">{{item.bundled ? '内置' : (item.downloaded ? '本机已下载' : ((item.downloadedVariants && (item.downloadedVariants.guide || item.downloadedVariants.instrumental)) ? '已下载一版' : (catalogConnected ? '可下载' : '联网下载')))}}</text>
      </view>
      <view class="download-empty-area" ink:if="{{songs.length === 0}}">
        <text class="download-state-text">{{catalogLoading ? '正在加载曲库…' : (catalogConnected ? '该语种暂无歌曲' : (phase === 'songs' ? '曲库连接失败 · 单击重试' : '曲库暂时无法连接'))}}</text>
      </view>
    </scroll-view>

    <view class="download-message-bar" ink:if="{{phase === 'songs' && songs.length > 0 && message}}">
      <text class="download-message-text">{{message}}</text>
    </view>
    <view class="download-hintbar">
      <text class="download-hint-text" ink:if="{{hintText}}">{{hintText}}</text>
    </view>
    </block>
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
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
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
}

.choice-option-first {
  margin-bottom: 12px;
}

.choice-active {
  border-color: var(--green-100);
  background-color: var(--green-12);
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

.choice-active .choice-label, .choice-marker {
  color: var(--green-100);
}

.choice-marker {
  flex-shrink: 0;
  margin-left: 8px;
  font-size: 12px;
  font-weight: bold;
}

.choice-footer {
  display: flex;
  flex-direction: row;
  position: relative;
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
  flex-shrink: 0;
  width: 136px;
  height: 40px;
  background-color: var(--green-12);
  border: 1px solid var(--green-72);
  border-radius: 6px;
}

.choice-confirm-disabled {
  opacity: 0.6;
}

.choice-confirm-text {
  font-size: 17px;
  font-weight: bold;
  color: var(--green-100);
}

.choice-hint {
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 8px;
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
  .download-song-list { padding-top: 2px; }
  .download-song-artist { display: none; }
  .download-empty-area { height: 38px; }
  .download-hintbar { height: 20px; }
  .download-hint-text { font-size: 11px; }
  .download-request-panel { padding: 4px 12px; }
  .download-request-preview { margin-top: 4px; padding: 2px 6px; }
  .download-request-actions { height: 28px; }
  .download-request-message { height: 16px; line-height: 16px; margin-top: 0; }

  .choice-header { flex-direction: row; height: 27px; }
  .choice-sub { margin: 0 10px 0 0; font-size: 12px; }
  .choice-title { flex: 0 1 auto; min-width: 0; font-size: 16px; }
  .choice-option { height: 37px; padding: 0 8px; }
  .choice-option-first { margin-bottom: 4px; }
  .choice-label { font-size: 16px; }
  .choice-desc { margin-top: 0; font-size: 12px; }
  .choice-footer { height: 31px; }
  .choice-confirm { width: 104px; height: 26px; }
  .choice-hint, .choice-confirm-text { font-size: 13px; }
}

</style>
