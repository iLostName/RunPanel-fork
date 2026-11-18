"use client";

import { useMemo } from "react";
import { encodeQr, qrSvgPath } from "@/lib/qr";

/**
 * A QR code, drawn as one SVG path from `lib/qr.ts`.
 *
 * Always dark on white, whatever the theme: phone cameras and scanner apps
 * look for dark modules on a light ground, and many cannot read the inverted
 * code a dark theme would otherwise produce. The four-module margin is the
 * quiet zone the standard asks for.
 */
export function QrCode({ value, size = 192, label }: { value: string; size?: number; label: string }) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  const path = useMemo(() => qrSvgPath(matrix), [matrix]);
  const extent = matrix.size + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`-4 -4 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="rounded-[var(--radius)] bg-white"
    >
      <rect x={-4} y={-4} width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
