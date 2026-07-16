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
let strobeTimer = null, strobeOn = false, strobeAt = 0, lastOn = null, lastOff = null;

// Cả 2 mode dùng CAMERA TRƯỚC: màn hình chớp đồng trục với camera + đèn pin máy 2.
const SUB = {
  lens: 'Dùng <b>camera trước</b> · tắt đèn phòng, bật <b>đèn pin máy 2</b> kê cạnh camera · màn hình tự chớp — chỉ đốm <b>nhấp nháy theo</b> mới là ống kính · giữ máy YÊN',
  ir: 'Dùng <b>camera trước</b> · <b>tắt HẾT đèn</b>, chờ ~10s cho camera ẩn chuyển quay đêm · tìm chấm sáng tím/trắng mắt thường không thấy',
};
const facingFor = () => 'user';

function startStrobe() {
  stopStrobe();
  strobeTimer = setInterval(() => {
    strobeOn = !strobeOn; strobeAt = performance.now();
    flashEl.classList.toggle('on', strobeOn);
  }, 150);   // ~3.3Hz
}
function stopStrobe() {
  if (strobeTimer) clearInterval(strobeTimer);
  strobeTimer = null; strobeOn = false; lastOn = null; lastOff = null;
  flashEl.classList.remove('on');
}

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

  // LENS: temporal differencing theo nhịp chớp màn hình.
  // Chỉ đốm PHẢN XẠ mới nhấp nháy theo strobe -> lộ ra. LED/TV tự sáng đều -> tự loại.
  const stable = performance.now() - strobeAt > 70;   // bỏ khung ngay sau khi đổi pha
  if (stable) { if (strobeOn) lastOn = lum; else lastOff = lum; }
  if (!lastOn || !lastOff) {
    statusEl.className = 'status idle';
    statusEl.textContent = 'Đang lấy nền — giữ máy YÊN…';
    return;
  }
  const sig = new Float32Array(AW * AH);   // biên độ nhấp nháy = ON - OFF
  let smax = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = lastOn[i] - lastOff[i];
    sig[i] = v > 0 ? v : 0;
    if (sig[i] > smax) smax = sig[i];
  }
  const modThresh = 70 - sens * 5;   // biên độ nhấp nháy tối thiểu (sens5 -> 45)
  const cfg = { minCells: 3, color: '255,40,40', label: 'nghi ống kính (nhấp nháy theo đèn)' };
  const hot = (i) => sig[i] >= modThresh && lastOn[i] >= 110;
  clusterDrawStatus(hot, d, Math.round(smax), cfg, false);
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
    loop();
    if (mode === 'ir') { flashEl.classList.remove('on'); await irCountdown(10); }
    else startStrobe();                 // lens: chớp màn hình để temporal-diff
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
  stopStrobe();
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
