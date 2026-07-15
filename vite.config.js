import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS + host để mở được trên điện thoại thật (camera cần secure context).
// Đặt VITE_NOSSL=1 để chạy HTTP (dùng khi verify trên máy/preview headless).
const noSsl = process.env.VITE_NOSSL === '1';

export default defineConfig({
  plugins: noSsl ? [] : [basicSsl()],
  server: {
    host: true,
    port: 5173,
  },
});
