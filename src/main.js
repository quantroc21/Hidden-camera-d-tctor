import { create } from 'diffyjs';
import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

/*
 * Máy soi camera — demo.
 * Camera lấy qua repo diffyjs (maniart/diffyjs). Phần dò tự viết:
 * màn hình sáng đứng yên -> ống kính camera phản xạ thành ĐỐM SÁNG CHÓI ->
 * tìm điểm sáng nổi bật nhất khung hình -> khoanh đỏ. Vật sáng lớn (gương/kính) bị loại.
 */

const AW = 96, AH = 72;              // lưới phân tích (nhỏ cho nhanh)
const SURFACE_RATIO = 0.05;          // cụm > 5% khung => bề mặt phản chiếu lớn -> loại
const MAX_LENS_CELLS = 22;           // ống kính ẩn NHỎ: đốm lớn hơn (chữ/icon/vật sáng) -> loại

const flashEl = document.getElementById('flash');
const stageEl = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const hintEl = document.getElementById('hint');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const sensEl = document.getElementById('sens');
const subEl = document.getElementById('sub');
const modeLensBtn = document.getElementById('modeLens');
const modeIrBtn = document.getElementById('modeIr');
const modeAiBtn = document.getElementById('modeAi');
const octx = overlay.getContext('2d');

const acanvas = document.createElement('canvas');
acanvas.width = AW; acanvas.height = AH;
const actx = acanvas.getContext('2d', { willReadFrequently: true });

let diffy = null, raf = null, started = false;
let mode = 'lens';          // 'lens' (soi ống kính) | 'ir' (soi đèn đêm)
let tracks = [];
let aiModel = null, aiBusy = false, aiLast = 0;

// Camera trước (máy 1). Máy 2 = đèn sáng ép sát camera (giữ đèn để ống kính phản xạ).
const SUB = {
  lens: 'Máy 1 <b>camera trước</b> · máy 2 <b>đèn sáng ép sát cạnh camera</b> · <b>NGHIÊNG / rê CHẬM</b> quanh vật — đốm nhỏ <b>ánh tím/xanh đổi màu</b> (lớp phủ ống kính) = camera (khoanh đỏ)',
  ir: 'Dùng <b>camera trước</b> · <b>tắt HẾT đèn</b>, chờ ~10s cho camera ẩn chuyển quay đêm · tìm chấm sáng tím/trắng mắt thường không thấy',
  ai: '<b>AI (thử)</b> · giữ <b>đèn sáng</b>, chĩa quanh phòng — AI nhận <b>điện thoại/laptop/TV</b> (vật chứa camera). Cần internet tải model lần đầu.',
};
const AI_CLASSES = { 'cell phone': 'điện thoại', laptop: 'laptop', tv: 'màn hình/TV' };
const facingFor = () => 'environment';

const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = (c) => {
  if (c && c.video && typeof c.video === 'object') c.video.facingMode = { ideal: facingFor() };
  return origGUM(c);
};

// làm mờ (trung bình vùng) để lấy nền cục bộ
function boxBlur(src, w, h, r) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      acc += src[ny * w + nx]; cnt++;
    }
    out[y * w + x] = acc / cnt;
  }
  return out;
}

function detect(video) {
  actx.drawImage(video, 0, 0, AW, AH);
  const d = actx.getImageData(0, 0, AW, AH).data;
  const lum = new Float32Array(AW * AH);
  let max = 0;
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    const L = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    lum[i] = L; if (L > max) max = L;
  }
  const sens = Number(sensEl.value);

  if (mode === 'ir') {
    // IR: chấm sáng nổi bật cục bộ trong tối (đèn hồng ngoại camera quay đêm)
    const bg = boxBlur(lum, AW, AH, 6);
    const cfg = { minCells: 2, color: '210,70,255', label: 'đốm IR (nghi camera quay đêm)' };
    const hot = (i) => lum[i] >= 78 && (lum[i] - bg[i]) >= (55 - sens * 3);
    clusterDrawStatus(hot, d, Math.round(max), cfg, false);
    return;
  }

  // LENS: đèn sáng đứng yên + BÁM GÓC (phép #2 retroreflection).
  // Rê máy chậm: đốm PHẢN XẠ NGƯỢC (ống kính) giữ sáng liên tục -> "track" già đi -> xác nhận.
  // Gương/kim loại chỉ lóe 1 góc rồi tắt -> track chết yểu -> loại. LED màu -> lọc màu riêng.
  detectLensSweep(d, lum, sens);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Hue (độ) từ RGB — để bắt ánh tím/xanh của lớp phủ AR ống kính
