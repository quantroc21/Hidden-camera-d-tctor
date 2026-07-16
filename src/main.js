import { create } from 'diffyjs';

/*
 * Máy soi camera — demo.
 * Camera lấy qua repo diffyjs (maniart/diffyjs). Phần dò tự viết:
 * màn hình sáng đứng yên -> ống kính camera phản xạ thành ĐỐM SÁNG CHÓI ->
 * tìm điểm sáng nổi bật nhất khung hình -> khoanh đỏ. Vật sáng lớn (gương/kính) bị loại.
 */

const AW = 96, AH = 72;              // lưới phân tích (nhỏ cho nhanh)
const SURFACE_RATIO = 0.05;          // cụm > 5% khung => bề mặt phản chiếu lớn -> loại

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
const octx = overlay.getContext('2d');

const acanvas = document.createElement('canvas');
acanvas.width = AW; acanvas.height = AH;
const actx = acanvas.getContext('2d', { willReadFrequently: true });

let diffy = null, raf = null, started = false;
let mode = 'lens';          // 'lens' (soi ống kính) | 'ir' (soi đèn đêm)
let tracks = [];

// Cả 2 mode dùng CAMERA TRƯỚC (máy 1). Máy 2 = đèn pin sáng, ép sát camera.
const SUB = {
  lens: 'Máy 1 <b>camera trước</b> · máy 2 <b>đèn pin sáng ép sát cạnh camera</b> · tắt đèn phòng · <b>RÊ THẬT CHẬM</b> quanh vật — đốm nào sáng bám theo góc = ống kính (khoanh đỏ)',
  ir: 'Dùng <b>camera trước</b> · <b>tắt HẾT đèn</b>, chờ ~10s cho camera ẩn chuyển quay đêm · tìm chấm sáng tím/trắng mắt thường không thấy',
};
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

// Điểm bằng chứng: gộp NHIỀU dấu hiệu của ống kính -> chỉ khoanh khi đủ điểm.
// Chấm điểm dựa trên tài liệu về "cat's eye"/lens-sensor retroreflection:
//  - phản xạ sáng gấp 2–4 bậc & BÃO HÒA sensor (LAPD, Optica) -> lõi bão hòa là dấu hiệu mạnh nhất
//  - chỉ hiện trong cửa sổ góc hẹp (LAPD FoV filter) -> bám vài khung khi rê, không cần dài
function evidence(t) {
  const n = t.n;
  const cMean = t.sC / n;
  const cVar = Math.max(0, t.sC2 / n - cMean * cMean), cStd = Math.sqrt(cVar);
  const fillM = t.sFill / n, aspM = t.sAsp / n, satM = t.sSat / n, szM = t.sSz / n, clipM = t.sClip / n;
  const satCore = clamp01(clipM / 0.22);                      // lõi bão hòa (near-clip) — đặc trưng nhất
  const strong  = clamp01((cMean - 45) / 110);               // chói vượt trội so với nền
  const persist = clamp01((t.age - 2) / 8);                  // bám trong cửa sổ góc hẹp khi rê
  const steady  = clamp01(1 - (cMean > 5 ? cStd / cMean : 1)); // sáng ổn định, không chớp loạn
  const round   = clamp01((fillM - 0.4) / 0.55) * clamp01((2.6 - aspM) / 1.6); // tròn & đặc
  const neutral = clamp01((0.34 - satM) / 0.34);             // trắng (không phải LED màu)
  const small   = clamp01((26 - szM) / 22);                  // đốm nhỏ
  return 0.22 * satCore + 0.20 * persist + 0.16 * strong + 0.14 * steady + 0.12 * round + 0.08 * neutral + 0.08 * small;
}

