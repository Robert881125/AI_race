// 合併後的「標註」流程（使用者要求把地面校正、標可用地面、標障礙、標遮擋合成一個按鈕）。
// 一個按鈕依序引導：① 還沒校正 → 點地面矩形四角；② 已校正 → 圈範圍；③ 圈好 → 選它是什麼。
// 純函式，可在 Node 測試。

export const CALIB_NAMES = ['近左', '近右', '遠右', '遠左'];

export const KIND_TEXT = {
  floor: '可用地面',
  obstacle: '障礙物',
  occluder: '看不清楚（遮擋）',
};

/** 目前在標註流程的哪一步：'calib' 校正四角／'draw' 圈範圍／'choose' 選種類 */
export function annotateStep({ calibPts = [], calib = null, pending = null }) {
  if (!calib || calibPts.length < 4) return 'calib';
  return pending ? 'choose' : 'draw';
}

/** 給使用者看的提示 */
export function annotateHint(step, { calibCount = 0, draftCount = 0, live = false } = {}) {
  if (step === 'calib') {
    return `步驟 1／3 地面校正：依序點地上量好尺寸的矩形四角，下一點：${CALIB_NAMES[calibCount % 4]}（已點 ${calibCount}／4）。`;
  }
  if (step === 'choose') return '步驟 3／3 這個範圍是什麼？請選下方按鈕。';
  if (live) return '已完成地面校正。即時鏡頭會自動掃描；要人工圈範圍，請改用照片或暫停的影片。';
  return draftCount
    ? `步驟 2／3 圈範圍：已點 ${draftCount} 點，點回第一點或按「完成這個範圍」。障礙物請圈「貼地的範圍」，不是物體頂部。`
    : '步驟 2／3 圈範圍：在畫面上逐點圈出可用地面、障礙物或看不清楚的區域。不圈也可以，系統會用 AI 掃描結果判斷。';
}