function rgbHue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn;
  if (dd < 1e-6) return 0;
  let h;
  if (mx === r) h = ((g - b) / dd) % 6;
  else if (mx === g) h = (b - r) / dd + 2;
  else h = (r - g) / dd + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}
// Độ "lấp lánh đổi màu" của một track = phương sai hue theo thời gian (giao thoa AR coating)
function hueVar(t) {
  if (t.n < 4) return 0;
  const R = Math.sqrt(t.sHueSin * t.sHueSin + t.sHueCos * t.sHueCos) / t.n;
  return clamp01((1 - R) / 0.4);   // hue trải rộng -> shimmer cao
}

// Điểm bằng chứng: gộp NHIỀU dấu hiệu của ống kính -> chỉ khoanh khi đủ điểm.
// Chấm điểm dựa trên tài liệu về "cat's eye"/lens-sensor retroreflection:
//  - phản xạ sáng gấp 2–4 bậc & BÃO HÒA sensor (LAPD, Optica) -> lõi bão hòa là dấu hiệu mạnh nhất
//  - chỉ hiện trong cửa sổ góc hẹp (LAPD FoV filter) -> bám vài khung khi rê, không cần dài
// Bằng chứng dựa trên đặc trưng lớp phủ AR: đốm nhỏ, có MÀU, và màu ĐỔI khi nghiêng
// (giao thoa nhiều lớp) -> khác LED (màu đứng yên) và bề mặt trắng phẳng.
function evidence(t) {
  const n = t.n;
  const cMean = t.sC / n;
  const fillM = t.sFill / n, aspM = t.sAsp / n, satM = t.sSat / n, szM = t.sSz / n;
  const persist  = clamp01((t.age - 2) / 8);                 // bám khi rê
  const shimmer  = hueVar(t);                                // màu đổi (AR coating) — đặc trưng nhất
  const colorful = clamp01((satM - 0.12) / 0.4);             // có màu (không xám/trắng phẳng)
  const strong   = clamp01((cMean - 40) / 110);              // đủ chói hơn nền
  const round    = clamp01((fillM - 0.4) / 0.55) * clamp01((2.6 - aspM) / 1.6);
  const small    = clamp01((22 - szM) / 18);                 // đốm nhỏ (ống kính ẩn)
  return 0.24 * persist + 0.22 * shimmer + 0.16 * colorful + 0.14 * small + 0.12 * round + 0.12 * strong;
}

