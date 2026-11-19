<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
import wx from 'wx'
import { getSongById } from '../../utils/songData.js'
import { calcAccuracyScore, encodePitchTrack, MIN_SAMPLE_QUALITY, SCORING_VERSION } from '../../utils/pitchEngine.js'
import { getGrade } from '../../utils/scoreEngine.js'
import { isServerConnected, submitScore } from '../../utils/leaderboard.js'
import { getSongFromLibrary } from '../../utils/songLibrary.js'

export default {
  data: {
    phase: 'calculating',
    songName: '',
    accuracyScore: 0,
    coverage: 0,
    totalScore: 0,
    grade: '',
    gradeLabel: '',
    submitStatus: 'idle',
    submitMsg: '',
    errorMsg: '',
    selectedIdx: 0,
    actionLabels: ['保存本机成绩', '重唱', '返回首页'],
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

  onUnload() {
    this.unloaded = true
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
    try {
      const recording = wx.getStorageSync('karaoke_last_recording')
      if (!this.song || !this.attemptId || !recording ||
          recording.songId !== this.song.id || recording.attemptId !== this.attemptId ||
          !Array.isArray(recording.pitchTrack)) {
        this.setData({ phase: 'error', errorMsg: '未找到本次演唱', hintText: '返回重唱' })
        return
      }
      this.scoringVersion = recording.scoringVersion ?? 1
      const { score, accuracy, coverage, sampleQuality } = calcAccuracyScore(recording.pitchTrack, this.song.refNotes, this.scoringVersion)
      if (this.scoringVersion >= 2 && recording.completed && sampleQuality < MIN_SAMPLE_QUALITY) {
        this.setData({ phase: 'error', errorMsg: '设备采样不稳定 · 请重唱', hintText: '返回重唱' })
        return
      }
      const { grade, label } = getGrade(score)
      this.completed = recording.completed === true
      this.samples = encodePitchTrack(recording.pitchTrack)
      const canUpload = this.completed && coverage > 0 && isServerConnected() && this.scoringVersion === SCORING_VERSION
      this.setData({
        phase: 'display',
        totalScore: score,
        accuracyScore: accuracy,
        coverage,
        grade,
        gradeLabel: label,
        actionLabels: [canUpload ? '提交成绩' : '保存本机成绩', '重唱', '返回首页'],
        hintText: '上下选择 · 确认 · 返回'
      })
    } catch (error) {
      console.error('读取演唱成绩失败', error)
      this.setData({ phase: 'error', errorMsg: '读取成绩失败', hintText: '确认重试 · 返回' })
    }
  },

  async doSubmit() {
    if (this.data.submitStatus === 'submitting' || this.data.submitStatus === 'done') return
    this.setData({ submitStatus: 'submitting', submitMsg: '正在保存' })
    try {
      const result = await submitScore({
        attemptId: this.attemptId,
        songId: this.song.id,
        songName: this.song.name,
        chartVersion: this.song.chartVersion,
        scoringVersion: this.scoringVersion,
        completed: this.completed,
        score: this.data.totalScore,
        accuracy: this.data.accuracyScore,
        coverage: this.data.coverage
      }, this.samples)
      if (this.unloaded) return
      this.setData({
        submitStatus: result.success && !result.retryable ? 'done' : 'error',
        submitMsg: result.message
      })
    } catch (error) {
      console.error('保存成绩失败', error)
      if (!this.unloaded) this.setData({ submitStatus: 'error', submitMsg: '保存失败 · 确认重试' })
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

      <view class="sub-scores">
        <view class="sub-row">
          <text class="sub-name">音准</text>
          <view class="bar-track">
            <view class="bar-fill" style="width: {{accuracyScore}}%;"></view>
          </view>
          <text class="sub-num">{{accuracyScore}}</text>
        </view>
        <view class="sub-row">
          <text class="sub-name">覆盖率</text>
          <view class="bar-track">
            <view class="bar-fill" style="width: {{coverage}}%;"></view>
          </view>
          <text class="sub-num">{{coverage}}%</text>
        </view>
      </view>

      <view class="submit-line" ink:if="{{submitStatus !== 'idle'}}">
        <text class="submit-msg">{{submitMsg}}</text>
      </view>

      <view class="action-row">
        <view class="action-btn" ink:for="{{actionLabels}}" ink:key="*this" bindtap="onTapAction" data-idx="{{index}}">
          <text class="action-label">{{item}}</text>
          <view class="action-marker">
            <view class="action-dot" ink:if="{{selectedIdx === index}}"></view>
          </view>
        </view>
      </view>
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
  height: 110px;
  flex-shrink: 0;
}

.grade-row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.grade-letter {
  font-size: 28px;
  font-weight: bold;
  color: var(--green-100);
}

.grade-label {
  font-size: 12px;
  color: var(--green-48);
  margin-left: 6px;
}

.score-num {
  font-size: 48px;
  font-weight: bold;
  color: var(--green-100);
  margin-top: 2px;
}

.score-unit {
  font-size: 11px;
  color: var(--green-24);
}

.sub-scores {
  display: flex;
  flex-direction: column;
  width: 100%;
  flex-shrink: 0;
  margin-top: 6px;
}

.sub-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 28px;
}

.sub-name {
  font-size: 11px;
  color: var(--green-48);
  width: 56px;
  flex-shrink: 0;
}

.bar-track {
  position: relative;
  flex: 1 1 auto;
  height: 10px;
  background-color: var(--green-12);
  border: 1px solid var(--green-24);
}

.bar-fill {
  height: 100%;
  background-color: var(--green-72);
}

.sub-num {
  font-size: 14px;
  font-weight: bold;
  color: var(--green-100);
  width: 44px;
  text-align: right;
  flex-shrink: 0;
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
  height: 40px;
  flex-shrink: 0;
  margin-top: 6px;
}

.action-btn {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  height: 100%;
  margin: 0 4px;
}

.action-label {
  font-size: 13px;
  color: var(--green-72);
}

.action-marker {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 8px;
  margin-left: 4px;
}

.action-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--green-100);
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
