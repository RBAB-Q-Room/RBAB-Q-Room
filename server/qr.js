'use strict';
const qrcode = require('qrcode-generator');

/** Render a URL as a self-contained SVG QR code (no external service). */
function qrSvg(text, { cellSize = 8, margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * cellSize;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${(c + margin) * cellSize} ${(r + margin) * cellSize}h${cellSize}v${cellSize}h-${cellSize}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Waiting Guest QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#2B2118"/></svg>`;
}

module.exports = { qrSvg };