// Phát hiện ống kính: gom đốm -> đo nhiều đặc trưng -> nối track -> chấm điểm bằng chứng
function detectLensSweep(d, lum, sens) {
  const bg = boxBlur(lum, AW, AH, 6);
  const absFloor = 150, localGap = 110 - sens * 7;
  const hot = (i) => lum[i] >= absFloor && (lum[i] - bg[i]) >= localGap;

  const seen = new Uint8Array(AW * AH);
  const cands = [];
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const i0 = y * AW + x;
    if (seen[i0] || !hot(i0)) continue;
    const st = [i0]; seen[i0] = 1;
    let c = 0, minX = x, maxX = x, minY = y, maxY = y, sR = 0, sG = 0, sB = 0, sL = 0, sBg = 0, nClip = 0;
    while (st.length) {
      const i = st.pop(), cx = i % AW, cy = (i - cx) / AW; c++;
      const p = i * 4; sR += d[p]; sG += d[p + 1]; sB += d[p + 2]; sL += lum[i]; sBg += bg[i];
      if (lum[i] >= 240) nClip++;   // đếm pixel gần bão hòa (lõi cat's eye)
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= AW || ny < 0 || ny >= AH) continue;
        const ni = ny * AW + nx;
        if (!seen[ni] && hot(ni)) { seen[ni] = 1; st.push(ni); }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = c / (bw * bh), aspect = Math.max(bw, bh) / Math.min(bw, bh);
    const mx = Math.max(sR, sG, sB), mn = Math.min(sR, sG, sB), sat = mx > 0 ? (mx - mn) / mx : 0;
    const contrast = sL / c - sBg / c;
    const box = { minX, maxX, minY, maxY };
    // Chỉ nhận đốm NHỎ & gọn (ống kính ẩn nhỏ). Đốm to (chữ/icon/vật sáng) -> loại.
    if (c > MAX_LENS_CELLS || c < 3) continue;
    if (fill >= 0.5 && aspect <= 2.3) {   // nhận cả đốm CÓ MÀU (ánh AR của ống kính)
      const hueRad = rgbHue(sR, sG, sB) * Math.PI / 180;
      cands.push({ cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2, box, fill, aspect, sat, contrast, size: c, hueRad });
    }
  }

  matchTracks(cands);
  const CONF = clamp01(0.60 - sens * 0.03);   // ngưỡng điểm (sens5 -> 0.45)
  const confirmed = [];
  let pendingCount = 0;
  for (const t of tracks) {
    if (t.miss > 0) continue;
    const s = evidence(t);
    const satM = t.sSat / t.n;
    // phải: đủ điểm + bám lâu + CÓ MÀU + màu ĐỔI (shimmer) -> loại LED (màu đứng yên) & đốm trắng
    if (s >= CONF && t.age >= 5 && satM >= 0.15 && hueVar(t) >= 0.15) confirmed.push(t.box);
    else if (s >= CONF - 0.12) pendingCount++;
  }
  drawSweep(confirmed);   // CHỈ vẽ chấm đỏ đã đủ bằng chứng

  statusEl.classList.remove('idle', 'ok', 'warn');
  if (confirmed.length > 0) {
    statusEl.textContent = `🔴 ${confirmed.length} đốm ĐỦ BẰNG CHỨNG ống kính`;
    statusEl.classList.add('warn');
  } else if (pendingCount > 0) {
    statusEl.textContent = '⏳ Đang gom bằng chứng — RÊ CHẬM quanh vật';
    statusEl.classList.add('idle');
  } else {
    statusEl.textContent = '✅ Chưa thấy ống kính';
    statusEl.classList.add('ok');
  }
}

// Nối đốm qua các khung + tích lũy thống kê đặc trưng để chấm điểm
function matchTracks(cands) {
  const R2 = 11 * 11;
  const used = new Array(tracks.length).fill(false);
  for (const cd of cands) {
    let best = -1, bestD = R2;
    for (let k = 0; k < tracks.length; k++) {
      if (used[k]) continue;
      const dx = tracks[k].x - cd.cx, dy = tracks[k].y - cd.cy, dd = dx * dx + dy * dy;
      if (dd < bestD) { bestD = dd; best = k; }
    }
    if (best >= 0) {
      const t = tracks[best]; used[best] = true;
      t.x = (t.x + cd.cx) / 2; t.y = (t.y + cd.cy) / 2;
      t.age++; t.miss = 0; t.box = cd.box;
      t.n++; t.sC += cd.contrast;
      t.sFill += cd.fill; t.sAsp += cd.aspect; t.sSat += cd.sat; t.sSz += cd.size;
      t.sHueSin += Math.sin(cd.hueRad); t.sHueCos += Math.cos(cd.hueRad);
    } else {
      tracks.push({
        x: cd.cx, y: cd.cy, age: 1, miss: 0, box: cd.box,
        n: 1, sC: cd.contrast,
        sFill: cd.fill, sAsp: cd.aspect, sSat: cd.sat, sSz: cd.size,
        sHueSin: Math.sin(cd.hueRad), sHueCos: Math.cos(cd.hueRad),
      });
    }
  }
  for (let k = 0; k < tracks.length; k++) if (!used[k]) tracks[k].miss++;
  tracks = tracks.filter((t) => t.miss <= 3);
}

function drawSweep(confirmed) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const sx = W / AW, sy = H / AH;
  // CHỈ vẽ chấm đỏ đã đủ bằng chứng
  octx.lineWidth = 3; octx.strokeStyle = 'rgba(255,40,40,0.97)'; octx.fillStyle = 'rgba(255,40,40,0.20)';
  for (const b of confirmed) circle(b, sx, sy);
}

