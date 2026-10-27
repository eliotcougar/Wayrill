import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const palettes = source.split(/:root\[data-theme=['"]light['"]\]/);
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return channels.reduce(
    (sum, value, index) =>
      sum +
      [0.2126, 0.7152, 0.0722][index] *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4),
    0,
  );
};
it.each(['dark', 'light'])(
  '%s palette keeps normal text and control boundaries readable',
  (theme) => {
    const section = palettes[theme === 'dark' ? 0 : 1].split('@media')[0];
    const colors = Object.fromEntries(
      [...section.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1], m[2]]),
    );
    const contrast = (foreground: string, background: string) => {
      const a = luminance(colors[foreground]),
        b = luminance(colors[background]);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    for (const foreground of ['text', 'text-secondary', 'text-muted', 'text-subtle'])
      for (const background of [
        'surface',
        'surface-sunken',
        'surface-adjacent',
        'surface-raised',
        'surface-hover',
      ])
        expect(
          contrast(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
    for (const role of ['warning', 'danger', 'success'])
      expect(contrast(role, `${role}-soft`), role).toBeGreaterThanOrEqual(4.5);
    expect(contrast('on-accent', 'accent-fill')).toBeGreaterThanOrEqual(4.5);
    for (const background of ['surface', 'surface-raised', 'surface-adjacent'])
      expect(
        contrast('scrollbar-thumb', background),
        `scrollbar on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    expect(contrast('border-strong', 'surface-raised')).toBeGreaterThanOrEqual(3);
    expect(contrast('switch-thumb', 'switch-track')).toBeGreaterThanOrEqual(3);
    expect(contrast('switch-thumb', 'switch-active')).toBeGreaterThanOrEqual(3);
    for (const kind of ['traffic', 'dns', 'resolver', 'observation'])
      for (const background of ['canvas-center', 'canvas-edge', 'surface-raised'])
        expect(contrast(`connection-${kind}`, background), kind).toBeGreaterThanOrEqual(3);
  },
);
