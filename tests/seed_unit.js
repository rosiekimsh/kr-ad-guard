const fs = require('fs'), path = require('path'), assert = require('assert');
const PH = require('../extension/phash.js');
const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'seed.json'), 'utf8'));
assert.strictEqual(j.v, 1); assert(Array.isArray(j.hashes));
for (const h of j.hashes) assert(PH.isHash(h) && PH.usable(h), 'bad hash ' + h);
console.log('seed.json 검증 통과 (' + j.hashes.length + '개)');