// BFS gom cụm + lọc gọn/màu + vẽ + báo trạng thái
function clusterDrawStatus(hot, d, maxVal, cfg, useColor) {
  const seen = new Uint8Array(AW * AH);
  const lenses = [], leds = [], surfaces = [];
  const maxLensCells = AW * AH * SURFACE_RATIO;
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const i0 = y * AW + x;
    if (seen[i0] || !hot(i0)) continue;
    const st = [i0]; seen[i0] = 1;
    let c = 0, minX = x, maxX = x, minY = y, maxY = y, sR = 0, sG = 0, sB = 0;
    while (st.length) {
      const i = st.pop(), cx = i % AW, cy = (i - cx) / AW; c++;
      const p = i * 4; sR += d[p]; sG += d[p + 1]; sB += d[p + 2];
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= AW || ny < 0 || ny >= AH) continue;
        const ni = ny * AW + nx;
        if (!seen[ni] && hot(ni)) { seen[ni] = 1; st.push(ni); }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = c / (bw * bh), aspect = Math.max(bw, bh) / Math.min(bw, bh);
    const compact = fill >= 0.45 && aspect <= 2.6 && c >= cfg.minCells;
    const mx = Math.max(sR, sG, sB), mn = Math.min(sR, sG, sB);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const box = { minX, maxX, minY, maxY };
    if (c > maxLensCells) surfaces.push(box);
    else if (compact) { if (useColor && sat >= 0.34) leds.push(box); else lenses.push(box); }
  }
  draw(lenses, leds, surfaces, cfg.color);
  status(lenses.length, leds.length, maxVal, cfg.label);
}

function circle(b, sx, sy) {
  const cx = (b.minX + b.maxX + 1) / 2 * sx, cy = (b.minY + b.maxY + 1) / 2 * sy;
  const r = Math.max((b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy) * 0.6 + 4;   // vòng nhỏ sát đốm
  octx.beginPath(); octx.arc(cx, cy, r, 0, 6.2832); octx.fill(); octx.stroke();
}

function draw(lenses, leds, surfaces, color) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const sx = W / AW, sy = H / AH;

  octx.lineWidth = 2; octx.strokeStyle = 'rgba(150,160,175,0.5)'; octx.setLineDash([6, 5]);
  for (const b of surfaces)
    octx.strokeRect(b.minX * sx, b.minY * sy, (b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy);
  octx.setLineDash([]);

  // LED thiết bị (đốm màu) = vàng
  octx.lineWidth = 3; octx.strokeStyle = 'rgba(255,190,40,0.95)'; octx.fillStyle = 'rgba(255,190,40,0.15)';
  for (const b of leds) circle(b, sx, sy);

  // nghi ống kính / IR = màu chính của mode
  octx.strokeStyle = `rgba(${color},0.95)`; octx.fillStyle = `rgba(${color},0.18)`;
  for (const b of lenses) circle(b, sx, sy);
}

function status(lens, led, max, label) {
  statusEl.classList.remove('idle', 'ok', 'warn');
  const dbg = ` · sáng nhất ${max}`;
  const tail = mode === 'ir' ? '' : ' — rê máy: còn lóe = camera';
  if (lens > 0) {
    statusEl.textContent = `🔴 ${lens} ${label}${tail}` + dbg;
    statusEl.classList.add('warn');
  } else if (led > 0) {
    statusEl.textContent = `🟡 Chỉ thấy ${led} đốm màu (nghi LED thiết bị: TV/máy lạnh)` + dbg;
    statusEl.classList.add('ok');
  } else {
    statusEl.textContent = `✅ Chưa thấy ${label}` + dbg;
    statusEl.classList.add('ok');
  }
}

function loop() {
  const v = diffy && diffy.video;
  if (v && v.readyState >= 2 && v.videoWidth) {
    if (mode === 'ai') aiTick(v); else detect(v);
  }
  raf = requestAnimationFrame(loop);
}

// Mode AI: coco-ssd nhận vật chứa camera (điện thoại/laptop/TV). Chạy giãn cách cho mượt.
function aiTick(v) {
  if (!aiModel || aiBusy) return;
  const now = performance.now();
  if (now - aiLast < 350) return;
  aiLast = now; aiBusy = true;
  aiModel.detect(v).then((preds) => { drawAI(preds, v); aiBusy = false; }).catch(() => { aiBusy = false; });
}

function drawAI(preds, v) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const sx = W / v.videoWidth, sy = H / v.videoHeight;
  octx.lineWidth = 3; octx.font = 'bold 14px sans-serif';
  let n = 0;
  for (const p of preds) {
    if (!(p.class in AI_CLASSES) || p.score < 0.5) continue;
    n++;
    const [x, y, bw, bh] = p.bbox;
    octx.strokeStyle = 'rgba(255,40,40,0.95)'; octx.fillStyle = 'rgba(255,40,40,0.14)';
    octx.fillRect(x * sx, y * sy, bw * sx, bh * sy);
    octx.strokeRect(x * sx, y * sy, bw * sx, bh * sy);
    octx.fillStyle = 'rgba(255,60,60,1)';
    octx.fillText(`${AI_CLASSES[p.class]} ${Math.round(p.score * 100)}%`, x * sx + 4, y * sy + 16);
  }
  statusEl.classList.remove('idle', 'ok', 'warn');
  if (n > 0) { statusEl.textContent = `🔴 ${n} vật nghi chứa camera (AI)`; statusEl.classList.add('warn'); }
  else { statusEl.textContent = '✅ AI chưa thấy vật chứa camera'; statusEl.classList.add('ok'); }
}

