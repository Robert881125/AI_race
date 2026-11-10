// 通行判斷核心（討論04 的 GroundProjector + PassabilityEngine 的網頁版簡化實作）。
// 純函式，無 DOM，可在 Node 測試。
//
// v0.1 簡化（畫面與報告都要標明）：
//  - 只檢查「輪椅寬度＋兩側餘裕」的橫截面，尚未計入車身長度與轉彎掃過的範圍。
//  - 每前進一格最多左右偏移一格（約 45°），屬於「緩轉候選」。
//  - 障礙貼地位置來自人工標註或已校正影格的地面接觸證據。

import { groundToImage } from './homography.js';

export const FREE = 0;
export const BLOCKED = 1;
export const UNKNOWN = 2;

export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentTouchesCell(a, b, x, y, half) {
  let enter = 0;
  let exit = 1;
  const center = [x, y];
  for (let axis = 0; axis < 2; axis++) {
    const low = center[axis] - half;
    const high = center[axis] + half;
    const delta = b[axis] - a[axis];
    if (!delta) {
      if (a[axis] < low || a[axis] > high) return false;
      continue;
    }
    const first = (low - a[axis]) / delta;
    const second = (high - a[axis]) / delta;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return false;
  }
  return true;
}

/**
 * 建立地面格網。
 * opts:
 *  calib          校正物件（可為 null，代表手工格網測試，此時不檢查可見性）
 *  corridor       { leftCm, rightCm }  通道左右邊界（地面 x）
 *  range          { startCm, endCm }   分析的前後範圍（地面 y）
 *  cellCm         格子大小
 *  blockedGround  地面多邊形陣列（確定的貼地阻隔）
 *  unknownGround  地面多邊形陣列（人工標的未知區）
 *  unknownImage   影像多邊形陣列（被物體遮住的畫面區域）
 *  marginCm       量測誤差：阻隔周圍這段距離內的空地改為未知
 */
export function buildGrid(opts) {
  const {
    calib = null,
    corridor,
    range,
    cellCm = 5,
    freeImage = [],
    sampleImage = null,
    blockedGround = [],
    unknownGround = [],
    unknownImage = [],
    marginCm = 5,
  } = opts;
  const cols = Math.floor((corridor.rightCm - corridor.leftCm) / cellCm);
  const rows = Math.floor((range.endCm - range.startCm) / cellCm);
  if (!(cols > 0 && rows > 0 && cols * rows <= 100_000)) return null;
  const cells = new Uint8Array(rows * cols);
  const observedRows = sampleImage ? new Uint8Array(rows) : null;
  const imgW = calib?.imageSize?.width;
  const imgH = calib?.imageSize?.height;

  for (let r = 0; r < rows; r++) {
    const y = range.startCm + (r + 0.5) * cellCm;
    for (let c = 0; c < cols; c++) {
      const x = corridor.leftCm + (c + 0.5) * cellCm;
      const ip = calib ? groundToImage(calib, [x, y]) : null;
      const inFrame = ip && ip[0] >= 0 && ip[1] >= 0 && ip[0] < imgW && ip[1] < imgH;
      let s = FREE;
      if (calib) {
        if (sampleImage) {
          s = inFrame ? sampleImage(ip) : UNKNOWN;
        } else if (!inFrame || !freeImage.some((poly) => pointInPolygon(ip, poly)) ||
                   unknownImage.some((poly) => pointInPolygon(ip, poly))) {
          s = UNKNOWN; // 沒有已確認地面，或視線被遮住
        }
      }
      if ((!calib || inFrame) &&
          blockedGround.some((poly) => pointInPolygon([x, y], poly))) s = BLOCKED;
      else if (s === FREE && (
        blockedGround.some((poly) => poly.some((point, i) =>
          segmentTouchesCell(point, poly[(i + 1) % poly.length], x, y, cellCm / 2))) ||
        unknownGround.some((poly) => pointInPolygon([x, y], poly))
      )) s = UNKNOWN; // 有碰到障礙邊界，整格不能當作可用
      cells[r * cols + c] = s;
      if (observedRows && s !== UNKNOWN) observedRows[r] = 1;
    }
  }

  // 誤差邊帶：阻隔旁 marginCm 內的空地改成未知（討論04：邊界受誤差影響的格子歸入 UNKNOWN）
  const m = Math.round(marginCm / cellCm);
  if (m > 0) {
    const src = cells.slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (src[r * cols + c] !== FREE) continue;
        let near = false;
        for (let dr = -m; dr <= m && !near; dr++) {
          for (let dc = -m; dc <= m && !near; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            if (src[rr * cols + cc] === BLOCKED) near = true;
          }
        }
        if (near) cells[r * cols + c] = UNKNOWN;
      }
    }
  }

  return { rows, cols, cellCm, corridor, range, cells, observedRows, hasEvidence: !calib || cells.some((cell) => cell !== UNKNOWN) };
}

export function cellAt(grid, r, c) {
  return grid.cells[r * grid.cols + c];
}

function colOfX(grid, x) {
  return Math.floor((x - grid.corridor.leftCm) / grid.cellCm);
}

function xOfCol(grid, c) {
  return grid.corridor.leftCm + (c + 0.5) * grid.cellCm;
}

function yOfRow(grid, r) {
  return grid.range.startCm + (r + 0.5) * grid.cellCm;
}

