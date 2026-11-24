// 지각 해시(dHash 64비트): 같은 배너가 크기·압축·도메인이 달라도 비슷한 값이 나오게 한다.
// 이미지 자체는 저장/전송하지 않고, 16자리 16진수 해시만 목록에 남긴다.
(function (root) {
  // g: 9열×8행 그레이값(길이 72) → 16자리 hex
  function dhashFromGray(g) {
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let nib = 0;
      for (let x = 0; x < 8; x++) {
        nib = (nib << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
        if (x === 3 || x === 7) { hex += nib.toString(16); nib = 0; }
      }
    }
    return hex;
  }
  const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  function hamming(a, b) {
    let d = 0;
    for (let i = 0; i < 16; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
    return d;
  }
  // 단색에 가까운 이미지는 해시가 불안정해 목록 등록/매칭에서 제외
  function usable(h) {
    let ones = 0;
    for (let i = 0; i < 16; i++) ones += POP[parseInt(h[i], 16)];
    return ones >= 14 && ones <= 50;
  }
  const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);
  const api = { dhashFromGray, hamming, usable, isHash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KB_PHASH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
