# 🔦 Máy soi camera — Demo

Web app soi phản xạ ống kính để **khoanh đỏ camera** (camera điện thoại, webcam, camera mua về)
khi chĩa gần trong phòng tối. Chạy hoàn toàn client-side (PWA-ready), không server.

> ⚠️ Đây là **demo hỗ trợ soi ống kính**, không phải cam kết phát hiện mọi camera ẩn.
> Nó bắt tốt các camera có **ống kính lộ** ở cự li gần; có thể **bỏ sót** camera pinhole/giấu kỹ
> và **báo nhầm** các bề mặt phản chiếu khác (kính, kim loại, giọt nước).

## Nền tảng công nghệ
- **Engine dò chuyển động:** [maniart/diffyjs](https://github.com/maniart/diffyjs) (npm `diffyjs`) — frame-differencing trên Canvas.
- **Lớp bọc riêng** (`src/main.js`):
  - Ép **camera sau** (`facingMode: environment`) bằng cách bọc `getUserMedia`.
  - **Nền chớp sáng** để ống kính lóe theo nhịp (retroreflection) → diffy thấy "chuyển động" tập trung tại đúng đốm.
  - Lọc **outlier thích ứng** (`mean + k·std`, có sàn tuyệt đối) để loại nhiễu sáng toàn cục do chớp/auto-exposure, rồi khoanh đỏ.

## Cách hoạt động (3 bước)
1. Bấm **Bắt đầu quét** → mở camera sau.
2. Nền màn hình **chớp trắng/đen** (chỉnh 0–8 Hz). Ống kính camera phản xạ ánh sáng này thành đốm sáng nhấp nháy.
3. Đốm nào nhấp nháy mạnh & tập trung → **khoanh đỏ** trên khung hình. Vật tĩnh bị loại tự nhiên.

## Chạy trên máy tính
```bash
npm install
npm run dev        # HTTPS (self-signed) — mở link Local
```

## Chạy trên ĐIỆN THOẠI (quan trọng)
Camera cần **secure context (HTTPS)**. Dev server đã bật HTTPS tự ký:
```bash
npm run dev        # xem dòng "Network: https://192.168.x.x:5173"
```
1. Điện thoại **cùng Wi-Fi** với máy tính.
2. Mở link **Network** (https://192.168.x.x:5173) trên Safari/Chrome.
3. Gặp cảnh báo chứng chỉ tự ký → bấm **“Vẫn tiếp tục / Visit anyway”**.
4. Cho phép **Camera**. Tắt đèn, chĩa camera sau vào vật nghi ngờ ~20–40cm, giữ máy yên.

> Muốn khách/khách hàng tự mở không cần máy tính: `npm run build` rồi deploy thư mục `dist/`
> lên Netlify/Vercel/GitHub Pages (tự có HTTPS thật, không còn cảnh báo chứng chỉ).

## Mẹo dùng cho kết quả tốt nhất
- **Tối phòng** càng nhiều càng tốt.
- Cự li **gần** (20–40cm), lens hướng **thẳng** về phía điện thoại.
- **Giữ máy yên** (rung tay tạo báo nhầm).
- Tăng **Độ nhạy** nếu không thấy gì; giảm nếu báo nhầm quá nhiều.

## Giới hạn đã biết
- iOS Safari **không** cho khóa nét/phơi sáng/đèn flash → dựa vào chớp màn hình + lọc nền.
- Không phát hiện được camera **không có ống kính lộ** hoặc **quay hướng khác**.
- Đây là công cụ **hỗ trợ soi thủ công**, nên đi kèm checklist kiểm tra bằng mắt.
