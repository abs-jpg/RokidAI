import { flushPendingScores } from './utils/leaderboard.js'
import { songs } from './utils/songData.js'
import { preloadSongAudio } from './utils/songLibrary.js'
import { forwardDownloadInput } from './utils/downloadReturn.js'

function retryScores() {
  flushPendingScores().catch(error => console.error('补传成绩失败', error))
}

function preloadDefaultAudio() {
  const song = songs[0]
  if (!song) return Promise.resolve()
  return Promise.allSettled([
    preloadSongAudio(song, 'guide'),
    preloadSongAudio(song, 'instrumental')
  ])
}

export default {
  globalData: {},

  onLaunch() {
    preloadDefaultAudio()
  },
  onShow() {
    retryScores()
    preloadDefaultAudio()
  },
  onKeyDown(event) {
    forwardDownloadInput(event, true)
  },
  onKeyUp(event) {
    forwardDownloadInput(event, false)
  },
  onNetworkStatus(event) {
    if (event.online) retryScores()
  }
}
