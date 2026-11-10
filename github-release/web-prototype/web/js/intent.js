// 語音回答的意圖判斷（關鍵詞，不需要大型語言模型，離線可用）。
// 原則：寧可「不清楚」也不要誤判為同意（討論01 §2 Step3、第一步規劃）。

const NO = /^(?:(?:先)?(?:不要|不用|不必|不需要|別)(?:回報)?(?:了)?|算了|等一下|等等)(?:謝謝)?$/;
const YES = /^(?:好(?:的|啊|喔)?|要|可以|對|是|同意|請回報|我要回報|(?:好|要|可以|同意|麻煩你)?回報|麻煩你|沒問題|ok|okay)(?:謝謝)?$/i;

/** 回傳 'yes' | 'no' | 'unclear' */
export function classifyConsent(raw) {
  const rawText = String(raw ?? '').trim();
  if (/[？?]/.test(rawText)) return 'unclear';
  const text = rawText.replace(/[，。！、\s,.!]/g, '');
  if (NO.test(text)) return 'no';
  if (YES.test(text)) return 'yes';
  return 'unclear';
}
