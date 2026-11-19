import { flushPendingScores } from './utils/leaderboard.js'

function retryScores() {
  flushPendingScores().catch(error => console.error('补传成绩失败', error))
}

export default {
  onShow() {
    retryScores()
  },
  onNetworkStatus(event) {
    if (event.online) retryScores()
  }
}
