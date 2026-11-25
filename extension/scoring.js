// 한국어 불법 도박 배너 판별용 점수 계산 (OCR 텍스트 / 링크 문자열 공용)
// OCR은 글자를 자주 틀리므로 자모(초성·중성·종성) 단위로 분해해서 퍼지 매칭한다.
(function (root) {
  const KEYWORDS = [
    // [단어, 가중치]
    ['첫충', 3], ['매충', 3], ['무한매충', 3], ['재충', 3], ['페이백', 3], ['콤프', 3], ['롤링', 3],
    ['가입코드', 3], ['먹튀', 3], ['꽁머니', 3], ['총판', 3], ['카지노', 3], ['슬롯', 3], ['토토', 3],
    ['배팅', 3], ['스포츠', 2], ['돌발', 2], ['최고배당', 3], ['무제재', 3], ['무제한', 2],
    ['테더', 2], ['USDT', 2], ['환전', 2], ['입금', 1], ['출금', 1], ['충전', 1], ['무기명', 3],
    ['신규', 1], ['가입', 1], ['고액전용', 3], ['보증', 1], ['안전놀이터', 3], ['놀이터', 2],
    ['바카라', 3], ['벳', 2], ['라이브', 1], ['쿠폰', 1], ['AI픽', 2],
    // 테더 입출금 문구는 OCR이 '임금가능'처럼 틀려도 퍼지로 잡힘
    ['입금가능', 2], ['입출금가능', 2], ['원화', 1],
    // 불법 의약품·성인 광고
    ['비아그라', 3], ['시알리스', 3], ['가품일시', 3], ['후불제', 2], ['발기부전', 3], ['정력제', 3], ['야동', 3], ['야설', 3], ['조건만남', 3], ['출장안마', 3],
    ['평생주소', 3], ['최신주소', 3], ['다음주소', 2], ['새주소', 2], ['공식채널', 2], ['텔레그램', 1], ['CASINO', 3], ['BACCARAT', 3],
    ['에볼루션', 3], ['프라그마틱', 3], ['파워볼', 3], ['홀덤', 2], ['꽁포인트', 3], ['입플', 2],
  ];
  // 합법 사행성·일반 암호화폐/금융 광고 오탐 방지용 감점 키워드
  const NEG_KEYWORDS = [
    ['체육진흥투표권', -5], ['국민체육진흥공단', -5], ['베트맨', -5], ['스포츠토토', -4],
    ['동행복권', -4], ['로또', -3], ['복권', -2], ['강원랜드', -3], ['마사회', -3],
    ['수수료', -2], ['거래소', -2], ['암호화폐', -2], ['알파벳', -2],
  ];

  function toJamo(s) {
    // ㅔ/ㅐ(ㅖ/ㅒ)는 OCR·표기에서 자주 뒤섞이므로 같은 글자로 취급 (페이백≈패이백, 베팅≈배팅)
    return Array.from(s.normalize('NFD').replace(/\u1166/g, '\u1162').replace(/\u1168/g, '\u1164'));
  }
  function normalize(s) {
    return s.replace(/\s+/g, '').toLowerCase();
  }
  // Sellers 알고리즘: text 안에서 pat과 편집거리 k 이하인 부분문자열이 있는지
  function fuzzyContains(textJ, patJ, k) {
    const m = patJ.length;
    if (m === 0) return false;
    let prev = new Array(m + 1);
    for (let i = 0; i <= m; i++) prev[i] = i;
    for (let j = 0; j < textJ.length; j++) {
      const cur = new Array(m + 1);
      cur[0] = 0;
      for (let i = 1; i <= m; i++) {
        const cost = patJ[i - 1] === textJ[j] ? 0 : 1;
        cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1);
      }
      if (cur[m] <= k) return true;
      prev = cur;
    }
    return false;
  }

  function build(list) {
    const seen = new Map();
    for (const [w, wt] of list) {
      const j = toJamo(w.toLowerCase());
      const key = j.join('');
      const prev = seen.get(key);
      if (prev && Math.abs(prev.wt) >= Math.abs(wt)) continue;
      seen.set(key, { w, wt, j, k: j.length >= 10 ? 2 : j.length >= 5 ? 1 : 0 });
    }
    return [...seen.values()];
  }
  const KW_J = build(KEYWORDS);
  const NEG_J = build(NEG_KEYWORDS);

  function scoreText(raw) {
    const text = normalize(raw || '');
    const textJ = toJamo(text);
    let score = 0;
    const hits = [];
    let weak = 0; // 가중치 1짜리 일반 단어(신규·가입·입금 등)는 금융/쇼핑 광고에도 흔하므로 합계 상한 2
    for (const kw of KW_J) {
      if (fuzzyContains(textJ, kw.j, kw.k)) {
        if (kw.wt <= 1) {
          if (weak >= 2) continue;
          weak += kw.wt;
        }
        score += kw.wt;
        hits.push(kw.w);
      }
    }
    for (const kw of NEG_J) {
      if (fuzzyContains(textJ, kw.j, kw.k)) {
        score += kw.wt;
        hits.push('-' + kw.w);
      }
    }
    const pct = (text.match(/\d+%/g) || []).length;
    if (pct >= 4) { score += 2; hits.push('%x' + pct); } // 혜택 비율표(첫충 70% 페이백 10% 콤프 3.5%…)
    else if (pct >= 2) { score += 1; hits.push('%x' + pct); }
    const plus = (text.match(/\d{1,3}\+\d{1,3}/g) || []).length;
    if (plus >= 2) { score += 3; hits.push('보너스표x' + plus); }
    return { score: Math.max(0, score), hits };
  }

  // 링크/alt/파일명 등 URL 성격의 문자열 점수
  const URL_PATTERNS = [
    [/casino|toto|(?<!alpha)bet(?![a-z])|slot|baccarat|sportsbook|gamble/i, 3],
    [/카지노|토토|슬롯|배팅|베팅|바카라|먹튀|놀이터/, 3],
    [/[?&](code|ref|rid|aff|invite|referral)=/i, 1],
    // 합법 사행성(체육진흥투표권·복권·경마·카지노 공기업) 도메인은 감점
    [/betman\.co\.kr|sportstoto\.co\.kr|dhlottery\.co\.kr|kspo\.or\.kr|kra\.co\.kr|kangwonland\.com/i, -4],
  ];
  function scoreUrlLike(str) {
    let score = 0;
    const hits = [];
    for (const [re, wt] of URL_PATTERNS) {
      if (re.test(str || '')) { score += wt; hits.push(String(re)); }
    }
    return { score: Math.max(0, score), hits };
  }

  // 페이지 문맥: 도박 광고 모음/홍보 페이지의 흔한 문구 (최대 3점).
  // 강한 문구(최신 주소·토토사이트 등)가 있어야 하고, 입점문의·광고문의·텔레그램 같은 일반 문구는 강한 문구와 함께일 때만 가산한다
  // (정상 쇼핑몰 푸터에도 '입점문의/광고문의'가 있기 때문)
  const PAGE_STRONG = [
    [/최신\s*주소|우회\s*주소|새\s*주소/, 2],
    [/먹튀\s*검증|토토\s*사이트|카지노\s*사이트|안전\s*놀이터|메이저\s*놀이터|총판\s*모집/, 2],
  ];
  const PAGE_WEAK = [[/입점\s*문의/, 1], [/(광고|배너)\s*문의/, 1], [/텔레그램/, 1]];
  function scorePage(text) {
    const t = String(text || '').slice(0, 30000);
    let strong = 0, weak = 0;
    const hits = [];
    for (const [re, wt] of PAGE_STRONG) if (re.test(t)) { strong += wt; hits.push(re.source.slice(0, 8)); }
    if (strong) for (const [re, wt] of PAGE_WEAK) if (re.test(t)) { weak += wt; hits.push(re.source.slice(0, 8)); }
    return { score: Math.min(3, strong + weak), hits };
  }

  const api = { scoreText, scoreUrlLike, scorePage, KEYWORDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KB_SCORING = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