async function startScan() {
  if (started) return;
  started = true;
  startBtn.disabled = true; modeLensBtn.disabled = true; modeIrBtn.disabled = true; modeAiBtn.disabled = true;
  hintEl.style.display = 'none';
  statusEl.textContent = 'Đang mở camera…';
  try {
    diffy = create({ resolution: { x: 8, y: 6 }, sourceDimensions: { w: 320, h: 240 }, debug: false });
    const v = diffy.video;
    v.setAttribute('playsinline', ''); v.muted = true; v.style.display = 'block';
    stageEl.insertBefore(v, overlay);
    try { await v.play(); } catch (_) {}
    const rect = stageEl.getBoundingClientRect();
    overlay.width = rect.width; overlay.height = rect.height;
    stopBtn.disabled = false;
    flashEl.classList.remove('on');     // màn hình tối; đèn sáng do máy 2 lo
    tracks = [];
    loop();
    if (mode === 'ir') await irCountdown(10);
    else if (mode === 'ai') {
      statusEl.textContent = 'Đang tải model AI… (vài giây, cần internet)';
      cocoSsd.load().then((m) => { aiModel = m; }).catch((e) => { statusEl.textContent = '❌ Tải model AI lỗi: ' + e.message; });
    }
    statusEl.textContent = mode === 'ai' ? statusEl.textContent : 'Đang quét…';
  } catch (err) {
    statusEl.textContent = '❌ Lỗi camera: ' + err.message;
    started = false; startBtn.disabled = false;
  }
}

// Đếm ngược để camera ẩn kịp chuyển sang quay đêm (bật IR)
function irCountdown(sec) {
  hintEl.style.display = 'flex';
  return new Promise((resolve) => {
    let t = sec;
    const tick = () => {
      hintEl.textContent = `🌙 Tắt HẾT đèn — chờ camera chuyển quay đêm: ${t}s`;
      if (t-- <= 0) { hintEl.style.display = 'none'; resolve(); return; }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function selectMode(m) {
  if (started) return;
  mode = m;
  modeLensBtn.classList.toggle('active', m === 'lens');
  modeIrBtn.classList.toggle('active', m === 'ir');
  modeAiBtn.classList.toggle('active', m === 'ai');
  subEl.innerHTML = SUB[m];
}

function stopScan() {
  if (raf) cancelAnimationFrame(raf);
  flashEl.classList.remove('on'); tracks = [];
  if (diffy) diffy.stop();
  stopBtn.disabled = true;
  statusEl.textContent = 'Đã dừng — tải lại trang để quét lại';
  statusEl.classList.add('idle');
}

startBtn.addEventListener('click', startScan);
stopBtn.addEventListener('click', stopScan);
modeLensBtn.addEventListener('click', () => selectMode('lens'));
modeIrBtn.addEventListener('click', () => selectMode('ir'));
modeAiBtn.addEventListener('click', () => selectMode('ai'));
window.addEventListener('resize', () => {
  if (!started) return;
  const rect = stageEl.getBoundingClientRect();
  overlay.width = rect.width; overlay.height = rect.height;
});