// Phát hiện ống kính: gom đốm -> đo nhiều đặc trưng -> nối track -> chấm điểm bằng chứng
function detectLensSweep(d, lum, sens) {
  const bg = boxBlur(lum, AW, AH, 6);
  const absFloor = 150, localGap = 110 - sens * 7;
  const hot = (i) => lum[i] >= absFloor && (lum[i] - bg[i]) >= localGap;

  const seen = new Uint8Array(AW * AH);
  const cands = [], leds = [], surfaces = [];
  const maxLensCells = AW * AH * SURFACE_RATIO;
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
    if (c > maxLensCells) surfaces.push(box);
    else if (fill >= 0.45 && aspect <= 2.6 && c >= 3) {
      if (sat >= 0.5) leds.push(box);       // màu đậm -> chắc chắn LED thiết bị
      else cands.push({ cx: (minX + maxX + 1) / 2, cy: (minY + maxY + 1) / 2, box, fill, aspect, sat, contrast, size: c, clip: nClip / c });
    }
  }

  matchTracks(cands);
  const CONF = clamp01(0.72 - sens * 0.03);   // ngưỡng điểm để khoanh đỏ (sens5 -> 0.57)
  const confirmed = [], pending = [];
  for (const t of tracks) {
    if (t.miss > 0) continue;
    const s = evidence(t);
    if (s >= CONF && t.age >= 4) confirmed.push(t.box);
    else if (s >= CONF - 0.18) pending.push(t.box);   // gần đủ điểm -> đang xác minh
    // điểm thấp -> KHÔNG vẽ (tránh phun chấm loạn)
  }
  drawSweep(confirmed, pending, leds, surfaces);

  statusEl.classList.remove('idle', 'ok', 'warn');
  if (confirmed.length > 0) {
    statusEl.textContent = `🔴 ${confirmed.length} đốm ĐỦ BẰNG CHỨNG ống kính (rê tiếp cho chắc)`;
    statusEl.classList.add('warn');
  } else if (pending.length > 0) {
    statusEl.textContent = `⏳ Đang gom bằng chứng ${pending.length} đốm — RÊ CHẬM quanh vật`;
    statusEl.classList.add('idle');
  } else {
    statusEl.textContent = '✅ Chưa đủ bằng chứng ống kính' + (leds.length ? ` (bỏ ${leds.length} LED màu)` : '');
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
      t.n++; t.sC += cd.contrast; t.sC2 += cd.contrast * cd.contrast;
      t.sFill += cd.fill; t.sAsp += cd.aspect; t.sSat += cd.sat; t.sSz += cd.size; t.sClip += cd.clip;
    } else {
      tracks.push({
        x: cd.cx, y: cd.cy, age: 1, miss: 0, box: cd.box,
        n: 1, sC: cd.contrast, sC2: cd.contrast * cd.contrast,
        sFill: cd.fill, sAsp: cd.aspect, sSat: cd.sat, sSz: cd.size, sClip: cd.clip,
      });
    }
  }
  for (let k = 0; k < tracks.length; k++) if (!used[k]) tracks[k].miss++;
  tracks = tracks.filter((t) => t.miss <= 3);
}

function drawSweep(confirmed, pending, leds, surfaces) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const sx = W / AW, sy = H / AH;
  // bề mặt lớn (gương/kính) - xám
  octx.lineWidth = 2; octx.strokeStyle = 'rgba(150,160,175,0.5)'; octx.setLineDash([6, 5]);
  for (const b of surfaces) octx.strokeRect(b.minX * sx, b.minY * sy, (b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy);
  octx.setLineDash([]);
  // LED màu thiết bị - vàng
  octx.lineWidth = 3; octx.strokeStyle = 'rgba(255,190,40,0.9)'; octx.fillStyle = 'rgba(255,190,40,0.12)';
  for (const b of leds) circle(b, sx, sy);
  // đốm đang xác minh - trắng mờ nét đứt
  octx.strokeStyle = 'rgba(230,230,230,0.7)'; octx.fillStyle = 'rgba(230,230,230,0.06)'; octx.setLineDash([4, 4]);
  for (const b of pending) circle(b, sx, sy);
  octx.setLineDash([]);
  // xác nhận bám góc - đỏ
  octx.strokeStyle = 'rgba(255,40,40,0.97)'; octx.fillStyle = 'rgba(255,40,40,0.18)';
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
  const r = Math.max((b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy, 16) * 0.7 + 10;
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
  if (v && v.readyState >= 2 && v.videoWidth) detect(v);
  raf = requestAnimationFrame(loop);
}

async function startScan() {
  if (started) return;
  started = true;
  startBtn.disabled = true; modeLensBtn.disabled = true; modeIrBtn.disabled = true;
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
    statusEl.textContent = 'Đang quét…';
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
window.addEventListener('resize', () => {
  if (!started) return;
  const rect = stageEl.getBoundingClientRect();
  overlay.width = rect.width; overlay.height = rect.height;
});
