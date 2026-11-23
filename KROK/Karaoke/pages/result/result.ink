<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { getSongById } from '../../utils/songData.js'
import { calcAccuracyScore, calcVocalCompleteness, encodePitchTrack } from '../../utils/pitchEngine.js'
import { getGrade, buildPracticeFeedback, calcLyricLengthCompleteness } from '../../utils/scoreEngine.js'
import { playFeedbackSpeech } from '../../utils/feedbackSpeech.js'
import { submitScore } from '../../utils/leaderboard.js'
import { getSongFromLibrary } from '../../utils/songLibrary.js'

const UPLOAD_ACTION = '保存到服务器排行榜'

export default {
  data: {
    phase: 'calculating',
    songName: '',
    accuracyScore: 0,
    coverage: 0,
    completenessScore: 0,
    totalScore: 0,
    hasRefNotes: true,
    feedback: [],
    grade: '',
    gradeLabel: '',
    submitStatus: 'idle',
    submitMsg: '',
    errorMsg: '',
    selectedIdx: 0,
    actionLabels: [UPLOAD_ACTION, '重唱', '返回首页'],
    hintText: '评分计算中'
  },

  onLoad(query) {
    this.query = query || {}
    this.attemptId = query && query.attemptId
    this.initializeSong()
  },

  onReady() {
    this.pageReady = true
    if (this.song) this.calculateScore()
  },

  onShow() {
    this.hidden = false
  },

  onHide() {
    this.hidden = true
    this.stopFeedbackSpeech?.()
    this.stopFeedbackSpeech = null
  },

  onUnload() {
    this.unloaded = true
    this.onHide()
  },

  async initializeSong() {
    let song = getSongById(this.query.songId)
    if (!song) {
      try {
        song = await getSongFromLibrary(this.query.songId)
      } catch (error) {
        console.error('加载在线歌曲失败', error)
      }
    }
    if (this.unloaded) return
    if (!song) {
      this.setData({ songName: '演唱成绩', phase: 'error', errorMsg: '歌曲不可用', hintText: '返回重唱' })
      return
    }
    this.song = song
    this.setData({ songName: song.name })
    if (this.pageReady) this.calculateScore()
  },

  onKeyUp(event) {
    const { code } = event
    if (code !== 'ArrowUp' && code !== 'ArrowDown' && code !== 'Enter') return
    event.preventDefault()
    if (this.data.phase === 'error' && code === 'Enter') {
      this.calculateScore()
      return
    }
    if (this.data.phase !== 'display') return
    if (code === 'Enter') {
      this.activateAction(this.data.selectedIdx)
    } else {
      const count = this.data.actionLabels.length
      const offset = code === 'ArrowUp' ? -1 : 1
      this.setData({ selectedIdx: (this.data.selectedIdx + offset + count) % count })
    }
  },

  onTapAction(event) {
    this.activateAction(Number(event.currentTarget.dataset.idx))
  },

  activateAction(index) {
    if (index === 0) this.doSubmit()
    else if (index === 1) wx.navigateBack()
    else if (index === 2) wx.navigateBack({ delta: 2 })
  },

  calculateScore() {
    if (this.data.phase === 'display') return
    try {
      const recording = wx.getStorageSync('karaoke_last_recording')
      if (!this.song || !this.attemptId || !recording ||
          recording.songId !== this.song.id || recording.attemptId !== this.attemptId ||
          !Array.isArray(recording.pitchTrack)) {
        this.setData({ phase: 'error', errorMsg: '未找到本次演唱', hintText: '返回重唱' })
        return
      }
      this.scoringVersion = recording.scoringVersion ?? 1
      this.chartVersion = recording.chartVersion ?? this.song.chartVersion
      this.completed = recording.completed === true
      this.recognizedText = recording.recognizedText || ''
      const hasRefNotes = Array.isArray(this.song.refNotes) && this.song.refNotes.length > 0
      const lyrics = this.song.lyrics || []
      const lyricsText = lyrics.map(line => line.text || '').join('')

      let score
      let accuracy = 0
      let coverage = 0
      let completeness = 0
      let pitchProfile
      if (hasRefNotes) {
        const result = calcAccuracyScore(recording.pitchTrack, this.song.refNotes, this.scoringVersion)
        accuracy = result.accuracy
        pitchProfile = result.pitchProfile
        completeness = this.scoringVersion >= 4
          ? calcLyricLengthCompleteness(this.recognizedText, lyricsText)
          : (result.completeness ?? result.coverage)
        coverage = completeness
        score = this.scoringVersion >= 4
          ? Math.round(completeness * 0.8 + accuracy * 0.2)
          : result.score
      } else {
        completeness = this.scoringVersion >= 4
          ? calcLyricLengthCompleteness(this.recognizedText, lyricsText)
          : calcVocalCompleteness(recording.pitchTrack, lyrics)
        coverage = completeness
        score = completeness
      }
      const { grade, label } = getGrade(score)
      this.samples = encodePitchTrack(recording.pitchTrack)
      const feedback = buildPracticeFeedback({
        lyrics,
        recognizedText: this.recognizedText,
        completed: this.completed,
        sungUntilMs: recording.sungUntilMs ?? recording.pitchTrack[recording.pitchTrack.length - 1]?.timeMs,
        hasRefNotes,
        pitchProfile
      })
      this.setData({
        phase: 'display',
        totalScore: score,
        accuracyScore: accuracy,
        coverage,
        completenessScore: completeness,
        hasRefNotes,
        feedback,
        grade,
        gradeLabel: label,
        hintText: '上下选择 · 确认 · 返回'
      }, () => {
        if (this.unloaded || this.hidden || this.feedbackSpoken) return
        this.feedbackSpoken = true
        this.stopFeedbackSpeech = playFeedbackSpeech(feedback)
      })
      if (this.completed) this.doSubmit()
    } catch (error) {
      console.error('读取演唱成绩失败', error)
      this.setData({ phase: 'error', errorMsg: '读取成绩失败', hintText: '确认重试 · 返回' })
    }
  },

  async doSubmit() {
    if (this.data.submitStatus === 'submitting' || this.data.submitStatus === 'done') return
    this.setData({ submitStatus: 'submitting', submitMsg: '正在上传排行榜' })
    try {
      const result = await submitScore({
        attemptId: this.attemptId,
        songId: this.song.id,
        songName: this.song.name,
        chartVersion: this.chartVersion ?? this.song.chartVersion,
        scoringVersion: this.scoringVersion,
        completed: this.completed,
        score: this.data.totalScore,
        accuracy: this.data.accuracyScore,
        coverage: this.data.coverage,
        recognizedText: this.recognizedText
      }, this.samples)
      if (this.unloaded) return
      this.setData({
        submitStatus: result.uploaded ? 'done' : 'error',
        submitMsg: result.message,
        actionLabels: [result.uploaded ? '已上传' : result.retryable ? '重试上传' : UPLOAD_ACTION, '重唱', '返回首页']
      })
    } catch (error) {
      console.error('上传成绩失败', error)
      if (!this.unloaded) this.setData({ submitStatus: 'error', submitMsg: '上传未完成 · 确认重试' })
    }
  }
}
</script>