/** 輪椅中心放在第 c 欄時，整個寬度（含餘裕）是否都是 allowed 狀態 */
function fits(grid, r, c, halfCells, allowed) {
  if (c - halfCells < 0 || c + halfCells >= grid.cols) return false;
  for (let k = c - halfCells; k <= c + halfCells; k++) {
    if (!allowed.has(cellAt(grid, r, k))) return false;
  }
  return true;
}

/** 每一列中「非確定阻隔」的最長連續寬度；若某列連這個上限都不足，就是確定瓶頸 */
export function findDefiniteBottleneck(grid, requiredCm) {
  for (let r = 0; r < grid.rows; r++) {
    if (grid.observedRows && !grid.observedRows[r]) continue;
    let best = 0;
    let run = 0;
    for (let c = 0; c < grid.cols; c++) {
      if (cellAt(grid, r, c) === BLOCKED) run = 0;
      else best = Math.max(best, ++run);
    }
    // 格網取整：寬度上限多給一格，避免把取整誤差算成阻隔
    const upperCm = (best + 1) * grid.cellCm + (grid.widthErrorCm ?? 0);
    if (upperCm < requiredCm) return { row: r, yCm: yOfRow(grid, r), maxGapCm: best * grid.cellCm };
  }
  return null;
}

/**
 * 找一條從輪椅位置到分析範圍最遠端、全程夠寬的連續動線。
 * 回傳 [{x,y}, ...] 或 null。
 */
export function searchForward(grid, requiredCm, startXCm, maxShiftCells = 1) {
  const half = Math.ceil(requiredCm / 2 / grid.cellCm - 0.5);
  const allowed = new Set([FREE]);
  const startCol = colOfX(grid, startXCm);
  if (!fits(grid, 0, startCol, half, allowed)) return null;

  let frontier = new Map([[startCol, -1]]);
  const parents = [frontier];
  for (let r = 1; r < grid.rows; r++) {
    const next = new Map();
    for (const c of frontier.keys()) {
      for (let d = -maxShiftCells; d <= maxShiftCells; d++) {
        const nc = c + d;
        if (next.has(nc)) continue;
        if (fits(grid, r, nc, half, allowed)) next.set(nc, c);
      }
    }
    if (next.size === 0) return null;
    parents.push(next);
    frontier = next;
  }
  // 回溯：優先選離起點欄最近的終點（較直）
  let c = [...frontier.keys()].sort((a, b) => Math.abs(a - startCol) - Math.abs(b - startCol))[0];
  const path = [];
  for (let r = grid.rows - 1; r >= 0; r--) {
    path.push({ x: xOfCol(grid, c), y: yOfRow(grid, r) });
    c = parents[r].get(c);
  }
  return path.reverse();
}

/**
 * 主判斷（討論04 assess）。
 * 回傳 { status: 'CANDIDATE'|'BLOCKED'|'UNKNOWN', reason, path, bottleneck }
 */
export function assess(grid, { requiredCm, startXCm = 0, maxShiftCells = 1 }) {
  if (!grid) return { status: 'UNKNOWN', reason: 'OUTSIDE_CALIBRATION', path: null, bottleneck: null };
  if (!Number.isFinite(requiredCm) || requiredCm <= 0) {
    return { status: 'UNKNOWN', reason: 'INVALID_PROFILE', path: null, bottleneck: null };
  }
  if (grid.hasEvidence === false) {
    return { status: 'UNKNOWN', reason: 'NO_GROUND_EVIDENCE', path: null, bottleneck: null };
  }

  const path = searchForward(grid, requiredCm, startXCm, maxShiftCells);
  if (path) return { status: 'CANDIDATE', reason: 'PATH_FOUND', path, bottleneck: null };

  const bottleneck = findDefiniteBottleneck(grid, requiredCm);
  if (bottleneck) return { status: 'BLOCKED', reason: 'NARROW_CROSS_SECTION', path: null, bottleneck };

  // 有沒有未知區擋在路上？
  let hasUnknown = false;
  for (let i = 0; i < grid.cells.length; i++) if (grid.cells[i] === UNKNOWN) { hasUnknown = true; break; }
  return {
    status: 'UNKNOWN',
    reason: hasUnknown ? 'OCCLUDED' : 'NO_VERIFIED_PATH',
    path: null,
    bottleneck: null,
  };
}

export const REASON_TEXT = {
  PATH_FOUND: '找到一條全程夠寬的連續動線（緩轉候選）',
  NARROW_CROSS_SECTION: '有一個橫截面，即使把未知區都當成空地，剩餘寬度仍不足',
  OCCLUDED: '可能的動線要經過看不到或量不準的區域',
  NO_VERIFIED_PATH: '找不到已驗證的連續動線，也無法證明有瓶頸',
  OUTSIDE_CALIBRATION: '尚未完成地面校正，無法判斷',
  INVALID_PROFILE: '輪椅通行寬度必須大於零',
  NO_GROUND_EVIDENCE: '尚無可確認的地面或阻隔，請用暫停影片或照片標註',
  LIVE_CALIBRATION_REQUIRED: '完成四點校正並確認量測條件後，才會自動判斷輪椅淨寬。',
  LIVE_SCANNING: '已啟用 90 公分輪椅淨寬判斷，等待下一個掃描影格。',
  LIVE_CONFIRMING_BLOCK: '偵測到可能受阻，正在用後續影格確認。',
  LIVE_SCAN_FAILED: '目前沒有可用的掃描結果。請重新掃描。',
  STALE_FRAME: '畫面已過期',
};

export const STATUS_TEXT = {
  CANDIDATE: '有候選動線',
  BLOCKED: '通行空間不足',
  UNKNOWN: '無法確認',
};
