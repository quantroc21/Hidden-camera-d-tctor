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
const octx = overlay.getContext('2d');

const acanvas = document.createElement('canvas');
acanvas.width = AW; acanvas.height = AH;
const actx = acanvas.getContext('2d', { willReadFrequently: true });

let diffy = null, raf = null, started = false;

// Ép camera sau
const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = (c) => {
  if (c && c.video && typeof c.video === 'object') c.video.facingMode = { ideal: 'environment' };
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
  const bg = boxBlur(lum, AW, AH, 6);   // nền cục bộ

  // Đèn pin ngoài + phòng tối -> glint ống kính rất chói & sắc. Siết chặt để bớt cảnh giả.
  const sens = Number(sensEl.value);
  const localGap = 120 - sens * 7;     // sens5 -> phải chói hơn nền ~85
  const absFloor = 165;                // và phải đủ sáng (glint từ đèn pin thường bão hòa)
  const hot = (i) => lum[i] >= absFloor && (lum[i] - bg[i]) >= localGap;

  // gom cụm (connected component 8 hướng)
  const seen = new Uint8Array(AW * AH);
  const lenses = [], surfaces = [];
  const maxLensCells = AW * AH * SURFACE_RATIO;
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const i0 = y * AW + x;
    if (seen[i0] || !hot(i0)) continue;
    const st = [i0]; seen[i0] = 1;
    let c = 0, minX = x, maxX = x, minY = y, maxY = y;
    while (st.length) {
      const i = st.pop(), cx = i % AW, cy = (i - cx) / AW; c++;
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
    const fill = c / (bw * bh);                 // gọn/đặc?
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    const compact = fill >= 0.45 && aspect <= 2.6 && c >= 3;
    const box = { minX, maxX, minY, maxY };
    if (c <= maxLensCells && compact) lenses.push(box);   // đốm tròn gọn = ống kính
    else if (c > maxLensCells) surfaces.push(box);        // mảng lớn = bề mặt phản chiếu
    // đốm nhỏ không gọn (viền/nhiễu) -> bỏ qua, không vẽ
  }

  draw(lenses, surfaces);
  status(lenses.length, surfaces.length, Math.round(max));
}

function draw(lenses, surfaces) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const sx = W / AW, sy = H / AH;

  octx.lineWidth = 2; octx.strokeStyle = 'rgba(150,160,175,0.5)'; octx.setLineDash([6, 5]);
  for (const b of surfaces)
    octx.strokeRect(b.minX * sx, b.minY * sy, (b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy);
  octx.setLineDash([]);

  octx.lineWidth = 3; octx.strokeStyle = 'rgba(255,40,40,0.95)'; octx.fillStyle = 'rgba(255,40,40,0.18)';
  for (const b of lenses) {
    const cx = (b.minX + b.maxX + 1) / 2 * sx, cy = (b.minY + b.maxY + 1) / 2 * sy;
    const r = Math.max((b.maxX - b.minX + 1) * sx, (b.maxY - b.minY + 1) * sy, 16) * 0.7 + 10;
    octx.beginPath(); octx.arc(cx, cy, r, 0, 6.2832); octx.fill(); octx.stroke();
  }
}

function status(lens, surf, max) {
  statusEl.classList.remove('idle', 'ok', 'warn');
  const dbg = ` · sáng nhất ${max}`;
  if (lens === 0) {
    statusEl.textContent = '✅ Chưa thấy đốm nghi ống kính' + dbg;
    statusEl.classList.add('ok');
  } else {
    statusEl.textContent = `🔴 ${lens} đốm nghi ống kính — rê máy: còn lóe = camera` + dbg;
    statusEl.classList.add('warn');
  }
}

function loop() {
  const v = diffy && diffy.video;
  if (v && v.readyState >= 2 && v.videoWidth) detect(v);
  raf = requestAnimationFrame(loop);
}

async function startScan() {
  if (started) return;
  started = true; startBtn.disabled = true; hintEl.style.display = 'none';
  statusEl.textContent = 'Đang mở camera…';
  try {
    diffy = create({ resolution: { x: 8, y: 6 }, sourceDimensions: { w: 320, h: 240 }, debug: false });
    const v = diffy.video;
    v.setAttribute('playsinline', ''); v.muted = true; v.style.display = 'block';
    stageEl.insertBefore(v, overlay);
    try { await v.play(); } catch (_) {}
    const rect = stageEl.getBoundingClientRect();
    overlay.width = rect.width; overlay.height = rect.height;
    flashEl.classList.remove('on');    // giữ TỐI: đèn pin máy thứ 2 lo phần chiếu sáng
    stopBtn.disabled = false;
    loop();
    statusEl.textContent = 'Đang quét…';
  } catch (err) {
    statusEl.textContent = '❌ Lỗi camera: ' + err.message;
    started = false; startBtn.disabled = false;
  }
}

function stopScan() {
  if (raf) cancelAnimationFrame(raf);
  flashEl.classList.remove('on');
  if (diffy) diffy.stop();
  stopBtn.disabled = true;
  statusEl.textContent = 'Đã dừng — tải lại trang để quét lại';
  statusEl.classList.add('idle');
}

startBtn.addEventListener('click', startScan);
stopBtn.addEventListener('click', stopScan);
window.addEventListener('resize', () => {
  if (!started) return;
  const rect = stageEl.getBoundingClientRect();
  overlay.width = rect.width; overlay.height = rect.height;
});
