import { getRefNoteAt } from './songData.js'

export const PITCH_STEP_MS = 40
export const SCORING_VERSION = 2
export const MIN_SAMPLE_QUALITY = 95

export function encodePitchTrack(track) {
  return track.filter(sample => Number.isFinite(sample.midi) || sample.midi === null)
    .map(sample => [Math.floor(sample.timeMs / PITCH_STEP_MS), sample.midi])
}
const MIN_RMS = 0.003
const MIN_CLARITY = 0.55
const CONFIDENCE_THRESHOLD = 0.18

// Reuse the working buffers and search for the first strong minimum of the normalized difference.
export function createPitchDetector(analyser) {
  const sampleRate = analyser.context.sampleRate
  const downsample = Math.max(1, Math.floor(sampleRate / 12000))
  const reducedRate = sampleRate / downsample
  const waveform = new Float32Array(analyser.fftSize)
  const window = new Float32Array(Math.floor(waveform.length / downsample))
  const minLag = Math.floor(reducedRate / 1000)
  const maxLag = Math.min(Math.ceil(reducedRate / 80), Math.floor(window.length / 2) - 1)
  const differences = new Float32Array(maxLag + 2)
  const length = window.length - maxLag - 1
  let lastHz = 0
  let pendingHz = 0
  let silentFrames = 0

  function accept(hz) {
    // 真实换八度需连续两帧确认，抑制单帧误判造成的曲线跳变。
    const ratio = lastHz > 0 ? hz / lastHz : 1
    if ((ratio > 1.8 && ratio < 2.2) || (ratio > 0.45 && ratio < 0.55)) {
      if (Math.abs(pendingHz - hz) <= hz * 0.05) {
        pendingHz = 0
        lastHz = hz
        return hz
      }
      pendingHz = hz
      return lastHz
    }
    pendingHz = 0
    lastHz = hz
    return hz
  }

  return () => {
    analyser.getFloatTimeDomainData(waveform)
    let sum = 0
    let energy = 0
    for (let i = 0; i < window.length; i++) {
      let block = 0
      for (let j = 0; j < downsample; j++) {
        block += waveform[i * downsample + j]
      }
      const sample = block / downsample
      window[i] = sample
      sum += sample
      energy += sample * sample
    }
    const mean = sum / window.length
    const rms = Math.sqrt(Math.max(0, energy / window.length - mean * mean))
    if (rms < MIN_RMS) {
      silentFrames++
      if (silentFrames > 2) lastHz = 0
      return null
    }
    silentFrames = 0

    let cumulative = 0
    differences[0] = 1
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let difference = 0
      for (let i = 0; i < length; i++) {
        const delta = window[i] - window[i + lag]
        difference += delta * delta
      }
      cumulative += difference
      differences[lag] = cumulative ? difference * lag / cumulative : 1

      const peak = lag - 1
      if (peak < minLag) continue
      const left = differences[peak - 1]
      const center = differences[peak]
      const right = differences[lag]
      if (center < CONFIDENCE_THRESHOLD && center <= left && center < right) {
        if (1 - center < MIN_CLARITY) continue
        const offset = (left - right) / (2 * (left - 2 * center + right))
        const hz = reducedRate / (peak + offset)
        if (hz < 80 || hz > 1000) return null
        return accept(hz)
      }
    }
    return null
  }
}

export function hzToMidi(hz) {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null
}

export function calcAccuracyScore(samples, refNotes, version = SCORING_VERSION) {
  let expectedFrames = 0
  for (const note of refNotes) {
    const first = Math.ceil((note.startMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    const afterLast = Math.ceil((note.endMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    expectedFrames += afterLast - first
  }

  let voicedFrames = 0
  let capturedFrames = 0
  let points = 0
  for (const sample of samples) {
    const ref = getRefNoteAt(refNotes, sample.timeMs)
    if (!ref) continue
    capturedFrames++
    if (!Number.isFinite(sample.midi)) continue
    points += Math.max(0, 100 - Math.abs(sample.midi - ref.midi) * 20)
    voicedFrames++
  }

  const denominator = version >= 2 ? capturedFrames : expectedFrames
  return {
    accuracy: voicedFrames ? Math.round(points / voicedFrames) : 0,
    coverage: denominator ? Math.min(100, Math.round(100 * voicedFrames / denominator)) : 0,
    score: denominator ? Math.min(100, Math.round(points / denominator)) : 0,
    sampleQuality: expectedFrames ? Math.min(100, 100 * capturedFrames / expectedFrames) : 0
  }
}
