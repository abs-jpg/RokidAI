// 评分引擎
// 清晰度评分（开发阶段降级为启发式估算，标注待接入）+ 综合评分 + 等级评定

/**
 * 计算清晰度得分
 * 开发阶段降级：基于 RMS 音量和有效音长占比的启发式估算
 * 界面标注"清晰度 · 待接入"
 * 真实路径：录音结束后 → MediaRecorder 收集的音频 → SpeechRecognitionSession → 识别歌词 → 与标准歌词比对计算匹配率
 *
 * @param {Object} params - 评分参数
 * @param {Float32Array|number[]} params.audioBuffer - 录音时域数据（可选，用于 RMS 计算）
 * @param {number} params.validFrames - 有效发声帧数（F0 非 null 的帧数）
 * @param {number} params.totalFrames - 总帧数
 * @returns {{ score: number, isEstimated: boolean, label: string }}
 */
export function calcClarityScore(params) {
  // 开发阶段：清晰度评分基于启发式估算
  // 真实路径（SpeechRecognitionSession 歌词匹配率）待接入
  const isEstimated = true;

  if (!params || (!params.audioBuffer && params.validFrames == null)) {
    return { score: 0, isEstimated, label: '待接入' };
  }

  let rms = 0;
  let validRatio = 0;

  // 从音频缓冲区计算 RMS
  if (params.audioBuffer && params.audioBuffer.length > 0) {
    let sum = 0;
    for (let i = 0; i < params.audioBuffer.length; i++) {
      sum += params.audioBuffer[i] * params.audioBuffer[i];
    }
    rms = Math.sqrt(sum / params.audioBuffer.length);
  }

  // 有效音长占比
  if (params.totalFrames > 0 && params.validFrames != null) {
    validRatio = params.validFrames / params.totalFrames;
  }

  // 启发式估算：
  // RMS 0.01~0.3 映射到 40~80 分（音量适中得分高）
  // validRatio 0~1 映射到 20~40 分（有效发声占比越高越好）
  let rmsScore = 0;
  if (rms > 0) {
    // RMS 在 0.05~0.15 区间为最佳（正常演唱音量）
    if (rms >= 0.05 && rms <= 0.15) {
      rmsScore = 80;
    } else if (rms > 0.15 && rms <= 0.3) {
      rmsScore = 70;
    } else if (rms > 0.03 && rms < 0.05) {
      rmsScore = 55;
    } else if (rms > 0.3) {
      rmsScore = 50; // 过大声可能爆音
    } else {
      rmsScore = 40; // 声音太小
    }
  }

  let ratioScore = 0;
  if (validRatio > 0) {
    ratioScore = Math.round(20 + validRatio * 20); // 20~40 分
  }

  const score = Math.max(0, Math.min(100, rmsScore + ratioScore));

  return { score, isEstimated, label: '待接入' };
}

/**
 * 计算综合评分
 * 总分 = 完整度 * 0.8 + 音准 * 0.2
 * 优先鼓励唱完整首歌词，不把少量音高偏差放大成低分。
 * @param {number} completenessScore - 演唱完整度 0-100
 * @param {number} pitchScore - 音准得分 0-100
 * @returns {number} 综合评分 0-100（四舍五入）
 */
export function calcTotalScore(completenessScore, pitchScore) {
  const completeness = Math.max(0, Math.min(100, completenessScore || 0));
  const pitch = Math.max(0, Math.min(100, pitchScore || 0));
  return Math.round(completeness * 0.8 + pitch * 0.2);
}

/**
 * 根据总分评定等级
 * S(≥90) / A(≥80) / B(≥70) / C(≥60) / D(<60)
 * @param {number} score - 总分 0-100
 * @returns {{ grade: string, label: string }}
 */
export function getGrade(score) {
  if (score >= 90) return { grade: 'S', label: '惊艳' };
  if (score >= 80) return { grade: 'A', label: '优秀' };
  if (score >= 70) return { grade: 'B', label: '不错' };
  if (score >= 60) return { grade: 'C', label: '及格' };
  return { grade: 'D', label: '加油' };
}

/**
 * 歌词匹配分：用最长公共子序列估算识别文本与标准歌词的相似度，返回 0-100。
 * 仅供复查和反馈展示；正式完整度必须根据发声时段计算，不能因为 ASR 错字扣分。
 */
