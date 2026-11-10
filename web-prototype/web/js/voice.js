// 語音播報（Web Speech 合成）與單次聆聽（Web Speech 辨識）。
// 聆聽只在系統提問之後開啟一次（第一步規劃：語音回合只在詢問之後開啟）。

let zhVoice = null;
function pickVoice() {
  if (zhVoice || !('speechSynthesis' in window)) return zhVoice;
  const voices = speechSynthesis.getVoices();
  zhVoice = voices.find((v) => /zh[-_]TW/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang)) || null;
  return zhVoice;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { zhVoice = null; pickVoice(); };

export const canSpeak = () => 'speechSynthesis' in window;

export function say(text) {
  return new Promise((resolve) => {
    if (!canSpeak()) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    const v = pickVoice();
    if (v) u.voice = v;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
    setTimeout(finish, Math.max(4000, text.length * 350)); // 某些瀏覽器不觸發 onend
  });
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = () => !!SR && window.isSecureContext;

let current = null;
export function listenOnce(ms = 6000) {
  return new Promise((resolve) => {
    if (!canListen()) return resolve('');
    const r = new SR();
    current = r;
    r.lang = 'zh-TW';
    r.interimResults = false;
    r.maxAlternatives = 1;
    let done = false;
    const finish = (t) => {
      if (done) return;
      done = true;
      current = null;
      try { r.abort(); } catch { /* 已結束 */ }
      resolve(t || '');
    };
    r.onresult = (e) => finish(e.results?.[0]?.[0]?.transcript || '');
    r.onerror = () => finish('');
    r.onend = () => finish('');
    setTimeout(() => finish(''), ms);
    try { r.start(); } catch { finish(''); }
  });
}

export function stopAll() {
  if (current) { try { current.abort(); } catch { /* 已結束 */ } }
  if (canSpeak()) speechSynthesis.cancel();
}
