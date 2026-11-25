<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { loadSongCatalog } from '../../utils/songLibrary.js'
import { getAccountNotice } from '../../utils/leaderboard.js'
import {
  closeBattle,
  connectBattle,
  isBattleOpen,
  onBattleMessage,
  sendBattle
} from '../../utils/battleClient.js'

export default {
  data: {
    phase: 'connecting',
    rooms: [],
    selectedIdx: 0,
    room: null,
    selfId: '',
    selfName: '',
    selfSongName: '未选择',
    opponentName: '等待加入',
    opponentSongName: '—',
    songs: [],
    songIdx: 0,
    hintText: '正在连接联机服务器',
    noticeText: '',
    errorMsg: ''
  },

  onLoad() {
    this.navigating = false
    this.enteredRoomAt = 0
    this.unsubscribe = onBattleMessage(message => this.handleMessage(message))
    this.initialize()
  },

  async initialize() {
    try {
      const catalog = await loadSongCatalog()
      if (this.unloaded) return
      const playable = catalog.songs.filter(song => song.bundled || song.downloadedVariants?.guide)
      if (!playable.length) {
        this.setData({ phase: 'error', errorMsg: '暂无可对战的已下载歌曲' })
        return
      }
      this.setData({ songs: playable })
      await connectBattle()
    } catch (error) {
      console.error('battle initialize failed', error)
      if (!this.unloaded) this.setData({ phase: 'error', errorMsg: '联机服务不可用', hintText: '确认重试 · 返回' })
    }
  },

  handleMessage(message) {
    if (message.type === 'welcome') {
      this.setData({ selfId: message.playerId, selfName: message.name, phase: 'lobby', hintText: '上下选择 · 确认加入', noticeText: getAccountNotice() })
      return
    }
    if (message.type === 'lobby') {
      const rooms = Array.isArray(message.rooms) ? message.rooms : []
      const maxIndex = rooms.length
      const selectedIdx = Math.max(0, Math.min(this.data.selectedIdx, maxIndex))
      this.setData({ rooms, selectedIdx })
      if (this.data.phase === 'connecting') {
        this.setData({ phase: 'lobby', hintText: rooms.length ? '上下选择 · 确认加入' : '确认创建房间' })
      }
      return
    }
    if (message.type === 'room') {
      this.enteredRoomAt = Date.now()
      const room = message.room
      const songs = this.data.songs
      const selected = room.players.find(player => player.id === this.data.selfId)
      const opponent = room.players.find(player => player.id !== this.data.selfId)
      let songIdx = this.data.songIdx
      if (selected && selected.selectedSongId) {
        const index = songs.findIndex(song => song.id === selected.selectedSongId)
        if (index >= 0) songIdx = index
      }
      let noticeText = ''
      if (opponent && opponent.selectedSongId && !(selected && selected.selectedSongId)) {
        noticeText = '对方选择了「' + this.getSongName(opponent.selectedSongId) + '」，选择同一首开始'
      }
      this.setData({
        phase: 'room',
        room,
        selfSongName: this.getSongName(selected && selected.selectedSongId),
        opponentName: opponent ? opponent.name : '等待加入',
        opponentSongName: opponent ? this.getSongName(opponent.selectedSongId) : '—',
        songIdx: Math.max(0, Math.min(songIdx, songs.length - 1)),
        hintText: '上下选歌 · 确认 · 返回退出',
        noticeText
      })
      return
    }
    if (message.type === 'battle.prepare' && !this.navigating) {
      this.navigating = true
      const opponent = message.opponent && message.opponent.name ? message.opponent.name : '对手'
      this.setData({ hintText: '正在准备对战' })
      wx.navigateTo({
        url: '/pages/record/record?mode=battle&songId=' + encodeURIComponent(message.songId) +
          '&roomId=' + encodeURIComponent(message.roomId) +
          '&roundId=' + encodeURIComponent(message.roundId) +
          '&chartVersion=' + message.chartVersion +
          '&scoringVersion=' + message.scoringVersion +
          '&selfId=' + encodeURIComponent(message.selfId) +
          '&opponent=' + encodeURIComponent(opponent),
        fail: () => {
          this.navigating = false
          sendBattle('battle.cancel', { roomId: message.roomId, roundId: message.roundId })
          this.setData({ phase: 'lobby', room: null, noticeText: '打开对战页失败' })
        }
      })
      return
    }
    if (message.type === 'battle.cancelled') {
      this.setData({ phase: 'lobby', room: null, noticeText: message.reason || '对战已取消' })
      return
    }
    if (message.type === 'notice') {
      this.setData({ noticeText: message.message || '', hintText: message.message || this.data.hintText })
      return
    }
    if (message.type === 'error') {
      this.setData({ noticeText: message.message || '操作失败' })
      return
    }
    if (message.type === 'left') {
      this.setData({ phase: 'lobby', room: null, noticeText: '已离开房间' })
      sendBattle('lobby')
      return
    }
    if (message.type === 'socket.close' || message.type === 'socket.error') {
      if (!this.navigating) {
        this.setData({ phase: 'error', errorMsg: '联机连接已断开', hintText: '确认重试 · 返回' })
      }
    }
  },

  onShow() {
    if (this.navigating) {
      this.navigating = false
      if (!isBattleOpen()) {
        this.setData({ phase: 'error', room: null, errorMsg: '联机连接已断开', hintText: '确认重试 · 返回' })
        return
      }
      if (this.data.room) sendBattle('room.leave')
      this.setData({ phase: 'lobby', room: null, noticeText: '' })
      sendBattle('lobby')
    }
  },

  onUnload() {
    this.unloaded = true
    if (this.unsubscribe) this.unsubscribe()
    if (!this.navigating) {
      if (this.data.room) sendBattle('room.leave')
      closeBattle()
    }
  },

  onKeyUp(event) {
    const code = event.code
    if (code === 'Backspace' && this.data.phase === 'room') {
      event.preventDefault()
      sendBattle('room.leave')
      return
    }
    if (code !== 'ArrowUp' && code !== 'ArrowDown' && code !== 'Enter') return
    event.preventDefault()

    if (this.data.phase === 'error' && code === 'Enter') {
      closeBattle()
      this.setData({ phase: 'connecting', hintText: '正在连接联机服务器' })
      this.initialize()
      return
    }
    if (this.data.phase === 'lobby') {
      const count = this.data.rooms.length + 1
      if (code === 'Enter') {
        const index = this.data.selectedIdx
        if (index >= this.data.rooms.length) sendBattle('room.create')
        else sendBattle('room.join', { roomId: this.data.rooms[index].id })
        return
      }
      const offset = code === 'ArrowUp' ? -1 : 1
      this.setData({ selectedIdx: (this.data.selectedIdx + offset + count) % count })
      return
    }

    if (this.data.phase === 'room') {
      if (!this.data.songs.length) return
      if (code === 'Enter') {
        const song = this.data.songs[this.data.songIdx]
        if (song) sendBattle('room.select', { songId: song.id })
        return
      }
      const offset = code === 'ArrowUp' ? -1 : 1
      this.setData({ songIdx: (this.data.songIdx + offset + this.data.songs.length) % this.data.songs.length })
    }
  },

  onTapRoom(event) {
    sendBattle('room.join', { roomId: event.currentTarget.dataset.id })
  },

  onTapCreate() {
    sendBattle('room.create')
  },

  onTapSong(event) {
    this.setData({ songIdx: Number(event.currentTarget.dataset.idx) })
    sendBattle('room.select', { songId: event.currentTarget.dataset.id })
  },

  getRoomPlayer(room, wantedId) {
    return room.players.find(player => player.id === wantedId) || null
  },

  getSongName(songId) {
    const song = this.data.songs.find(item => item.id === songId)
    return song ? song.name : (songId ? '已选择' : '未选择')
  },

  getSelfPlayer() {
    return this.data.room ? this.getRoomPlayer(this.data.room, this.data.selfId) : null
  },

  getOpponentPlayer() {
    if (!this.data.room) return null
    return this.data.room.players.find(player => player.id !== this.data.selfId) || null
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="title">多人联机</text>
      <text class="self-name" ink:if="{{selfName}}">{{selfName}}</text>
    </view>

    <view class="body-area center" ink:if="{{phase === 'connecting'}}">
      <text class="state-text">正在连接联机服务器</text>
    </view>

    <view class="body-area center" ink:if="{{phase === 'error'}}">
      <text class="state-text">{{errorMsg}}</text>
      <text class="state-sub">返回后重新进入</text>
    </view>

    <block ink:if="{{phase === 'lobby'}}">
      <text class="section-title">现有房间</text>
      <text class="notice-text" ink:if="{{noticeText}}">{{noticeText}}</text>
      <scroll-view class="room-list" scroll-y="{{true}}" scroll-into-view="room-row-{{selectedIdx}}">
        <view
          id="room-row-{{index}}"
          class="room-row {{selectedIdx === index ? 'row-active' : ''}}"
          ink:for="{{rooms}}"
          ink:key="id"
          bindtap="onTapRoom"
          data-id="{{item.id}}"
        >
          <text class="room-name">{{item.name}}</text>
          <text class="room-meta">{{item.playerCount}}/2</text>
          <text class="room-status">{{item.status === 'waiting' ? '等待' : (item.status === 'selecting' ? '选歌' : '已满')}}</text>
        </view>
        <view class="empty-rooms" ink:if="{{rooms.length === 0}}">
          <text class="state-sub">暂无房间，创建一个吧</text>
        </view>
      </scroll-view>

      <view
        id="room-row-{{rooms.length}}"
        class="create-room {{selectedIdx === rooms.length ? 'row-active' : ''}}"
        bindtap="onTapCreate"
      >
        <text class="create-text">＋ 创建房间</text>
      </view>
    </block>

    <block ink:if="{{phase === 'room'}}">
      <text class="room-title">{{room.name}}</text>
      <view class="players-row">
        <view class="player-card">
          <text class="player-role">我</text>
          <text class="player-name">{{selfName}}</text>
          <text class="player-song">{{selfSongName}}</text>
        </view>
        <view class="player-card opponent-card">
          <text class="player-role">对手</text>
          <text class="player-name">{{opponentName}}</text>
          <text class="player-song">{{opponentSongName}}</text>
        </view>
      </view>

      <text class="notice-text" ink:if="{{noticeText}}">{{noticeText}}</text>
      <text class="section-title">选择对战歌曲（双方都需缓存）</text>
      <scroll-view class="song-list" scroll-y="{{true}}" scroll-into-view="battle-song-{{songIdx}}">
        <view
          id="battle-song-{{index}}"
          class="song-row {{songIdx === index ? 'row-active' : ''}}"
          ink:for="{{songs}}"
          ink:key="id"
          bindtap="onTapSong"
          data-id="{{item.id}}"
          data-idx="{{index}}"
        >
          <text class="song-name">{{item.name}}</text>
          <text class="song-tag">{{item.bundled ? '内置' : '已缓存'}}</text>
        </view>
      </scroll-view>
    </block>

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
  height: 30px;
  flex-shrink: 0;
  padding: 0 8px;
  border-bottom: 1px solid var(--green-24);
}

.title {
  font-size: 18px;
  font-weight: bold;
  color: var(--green-100);
}

.self-name {
  font-size: 11px;
  color: var(--green-48);
}

.body-area {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.center {
  align-items: center;
  justify-content: center;
}

.state-text {
  font-size: 15px;
  color: var(--green-72);
}

.state-sub {
  font-size: 11px;
  color: var(--green-48);
  margin-top: 8px;
}

.section-title {
  font-size: 11px;
  color: var(--green-48);
  padding: 6px 10px 2px;
  flex-shrink: 0;
}

.room-list {
  flex: 1 1 auto;
  min-height: 0;
}

.room-row, .song-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 36px;
  padding: 0 10px;
  margin: 1px 6px;
}

.room-name, .song-name {
  font-size: 14px;
  color: var(--green-72);
  flex: 1 1 auto;
  min-width: 0;
}

.room-meta, .room-status, .song-tag {
  font-size: 11px;
  color: var(--green-48);
  margin-left: 8px;
}

.row-active {
  background-color: var(--green-12);
  border-left: 2px solid var(--green-100);
}

.row-active .room-name,
.row-active .song-name {
  color: var(--green-100);
  font-weight: bold;
}

.empty-rooms {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 60px;
}

.create-room {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  margin: 6px;
  border: 1px solid var(--green-48);
  flex-shrink: 0;
}

.create-text {
  font-size: 16px;
  color: var(--green-100);
}

.room-title {
  font-size: 15px;
  font-weight: bold;
  color: var(--green-100);
  padding: 6px 10px 0;
  flex-shrink: 0;
}

.players-row {
  display: flex;
  flex-direction: row;
  height: 58px;
  padding: 4px 8px;
  flex-shrink: 0;
}

.player-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex: 1 1 0;
  padding: 0 8px;
  border-right: 1px solid var(--green-24);
}

.opponent-card {
  border-right: 0;
}

.player-role {
  font-size: 10px;
  color: var(--green-48);
}

.player-name {
  font-size: 13px;
  color: var(--green-100);
}

.player-song {
  font-size: 10px;
  color: var(--green-48);
}

.notice-text {
  font-size: 10px;
  color: var(--green-72);
  text-align: center;
  flex-shrink: 0;
}

.song-list {
  flex: 1 1 auto;
  min-height: 0;
}

.hintbar {
  display: flex;
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
