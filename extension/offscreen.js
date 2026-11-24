// 오프스크린 문서: Tesseract(한국어) OCR 실행. 모든 처리는 기기 안에서만 일어난다.
// v0.3 최적화
//  - 기기 사양에 맞춰 워커 수 결정(저사양 1개), 놀고 있는 워커는 일정 시간 뒤 종료해 메모리 반환
//  - 패스는 최대 2번: gray(그레이+대비확장, 900px) → 부족할 때만 raw(원본색).
//    실측(크롭 27장): 반전·1400px 패스는 점수 개선이 없어 제거, 시간 약 35% 절감
//  - 1패스에서 글자가 거의 안 읽히면(사진 위주) 2패스 생략
const CORES = navigator.hardwareConcurrency || 4;
const MEM = navigator.deviceMemory || 4; // GB (크롬은 최대 8로 표기)
const MAX_WORKERS = CORES >= 8 && MEM >= 8 ? 3 : CORES >= 4 && MEM >= 4 ? 2 : 1;
const IDLE_KILL_MS = 25000;
const TARGET_W = 900;

const idle = [];
const waiters = [];
let created = 0;
let idleTimer = null;

async function makeWorker() {
  const w = await Tesseract.createWorker('kor', 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core'),
    langPath: chrome.runtime.getURL('lib/lang'),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none',
  });
  await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text
  return w;
}

async function acquire() {
  clearTimeout(idleTimer);
  if (idle.length) return idle.pop();
  if (created < MAX_WORKERS) {
    created++;
    try { return await makeWorker(); } catch (e) { created--; throw e; }
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release(w) {
  const next = waiters.shift();
  if (next) { next(w); return; }
  idle.push(w);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { // 한동안 일이 없으면 워커 종료(모델·wasm 메모리 반환)
    while (idle.length) {
      const x = idle.pop();
      created--;
      try { await x.terminate(); } catch (_) {}
    }
  }, IDLE_KILL_MS);
}

async function loadBitmap(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error('http ' + res.status);
  const blob = await res.blob();
  if (blob.size > 4e6) throw new Error('too big');
  return createImageBitmap(blob);
}

// mode: 'gray'(그레이스케일+대비 확장) | 'raw'(원본 색)
function render(bmp, mode) {
  let scale = Math.min(3, Math.max(1, TARGET_W / bmp.width));
  if (bmp.width > 1600) scale = 1600 / bmp.width;
  const W = Math.round(bmp.width * scale), H = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, 0, 0, W, H);
  if (mode === 'raw') return canvas;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g; hist[g]++;
  }
  const total = W * H;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 9×8 그레이로 줄여 dHash 계산. 큰 이미지를 한 번에 줄이면 앨리어싱으로 크기별 해시가 달라지므로
// 절반씩 단계적으로 줄인 뒤(박스 평균에 가까움) 72×64에서 8×8 블록 평균을 낸다.
function hashBitmap(bmp) {
  let cur = bmp;
  while (cur.width > 144 || cur.height > 128) {
    const c = document.createElement('canvas');
    c.width = Math.max(72, Math.ceil(cur.width / 2)); c.height = Math.max(64, Math.ceil(cur.height / 2));
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const f = document.createElement('canvas');
  f.width = 72; f.height = 64;
  const ctx = f.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 72, 64);
  ctx.drawImage(cur, 0, 0, 72, 64);
  const d = ctx.getImageData(0, 0, 72, 64).data;
  const g = new Array(72).fill(0);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 72; x++) {
    const i = (y * 72 + x) * 4;
    g[((y >> 3) * 9) + (x >> 3)] += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  }
  return KB_PHASH.dhashFromGray(g);
}
async function hashImage(url) {
  const bmp = await loadBitmap(url);
  try { return hashBitmap(bmp); } finally { bmp.close && bmp.close(); }
}

const glyphCount = (t) => (t.match(/[가-힣A-Za-z0-9]/g) || []).length;

async function ocrImage(url, th) {
  const bmp = await loadBitmap(url);
  if (bmp.width < 100 || bmp.height < 20) { bmp.close && bmp.close(); return { score: 0, hits: [], passes: 0, text: '' }; }
  const texts = [];
  let best = { score: 0, hits: [] };
  const w = await acquire();
  try {
    for (const mode of ['gray', 'raw']) {
      const { data } = await w.recognize(render(bmp, mode));
      const t = data.text || '';
      texts.push(t);
      best = KB_SCORING.scoreText(texts.join(' '));
      if (best.score >= th) break; // 충분히 확실하면 조기 종료
      if (mode === 'gray' && glyphCount(t) < 4) break; // 글자가 거의 없는 이미지는 재시도 무의미
    }
  } finally {
    release(w);
    bmp.close && bmp.close();
  }
  return { score: best.score, hits: best.hits, passes: texts.length, text: texts.join(' | ').slice(0, 300) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'KB_OFFSCREEN_OCR') return false;
  if (msg.op === 'hash') {
    hashImage(msg.url)
      .then((hash) => sendResponse({ ok: true, hash }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  ocrImage(msg.url, msg.th || 5)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
