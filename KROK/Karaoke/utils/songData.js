import { daoXiangSong } from './daoXiangSong.js'

// 稻香直接随应用发布，首次启动无需从音乐下载页获取。
export const songs = [daoXiangSong]

export function getSongById(id) {
  return songs.find(song => song.id === id)
}

export function getRefNoteAt(refNotes, timeMs) {
  return refNotes.find(note => note.startMs <= timeMs && timeMs < note.endMs)
}

export function getLyricAt(lyrics, timeMs) {
  return lyrics.find(line => line.startMs <= timeMs && timeMs < line.endMs)
}