function normalizeLyrics(text) {
  return String(text || '').replace(/[\s，。、！？!?,，.·「」『』（）()\[\]"'“”‘’…—\-:：;；]/g, '');
}

export function countLyricCharacters(text) {
  return Array.from(normalizeLyrics(text)).length;
}

export function calcLyricLengthCompleteness(recognizedText, lyricsText) {
  const expected = countLyricCharacters(lyricsText);
  if (!expected) return 0;
  const recognized = countLyricCharacters(recognizedText);
  return Math.min(100, Math.round(100 * recognized / expected));
}

function longestCommonSubsequenceLength(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const curr = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[m];
}

export function calcLyricMatchScore(recognizedText, lyricsText) {
  const a = normalizeLyrics(recognizedText);
  const b = normalizeLyrics(lyricsText);
  if (!a.length || !b.length) return 0;
  const lcs = longestCommonSubsequenceLength(a, b);
  return Math.min(100, Math.round(100 * 2 * lcs / (a.length + b.length)));
}

// 拉丁文字按词核对，中日韩文字按字核对。保留原文位置，以便指出短片段。
function lyricReviewTokens(text) {
  return Array.from(text.matchAll(/[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}\p{N}]+)*|[\p{L}\p{N}]/gu), match => ({
    key: match[0].normalize('NFKC').toLowerCase().replace(/['’]/g, ''),
    start: match.index,
    end: match.index + match[0].length
  }));
}

function recognitionReviewSnippets(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const snippets = [];
  for (const phrase of normalized.split(/[。！？!?；;\n]+/u).map(value => value.trim()).filter(Boolean)) {
    const tokens = lyricReviewTokens(phrase);
    if (!tokens.length) continue;
    const limit = phrase.includes(' ') ? 48 : 24;
    if (phrase.length <= limit) {
      snippets.push(phrase);
      continue;
    }
    let start = 0;
    while (start < tokens.length) {
      let end = start + 1;
      while (end < tokens.length && tokens[end].end - tokens[start].start <= limit) end++;
      const snippet = phrase.slice(tokens[start].start, tokens[end - 1].end).trim();
      if (snippet) snippets.push(snippet);
      start = end;
    }
  }
  return [...new Set(snippets)];
}

function buildLyricReview(lyrics, recognizedText, completed, sungUntilMs, random = Math.random) {
  const lines = lyrics.map((line, index) => {
    const text = String(line?.text || '').trim();
    return {
      number: index + 1,
      text,
      normalized: normalizeLyrics(text),
      tokens: lyricReviewTokens(text),
      endMs: line?.endMs
    };
  }).filter(line => line.tokens.length);

  const heardText = String(recognizedText || '').trim();
  const heardTokens = lyricReviewTokens(heardText);
  if (!heardTokens.length) {
    return ['这一遍已经把旋律走完，下一遍继续跟着歌词唱，保持现在的节奏和清楚咬字。'];
  }
  const sungLines = completed ? lines : lines.filter(line => line.endMs <= sungUntilMs);
  const heardNormalized = normalizeLyrics(heardText);
  const exactMatches = sungLines.filter(line =>
    line.normalized && heardNormalized.includes(line.normalized)
  );
  const randomValue = typeof random === 'function' ? random() : random;
  const secureRandomValue = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(0.999999, randomValue))
    : Math.random();

  if (exactMatches.length) {
    return ['这一句歌词跟得很准，咬字也很清楚，下一遍继续保持。'];
  }

  const snippets = recognitionReviewSnippets(heardText);
  const snippet = snippets[Math.floor(secureRandomValue * Math.max(1, snippets.length))] || '';
  const snippetTokens = lyricReviewTokens(snippet).map(token => token.key);
  let bestCoverage = 0;
  if (snippetTokens.length) {
    for (const line of sungLines) {
      const lineTokens = line.tokens.map(token => token.key);
      const matched = longestCommonSubsequenceLength(lineTokens, snippetTokens);
      bestCoverage = Math.max(bestCoverage, matched / lineTokens.length);
    }
  }
  if (bestCoverage >= 0.65) {
    return ['这一句已经跟上了歌词，个别字再唱清楚一点，下一遍会更顺畅。'];
  }
  return ['这一段的节奏跟得比较稳，下一遍继续跟着歌词唱，保持清楚的咬字。'];
}

function practicePitchAdvice(profile) {
  if (!profile || profile.pitchedFrames < Math.max(12, profile.expectedFrames * 0.08)) {
    return '这一遍的音高轨迹已经记录下来，下一遍继续跟着起音和长音唱，保持现在的节奏。';
  }
  const {
    pitchedFrames,
    highFrames,
    lowFrames,
    octaveHighFrames,
    octaveLowFrames,
    averageLowDifference,
    averageHighDifference
  } = profile;
  const lowSemitones = Math.max(0.5, Number(averageLowDifference) || 0).toFixed(1);
  const highSemitones = Math.max(0.5, Number(averageHighDifference) || 0).toFixed(1);
  if (Math.max(octaveHighFrames, octaveLowFrames) >= pitchedFrames * 0.6) {
    if (octaveLowFrames >= octaveHighFrames) {
      return `整体音高比参考低约 ${lowSemitones} 个半音，接近一个八度；下一遍保持现在的节奏，再把起音带到更高的音区。`;
    }
    return `整体音高比参考高约 ${highSemitones} 个半音，接近一个八度；下一遍保持现在的节奏，再把起音放到更合适的音区。`;
  }
  const high = highFrames / pitchedFrames;
  const low = lowFrames / pitchedFrames;
  if (low >= 0.6) {
    return `整体音高比参考低约 ${lowSemitones} 个半音；下一遍保持现在的节奏和长音，再把音高轻轻往上托一点。`;
  }
  if (high >= 0.6) {
    return `整体音高比参考高约 ${highSemitones} 个半音；下一遍保持现在的节奏和长音，再把音高轻轻往下收一点。`;
  }
  if (high + low < 0.2) {
    return '大部分音高贴近参考旋律，下一遍继续保持现在的起音、长音和句尾稳定。';
  }
  return '这一遍的音高起伏已经控制得不错，下一遍继续保持长音和句尾稳定。';
}

export function buildPracticeFeedback({
  lyrics = [],
  recognizedText,
  completed,
  sungUntilMs,
  hasRefNotes,
  pitchProfile,
  random
}) {
  const lyricReview = buildLyricReview(lyrics, recognizedText, completed, sungUntilMs, random);
  const pitchReview = hasRefNotes
    ? practicePitchAdvice(pitchProfile)
    : '这一遍先跟着伴奏找好起音，下一遍继续保持现在的节奏和清楚咬字。';
  return [...lyricReview, pitchReview];
}
