// 서비스 워커: 오프스크린 OCR 중계 + 결과 캐시 + 뱃지/통계
const DEFAULTS = { enabled: true, mode: 'balanced', debug: false, allow: [] };

importScripts('phash.js');
const PH = self.KB_PHASH;

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: 'kb-report', title: '도박 배너로 신고 (차단 목록에 추가)', contexts: ['image'] }, () => void chrome.runtime.lastError);
  const cur = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...cur });
});

// ---- 캐시 (URL → OCR 결과) ----
const CACHE_KEY = 'kbCache3'; // scoring.js 규칙이 바뀌면 숫자를 올려 옛 점수 캐시를 무효화
chrome.storage.local.remove(['kbCache', 'kbCache2']).catch(() => {});
const CACHE_MAX = 3000;
let cache = null; // Map
let cacheLoading = null;
let persistTimer = null;

function keyOf(url) {
  const u = url.split('#')[0];
  if (u.length <= 300) return u;
  let h = 5381;
  for (let i = 0; i < u.length; i++) h = ((h << 5) + h + u.charCodeAt(i)) | 0;
  return 'h:' + u.length + ':' + h;
}
async function loadCache() {
  if (cache) return cache;
  if (!cacheLoading) {
    cacheLoading = chrome.storage.local.get(CACHE_KEY).then((o) => {
      cache = new Map(Object.entries(o[CACHE_KEY] || {}));
      return cache;
    });
  }
  return cacheLoading;
}
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!cache) return;
    if (cache.size > CACHE_MAX) {
      const sorted = [...cache.entries()].sort((a, b) => a[1].t - b[1].t);
      cache = new Map(sorted.slice(sorted.length - CACHE_MAX));
    }
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  }, 3000);
}

// ---- 오프스크린 ----
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: '온디바이스 OCR(Tesseract) 워커 실행',
      })
      .finally(() => { creating = null; });
  }
  await creating;
}
async function askOffscreen(payload) {
  await ensureOffscreen();
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'KB_OFFSCREEN_OCR', ...payload });
      if (r) return r;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 300)); // 오프스크린 스크립트가 아직 로드 중일 수 있음
  }
  return { ok: false, error: String((lastErr && lastErr.message) || 'offscreen unreachable') };
}

