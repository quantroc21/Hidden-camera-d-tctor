import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Local dev bật HTTPS (self-signed) để test camera trên điện thoại thật.
// Production (Cloudflare) không cần: đã có HTTPS thật, nên chỉ bật SSL khi `serve`.
// Đặt VITE_NOSSL=1 để chạy HTTP.
export default defineConfig(({ command }) => {
  const useSsl = command === 'serve' && process.env.VITE_NOSSL !== '1';
  return {
    plugins: [...(useSsl ? [basicSsl()] : [])],
    server: { host: true, port: 5173 },
  };
});