<page>
  <view class="page-root">
    <view class="topbar">
      <text class="song-name">{{songName}}</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'calculating'}}">
      <text class="calc-text">评分计算中</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'error'}}">
      <text class="error-text">{{errorMsg}}</text>
    </view>

    <view class="body-area" ink:if="{{phase === 'display'}}">
      <view class="score-hero">
        <view class="grade-row">
          <text class="grade-letter">{{grade}}</text>
          <text class="grade-label">{{gradeLabel}}</text>
        </view>
        <text class="score-num">{{totalScore}}</text>
        <text class="score-unit">演唱得分</text>
      </view>

      <view class="summary-box">
        <text class="summary-title">用户点评</text>
        <text class="summary-text" ink:for="{{feedback}}" ink:key="*this">{{item}}</text>
      </view>

      <view class="submit-line" ink:if="{{submitStatus !== 'idle'}}">
        <text class="submit-msg">{{submitMsg}}</text>
      </view>
    </view>

    <view class="action-row" ink:if="{{phase === 'display'}}">
      <view class="action-btn {{selectedIdx === index ? 'action-btn-active' : ''}}" ink:for="{{actionLabels}}" ink:key="*this" bindtap="onTapAction" data-idx="{{index}}">
        <text class="action-label">{{item}}</text>
      </view>
    </view>

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
  justify-content: center;
  height: 28px;
  flex-shrink: 0;
}

.song-name {
  font-size: 14px;
  font-weight: bold;
  color: var(--green-100);
}

.body-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 16px;
}

.calc-text {
  font-size: 16px;
  color: var(--green-72);
}

.error-text {
  font-size: 16px;
  color: var(--green-72);
}

.score-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 88px;
  flex-shrink: 0;
}

.grade-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.grade-letter {
  font-size: 24px;
  line-height: 26px;
  font-weight: bold;
  color: var(--green-100);
}

.grade-label {
  font-size: 12px;
  color: var(--green-48);
  margin-left: 6px;
}

.score-num {
  font-size: 42px;
  line-height: 44px;
  font-weight: bold;
  color: var(--green-100);
  margin-top: 2px;
}

.score-unit {
  font-size: 11px;
  line-height: 14px;
  color: var(--green-48);
}

.summary-box {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  flex-shrink: 0;
  margin-top: 6px;
  padding: 5px 10px;
  border: 1px solid var(--green-24);
}

.summary-title {
  flex-shrink: 0;
  font-size: 13px;
  line-height: 16px;
  font-weight: bold;
  color: var(--green-100);
}

.summary-text {
  flex-shrink: 0;
  width: 100%;
  font-size: 13px;
  color: var(--green-72);
  line-height: 16px;
  margin-top: 2px;
}

.submit-line {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 16px;
}

.submit-msg {
  font-size: 10px;
  color: var(--green-48);
}

.action-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-around;
  width: 416px;
  align-self: center;
  height: 32px;
  flex-shrink: 0;
  margin-top: 6px;
}

.action-btn {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex-shrink: 0;
  width: 128px;
  height: 28px;
  border: 1px solid rgba(76,199,115,0.24);
}

.action-btn-active {
  border-color: #4cc773;
  background-color: rgba(76,199,115,0.12);
}

.action-label {
  font-size: 13px;
  color: rgba(76,199,115,0.84);
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
