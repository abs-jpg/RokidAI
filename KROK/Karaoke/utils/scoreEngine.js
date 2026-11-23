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

const MAX_LYRIC_ALIGNMENT_CELLS = 3_000_000;
const MAX_LYRIC_EXAMPLES = 2;

// 拉丁文字按词核对，中日韩文字按字核对。保留原文位置，以便指出短片段。
function lyricReviewTokens(text) {
  return Array.from(text.matchAll(/[\p{Script=Latin}\p{N}]+(?:['’][\p{Script=Latin}\p{N}]+)*|[\p{L}\p{N}]/gu), match => ({
    key: match[0].normalize('NFKC').toLowerCase().replace(/['’]/g, ''),
    start: match.index,
    end: match.index + match[0].length
  }));
}

function alignLyricReview(lines, heard, completed) {
  const expected = lines.flatMap(line => line.tokens.map(token => ({ key: token.key, line })));
  const columns = heard.length + 1;
  const cells = (expected.length + 1) * columns;
  if (!heard.length || !expected.length || cells > MAX_LYRIC_ALIGNMENT_CELLS) return;

  const directions = new Uint8Array(cells);
  let previous = new Uint32Array(columns);
  let current = new Uint32Array(columns);
  for (let j = 1; j < columns; j++) previous[j] = j;

  for (let i = 1; i <= expected.length; i++) {
    current[0] = i;
    const row = i * columns;
    const key = expected[i - 1].key;
    for (let j = 1; j < columns; j++) {
      const diagonal = previous[j - 1] + (key === heard[j - 1].key ? 0 : 1);
      const missing = previous[j] + 1;
      const extra = current[j - 1] + 1;
      if (diagonal <= missing && diagonal <= extra) {
        current[j] = diagonal;
      } else if (missing <= extra) {
        current[j] = missing;
        directions[row + j] = 1;
      } else {
        current[j] = extra;
        directions[row + j] = 2;
      }
    }
    [previous, current] = [current, previous];
  }

  // 提前结束时，末尾可能还有一段未唱完的歌词，允许识别文本尾部未被匹配。
  let end = heard.length;
  if (!completed) {
    for (let j = 0; j < heard.length; j++) {
      if (previous[j] < previous[end]) end = j;
    }
  }

  for (let i = expected.length, j = end; i > 0;) {
    const token = expected[i - 1];
    const line = token.line;
    const direction = j === 0 ? 1 : directions[i * columns + j];
    if (direction === 1) {
      line.edits++;
      i--;
      continue;
    }
    line.heardStart = j - 1;
    if (line.heardEnd == null) line.heardEnd = j;
    if (direction === 2) {
      line.edits++;
    } else {
      if (token.key === heard[j - 1].key) {
        line.matches++;
      } else {
        line.edits++;
      }
      i--;
    }
    j--;
  }
}

function lyricReviewExcerpt(text, tokens, focus = 0) {
  const limit = 24;
  if (text.length <= limit) return text;
  const index = Math.min(focus, tokens.length - 1);
  const previous = tokens[Math.max(0, index - 1)];
  const start = tokens[index].end - previous.start <= limit ? previous.start : tokens[index].start;
  let end = Math.min(start + limit, tokens[index].end);
  for (let i = index + 1; i < tokens.length && tokens[i].end - start <= limit; i++) end = tokens[i].end;
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function buildLyricReview(lyrics, recognizedText, completed, sungUntilMs) {
  const lines = lyrics.map((line, index) => {
    const text = String(line?.text || '').trim();
    return { number: index + 1, text, tokens: lyricReviewTokens(text), endMs: line?.endMs, edits: 0, matches: 0 };
  }).filter(line => line.tokens.length);

  const heardText = String(recognizedText || '').trim();
  const heardTokens = lyricReviewTokens(heardText);
  if (!heardTokens.length) return ['本次没有取得可对照的识别唱词。'];
  const sungLines = completed ? lines : lines.filter(line => line.endMs <= sungUntilMs);
  alignLyricReview(sungLines, heardTokens, completed);

  const isAnchor = line => line && line.matches >= Math.max(1, Math.ceil(line.tokens.length * 0.65));
  const candidates = sungLines.filter((line, index) => line.heardStart != null &&
    (line.matches >= Math.min(2, line.tokens.length) ||
      (isAnchor(sungLines[index - 1]) && isAnchor(sungLines[index + 1]))));
  candidates.sort((a, b) => b.edits / b.tokens.length - a.edits / a.tokens.length || b.edits - a.edits || a.number - b.number);
  const differing = candidates.filter(line => line.edits > 0);
  const examples = (differing.length ? differing.slice(0, MAX_LYRIC_EXAMPLES) : candidates.slice(0, 1));
  if (!examples.length) {
    const observed = lyricReviewExcerpt(heardText, heardTokens);
    return ['识别「' + observed + '」。' + (lines.length ? '未找到可靠对应的原词。' : '这首歌缺少参考歌词。')];
  }

  return examples.map(line => {
    const heard = heardTokens.slice(line.heardStart, line.heardEnd);
    const mismatch = line.tokens.findIndex((token, index) => token.key !== heard[index]?.key);
    const focus = mismatch < 0 ? 0 : mismatch;
    const intended = lyricReviewExcerpt(line.text, line.tokens, focus);
    const heardStart = heard[0].start;
    const phrase = heardText.slice(heardStart, heard[heard.length - 1].end);
    const observed = lyricReviewExcerpt(phrase, lyricReviewTokens(phrase), focus);
    return '第' + line.number + '句 识别「' + observed + '」 · 原词「' + intended + '」。';
  });
}

function practicePitchAdvice(profile) {
  if (!profile || profile.pitchedFrames < Math.max(12, profile.expectedFrames * 0.08)) {
    return '音高样本较少，下次把长音唱稳，再对照参考线。';
  }
  const { pitchedFrames, highFrames, lowFrames, octaveHighFrames, octaveLowFrames } = profile;
  if (Math.max(octaveHighFrames, octaveLowFrames) >= pitchedFrames * 0.6) {
    const direction = octaveHighFrames > octaveLowFrames ? '高' : '低';
    return `实唱大多比参考${direction}近一个八度，先听起音确认音区。`;
  }
  const high = highFrames / pitchedFrames;
  const low = lowFrames / pitchedFrames;
  if (high >= 0.6) return '音准多半偏高，听清起音后往下微调。';
  if (low >= 0.6) return '音准多半偏低，听清起音后往上微调。';
  if (high + low < 0.2) return '大部分音贴近参考旋律，继续稳住句尾和长音。';
  if (high >= 0.15 && low >= 0.15) return '音高有时偏高、有时偏低，先唱稳长音，再练换音。';
  return high > low
    ? '有些片段偏高，重唱时留意换音后的落点。'
    : '有些片段偏低，重唱时跟住参考线的上行音。';
}

export function buildPracticeFeedback({ lyrics = [], recognizedText, completed, sungUntilMs, hasRefNotes, pitchProfile }) {
  const lyricReview = buildLyricReview(lyrics, recognizedText, completed, sungUntilMs);
  const pitchReview = hasRefNotes
    ? practicePitchAdvice(pitchProfile)
    : '这首歌缺少参考音高，可以先跟伴奏找准每句起音。';
  return [...lyricReview, pitchReview];
}
