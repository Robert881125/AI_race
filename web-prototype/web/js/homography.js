// 平面透視轉換（地面四點校正）。純函式，無 DOM，可在 Node 測試。
// 討論03 §2：用四個已量測的地面點，把影像座標換成地面公分座標。

/** 由 4 組對應點求 3x3 矩陣 H，使 H * src ≈ dst。 */
export function solveHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new Error('需要 4 組對應點');
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // 四點共線或重複
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function invert3x3(m) {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/** 套用 H，回傳 { p:[x,y], w }。w 的正負用來判斷點是否落在地平線另一側。 */
export function applyH(H, [x, y]) {
  const u = H[0][0] * x + H[0][1] * y + H[0][2];
  const v = H[1][0] * x + H[1][1] * y + H[1][2];
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  if (Math.abs(w) < 1e-12) return null;
  return { p: [u / w, v / w], w };
}

/**
 * 建立校正物件。
 * imagePts：影像上依序點的 4 角【近左、近右、遠右、遠左】（像素，影片原始解析度）
 * rect：{ widthCm, lengthCm, nearCm }，nearCm = 輪椅前緣到矩形近端的距離
 * 地面座標：以矩形中線為 x=0（向右為正），輪椅前緣為 y=0（向前為正），單位公分。
 */
export function makeCalibration(imagePts, rect, imageSize) {
  const { widthCm: W, lengthCm: L, nearCm: d0 } = rect;
  if (![W, L, d0].every(Number.isFinite) || W <= 0 || L <= 0 || d0 < 0 ||
      imagePts.length !== 4 || !imagePts.every(([x, y]) =>
        Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 &&
        x <= imageSize.width && y <= imageSize.height)) return null;
  const turns = imagePts.map(([ax, ay], i) => {
    const [bx, by] = imagePts[(i + 1) % 4];
    const [cx, cy] = imagePts[(i + 2) % 4];
    return (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
  });
  if (!turns.every((turn) => turn > 0) && !turns.every((turn) => turn < 0)) return null;
  const groundPts = [
    [-W / 2, d0],
    [W / 2, d0],
    [W / 2, d0 + L],
    [-W / 2, d0 + L],
  ];
  const imgToGround = solveHomography(imagePts, groundPts);
  if (!imgToGround) return null;
  const groundToImg = invert3x3(imgToGround);
  if (!groundToImg) return null;
  // 以矩形中心為參考，記下「地面這一側」的 w 正負號
  const center = [0, d0 + L / 2];
  const ref = applyH(groundToImg, center);
  if (!ref) return null;
  const centerImg = applyH(imgToGround, ref.p);
  if (!centerImg) return null;
  return {
    imagePts,
    rect: { ...rect },
    imageSize: { ...imageSize },
    imgToGround,
    groundToImg,
    signG2I: Math.sign(ref.w),
    signI2G: Math.sign(centerImg.w),
  };
}

/** 影像 → 地面（公分）。落在地平線以上回傳 null。 */
export function imageToGround(calib, pt) {
  const r = applyH(calib.imgToGround, pt);
  if (!r || Math.sign(r.w) !== calib.signI2G) return null;
  return r.p;
}

/** 地面（公分）→ 影像。在鏡頭後方回傳 null。 */
export function groundToImage(calib, pt) {
  const r = applyH(calib.groundToImg, pt);
  if (!r || Math.sign(r.w) !== calib.signG2I) return null;
  return r.p;
}
