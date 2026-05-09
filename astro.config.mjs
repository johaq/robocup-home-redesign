import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://johaq.github.io',
  base: process.env.GITHUB_ACTIONS ? '/robocup-home-redesign' : undefined,
  output: 'static',
  publicDir: './public',   // copies referee-tool pages + assets into dist unchanged
  outDir: './dist',
  build: {
    format: 'file',        // teams.astro → dist/teams.html (not dist/teams/index.html)
  },
  trailingSlash: 'never',
});
