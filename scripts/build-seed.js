#!/usr/bin/env node
// 기본 내장 목록(extension/seed.json) 생성: 사용자들이 '학습 목록 내보내기'로 보낸 KBL1 파일들을 합친다.
// 사용법: node scripts/build-seed.js 목록1.txt 목록2.txt ...   (인자가 없으면 현재 seed.json 유지)
// - 형식이 잘못된 값·단색(불안정) 해시 제거, 거리 ≤3 중복 제거, 최대 5000개
const fs = require('fs');
const path = require('path');
const PH = require('../extension/phash.js');
const out = path.join(__dirname, '..', 'extension', 'seed.json');
const MAX = 5000;
let cur = [];
try { cur = JSON.parse(fs.readFileSync(out, 'utf8')).hashes || []; } catch (_) {}
const all = [...cur];
for (const f of process.argv.slice(2)) {
  const body = fs.readFileSync(f, 'utf8').trim().replace(/^KBL1:/, '');
  all.push(...body.split(/[,\s]+/));
}
const res = [];
let bad = 0, dup = 0;
for (const h of all.map((x) => x.toLowerCase())) {
  if (!PH.isHash(h) || !PH.usable(h)) { if (h) bad++; continue; }
  if (res.some((k) => PH.hamming(k, h) <= 3)) { dup++; continue; }
  res.push(h);
}
const final = res.slice(0, MAX);
fs.writeFileSync(out, JSON.stringify({ v: 1, hashes: final }) + '\n');
console.log(`seed.json: ${final.length}개 (이전 ${cur.length}, 잘못된 값 ${bad}, 중복 ${dup})`);
