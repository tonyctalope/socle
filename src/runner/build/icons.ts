import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { BuildFailure } from './files.ts';

// An app's icon: one SVG picture (icon.svg) that the platform turns into the PNG files phones
// want on a Home Screen. The picture is drawn by an agent, so it is rendered here, in the
// process of the build (no network, killed at its deadline), by a rasterizer that cannot read
// files or fetch anything: what an SVG refers to outside itself is simply not drawn.

export const ICON_FILE = 'icon.svg';
/** Larger than any reasonable icon drawn by hand or by an agent. */
const MAX_ICON_BYTES = 64 * 1024;
/**
 * What the PNG files of one icon may weigh together: every version keeps its own, and they are
 * served from memory. Plain shapes give a few dozen KiB; a small SVG that asks for noise or
 * heavy filters gives megabytes.
 */
const MAX_RENDERED_BYTES = 512 * 1024;

/** The files served under /_socle/icons/ for an app that has its own icon, as base64 PNG. */
export type AppIcons = Record<(typeof ICON_NAMES)[number], string>;
export const ICON_NAMES = [
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
] as const;

let ready: Promise<void> | null = null;
function rasterizer(): Promise<void> {
  ready ??= initWasm(readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')));
  return ready;
}

function render(svg: string, size: number): string {
  // No fonts are loaded: an icon is shapes. Text in it is not drawn (the guide says so).
  const picture = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } });
  try {
    if (Math.abs(picture.width - picture.height) > 0.5) {
      throw new BuildFailure([
        { file: ICON_FILE, message: 'the icon must be square (same width and height, or a square viewBox)' },
      ]);
    }
    const image = picture.render();
    try {
      return Buffer.from(image.asPng()).toString('base64');
    } finally {
      image.free();
    }
  } finally {
    picture.free();
  }
}

/**
 * The picture on a plain square of `background`, taking `share` of its width: phones crop
 * "maskable" icons to their own shape (a circle, a squircle), so the picture needs a margin,
 * and iPhones show no transparency.
 */
function onBackground(svg: string, background: string, share: number): string {
  const size = 512;
  const inner = Math.round(size * share);
  const offset = (size - inner) / 2;
  const data = Buffer.from(svg).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${background}"/><image x="${offset}" y="${offset}" width="${inner}" height="${inner}" href="data:image/svg+xml;base64,${data}"/></svg>`;
}

/** `background` is a #rrggbb color (the app's, or the platform's). */
export async function buildIcons(svg: string, background: string): Promise<AppIcons> {
  if (Buffer.byteLength(svg) > MAX_ICON_BYTES) {
    throw new BuildFailure([
      { file: ICON_FILE, message: `the icon is too large (limit ${MAX_ICON_BYTES / 1024} KiB)` },
    ]);
  }
  await rasterizer();
  try {
    const maskable = onBackground(svg, background, 0.8);
    const icons: AppIcons = {
      'icon-192.png': render(svg, 192),
      'icon-512.png': render(svg, 512),
      'icon-maskable-192.png': render(maskable, 192),
      'icon-maskable-512.png': render(maskable, 512),
      'apple-touch-icon.png': render(onBackground(svg, background, 1), 180),
    };
    // Base64 text: four characters for three bytes.
    const bytes = Object.values(icons).reduce((sum, png) => sum + Math.floor((png.length * 3) / 4), 0);
    if (bytes > MAX_RENDERED_BYTES) {
      throw new BuildFailure([
        {
          file: ICON_FILE,
          message: `the icon is too heavy once drawn (${Math.round(bytes / 1024)} KiB of pictures, limit ${MAX_RENDERED_BYTES / 1024}): draw it with plain shapes, without noise or heavy filters`,
        },
      ]);
    }
    return icons;
  } catch (error) {
    if (error instanceof BuildFailure) throw error;
    const reason = String((error as Error)?.message ?? error).slice(0, 200);
    throw new BuildFailure([
      { file: ICON_FILE, message: `the icon is not an SVG picture that can be drawn: ${reason}` },
    ]);
  }
}
