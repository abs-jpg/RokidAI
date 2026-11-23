export function playFeedbackSpeech(lines) {
  const text = lines.join(' ')
  const synth = globalThis.speechSynthesis
  if (!text || !synth || typeof SpeechSynthesisUtterance !== 'function') return null

  let controller
  let player
  const stop = () => {
    controller?.abort()
    player?.destroy()
    player = null
  }
  try {
    const utterance = new SpeechSynthesisUtterance(text)
    if (typeof synth.synthesize !== 'function' || typeof SpeechAudioPlayer !== 'function') {
      synth.speak?.(utterance)
      return null
    }
    controller = new AbortController()
    synth.synthesize(utterance, { subtitles: 'none', signal: controller.signal }).then(task => {
      task.finished.catch(error => {
        if (!controller.signal.aborted) console.warn('用户点评播报失败', error)
      })
      if (controller.signal.aborted) {
        if (task.state === 'running') task.abort()
        return
      }
      player = new SpeechAudioPlayer(task)
      player.play()
    }).catch(error => {
      if (!controller.signal.aborted) console.warn('用户点评播报失败', error)
      stop()
    })
  } catch (error) {
    console.warn('用户点评播报失败', error)
    stop()
  }
  return stop
}
