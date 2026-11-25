const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, mode: 'balanced', debug: false, allow: [] };

async function main() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}

  $('enabled').checked = cfg.enabled;
  $('mode').value = cfg.mode;
  $('debug').checked = cfg.debug;
  $('site').checked = !cfg.allow.includes(host);
  $('site').disabled = !host;

  const st = (await chrome.storage.local.get('kbStats')).kbStats || { total: 0 };
  $('total').textContent = st.total;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'KB_POPUP_STATE', tabId: tab.id });
    if (r) $('page').textContent = r.count;
  } catch (_) {}

  $('enabled').onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
  $('mode').onchange = (e) => chrome.storage.sync.set({ mode: e.target.value });
  $('debug').onchange = (e) => chrome.storage.sync.set({ debug: e.target.checked });
  $('site').onchange = async (e) => {
    const cur = (await chrome.storage.sync.get(DEFAULTS)).allow || [];
    const next = e.target.checked ? cur.filter((h) => h !== host) : [...new Set([...cur, host])];
    chrome.storage.sync.set({ allow: next });
  };
  $('report').onclick = async () => {
    $('msg').textContent = '리포트 생성 중…';
    const r = await chrome.runtime.sendMessage({ type: 'KB_REPORT_REQUEST', tabId: tab.id });
    try {
      await navigator.clipboard.writeText(r.text);
      $('msg').textContent = `복사됨 (${r.text.split('\n').length}줄). 채팅에 붙여넣으세요.`;
    } catch (_) {
      $('msg').innerHTML = '';
      const ta = document.createElement('textarea');
      ta.value = r.text; ta.style.cssText = 'width:100%;height:120px;font-size:11px';
      $('msg').appendChild(ta); ta.select();
    }
  };
  const refreshKnown = async () => {
    try { const r = await chrome.runtime.sendMessage({ type: 'KB_KNOWN_STATE' }); $('known').textContent = r ? r.count : 0; $('kauto').textContent = [r && r.auto ? `자동 ${r.auto}개` : '', r && r.seed ? `기본 내장 ${r.seed}개` : ''].filter(Boolean).join(', ').replace(/^(.+)$/, '($1)'); } catch (_) {}
  };
  refreshKnown();
  $('kexport').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'KB_KNOWN_EXPORT' });
    try { await navigator.clipboard.writeText(r.text); $('msg').textContent = '학습 목록을 복사했습니다 (이미지·주소 없이 해시만 들어 있음).'; }
    catch (_) { $('kbox').style.display = 'block'; $('ktext').value = r.text; $('ktext').select(); }
  };
  $('kimport').onclick = () => { $('kbox').style.display = $('kbox').style.display === 'none' ? 'block' : 'none'; };
  $('kgo').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'KB_KNOWN_IMPORT', text: $('ktext').value });
    $('msg').textContent = r.ok ? `${r.added}개 추가됨 (총 ${r.total}개). 페이지를 새로고침하세요.` : r.error;
    if (r.ok) { $('ktext').value = ''; refreshKnown(); }
  };
  $('kclear').onclick = async () => {
    if (!confirm('학습한 목록(신고·자동 학습·정상 표시)을 모두 초기화할까요?')) return;
    await chrome.runtime.sendMessage({ type: 'KB_KNOWN_CLEAR' });
    $('msg').textContent = '학습 목록을 초기화했습니다.'; refreshKnown();
  };
  $('pick').onclick = async () => {
    try { await chrome.runtime.sendMessage({ type: 'KB_PICK_START', tabId: tab.id }); } catch (_) {}
    window.close();
  };
  $('restore').onclick = async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'KB_RESTORE' }); $('page').textContent = 0; } catch (_) {}
  };
}
main();
