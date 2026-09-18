import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command }) => ({
  // Project Pages serve from https://<user>.github.io/abyssus-planner/, so built
  // asset URLs need that prefix. The dev server stays at the root.
  base: command === 'build' ? '/abyssus-planner/' : '/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
}));
