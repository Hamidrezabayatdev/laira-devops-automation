import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

describe('Web Tailwind & PostCSS Compilation Pipeline', () => {
  const globalsCssPath = path.resolve(__dirname, '../src/app/globals.css');
  const tailwindConfigPath = path.resolve(__dirname, '../tailwind.config.ts');
  const postcssConfigPath = path.resolve(__dirname, '../postcss.config.mjs');

  it('contains Tailwind directives in globals.css', () => {
    expect(fs.existsSync(globalsCssPath)).toBe(true);
    const content = fs.readFileSync(globalsCssPath, 'utf-8');
    expect(content).toContain('@tailwind base;');
    expect(content).toContain('@tailwind components;');
    expect(content).toContain('@tailwind utilities;');
    expect(content).toContain('@import "@fontsource-variable/vazirmatn";');
  });

  it('has PostCSS and Tailwind config files present', () => {
    expect(fs.existsSync(postcssConfigPath)).toBe(true);
    expect(fs.existsSync(tailwindConfigPath)).toBe(true);
  });

  it('compiles CSS with working .flex and responsive/focus utility rules', async () => {
    const rawCss = fs.readFileSync(globalsCssPath, 'utf-8');
    const result = await postcss([
      tailwindcss({ config: tailwindConfigPath }),
      autoprefixer,
    ]).process(rawCss, { from: globalsCssPath });

    const compiledCss = result.css;

    // 1. Verify basic flex display (fixing "Browser computed .flex display block")
    expect(compiledCss).toMatch(/\.flex\s*\{\s*display:\s*flex;?\s*\}/);
    expect(compiledCss).toMatch(/\.inline-flex\s*\{\s*display:\s*inline-flex;?\s*\}/);
    expect(compiledCss).toMatch(/\.hidden\s*\{\s*display:\s*none;?\s*\}/);

    // 2. Verify responsive shell breakpoints used in AppShell (narrow / desktop)
    expect(compiledCss).toMatch(/\.lg\\:flex/);
    expect(compiledCss).toMatch(/\.xl\\:flex/);
    expect(compiledCss).toMatch(/\.md\\:flex/);
    expect(compiledCss).toMatch(/\.sm\\:block/);

    // 3. Verify keyboard focus-visible utilities
    expect(compiledCss).toMatch(/focus-visible\\:ring-2/);
    expect(compiledCss).toMatch(/focus-visible\\:outline-none/);

    // 4. Verify arbitrary hex color and brand classes
    expect(compiledCss).toContain('.bg-\\[\\#181818\\]');
    expect(compiledCss).toContain('.border-\\[\\#323644\\]');
    expect(compiledCss).toContain('.text-\\[\\#28c1f5\\]');

    // 5. Verify CSS variables and brand design tokens are preserved
    expect(compiledCss).toContain('--brand-mint: #87fcc4');
    expect(compiledCss).toContain('--brand-cyan: #28c1f5');
    expect(compiledCss).toContain('--background: #181818');
  });
});