// ---- 신고 목록 (지각 해시만 저장: 이미지·URL·도메인은 저장하지 않음) ----
const KNOWN_KEY = 'kbKnown';
const KNOWN_MAX = 5000;
const KNOWN_DIST = 9; // 64비트 중 이만큼까지 다르면 같은 배너로 본다 (브라우저 실측 27장: 같은 배너 0.5~1.5배·JPEG ≤8, 서로 다른 배너 ≥17)
// 온디바이스 학습 목록 (모두 해시만, 기기 밖으로 나가지 않음)
//  known: 사용자가 우클릭으로 신고한 배너 / auto: 확실하게 차단한 배너를 스스로 기억 / safe: 사용자가 '복구'한 정상 배너
const AUTO_KEY = 'kbAuto', SAFE_KEY = 'kbSafe';
const AUTO_MAX = 2000, SAFE_MAX = 1000;
const LEARN_SCORE = 9; // OCR 점수가 이 이상(강한 키워드 3개 안팎)일 때만 스스로 학습
let known = null, auto = [], safe = [], seed = [];
// 기본 내장 목록(seed.json): 배포 때 함께 들어가는 확인된 불법 배너 해시. 읽기 전용이고 '복구'(정상 목록)가 항상 우선한다
async function loadSeed() {
  try {
    const j = await (await fetch(chrome.runtime.getURL('seed.json'))).json();
    seed = (j && Array.isArray(j.hashes) ? j.hashes : []).filter(PH.isHash);
  } catch (_) { seed = []; }
}
async function loadKnown() {
  if (!known) {
    const o = await chrome.storage.local.get([KNOWN_KEY, AUTO_KEY, SAFE_KEY]);
    known = (o[KNOWN_KEY] || []).filter(PH.isHash);
    auto = (o[AUTO_KEY] || []).filter(PH.isHash);
    safe = (o[SAFE_KEY] || []).filter(PH.isHash);
    await loadSeed();
  }
  return known;
}
async function saveKnown(resetCache = true) {
  if (known.length > KNOWN_MAX) known = known.slice(known.length - KNOWN_MAX);
  if (auto.length > AUTO_MAX) auto = auto.slice(auto.length - AUTO_MAX);
  if (safe.length > SAFE_MAX) safe = safe.slice(safe.length - SAFE_MAX);
  await chrome.storage.local.set({ [KNOWN_KEY]: known, [AUTO_KEY]: auto, [SAFE_KEY]: safe });
  if (resetCache) {
    cache = new Map(); // 신고/정상 목록이 바뀌면 점수 캐시 무효화
    await chrome.storage.local.remove(CACHE_KEY);
  }
}
const near = (list, h, d) => list.some((k) => PH.hamming(k, h) <= d);
function matchKnown(h) {
  return PH.usable(h) && (near(known, h, KNOWN_DIST) || near(auto, h, KNOWN_DIST) || near(seed, h, KNOWN_DIST));
}
function matchSafe(h) {
  return PH.usable(h) && near(safe, h, KNOWN_DIST);
}
// 확실하게 차단한 배너는 스스로 기억 (정상 목록에 있으면 학습하지 않음)
async function learnAuto(url) {
  try {
    const r = await askOffscreen({ op: 'hash', url });
    if (!r.ok || !PH.usable(r.hash) || matchSafe(r.hash) || matchKnown(r.hash)) return;
    auto.push(r.hash);
    await saveKnown(false);
  } catch (_) {}
}
// ---- 직접 지우기(수동 선택): 정확한 주소(쿼리 제외)도 기억해, 링크 밖 이미지·배경이미지도 다음에 자동으로 숨긴다 ----
const PICK_KEY = 'kbPicked', PICK_MAX = 500;
const pickKey = (u, frame) => { try { const x = new URL(u); return (frame ? 'f:' : '') + x.origin + x.pathname; } catch (_) { return ''; } };
async function addPicked(key) {
  if (!key) return;
  const o = (await chrome.storage.local.get(PICK_KEY))[PICK_KEY] || [];
  if (!o.includes(key)) await chrome.storage.local.set({ [PICK_KEY]: [...o, key].slice(-PICK_MAX) });
}
async function removePicked(urls) {
  const keys = new Set(urls.map((u) => pickKey(u, false)));
  const o = (await chrome.storage.local.get(PICK_KEY))[PICK_KEY] || [];
  const next = o.filter((k) => !keys.has(k));
  if (next.length !== o.length) await chrome.storage.local.set({ [PICK_KEY]: next });
}
async function framesOf(tabId) {
  try { return (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch (_) { return []; }
}
async function broadcast(tabId, msg) {
  for (const f of await framesOf(tabId)) chrome.tabs.sendMessage(tabId, msg, { frameId: f.frameId }).catch(() => {});
}

// 사용자가 '복구'한 배너: 학습 목록에서 빼고 정상 목록에 넣어 같은 오탐이 반복되지 않게 한다
async function unlearn(urls) {
  await loadKnown();
  let n = 0;
  for (const url of urls.slice(0, 20)) {
    const r = await askOffscreen({ op: 'hash', url });
    if (!r.ok || !PH.usable(r.hash)) continue;
    const h = r.hash;
    known = known.filter((k) => PH.hamming(k, h) > KNOWN_DIST);
    auto = auto.filter((k) => PH.hamming(k, h) > KNOWN_DIST);
    if (!near(safe, h, 2)) safe.push(h);
    n++;
  }
  await removePicked(urls);
  if (n) await saveKnown();
  return n;
}
async function addKnown(hashes) {
  await loadKnown();
  let added = 0;
  for (const h of hashes) {
    if (!PH.isHash(h) || !PH.usable(h)) continue;
    if (known.some((k) => PH.hamming(k, h) <= 2)) continue;
    known.push(h); added++;
  }
  if (added) await saveKnown();
  return added;
}
async function reportImage(url, tabId) {
  const r = await askOffscreen({ op: 'hash', url });
  if (!r.ok) return { ok: false, error: r.error };
  if (!PH.usable(r.hash)) return { ok: false, error: '단색에 가까운 이미지라 등록할 수 없습니다' };
  const added = await addKnown([r.hash]);
  // 모든 프레임에서 같은 이미지를 바로 숨김
  let frames = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch (_) {}
  for (const f of frames) chrome.tabs.sendMessage(tabId, { type: 'KB_HIDE_SRC', url }, { frameId: f.frameId }).catch(() => {});
  return { ok: true, added };
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'kb-report' || !info.srcUrl || !tab) return;
  reportImage(info.srcUrl, tab.id).then((r) => {
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: r.ok ? '#1a7f37' : '#888' });
    chrome.action.setBadgeText({ tabId: tab.id, text: r.ok ? '신고' : '실패' });
  });
});

