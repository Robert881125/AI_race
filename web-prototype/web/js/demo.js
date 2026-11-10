// 示範畫面：用已知的「假相機」畫出一段騎樓地面、校正膠帶與紙箱。
// 用途：沒有實拍影片時，也能展示整個流程，並驗證程式。
// 示範畫面的障礙與遮擋以「人工標註」預先放好（模型認不出畫出來的紙箱）。

import { makeCalibration, groundToImage } from './homography.js';

export const DEMO_SIZE = { width: 960, height: 720 };
export const DEMO_RECT = { widthCm: 160, lengthCm: 200, nearCm: 50 };
export const DEMO_CALIB_PTS = [[230, 660], [730, 660], [600, 330], [360, 330]];

export const DEMO_SCENES = {
  clear: { name: '淨空', boxes: [], pillars: [] },
  side: { name: '紙箱靠邊', boxes: [{ x0: 30, x1: 80, y0: 120, y1: 160, h: 45 }], pillars: [] },
  middle: { name: '紙箱在中間', boxes: [{ x0: -35, x1: 35, y0: 120, y1: 160, h: 45 }], pillars: [] },
  hidden: {
    name: '行人擋住視線',
    boxes: [{ x0: 30, x1: 80, y0: 120, y1: 160, h: 45 }],
    // 行人會移動：只當遮擋（後方看不到），不當阻隔
    pillars: [{ x0: -40, x1: -10, y0: 90, y1: 110, h: 160 }],
  },
};

const quad = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export function renderDemoScene(key) {
  const scene = DEMO_SCENES[key];
  const calib = makeCalibration(DEMO_CALIB_PTS, DEMO_RECT, DEMO_SIZE);
  const P = (pt) => groundToImage(calib, pt);
  const canvas = document.createElement('canvas');
  canvas.width = DEMO_SIZE.width;
  canvas.height = DEMO_SIZE.height;
  const ctx = canvas.getContext('2d');

  const poly = (pts, fill, stroke) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  };

  // 背景：牆面與車道
  ctx.fillStyle = '#9a948a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  poly(quad(-400, -80, -20, 520).map(P), '#4a4a4a'); // 左側車道
  poly(quad(80, 400, -20, 520).map(P), '#b5ab98'); // 右側店面牆腳
  // 騎樓地面
  poly(quad(-80, 80, -20, 520).map(P), '#d9d3c6');
  ctx.lineWidth = 1;
  for (let y = 0; y <= 520; y += 40) {
    const a = P([-80, y]); const b = P([80, y]);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
  }
  for (let x = -80; x <= 80; x += 40) {
    const a = P([x, -20]); const b = P([x, 520]);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
  }
  // 路緣
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#efefef';
  ctx.beginPath(); ctx.moveTo(...P([-80, -20])); ctx.lineTo(...P([-80, 520])); ctx.stroke();

  // 校正膠帶矩形
  const { widthCm: W, lengthCm: L, nearCm: d0 } = DEMO_RECT;
  ctx.lineWidth = 5;
  poly(quad(-W / 2, W / 2, d0, d0 + L).map(P), null, '#f2c200');

  const obstacles = [];
  const occluders = [];

  // 由遠到近畫物體
  const things = [
    ...scene.pillars.map((b) => ({ ...b, kind: 'pillar' })),
    ...scene.boxes.map((b) => ({ ...b, kind: 'box' })),
  ].sort((a, b) => b.y0 - a.y0);

  for (const t of things) {
    const foot = quad(t.x0, t.x1, t.y0, t.y1).map(P); // 近左 近右 遠右 遠左
    const pxPerCmNear = (foot[1][0] - foot[0][0]) / (t.x1 - t.x0);
    const pxPerCmFar = (foot[2][0] - foot[3][0]) / (t.x1 - t.x0);
    const hn = t.h * pxPerCmNear;
    const hf = t.h * pxPerCmFar;
    const up = (p, h) => [p[0], p[1] - h];
    const top = [up(foot[0], hn), up(foot[1], hn), up(foot[2], hf), up(foot[3], hf)];
    const front = [foot[0], foot[1], top[1], top[0]];
    const color = t.kind === 'box' ? ['#b0824f', '#c99a63', '#8e6639'] : ['#2f4a6b', '#3d5d85', '#263d59'];
    poly(front, color[0]);
    poly(top, color[1]);
    poly([foot[1], foot[2], top[2], top[1]], color[2]);
    ctx.lineWidth = 1.5;
    poly(front, null, 'rgba(0,0,0,0.35)');
    poly(top, null, 'rgba(0,0,0,0.35)');

    if (t.kind === 'box') {
      obstacles.push({ poly: foot, category: 'goods', label: '紙箱' });
    } else {
      // 行人整個畫面範圍：本身與後方地面都看不到 → 未知
      occluders.push([foot[0], foot[1], foot[2], top[2], top[3], top[0]].map((p) => [...p]));
    }
  }

  return {
    canvas,
    calibPts: DEMO_CALIB_PTS.map((p) => [...p]),
    rect: { ...DEMO_RECT },
    obstacles,
    occluders,
  };
}
