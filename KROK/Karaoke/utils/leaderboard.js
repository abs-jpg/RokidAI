import wx from 'wx';
import { createOpenAPI } from 'open';
import { LEADERBOARD_API_URL, LEADERBOARD_API_URLS } from './leaderboardConfig.js';
import { SCORING_VERSION } from './pitchEngine.js';

const STORAGE_KEY = 'karaoke_leaderboard';
const SERVER_URL = LEADERBOARD_API_URL.trim().replace(/\/+$/, '');
const SERVER_URLS = (typeof LEADERBOARD_API_URLS !== 'undefined' && LEADERBOARD_API_URLS) ||
  (SERVER_URL ? [SERVER_URL] : []);
const TOKEN_KEY = 'karaoke_server_token:' + SERVER_URL;
const TOKEN_BIND_KEY = TOKEN_KEY + ':rokid:verified';
const PENDING_KEY = TOKEN_KEY + ':pending';
const MAX_PENDING_SCORES = 20;
const REQUEST_TIMEOUT_MS = 5000;
const NATIVE_REQUEST_TIMEOUT_MS = 12000;
const PROFILE_TIMEOUT_MS = 4000;
let registration;
let profilePromise;
let accountNotice = '';
let flushing;

/**
 * 从本地存储读取排行榜数据
 * @returns {Array<{userId, songId, songName, score, accuracy, coverage, date}>}
 */
function readLocal() {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (data && Array.isArray(data)) return data;
  } catch (e) {
    console.error('leaderboard readLocal error', e);
  }
  return [];
}

/**
 * 写入本地存储
 * @param {Array} list
 */
function writeLocal(list) {
  try {
    wx.setStorageSync(STORAGE_KEY, list);
    return true;
  } catch (e) {
    console.error('leaderboard writeLocal error', e);
    return false;
  }
}

/**
 * 生成简易用户 ID（首次使用时存入本地）
 * @returns {string}
 */
function getUserId() {
  try {
    let uid = wx.getStorageSync('karaoke_uid');
    if (!uid) {
      uid = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      wx.setStorageSync('karaoke_uid', uid);
    }
    return uid;
  } catch (e) {
    return 'user_guest';
  }
}

function requestWithWx(url, options) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: options?.method || 'GET',
      header: options?.headers || {},
      data: options?.body,
      dataType: 'text',
      timeout: NATIVE_REQUEST_TIMEOUT_MS,
      success(result) {
        const status = result.statusCode;
        let body = result.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch { body = null; }
        }
        resolve({ ok: status >= 200 && status < 300, status, body });
      },
      fail(error) { reject(new Error(error?.errMsg || '无法连接排行榜服务器')); }
    });
  });
}

async function request(path, options) {
  let lastError = new Error('服务器地址未配置');
  for (const baseUrl of SERVER_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(baseUrl + path, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (typeof wx.request === 'function') {
      try { return await requestWithWx(baseUrl + path, options); }
      catch (error) { lastError = error; }
    }
  }
  throw lastError;
}

function readToken() {
  const token = wx.getStorageSync(TOKEN_KEY);
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function loadRokuIdentity() {
  if (!profilePromise) {
    profilePromise = (async () => {
      let timer;
      try {
        const profile = await Promise.race([
          (async () => {
            const api = await createOpenAPI();
            return api.account.getProfile();
          })(),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('账号查询超时')), PROFILE_TIMEOUT_MS);
          })
        ]);
        accountNotice = typeof profile?.notification === 'string' ? profile.notification : '';
        if (!profile || typeof profile.accountId !== 'string' || !profile.accountId) return null;
        return {
          accountId: profile.accountId,
          code: profile.code || ''
        };
      } catch (e) {
        console.error('Rokid getProfile failed', e);
        accountNotice = '账号服务暂不可用';
        return null;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { profilePromise = null; });
  }
  return profilePromise;
}

