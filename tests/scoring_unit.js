// node tests/scoring_unit.js — 합법/정상 문구는 균형(5점) 미만, 불법 도박 문구는 이상이어야 한다.
// 실제 광고 이미지 없이 합성 문자열로만 검증한다.
const S = require('../extension/scoring.js');
const TH = 5;
const legit = [
  '스포츠토토 체육진흥투표권 발매',
  '베트맨 프로토 승부식 발매중',
  '동행복권 로또6/45 1등 당첨금',
  '강원랜드 카지노 호텔 패키지',
  '수수료 페이백 30% 거래소 평생할인',
  '알파벳 주가 상승 신규 가입 이벤트',
  '신규 가입 시 쿠폰 지급 보증 서비스 입금 출금',
];
const bad = [
  '신규첫충 무한매충15 페이백 카지노 5+3 10+5 30+10',
  '스포츠 최고배당 무제재 무제한 베팅 가입첫충 페이백 콤프',
  '무기명 테더 입출금가능 가입코드',
  '패이택 롤링100% 콤프 모든게임',
  '후불제 비아그라 시알리스',
];
const url = [
  ['https://www.betman.co.kr/main', false],
  ['https://www.sportstoto.co.kr/', false],
  ['https://abet-casino.com/?code=ab1', true],
  ['https://alphabet.com/', false],
  ['https://oceanbet.com/', true],
];
let fail = 0;
const chk = (ok, msg) => { if (!ok) { fail++; console.log('FAIL', msg); } };
for (const t of legit) { const r = S.scoreText(t); chk(r.score < TH, `legit ${r.score} ${t} [${r.hits}]`); }
for (const t of bad) { const r = S.scoreText(t); chk(r.score >= TH, `bad ${r.score} ${t} [${r.hits}]`); }
for (const [u, expectBlock] of url) { const r = S.scoreUrlLike(u); chk((r.score >= 3) === expectBlock, `url ${r.score} ${u}`); }
// 페이지 문맥: 도박 모음 페이지는 가산, 정상 쇼핑몰 푸터(입점문의·광고문의)는 0점
chk(S.scorePage('공식 텔레그램 채널 — 최신 주소는 여기서 확인하세요! 입점문의').score === 3, 'page aggregator');
chk(S.scorePage('고객센터 광고문의 입점문의 텔레그램 문의').score === 0, 'page shop footer');
chk(S.scorePage('입점문의').score === 0, 'page 입점문의 only');
console.log(fail ? `${fail} 실패` : '점수 단위 테스트 전부 통과');
process.exit(fail ? 1 : 0);
