import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin panel, served by the web server at /admin/ behind the sign-in gate.
export default defineConfig({
  root: 'admin',
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: '../dist/admin',
    emptyOutDir: true,
  },
});