async function getToken() {
  const token = readToken();
  const identity = await loadRokuIdentity();
  let boundRoku = '';
  try {
    boundRoku = wx.getStorageSync(TOKEN_BIND_KEY) || '';
  } catch (e) {
    boundRoku = '';
  }
  const canLink = Boolean(identity?.accountId && identity.code && !accountNotice);
  if (token && (!identity || boundRoku === identity.accountId || (!boundRoku && !canLink))) return token;
  if (boundRoku && (!identity || (identity.accountId === boundRoku && !canLink))) {
    throw new Error(accountNotice || '请重新授权 Rokid 账号');
  }
  if (!registration) {
    registration = (async () => {
      let response;
      if (canLink) {
        response = await request('/api/players', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rokuUserId: identity.accountId, rokuCode: identity.code })
        });
        if (!response.ok || response.body?.accountLinked !== true) {
          if (![403, 503].includes(response.status)) throw new Error('无法绑定 Rokid 账号');
          if (boundRoku === identity.accountId) throw new Error('账号校验暂不可用，请稍后重试');
          accountNotice = '账号校验暂不可用 · 使用匿名歌手';
          if (token && !boundRoku) return token;
          response = null;
        }
      }
      if (!response) response = await request('/api/players', { method: 'POST' });
      const newToken = response.body?.token;
      if (!response.ok || typeof newToken !== 'string' || !/^[a-f0-9]{64}$/.test(newToken)) {
        throw new Error('无法取得服务器歌手身份');
      }
      wx.setStorageSync(TOKEN_KEY, newToken);
      wx.setStorageSync(TOKEN_BIND_KEY, response.body.accountLinked === true ? identity.accountId : '');
      return newToken;
    })().finally(() => { registration = null; });
  }
  return registration;
}

function readBinding() {
  return wx.getStorageSync(TOKEN_BIND_KEY) || '';
}

async function uploadScore(entry, samples, owner) {
  // 第 3 版起覆盖率的分母是谱面帧数，静音帧可省略；音高值保留原始精度。
  const uploadSamples = entry.scoringVersion >= 3
    ? samples.filter(([, midi, voice]) => midi !== null || voice === 1)
      .map(sample => sample[2] === Number(sample[1] !== null) ? sample.slice(0, 2) : sample)
    : samples;
  const body = JSON.stringify({
    attemptId: entry.attemptId,
    songId: entry.songId,
    chartVersion: entry.chartVersion,
    scoringVersion: entry.scoringVersion,
    completed: entry.completed,
    recognizedText: entry.recognizedText || '',
    samples: uploadSamples
  });
  const send = token => request('/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body
  });
  const token = await getToken();
  if (owner && readBinding() !== owner) throw new Error('待上传成绩属于其他账号');
  const response = await send(token);
  if (response.status !== 401) return response;
  if (readToken() === token) wx.setStorageSync(TOKEN_KEY, '');
  const renewed = await getToken();
  if (owner && readBinding() !== owner) throw new Error('待上传成绩属于其他账号');
  return send(renewed);
}

function scoreUploadMessage(errorCode) {
  switch (errorCode) {
    case 'VERSION_MISMATCH': return '曲谱或计分版本不一致';
    case 'BODY_TOO_LARGE': return '服务器限制了成绩数据大小';
    case 'NOT_ELIGIBLE': return '服务器未识别到有效唱词';
    case 'INVALID_RECOGNITION': return '识别唱词格式无效';
    case 'INVALID_PITCH_TRACK': return '音高记录格式无效';
    case 'ATTEMPT_CONFLICT': return '服务器已有不同的同编号成绩';
    case 'SONG_NOT_FOUND': return '服务器曲库中找不到这首歌';
    default: return '服务器未接收成绩';
  }
}

function readPending() {
  const list = wx.getStorageSync(PENDING_KEY);
  return Array.isArray(list) ? list : [];
}

function getScoreUploadBlock(entry) {
  if (entry.completed !== true) return '唱完最后一句后才能上榜';
  if (entry.scoringVersion !== SCORING_VERSION) return '评分版本不一致';
  if (!isServerConnected()) return '当前版本未配置排行榜服务器';
  return '';
}

