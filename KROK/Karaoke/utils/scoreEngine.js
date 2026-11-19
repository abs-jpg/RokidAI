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
 * 总分 = 音准分 * 0.6 + 清晰度分 * 0.4
 * @param {number} accuracyScore - 音准得分 0-100
 * @param {number} clarityScore - 清晰度得分 0-100
 * @returns {number} 综合评分 0-100（四舍五入）
 */
export function calcTotalScore(accuracyScore, clarityScore) {
  const acc = Math.max(0, Math.min(100, accuracyScore || 0));
  const cla = Math.max(0, Math.min(100, clarityScore || 0));
  return Math.round(acc * 0.6 + cla * 0.4);
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
