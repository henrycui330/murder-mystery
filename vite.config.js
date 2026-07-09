import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Relative paths for deployment in subfolders (like GitHub Pages)
  build: {
    outDir: 'dist',
  }
});