export function flushPendingScores() {
  if (flushing) return flushing;
  flushing = (async () => {
    const results = new Map();
    if (!isServerConnected()) return results;
    const visited = new Set();
    for (;;) {
      const item = readPending().find(item => !visited.has(item.entry.attemptId) &&
        (!item.owner || item.owner === readBinding()));
      if (!item) return results;
      const id = item.entry.attemptId;
      visited.add(id);
      try {
        const response = await uploadScore(item.entry, item.samples, item.owner);
        const uploaded = response.ok && response.body?.ok === true;
        const permanent = response.status >= 400 && response.status < 500 && ![401, 413, 429].includes(response.status);
        const message = scoreUploadMessage(response.status === 413 ? 'BODY_TOO_LARGE' : response.body?.error);
        if (response.status === 413) {
          results.set(id, { uploaded: false, retryable: true, message });
          continue;
        }
        if (!uploaded && !permanent) {
          results.set(id, {
            uploaded: false,
            retryable: true,
            message: response.status === 429 ? '服务器限流 · 稍后补传' : '服务器暂未确认 · 待补传'
          });
          return results;
        }
        wx.setStorageSync(PENDING_KEY, readPending().filter(value => value.entry.attemptId !== id));
        results.set(id, { uploaded, message });
      } catch (error) {
        console.error('pending score upload failed', error);
        return results;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

export async function submitScore(entry, samples) {
  const record = {
    ...entry,
    userId: getUserId(),
    date: new Date().toLocaleDateString('zh-CN')
  };
  saveScoreLocal(record);
  const blocked = getScoreUploadBlock(entry);
  if (blocked) {
    return { uploaded: false, retryable: false, message: blocked };
  }

  let queued = false;
  try {
    const pending = readPending();
    if (!pending.some(item => item.entry.attemptId === entry.attemptId)) {
      if (pending.length >= MAX_PENDING_SCORES) {
        return { uploaded: false, retryable: true, message: '待上传空间已满 · 联网后确认重试' };
      }
      pending.push({ entry, samples, owner: readBinding() });
      wx.setStorageSync(PENDING_KEY, pending);
    }
    queued = true;
    const results = await flushPendingScores();
    const result = results.get(entry.attemptId);
    if (result?.uploaded) {
      return { uploaded: true, message: '已保存到服务器排行榜' };
    }
    if (result) {
      return result;
    }
  } catch (error) {
    console.error('leaderboard upload failed', error);
  }
  return {
    uploaded: false,
    retryable: true,
    message: queued ? '未能连接服务器 · 待补传' : '上传未完成 · 确认重试'
  };
}

/**
 * 将成绩存入本地存储（内部方法）
 * @param {Object} record
 */
function saveScoreLocal(record) {
  const list = readLocal();
  if (record.attemptId && list.some(item => item.attemptId === record.attemptId)) return true;
  list.push(record);
  // 按分数降序排列
  list.sort((a, b) => b.score - a.score);
  // 保留前 50 条
  if (list.length > 50) list.length = 50;
  return writeLocal(list);
}

/**
 * 保存成绩（同步接口，供不使用 Promise 的调用方使用）
 * @param {Object} record - 成绩记录
 */
export function saveScore(record) {
  saveScoreLocal({
    ...record,
    userId: getUserId(),
    date: record.date || new Date().toLocaleDateString('zh-CN')
  });
}

/**
 * 获取排行榜
 * 真实路径：fetch GET 从自建服务器
 * 开发阶段降级：从本地存储读取
 * @param {string} [songId] - 可选，按歌曲筛选
 * @returns {Promise<{ list: Array, source: string, connected: boolean }>}
 */
export async function getLeaderboard(songId) {
  if (isServerConnected()) {
    try {
      const token = readToken();
      const query = songId ? '?songId=' + encodeURIComponent(songId) : '';
      const response = await request('/api/leaderboard' + query, {
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (response.ok && Array.isArray(response.body?.list)) {
        return { list: response.body.list, myRank: response.body.myRank, source: 'server', connected: true };
      }
    } catch (e) {
      console.error('getLeaderboard fetch error', e);
    }
  }

  let list = readLocal();
  if (songId) {
    list = list.filter(item => item.songId === songId);
  }
  // 按分数降序
  list.sort((a, b) => b.score - a.score);
  return { list, source: 'local', connected: false };
}

/**
 * 检查是否已配置服务器地址。
 * 内测允许 HTTP（IP + 非标准端口）；正式上线请改用 HTTPS 域名。
 * @returns {boolean}
 */
export function isServerConnected() {
  return SERVER_URLS.length > 0 && SERVER_URLS.every(url => /^https?:\/\/[^/?#]+$/.test(url));
}

export async function getPlayerToken() {
  return getToken();
}

export async function submitSongRequest(id, text) {
  const body = JSON.stringify({ id, text });
  const send = token => request('/api/song-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body
  });
  const token = await getPlayerToken();
  let response = await send(token);
  if (response.status === 401) {
    invalidatePlayerToken(token);
    response = await send(await getPlayerToken());
  }
  if (response.ok && response.body?.ok === true) return;
  if (response.status === 404) throw new Error('服务器尚未开通留言');
  if (response.status === 429) throw new Error('发送太频繁，请稍后再试');
  throw new Error('留言未送达，请重试');
}

export function getAccountNotice() {
  return accountNotice;
}

export function invalidatePlayerToken(token) {
  try {
    if (readToken() === token) wx.setStorageSync(TOKEN_KEY, '');
  } catch (error) {
    console.error('无法清除过期歌手凭据', error);
  }
}
