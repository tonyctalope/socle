#!/usr/bin/env bash
# One-off: renders the platform icons from scripts/icon.svg into src/assets/icons/.
# Needs rsvg-convert (librsvg). The PNGs are committed, so this only runs when the art changes.
set -euo pipefail
cd "$(dirname "$0")/.."
out=src/assets/icons
mkdir -p "$out"
art='<rect x="176" y="150" width="160" height="150" rx="30" fill="#fff"/><rect x="112" y="322" width="288" height="58" rx="22" fill="#fff" fill-opacity=".82"/>'
bg='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f73a6"/><stop offset="1" stop-color="#24476d"/></linearGradient></defs>'
svg() { printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">%s</svg>' "$1"; }
# "any" icons: rounded square. Maskable and Apple icons: full bleed, art inside the safe zone.
svg "$bg<rect width=\"512\" height=\"512\" rx=\"112\" fill=\"url(#g)\"/>$art" > "$out/.any.svg"
svg "$bg<rect width=\"512\" height=\"512\" fill=\"url(#g)\"/><g transform=\"translate(256 256) scale(.78) translate(-256 -256)\">$art</g>" > "$out/.full.svg"
svg "<g fill=\"#000\">$(printf '%s' "$art" | sed 's/fill="#fff"/fill="#000"/g; s/ fill-opacity="[^"]*"//g')</g>" > "$out/.badge.svg"
rsvg-convert -w 192 -h 192 "$out/.any.svg" -o "$out/icon-192.png"
rsvg-convert -w 512 -h 512 "$out/.any.svg" -o "$out/icon-512.png"
rsvg-convert -w 192 -h 192 "$out/.full.svg" -o "$out/icon-maskable-192.png"
rsvg-convert -w 512 -h 512 "$out/.full.svg" -o "$out/icon-maskable-512.png"
rsvg-convert -w 180 -h 180 "$out/.full.svg" -o "$out/apple-touch-icon.png"
rsvg-convert -w 96 -h 96 "$out/.badge.svg" -o "$out/badge-96.png"
rm "$out"/.*.svg
ls -l "$out"
