import { getRefNoteAt } from './songData.js'

export const PITCH_STEP_MS = 40
export const SCORING_VERSION = 5

export function encodePitchTrack(track) {
  return track.filter(sample => Number.isFinite(sample.midi) || sample.midi === null)
    .map(sample => [
      Math.floor(sample.timeMs / PITCH_STEP_MS),
      sample.midi,
      sample.voiceActive === true || Number.isFinite(sample.midi) ? 1 : 0
    ])
}
const MIN_RMS = 0.003
const MIN_CLARITY = 0.55
const CONFIDENCE_THRESHOLD = 0.18
const DEFAULT_MIN_HZ = 80
const MAX_HZ = 1000

// Reuse the working buffers and search for the first strong minimum of the normalized difference.
export function createPitchDetector(analyser, minHz = DEFAULT_MIN_HZ) {
  const sampleRate = analyser.context.sampleRate
  const downsample = Math.max(1, Math.floor(sampleRate / 12000))
  const reducedRate = sampleRate / downsample
  const waveform = new Float32Array(analyser.fftSize)
  const window = new Float32Array(Math.floor(waveform.length / downsample))
  const minLag = Math.floor(reducedRate / MAX_HZ)
  const maxLag = Math.min(Math.ceil(reducedRate / minHz), Math.floor(window.length / 2) - 1)
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
      pendingHz = 0
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
        if (hz < minHz || hz > MAX_HZ) break
        return accept(hz)
      }
    }
    pendingHz = 0
    return null
  }
}

export function createVoiceActivityDetector(analyser, threshold = MIN_RMS) {
  const waveform = new Float32Array(analyser.fftSize)
  return () => {
    analyser.getFloatTimeDomainData(waveform)
    let sum = 0
    let energy = 0
    for (let index = 0; index < waveform.length; index++) {
      sum += waveform[index]
      energy += waveform[index] * waveform[index]
    }
    const mean = sum / waveform.length
    const rms = Math.sqrt(Math.max(0, energy / waveform.length - mean * mean))
    return rms >= threshold
  }
}

export function hzToMidi(hz) {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null
}

export function countExpectedFrames(refNotes) {
  let expectedFrames = 0
  for (const note of refNotes) {
    const first = Math.ceil((note.startMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    const afterLast = Math.ceil((note.endMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    expectedFrames += afterLast - first
  }
  return Math.max(0, expectedFrames)
}

export function countExpectedLyricFrames(lyrics) {
  let expectedFrames = 0
  for (const line of lyrics || []) {
    if (!line?.text?.trim() || !Number.isFinite(line.startMs) || !Number.isFinite(line.endMs)) continue
    const first = Math.ceil((line.startMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    const afterLast = Math.ceil((line.endMs - PITCH_STEP_MS / 2) / PITCH_STEP_MS)
    expectedFrames += Math.max(0, afterLast - first)
  }
  return expectedFrames
}

// 完整度只检查歌词时间段内是否持续检测到用户发声，不比较识别出了哪些词。
export function calcVocalCompleteness(samples, lyrics) {
  const expectedFrames = countExpectedLyricFrames(lyrics)
  if (!expectedFrames) return 0
  let voicedFrames = 0
  for (const sample of samples) {
    if (sample.voiceActive !== true && !Number.isFinite(sample.midi)) continue
    const inLyric = (lyrics || []).some(line =>
      line?.text?.trim() && line.startMs <= sample.timeMs && sample.timeMs < line.endMs
    )
    if (inLyric) voicedFrames++
  }
  return Math.min(100, Math.round(100 * voicedFrames / expectedFrames))
}

// 联机实时音准累计：只计算 20% 的音准部分；80% 完整度由 ASR 字符覆盖率累加。
export function calcLiveScoreIncrement(midi, refMidi, expectedFrames, voiceActive = false, version = SCORING_VERSION) {
  if (!expectedFrames || !Number.isFinite(refMidi)) return 0
  const active = voiceActive || Number.isFinite(midi)
  if (!active) return 0
  const penalty = version >= 5 ? 5 : version >= 4 ? 10 : 20
  const pitchQuality = Number.isFinite(midi)
    ? Math.max(0, 100 - Math.abs(midi - refMidi) * penalty)
    : 0
  return (pitchQuality * 0.2) / expectedFrames
}

export function calcAccuracyScore(samples, refNotes, version = SCORING_VERSION) {
  const expectedFrames = countExpectedFrames(refNotes)
  const pitchPenalty = version >= 5 ? 5 : version >= 4 ? 10 : 20

  let voicedFrames = 0
  let pitchedFrames = 0
  let capturedFrames = 0
  let points = 0
  let highFrames = 0
  let lowFrames = 0
  let octaveHighFrames = 0
  let octaveLowFrames = 0
  for (const sample of samples) {
    const ref = getRefNoteAt(refNotes, sample.timeMs)
    if (!ref) continue
    capturedFrames++
    if (sample.voiceActive !== true && !Number.isFinite(sample.midi)) continue
    voicedFrames++
    if (!Number.isFinite(sample.midi)) continue
    const difference = sample.midi - ref.midi
    points += Math.max(0, 100 - Math.abs(difference) * pitchPenalty)
    if (difference > 0.5) highFrames++
    if (difference < -0.5) lowFrames++
    if (difference >= 10 && difference <= 14) octaveHighFrames++
    if (difference >= -14 && difference <= -10) octaveLowFrames++
    pitchedFrames++
  }

  const denominator = version >= 2 ? capturedFrames : expectedFrames
  const accuracy = pitchedFrames ? Math.round(points / pitchedFrames) : 0
  const coverageDenominator = version >= 3 ? expectedFrames : denominator
  const coverage = coverageDenominator
    ? Math.min(100, Math.round(100 * voicedFrames / coverageDenominator))
    : 0
  const score = version >= 3
    ? Math.round(coverage * 0.8 + accuracy * 0.2)
    : (denominator ? Math.min(100, Math.round(points / denominator)) : 0)
  return {
    accuracy,
    coverage,
    completeness: coverage,
    score,
    pitchProfile: { pitchedFrames, expectedFrames, highFrames, lowFrames, octaveHighFrames, octaveLowFrames },
    sampleQuality: expectedFrames ? Math.min(100, 100 * capturedFrames / expectedFrames) : 0
  }
}