async function handleOcr(msg) {
  const c = await loadCache();
  const key = keyOf(msg.url);
  const hit = c.get(key);
  if (hit) return { ok: true, cached: true, score: hit.s, hits: hit.h, text: hit.x || '' };
  await loadKnown();
  if (msg.hashOnly) { // 배너 비율이 아닌 링크 이미지: OCR 없이 학습 목록과만 대조(미일치는 캐시하지 않음)
    const none = { ok: true, score: 0, hits: [], text: '' };
    if (!known.length && !auto.length && !seed.length && !safe.length) return none;
    const hr = await askOffscreen({ op: 'hash', url: msg.url });
    if (hr.ok && !matchSafe(hr.hash) && matchKnown(hr.hash)) {
      c.set(key, { s: 99, h: ['학습목록'], x: '', t: Date.now() });
      persistSoon();
      return { ok: true, known: true, score: 99, hits: ['학습목록'], text: '' };
    }
    return none;
  }
  if (known.length || auto.length || seed.length || safe.length) { // 학습 목록과 먼저 대조(저렴): 정상 목록이면 통과, 일치하면 OCR 없이 확정
    const hr = await askOffscreen({ op: 'hash', url: msg.url });
    if (hr.ok && matchSafe(hr.hash)) return { ok: true, score: 0, hits: ['정상목록'], text: '' };
    if (hr.ok && matchKnown(hr.hash)) {
      const res = { ok: true, known: true, score: 99, hits: ['학습목록'], text: '' };
      c.set(key, { s: 99, h: res.hits, x: '', t: Date.now() });
      persistSoon();
      return res;
    }
  }
  const r = await askOffscreen({ url: msg.url, th: msg.th });
  if (r.ok && r.score >= LEARN_SCORE) learnAuto(msg.url); // 확실한 도박 배너는 스스로 기억
  if (r.ok) {
    c.set(key, { s: r.score, h: r.hits, x: (r.text || '').slice(0, 200), t: Date.now() });
    persistSoon();
  }
  return r;
}

// ---- 탭별(프레임 합산) 숨김 개수 ----
async function setFrameCount(tabId, frameId, n) {
  const k = 'tc' + tabId;
  const o = (await chrome.storage.session.get(k))[k] || {};
  o[frameId] = n;
  await chrome.storage.session.set({ [k]: o });
  return Object.values(o).reduce((a, b) => a + b, 0);
}
async function tabCount(tabId) {
  const k = 'tc' + tabId;
  const o = (await chrome.storage.session.get(k))[k] || {};
  return Object.values(o).reduce((a, b) => a + b, 0);
}
async function bumpTotal(delta) {
  const o = await chrome.storage.local.get('kbStats');
  const st = o.kbStats || { total: 0 };
  st.total += delta;
  await chrome.storage.local.set({ kbStats: st });
}
const lastFrameCount = new Map(); // `${tabId}:${frameId}` → 이전 개수(누적 통계용)

