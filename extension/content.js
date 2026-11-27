// 콘텐츠 스크립트 v0.3: 배너 후보 탐지(구조) → URL/문구/페이지 문맥 점수 → OCR 점수 → 숨김
// - 모든 프레임에서 동작(iframe 광고 지원), 하위 프레임에서 걸리면 상위 프레임이 iframe 자체를 숨김
// - 테스트 리포트용 기록(entries) 유지
(() => {
  const S = globalThis.KB_SCORING;
  if (!S) return;
  const IS_TOP = window.top === window;

  const DEFAULTS = { enabled: true, mode: 'balanced', debug: false, allow: [], forceOn: [] };
  const TH_BY_MODE = { conservative: 7, balanced: 5, aggressive: 4 };
  const MAX_OCR = IS_TOP ? 40 : 12;
  // 사양에 따라 동시 OCR 요청 수 조절 (offscreen.js의 워커 수 + 1로 파이프라인 유지)
  const CORES = navigator.hardwareConcurrency || 4, MEM = navigator.deviceMemory || 4;
  const MAX_INFLIGHT = (CORES >= 8 && MEM >= 8 ? 3 : CORES >= 4 && MEM >= 4 ? 2 : 1) + 1;
  const LAZY_RANGE = 2.5; // 화면 위아래 몇 화면 높이 안쪽의 배너만 OCR (먼 배너는 스크롤하면 처리)

  let cfg = { ...DEFAULTS };
  const state = new WeakMap(); // 요소 → entry
  const hidden = new Set(); // 숨긴 컨테이너(iframe 포함)
  const entries = [];
  let unlinked = [];
  let restored = false;
  let pageCount = 0;
  let ocrBudget = MAX_OCR;
  let budgetSkipped = 0;
  let pageInfo = { score: 0, hits: [] };
  let pageAt = 0;
  let inflight = 0;
  const queue = [];

  const TH = () => TH_BY_MODE[cfg.mode] || 5;
  const TRUSTED_SITE = S.isTrustedHost(location.hostname);
  const active = () => cfg.enabled && !restored && (!TRUSTED_SITE || (cfg.forceOn || []).includes(location.hostname)) && !(cfg.allow || []).includes(location.hostname);

  // ---------- 유틸 ----------
  function maskHost(h) {
    if (!h) return '';
    const p = h.replace(/^www\./, '').split('.');
    const keep = /^(co|or|go|ne|re|pe|ac|com|net|org)$/.test(p[p.length - 2] || '') && p.length > 2 ? 2 : 1;
    return p.map((x, i) => (i >= p.length - keep ? x : x.slice(0, 2) + '***')).join('.');
  }
  function hostOf(u) { if (!u) return ''; try { return new URL(u, document.baseURI).hostname; } catch (_) { return ''; } }
  function fileName(src) {
    try { return decodeURIComponent((src || '').split('?')[0].split('/').pop() || ''); } catch (_) { return ''; }
  }

  // ---------- 페이지 문맥 (5초 캐시, 최상위 프레임만) ----------
  function pageContext() {
    if (!IS_TOP) return pageInfo;
    const now = Date.now();
    if (now - pageAt < 5000) return pageInfo;
    pageAt = now;
    try {
      pageInfo = S.scorePage(document.body ? document.body.innerText : '');
    } catch (_) { pageInfo = { score: 0, hits: [] }; }
    return pageInfo;
  }

  // ---------- 후보 탐지 ----------
  // 광고 슬롯 크기 iframe인가: 블로그 본문 같은 큰 프레임은 광고 슬롯으로 취급하지 않는다 (970x250, 300x600 등은 포함)
  const adSlotSize = (w, h) => w * h <= 450000 && h <= 700 && w <= 1000;
  function bannerShape(w, h) {
    return w >= 180 && h >= 36 && h <= 260 && w / h >= 2.2 && w / h <= 14;
  }
  function bgUrl(el) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== 'none' && bg.match(/url\((['"]?)(.*?)\1\)/);
    if (!m) return null;
    try { return new URL(m[2], document.baseURI).href; } catch (_) { return null; }
  }

  // 이 요소가 '오늘 그만보기' 버튼이 있는 팝업 레이어 안에 있는가 (가까운 조상 몇 단계만 검사)
  const todayCache = new WeakMap();
  function inTodayPopup(el) {
    let p = el.parentElement;
    for (let n = 0; p && p !== document.body && n < 6; p = p.parentElement, n++) {
      let v = todayCache.get(p);
      if (!v) {
        v = false;
        if (/오늘/.test(p.textContent || '') && (p.textContent || '').length < 400) {
          const b = findBtn(p, TODAY_RE, 14);
          v = !!(b && inPopupLayer(p));
        }
        if (v) todayCache.set(p, v);
      }
      if (v) return true;
    }
    return false;
  }

  function collectCandidates() {
    const list = [];
    let relaxedN = 0, popupN = 0;
    unlinked = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      if (r.width < 100 || r.height < 20) continue;
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('blob:')) continue;
      const a = img.closest('a[href]');
      // 하위 프레임: 프레임 전체를 거의 덮는 이미지는 광고 슬롯으로 간주(링크/비율 무관)
      const fillsFrame = !IS_TOP && adSlotSize(vw, vh) && r.width * r.height >= 0.6 * vw * vh && r.width >= 200 && r.height >= 50;
      if (a && (bannerShape(r.width, r.height) || fillsFrame)) {
        list.push({ el: img, anchor: a, src, w: r.width, h: r.height, alt: (img.alt || '') + ' ' + (img.title || ''), href: a.href });
      } else if (fillsFrame) {
        list.push({ el: img, anchor: img, src, w: r.width, h: r.height, alt: (img.alt || '') + ' ' + (img.title || ''), href: '' });
      } else if (IS_TOP && r.width >= 150 && r.height >= 120 && popupN < 6 && inTodayPopup(img)) {
        // '오늘 그만보기'가 달린 팝업 안의 큰 이미지: 세로형·정사각형이어도 OCR 대상 (광고 팝업이 대부분)
        popupN++;
        list.push({ el: img, anchor: a || img, src, w: r.width, h: r.height, alt: (img.alt || '') + ' ' + (img.title || ''), href: a ? a.href : '', popup: true });
      } else if (a && r.width >= 120 && r.height >= 50 && relaxedN < 30 && !bannerShape(r.width, r.height)) {
        // 배너 비율이 아닌 링크 이미지(300×250 등): OCR 없이 학습 목록(해시)과만 대조
        relaxedN++;
        list.push({ el: img, anchor: a, src, w: r.width, h: r.height, alt: '', href: a.href, hashOnly: true });
      } else if (bannerShape(r.width, r.height) && unlinked.length < 10) {
        unlinked.push(`${Math.round(r.width)}x${Math.round(r.height)} ${maskHost(hostOf(src))}/${fileName(src)}`.slice(0, 90));
      }
    }
    // 배경 이미지로 만든 배너
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.querySelector('img')) continue;
      const r = a.getBoundingClientRect();
      if (!bannerShape(r.width, r.height)) continue;
      if (textLen(a) > 3) continue; // 글자가 있는 버튼/메뉴/순위표 행은 배너가 아님(배너는 보통 DOM 글자가 없다)
      let src = bgUrl(a);
      let holder = a;
      if (!src) {
        for (const c of a.children) {
          if (c.tagName !== 'DIV' && c.tagName !== 'SPAN') continue;
          src = bgUrl(c);
          if (src) { holder = c; break; }
        }
      }
      if (!src || src.startsWith('data:image/svg')) continue;
      // 실제로 배경이 걸린 요소(holder) 자체가 배너 모양이어야 함: 행 안의 작은 뱃지/아이콘 배경은 배너가 아니다
      const hr = holder.getBoundingClientRect();
      if (!bannerShape(hr.width, hr.height)) continue;
      list.push({ el: holder, anchor: a, src, w: r.width, h: r.height, alt: a.title || '', href: a.href });
    }
    return list;
  }

  // 같은 크기 배너가 여러 개면 광고 묶음일 가능성 ↑
  function clusterBonus(all) {
    const groups = new Map();
    for (const c of all) {
      const k = Math.round(c.w / 8) + 'x' + Math.round(c.h / 8);
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    return (c) => {
      const n = groups.get(Math.round(c.w / 8) + 'x' + Math.round(c.h / 8)) || 0;
      return n >= 5 ? 2 : n >= 3 ? 1 : 0;
    };
  }

  // ---------- 숨김 ----------
  const textLen = (el) => (el.textContent || '').replace(/\s+/g, '').length;
  const TEXT_OK = 12; // 배너 링크가 가진 DOM 글자가 이보다 길면 '글이 있는 링크'로 보고 글자는 건드리지 않는다

  function containerFor(c) {
    let node = c.anchor;
    // 링크 안에 제목 같은 글자가 함께 있으면(뉴스 카드 등) 이미지만 숨긴다
    if (node !== c.el && textLen(node) > TEXT_OK) return c.el;
    if (!IS_TOP) return node === c.el ? c.el : node; // 하위 프레임은 프레임 통째로 숨길 것이므로 그대로
    for (let i = 0; i < 3; i++) {
      const p = node.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (textLen(p) - textLen(node) > 0) break; // 부모에 배너 외의 글자(본문)가 있으면 올라가지 않는다
      const kids = [...p.children].filter((k) => !['SCRIPT', 'STYLE', 'LINK'].includes(k.tagName));
      if (kids.length !== 1) break;
      const pr = p.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      if (pr.height > nr.height * 1.6 + 24) break;
      node = p;
    }
    return node;
  }

  function applyHide(box, info) {
    if (cfg.debug) {
      box.style.setProperty('outline', '3px solid #e33', 'important');
      box.setAttribute('data-kb', 'flagged ' + info);
    } else {
      box.style.setProperty('display', 'none', 'important');
      box.setAttribute('data-kb-hidden', info);
    }
  }

  function report() {
    try { chrome.runtime.sendMessage({ type: 'KB_BLOCKED', pageCount }); } catch (_) {}
  }

  const hiddenSrc = new Set(); // 복구 시 '정상 배너'로 알려주기 위한 숨긴 이미지 주소
  const hiddenInfo = []; // 리포트용: 어떤 요소를 숨겼는지 (태그·클래스·글자수)
  function hide(c, info, force) {
    let box = containerFor(c);
    if (hidden.has(box)) return;
    // 최종 안전장치: 숨길 요소에 글자가 많이 들어 있으면 그 글자까지 지우게 되므로 이미지 자신만 숨기고, 그것도 글자가 있으면 숨기지 않는다
    if (IS_TOP && textLen(box) > TEXT_OK) {
      if (box !== c.el && textLen(c.el) <= TEXT_OK) box = c.el;
      else if (force) box = c.el; // 사용자가 직접 고른 것은 글자가 있어도 그 이미지 요소는 숨긴다
      else { const e = state.get(c.el); if (e) e.dec = 'SKIP(text)'; return; }
      if (hidden.has(box)) return;
    }
    hiddenInfo.push(`${box.tagName}${box.className && typeof box.className === 'string' ? '.' + box.className.trim().split(/\s+/)[0] : ''} 글자${textLen(box)}자 ${info}`.slice(0, 90));
    hidden.add(box);
    if (c.src && /^https?:/.test(c.src)) hiddenSrc.add(c.src);
    pageCount++;
    applyHide(box, info);
    report();
    if (IS_TOP) dismissPopupAround(box);
    if (!IS_TOP && adSlotSize(window.innerWidth, window.innerHeight)) { // 상위 프레임에게 이 iframe 자체를 숨기도록 요청 (남는 빈 공간 제거)
      try {
        chrome.runtime.sendMessage({ type: 'KB_FRAME_FLAGGED', url: location.href, w: window.innerWidth, h: window.innerHeight });
      } catch (_) {}
    }
  }

  // ---------- 광고 팝업(레이어)의 '오늘 그만보기' 자동 클릭 ----------
  // 광고로 판정해 숨긴 이미지가 팝업 안에 있을 때만 동작한다 (정상 팝업은 건드리지 않음).
  const TODAY_RE = /^(오늘(하루)?(은|동안)?(그만|다시|더)?(보지않기|보지않음|보기안|그만보기|열지않기|열지않음|안보기|안볼래요?|닫기)|하루(동안)?(그만보기|보지않기|열지않기|안보기)|오늘하루)/;
  const CLOSE_RE = /^(닫기|닫기[x×✕]?|close|[x×✕])$/i;
  const dismissed = new WeakSet();
  const normTxt = (el) => ((el.tagName === 'INPUT' ? el.value : el.textContent) || '').replace(/\s+/g, '');
  const isShown = (el) => { if (!el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
  function findBtn(root, re, maxLen) {
    let found = null;
    for (const el of root.querySelectorAll('a,button,span,label,div,p,li,em,strong,i,input[type=button],input[type=submit]')) {
      if (el.closest('[data-kb-hidden]') && el.closest('[data-kb-hidden]') !== root) continue;
      const t = normTxt(el);
      if (!t || t.length > maxLen || !re.test(t)) continue;
      found = el; // 문서 순서상 더 깊은(나중에 나온 자손) 요소가 덮어써서 가장 안쪽 요소가 선택됨
    }
    return found;
  }
  function inPopupLayer(el) {
    for (let p = el, n = 0; p && p !== document.body && n < 12; p = p.parentElement, n++) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') return true;
    }
    return false;
  }
  function dismissPopupAround(box) {
    if (cfg.autoPopup === false) return;
    let root = box.parentElement;
    for (let n = 0; root && root !== document.body && root !== document.documentElement && n < 8; root = root.parentElement, n++) {
      const btn = findBtn(root, TODAY_RE, 14);
      if (!btn) continue;
      if (dismissed.has(root) || !inPopupLayer(root)) return;
      const r = root.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.98 && r.height > window.innerHeight * 0.98) return; // 전체화면 래퍼는 건드리지 않음
      dismissed.add(root);
      try { (btn.closest('a,button,label') || btn).click(); } catch (_) {}
      setTimeout(() => { // 체크박스형이면 닫기 버튼도 누르고, 그래도 남으면 팝업 자체를 숨긴다
        if (!isShown(root)) return;
        const cl = findBtn(root, CLOSE_RE, 4);
        if (cl) { try { (cl.closest('a,button') || cl).click(); } catch (_) {} }
        setTimeout(() => {
          if (isShown(root) && !hidden.has(root)) { hidden.add(root); applyHide(root, 'popup'); }
        }, 500);
      }, 400);
      return;
    }
  }

  // ---------- 직접 지우기 (사용자가 클릭해서 선택) ----------
  const normKey = (u) => { try { const x = new URL(u, document.baseURI); return x.origin + x.pathname; } catch (_) { return ''; } };
  let picked = new Set(); // 이전에 직접 지운 이미지/프레임 주소(쿼리 제외). 같은 주소가 다시 나오면 감지 없이 숨긴다
  function scanPicked() {
    if (!picked.size) return;
    for (const img of document.images) {
      const src = img.currentSrc || img.src;
      if (!src || !picked.has(normKey(src))) continue;
      const a = img.closest('a[href]');
      hide({ el: img, anchor: a || img, src, w: 0, h: 0, alt: '', href: '' }, 'picked', true);
    }
    for (const el of document.querySelectorAll('[style*="url("]')) {
      const src = bgUrl(el);
      if (src && picked.has(normKey(src))) hide({ el, anchor: el.closest('a[href]') || el, src, w: 0, h: 0, alt: '', href: '' }, 'picked', true);
    }
    for (const f of document.querySelectorAll('iframe')) {
      if (f.src && !hidden.has(f) && picked.has('f:' + normKey(f.src))) { hidden.add(f); pageCount++; applyHide(f, 'picked'); report(); }
    }
  }

  let pickUI = null;
  function pickTargetAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === document.documentElement || el === document.body || (el.hasAttribute && el.hasAttribute('data-kb-ui'))) continue;
      if (el.tagName === 'IMG') { const src = el.currentSrc || el.src; if (src) return { kind: 'img', el, src }; }
      if (el.tagName === 'IFRAME') return { kind: 'frame', el, src: el.src || '' };
      const r = el.getBoundingClientRect();
      if (r.width * r.height <= 0.6 * innerWidth * innerHeight) { // 페이지 전체 배경은 제외
        const src = bgUrl(el);
        if (src && !src.startsWith('data:image/svg')) return { kind: 'bg', el, src };
      }
    }
    return null;
  }
  function stopPick(notify) {
    if (!pickUI) return;
    pickUI.remove();
    pickUI = null;
    if (notify) { try { chrome.runtime.sendMessage({ type: 'KB_PICK_DONE' }); } catch (_) {} }
  }
  function commitPick(t) {
    const savable = /^https?:/.test(t.src || '');
    if (t.kind === 'frame') {
      hidden.add(t.el); pageCount++; applyHide(t.el, 'picked'); report();
    } else {
      const a = t.el.closest('a[href]');
      hide({ el: t.el, anchor: a || t.el, src: t.src, w: 0, h: 0, alt: '', href: '' }, 'picked', true);
    }
    try { chrome.runtime.sendMessage({ type: 'KB_PICKED', kind: t.kind === 'frame' ? 'frame' : 'img', url: savable ? t.src : '' }); } catch (_) {}
  }
  function startPick() {
    if (pickUI) return;
    const mk = (css) => { const d = document.createElement('div'); d.setAttribute('data-kb-ui', '1'); d.style.cssText = css; return d; };
    const box = mk('position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #e33;background:rgba(238,51,51,.18);display:none;box-sizing:border-box;margin:0;padding:0');
    const tip = IS_TOP ? mk('position:fixed;z-index:2147483647;pointer-events:none;top:8px;left:50%;transform:translateX(-50%);background:#111;color:#fff;font:13px/1.4 sans-serif;padding:7px 14px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4)') : null;
    if (tip) tip.textContent = '지울 배너를 클릭하세요 (Esc: 취소)';
    document.documentElement.append(...[box, tip].filter(Boolean));
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const onMove = (e) => {
      const t = pickTargetAt(e.clientX, e.clientY);
      if (!t) { box.style.display = 'none'; return; }
      const r = t.el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const onClick = (e) => {
      swallow(e);
      const t = pickTargetAt(e.clientX, e.clientY);
      stopPick(false);
      if (t) commitPick(t);
      else if (!IS_TOP) { // 이미지가 없는 광고 프레임(캔버스·플래시 등): 프레임 자체를 숨기고 주소를 기억
        try {
          chrome.runtime.sendMessage({ type: 'KB_FRAME_FLAGGED', url: location.href, w: window.innerWidth, h: window.innerHeight });
          chrome.runtime.sendMessage({ type: 'KB_PICKED', kind: 'frame', url: location.href });
        } catch (_) {}
      } else { try { chrome.runtime.sendMessage({ type: 'KB_PICK_DONE' }); } catch (_) {} }
    };
    const onKey = (e) => { if (e.key === 'Escape') { swallow(e); stopPick(true); } };
    const blockEvs = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu', 'dblclick'];
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    for (const n of blockEvs) window.addEventListener(n, swallow, true);
    pickUI = {
      remove() {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        for (const n of blockEvs) window.removeEventListener(n, swallow, true);
        box.remove(); if (tip) tip.remove();
      },
    };
  }

  // 사용자가 우클릭으로 신고한 이미지: 같은 src를 가진 이미지를 즉시 숨김 (이 프레임 안에서만)
  function hideBySrc(url) {
    for (const img of document.images) {
      if ((img.currentSrc || img.src) !== url) continue;
      const a = img.closest('a[href]');
      hide({ el: img, anchor: a || img, src: url, w: 0, h: 0, alt: '', href: a ? a.href : '' }, 'reported');
    }
  }

  function hideChildFrame(msg) {
    const frames = [...document.querySelectorAll('iframe')];
    const sized = frames.filter((f) => {
      const r = f.getBoundingClientRect();
      return Math.abs(r.width - msg.w) <= 3 && Math.abs(r.height - msg.h) <= 3;
    });
    const f = sized.find((x) => x.src === msg.url) || (sized.length === 1 ? sized[0] : null);
    if (!f || hidden.has(f)) return;
    if (!adSlotSize(msg.w, msg.h)) return; // 큰 프레임(본문 등)은 통째로 숨기지 않는다
    hidden.add(f);
    applyHide(f, 'frame');
  }

  function restoreAll() {
    restored = true;
    for (const box of hidden) {
      box.style.removeProperty('display');
      box.style.removeProperty('outline');
      box.removeAttribute('data-kb-hidden');
      box.removeAttribute('data-kb');
    }
    hidden.clear();
    pageCount = 0;
    report();
    // 사용자가 복구했다 = 오탐: 학습한 해시에서 빼고 정상 목록에 넣어 반복되지 않게 함
    if (hiddenSrc.size) {
      try { chrome.runtime.sendMessage({ type: 'KB_UNLEARN', urls: [...hiddenSrc] }); } catch (_) {}
      hiddenSrc.clear();
    }
  }

  // 원본 이미지가 배너 크기·비율인가 (<img>만 즉시 판별, 배경이미지는 OCR 경로로)
  function isBannerImage(c) {
    const el = c.el;
    if (el.tagName !== 'IMG' || !el.naturalWidth || !el.naturalHeight) return false;
    const ratio = el.naturalWidth / el.naturalHeight;
    return el.naturalWidth >= 300 && ratio >= 2.2 && ratio <= 14;
  }

  // 후보가 현재 뷰포트에서 얼마나 떨어져 있는지(px). 화면 안이면 0
  function distOf(c) {
    const r = c.el.getBoundingClientRect();
    if (r.bottom < 0) return -r.bottom;
    if (r.top > window.innerHeight) return r.top - window.innerHeight;
    return 0;
  }

  // ---------- OCR 큐 ----------
  function pump() {
    if (document.hidden) return; // 백그라운드 탭에서는 OCR을 쉬고, 탭이 보이면 이어서 처리
    while (inflight < MAX_INFLIGHT && queue.length) {
      const job = queue.shift();
      inflight++;
      runJob(job).finally(() => { inflight--; pump(); });
    }
  }
  async function runJob(job) {
    const e = job.entry;
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'KB_OCR_REQUEST', url: job.c.src, th: Math.max(2, TH() - job.pre), hashOnly: !!job.hashOnly });
    } catch (_) { /* 확장 컨텍스트 무효화 등 */ }
    if (!resp || !resp.ok) {
      e.dec = 'FAIL';
      e.err = (resp && resp.error) || 'no response';
      return;
    }
    e.ocr = resp.score;
    e.hits = resp.hits || [];
    e.text = resp.text || '';
    e.total = resp.score + job.pre;
    // 같은 크기 격자·페이지 문맥 같은 '구조 보너스'만으로는 약한 OCR 단서(1~2점)를 차단으로 바꾸지 않는다: OCR+URL 단서 합이 3 이상이어야 함
    if (active() && e.total >= TH() && resp.score + job.hard >= 3) {
      e.dec = 'BLOCK';
      hide(job.c, `ocr:${e.total}:${e.hits.slice(0, 4).join(',')}`);
    } else {
      e.dec = 'pass';
    }
  }

  // ---------- 스캔 ----------
  function scan() {
    if (!active()) return;
    if (window.innerWidth < 150 || window.innerHeight < 30) return; // 추적 픽셀 등 초소형 프레임
    scanPicked();
    const all = collectCandidates();
    const bonusOf = clusterBonus(all.filter((c) => !c.hashOnly));
    const pg = all.length ? pageContext() : pageInfo;
    for (const c of all) {
      if (state.has(c.el)) continue;
      if (c.el.tagName === 'IMG' && !c.el.complete) {
        c.el.addEventListener('load', scheduleScan, { once: true });
        continue;
      }
      if (c.hashOnly) { // 해시 대조 전용: 보고서/OCR 예산에 넣지 않는다
        state.set(c.el, { hashOnly: true });
        queue.push({ c, pre: 0, hard: 0, hashOnly: true, entry: { hits: [] }, dist: distOf(c) });
        continue;
      }
      const urlInfo = S.scoreUrlLike(`${c.href} ${c.alt} ${fileName(c.src)}`);
      const pre = urlInfo.score + bonusOf(c) + pg.score + (c.popup ? 2 : 0);
      // 구조 점수만으로 확정되면 거리와 상관없이 즉시 숨김(비용 0). 아니면 화면에서 먼 배너는 지연
      if (pre < TH() && distOf(c) > LAZY_RANGE * window.innerHeight) continue;
      const entry = {
        w: Math.round(c.w), h: Math.round(c.h), pre, pg: pg.score, ocr: null, total: pre, hits: [], text: '', dec: 'queued',
        src: `${maskHost(hostOf(c.src))}/${fileName(c.src)}`.slice(0, 80), href: maskHost(hostOf(c.href)),
      };
      state.set(c.el, entry);
      entries.push(entry);
      // 즉시 숨김(OCR 없이): URL 단서(3점 이상)가 있거나, 구조·문맥 점수만으로는 원본 이미지가 배너 크기·비율일 때만
      if (pre >= TH() && (urlInfo.score >= 3 || isBannerImage(c))) {
        entry.dec = 'BLOCK';
        entry.why = 'url';
        hide(c, `url:${pre}`);
        continue;
      }
      if (ocrBudget <= 0) { entry.dec = 'SKIP(budget)'; budgetSkipped++; continue; }
      ocrBudget--;
      queue.push({ c, pre, hard: urlInfo.score, entry, dist: c.popup ? -1 : distOf(c) });
    }
    queue.sort((a, b) => a.dist - b.dist); // 화면에 가까운 배너부터
    pump();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 600);
  }

  function buildReport() {
    const ifr = IS_TOP
      ? [...document.querySelectorAll('iframe')].map((f) => {
          const r = f.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)} ${maskHost(hostOf(f.src))}`;
        }).filter((s) => !s.startsWith('0x0')).slice(0, 12)
      : [];
    return {
      frame: IS_TOP ? 'top' : 'sub',
      host: maskHost(location.hostname),
      size: `${window.innerWidth}x${window.innerHeight}`,
      images: document.images.length,
      unlinked,
      iframes: ifr,
      hidden: pageCount,
      budgetSkipped,
      page: pageInfo,
      hiddenInfo: hiddenInfo.slice(0, 20),
      entries: entries.slice(0, 60),
    };
  }

  // ---------- 시작 ----------
  async function init() {
    try { cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }; } catch (_) {}
    try { picked = new Set((await chrome.storage.local.get('kbPicked')).kbPicked || []); } catch (_) {}
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.kbPicked) { picked = new Set(changes.kbPicked.newValue || []); scheduleScan(); return; }
      if (area !== 'sync') return;
      for (const [k, v] of Object.entries(changes)) cfg[k] = v.newValue;
      scheduleScan();
    });
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'KB_RESTORE') { restoreAll(); sendResponse({ ok: true }); }
      else if (msg.type === 'KB_GET_REPORT') sendResponse(buildReport());
      else if (msg.type === 'KB_HIDE_FRAME') hideChildFrame(msg);
      else if (msg.type === 'KB_HIDE_SRC') hideBySrc(msg.url);
      else if (msg.type === 'KB_PICK_START') startPick();
      else if (msg.type === 'KB_PICK_STOP') stopPick(false);
      return false;
    });
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src'],
    });
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('load', scheduleScan);
    setTimeout(scan, 1500);
    setTimeout(scan, 4000);
  }
  init();
})();
