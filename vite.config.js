import { defineConfig } from 'vite'

// Relative base so the built site works from any static path,
// e.g. a GitHub Pages project site (user.github.io/paylink/) or a custom domain root.
export default defineConfig({
  base: './',
})
