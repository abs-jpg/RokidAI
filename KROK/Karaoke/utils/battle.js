// 联机对战模块
// 开发阶段降级：本地模拟匹配 + 异步比分比对，标注"非真实联机"
// 真实路径：WebSocket 信令 + RTCPeerConnection 音频传输

import { songs } from './songData.js';

const SIGNAL_SERVER = ''; // 信令服务器地址，部署后填写
const CONNECTED = false; // 信令服务器未部署，使用本地模拟

/**
 * 发起联机匹配
 * 真实路径：连接 WebSocket 信令服务器，发送匹配请求，等待对手
 * 开发阶段降级：本地模拟，延迟 10-15 秒后随机成功/失败
 *
 * @param {{ onStatus: Function, onMatched: Function, onFailed: Function, signal: AbortSignal }} params
 * @returns {Promise<{ success: boolean, opponentId: string, songId: string, message?: string }>}
 */
export function startMatch(params) {
  const { onStatus, onMatched, onFailed, signal } = params || {};

  if (CONNECTED && SIGNAL_SERVER) {
    // 真实路径：WebSocket 信令
    return startRealMatch(params);
  }

  // 本地模拟降级
  return startSimulatedMatch(params);
}

/**
 * 本地模拟匹配
 * 延迟 10-15 秒后随机成功（80%）或失败（20%）
 */
function startSimulatedMatch(params) {
  const { onStatus, onMatched, onFailed, signal } = params || {};

  return new Promise((resolve) => {
    const delay = 10000 + Math.floor(Math.random() * 5000); // 10-15 秒

    // 更新状态文案
    const statusMessages = [
      '搜索对手中…',
      '正在匹配…',
      '等待对手响应…'
    ];
    let msgIdx = 0;
    if (onStatus) onStatus(statusMessages[0]);

    const statusTimer = setInterval(() => {
      msgIdx = (msgIdx + 1) % statusMessages.length;
      if (onStatus) onStatus(statusMessages[msgIdx]);
    }, 3000);

    // 模拟匹配结果
    const matchTimer = setTimeout(() => {
      clearInterval(statusTimer);
      const success = Math.random() > 0.2; // 80% 成功率
      const songId = songs[0].id;
      const opponentId = 'rival_' + Math.random().toString(36).slice(2, 8);

      if (success) {
        if (onMatched) onMatched({ opponentId, songId });
        resolve({ success: true, opponentId, songId, message: '已匹配到对手' });
      } else {
        if (onFailed) onFailed('未能找到对手');
        resolve({ success: false, opponentId: '', songId: '', message: '未能找到对手' });
      }
    }, delay);

    // 支持取消（AbortSignal 或 cancelMatch）
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(matchTimer);
        clearInterval(statusTimer);
        if (onFailed) onFailed('已取消匹配');
        resolve({ success: false, opponentId: '', songId: '', message: '已取消匹配' });
      });
    }

    // 存 timer id 供 cancelMatch 使用
    _activeMatchTimers = { statusTimer, matchTimer, resolve };
  });
}

let _activeMatchTimers = null;

/**
 * 取消匹配
 */
export function cancelMatch() {
  if (_activeMatchTimers) {
    clearTimeout(_activeMatchTimers.matchTimer);
    clearInterval(_activeMatchTimers.statusTimer);
    _activeMatchTimers.resolve({ success: false, opponentId: '', songId: '', message: '已取消匹配' });
    _activeMatchTimers = null;
  }
}

/**
 * 真实路径：WebSocket 信令匹配（待接入）
 */
async function startRealMatch(params) {
  const { onStatus, onMatched, onFailed } = params || {};

  try {
    if (onStatus) onStatus('连接服务器…');

    // 尝试创建 WebSocket 连接
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket not supported');
    }

    const ws = new WebSocket(SIGNAL_SERVER);
    // WebSocket 信令逻辑待接入
    // 此处为占位，真实部署后实现完整信令流程
    return { success: false, opponentId: '', songId: '', message: '信令服务器待接入' };
  } catch (e) {
    console.error('startRealMatch error', e);
    if (onFailed) onFailed('连接失败');
    return { success: false, opponentId: '', songId: '', message: '连接失败' };
  }
}

/**
 * 异步比对双方成绩（开发阶段降级）
 * 双方各自录制后，将成绩比对展示
 * 真实路径：通过 RTCDataChannel 同步双方成绩
 *
 * @param {{ myScore: number, opponentScore: number }} scores
 * @returns {{ winner: 'me'|'opponent'|'draw', myScore: number, opponentScore: number, message: string }}
 */
export function compareScores(scores) {
  const { myScore, opponentScore } = scores;

  if (myScore > opponentScore) {
    return {
      winner: 'me',
      myScore,
      opponentScore,
      message: '你赢了！'
    };
  } else if (myScore < opponentScore) {
    return {
      winner: 'opponent',
      myScore,
      opponentScore,
      message: '对手获胜'
    };
  } else {
    return {
      winner: 'draw',
      myScore,
      opponentScore,
      message: '平局'
    };
  }
}

/**
 * 生成模拟对手分数（开发阶段）
 * @param {number} myScore - 我的分数，用于生成相近的对手分数
 * @returns {number}
 */
export function generateOpponentScore(myScore) {
  // 在我的分数 ±15 范围内随机生成
  const offset = Math.floor(Math.random() * 30) - 15;
  return Math.max(0, Math.min(100, myScore + offset));
}

/**
 * 检查是否为真实联机
 * @returns {boolean}
 */
export function isRealConnection() {
  return CONNECTED;
}
