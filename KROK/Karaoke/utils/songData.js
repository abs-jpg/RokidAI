const beatMs = 600
const introBeats = 4
const phraseBeats = 10
const phrases = [
  { text: '晨光轻轻落在路上', melody: [57, 59, 60, 62, 60, 59, 57, 55] },
  { text: '微风绕过青色山岗', melody: [55, 57, 59, 60, 62, 60, 59, 57] },
  { text: '我把歌声送向远方', melody: [57, 60, 62, 64, 62, 60, 59, 57] },
  { text: '一路唱到星光闪亮', melody: [55, 57, 59, 60, 62, 59, 57, 55] }
]

const lyrics = phrases.map(({ text }, index) => {
  const startMs = (introBeats + index * phraseBeats) * beatMs
  return { text, startMs, endMs: startMs + 9 * beatMs }
})

export const songs = [
  {
    id: 'morning-light',
    chartVersion: 1,
    name: '晨光小路',
    artist: '原创练习曲',
    difficulty: 1,
    durationMs: 30000,
    accompaniment: '/assets/morning-light.ogg',
    lyrics,
    refNotes: phrases.flatMap(({ melody }, phraseIndex) =>
      melody.map((midi, noteIndex) => {
        const startMs = lyrics[phraseIndex].startMs + noteIndex * beatMs
        const beats = noteIndex === melody.length - 1 ? 2 : 1
        return { midi, startMs, endMs: startMs + beats * beatMs }
      })
    )
  }
]

export function getSongById(id) {
  return songs.find(song => song.id === id)
}

export function getRefNoteAt(refNotes, timeMs) {
  return refNotes.find(note => note.startMs <= timeMs && timeMs < note.endMs)
}

export function getLyricAt(lyrics, timeMs) {
  return lyrics.find(line => line.startMs <= timeMs && timeMs < line.endMs)
}
