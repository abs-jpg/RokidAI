<script def>
{
  "usingComponents": {}
}
</script>

<script setup>
export default {
  data: {
    battleResultOutcome: 'win',
    battleResultTitle: '胜利',
    battleSelfScore: 92,
    battleOpponentScore: 87,
    hintText: '点按镜腿 · 确认离开'
  },

  onKeyUp(event) {
    if (event.code === 'ArrowUp' || event.code === 'Enter') {
      event.preventDefault()
      this.showResult('win')
    } else if (event.code === 'ArrowDown') {
      event.preventDefault()
      this.showResult('loss')
    }
  },

  toggleOutcome() {
    this.showResult(this.data.battleResultOutcome === 'win' ? 'loss' : 'win')
  },

  showResult(outcome) {
    const win = outcome === 'win'
    this.setData({
      battleResultOutcome: win ? 'win' : 'loss',
      battleResultTitle: win ? '胜利' : '失败',
      battleSelfScore: win ? 92 : 87,
      battleOpponentScore: win ? 87 : 92
    })
  }
}
</script>

<page>
  <view class="page-root" bindtap="toggleOutcome">
    <view class="battle-result">
      <text class="battle-result-eyebrow">本局结算</text>
      <view class="battle-result-badge {{battleResultOutcome}}">
        <text class="battle-result-title">{{battleResultTitle}}</text>
      </view>
      <view class="battle-result-scores">
        <view class="battle-result-score-cell {{battleResultOutcome === 'win' ? 'battle-result-score-leading' : ''}}">
          <text class="battle-result-score-role">你</text>
          <text class="battle-result-score-value">{{battleSelfScore}}</text>
        </view>
        <view class="battle-result-score-separator"></view>
        <view class="battle-result-score-cell {{battleResultOutcome === 'loss' ? 'battle-result-score-leading' : ''}}">
          <text class="battle-result-score-role">对手</text>
          <text class="battle-result-score-value">{{battleOpponentScore}}</text>
        </view>
      </view>
    </view>
    <view class="battle-hintbar">
      <view class="hint-dot"></view>
      <text class="battle-hint">{{hintText}}</text>
    </view>
  </view>
</page>

<style>
.page-root {
  display: flex;
  flex-direction: column;
  position: relative;
  width: 448px;
  height: 328px;
  margin: 12px 16px;
  overflow: hidden;
  background-color: #101516;
}

.page-root::before,
.page-root::after {
  position: absolute;
  top: 16px;
  width: 44px;
  height: 1px;
  background-color: rgba(76,199,115,0.25);
  content: "";
}

.page-root::before { left: 16px; }
.page-root::after { right: 16px; }

.battle-result {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6px 16px 0;
}

.battle-result-eyebrow {
  margin-bottom: 8px;
  color: rgba(76,199,115,0.56);
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 4px;
}

.battle-result-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 126px;
  height: 126px;
  border: 4px solid #a5adb2;
  border-radius: 63px;
  background-color: rgba(255,255,255,0.025);
}

.battle-result-badge.win {
  border-color: #ff6573;
  background-color: rgba(255,101,115,0.06);
  box-shadow: 0 0 18px rgba(255,101,115,0.18);
}

.battle-result-title {
  color: #b7bec2;
  font-size: 38px;
  font-weight: bold;
  letter-spacing: 5px;
}

.battle-result-badge.win .battle-result-title {
  color: #ff6573;
}

.battle-result-scores {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 280px;
  height: 50px;
  margin-top: 8px;
}

.battle-result-score-cell {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.battle-result-score-role {
  color: rgba(76,199,115,0.48);
  font-size: 10px;
  line-height: 12px;
}

.battle-result-score-value {
  color: rgba(76,199,115,0.82);
  font-size: 25px;
  line-height: 29px;
  font-weight: bold;
}

.battle-result-score-leading .battle-result-score-value {
  color: #ff6573;
}

.battle-result-score-separator {
  width: 1px;
  height: 30px;
  flex-shrink: 0;
  background-color: rgba(76,199,115,0.20);
}

.battle-hintbar {
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: 22px;
  border-top: 1px solid rgba(76,199,115,0.22);
}

.hint-dot {
  width: 4px;
  height: 4px;
  margin-right: 7px;
  border-radius: 2px;
  background-color: #4cc773;
}

.battle-hint {
  color: rgba(76,199,115,0.66);
  font-size: 11px;
}
</style>