// ---- 테스트 리포트 ----
async function collectReport(tabId) {
  let frames = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch (_) {}
  const parts = await Promise.all(
    frames.map((f) =>
      chrome.tabs.sendMessage(tabId, { type: 'KB_GET_REPORT' }, { frameId: f.frameId }).catch(() => null)
    )
  );
  const cfg = await chrome.storage.sync.get({ mode: 'balanced' });
  const TH = { conservative: 7, balanced: 5, aggressive: 4 }[cfg.mode] || 5;
  const lines = [];
  lines.push(`[KB 리포트 v${chrome.runtime.getManifest().version}] 민감도=${cfg.mode}(기준 ${TH}점) · ${new Date().toISOString().slice(0, 16)}`);
  lines.push('※ 도메인은 일부 가려져 있습니다 (ab***.com)');
  const ok = parts.filter(Boolean);
  if (!ok.length) lines.push('(응답한 프레임 없음 — 페이지를 새로고침한 뒤 다시 시도하세요)');
  let n = 0;
  for (const p of ok) {
    lines.push('');
    lines.push(`■ 프레임 ${p.frame === 'top' ? '(최상위)' : '(iframe)'} ${p.host} · 뷰포트 ${p.size} · 이미지 ${p.images}개 · 숨김 ${p.hidden}개` + (p.budgetSkipped ? ` · 예산초과 건너뜀 ${p.budgetSkipped}` : ''));
    if (p.page && p.page.score) lines.push(`  페이지 문맥 +${p.page.score}점 (${p.page.hits.join(', ')})`);
    if (p.hiddenInfo && p.hiddenInfo.length) lines.push('  숨긴 요소: ' + p.hiddenInfo.join(' | '));
    if (p.iframes && p.iframes.length) lines.push('  iframe들: ' + p.iframes.join(' | '));
    if (p.unlinked && p.unlinked.length) lines.push('  링크 없는 배너형 이미지: ' + p.unlinked.join(' | '));
    const order = { BLOCK: 0, pass: 1 };
    const es = [...p.entries].sort((a, b) => (order[a.dec] ?? 2) - (order[b.dec] ?? 2) || b.total - a.total);
    for (const e of es) {
      n++;
      const pgTxt = e.pg ? ` 문맥 ${e.pg} 포함` : '';
      const sc = e.ocr == null ? `구조 ${e.pre}${pgTxt}` : `총 ${e.total} (구조 ${e.pre}${pgTxt} + OCR ${e.ocr})`;
      lines.push(`  #${n} [${e.dec}] ${sc} · ${e.w}x${e.h} · 이미지 ${e.src}` + (e.href ? ` · 링크 ${e.href}` : ''));
      if (e.hits && e.hits.length) lines.push(`      키워드: ${e.hits.join(', ')}`);
      if (e.text) lines.push(`      OCR: "${e.text.replace(/\s+/g, ' ').slice(0, 140)}"`);
      if (e.err) lines.push(`      오류: ${e.err}`);
    }
    if (!p.entries.length) lines.push('  (배너 후보 없음)');
  }
  return lines.join('\n');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'KB_OCR_REQUEST') {
    handleOcr(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'KB_BLOCKED' && sender.tab) {
    const tabId = sender.tab.id;
    const fk = tabId + ':' + sender.frameId;
    const prev = lastFrameCount.get(fk) || 0;
    lastFrameCount.set(fk, msg.pageCount);
    setFrameCount(tabId, sender.frameId, msg.pageCount).then((sum) => {
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#d33' });
      chrome.action.setBadgeText({ tabId, text: sum > 0 ? String(sum) : '' });
    });
    if (msg.pageCount > prev) bumpTotal(msg.pageCount - prev);
    return false;
  }
  if (msg.type === 'KB_FRAME_FLAGGED' && sender.tab) {
    const tabId = sender.tab.id;
    chrome.webNavigation
      .getFrame({ tabId, frameId: sender.frameId })
      .then((fr) => {
        if (fr && fr.parentFrameId >= 0) {
          chrome.tabs.sendMessage(tabId, { type: 'KB_HIDE_FRAME', url: msg.url, w: msg.w, h: msg.h }, { frameId: fr.parentFrameId }).catch(() => {});
        }
      })
      .catch(() => {});
    return false;
  }
  if (msg.type === 'KB_KNOWN_STATE') { loadKnown().then((k) => sendResponse({ count: k.length + auto.length, auto: auto.length, safe: safe.length, seed: seed.length })); return true; }
  if (msg.type === 'KB_KNOWN_EXPORT') { loadKnown().then((k) => sendResponse({ text: 'KBL1:' + k.concat(auto).join(',') })); return true; }
  if (msg.type === 'KB_PICK_START' && msg.tabId != null) { broadcast(msg.tabId, { type: 'KB_PICK_START' }); sendResponse({ ok: true }); return false; }
  if (msg.type === 'KB_PICK_DONE' && sender.tab) { broadcast(sender.tab.id, { type: 'KB_PICK_STOP' }); return false; }
  if (msg.type === 'KB_PICKED' && sender.tab) {
    const tabId = sender.tab.id;
    broadcast(tabId, { type: 'KB_PICK_STOP' });
    if (/^https?:/.test(msg.url || '')) {
      addPicked(pickKey(msg.url, msg.kind === 'frame'));
      if (msg.kind === 'img') reportImage(msg.url, tabId); // 해시로도 기억 → 주소가 다른 같은 이미지도 차단
    }
    return false;
  }
  if (msg.type === 'KB_UNLEARN') { unlearn(msg.urls || []).then((n) => sendResponse({ ok: true, n })).catch(() => sendResponse({ ok: false })); return true; }
  if (msg.type === 'KB_KNOWN_IMPORT') {
    const body = String(msg.text || '').trim().replace(/^KBL1:/, '');
    const hs = body.split(/[\s,]+/).filter(PH.isHash);
    if (!hs.length) { sendResponse({ ok: false, error: '올바른 목록이 아닙니다 (KBL1:…)' }); return true; }
    addKnown(hs).then(async (added) => sendResponse({ ok: true, added, total: (await loadKnown()).length }));
    return true;
  }
  if (msg.type === 'KB_KNOWN_CLEAR') {
    loadKnown().then(async () => { known = []; auto = []; safe = []; await saveKnown(); sendResponse({ ok: true }); });
    return true;
  }
  if (msg.type === 'KB_POPUP_STATE') {
    tabCount(msg.tabId).then((count) => sendResponse({ count }));
    return true;
  }
  if (msg.type === 'KB_REPORT_REQUEST') {
    collectReport(msg.tabId).then((text) => sendResponse({ text })).catch((e) => sendResponse({ text: '리포트 생성 실패: ' + e }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.storage.session.remove('tc' + tabId);
    for (const k of [...lastFrameCount.keys()]) if (k.startsWith(tabId + ':')) lastFrameCount.delete(k);
  }
});
