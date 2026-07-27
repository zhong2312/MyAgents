import { describe, expect, it } from 'vitest';
import { physicalPositionToCssPixels } from './dragDropCoordinates';

describe('physicalPositionToCssPixels', () => {
  it.each([
    { dpr: 1, physical: { x: 320, y: 180 }, css: { x: 320, y: 180 } },
    { dpr: 1.25, physical: { x: 500, y: 250 }, css: { x: 400, y: 200 } },
    { dpr: 1.5, physical: { x: 450, y: 225 }, css: { x: 300, y: 150 } },
    { dpr: 2, physical: { x: 640, y: 360 }, css: { x: 320, y: 180 } },
  ])('converts a Tauri physical position at DPR $dpr', ({ dpr, physical, css }) => {
    expect(physicalPositionToCssPixels(physical, dpr)).toEqual(css);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to DPR 1 for invalid scale %s',
    (dpr) => {
      expect(physicalPositionToCssPixels({ x: 42, y: 24 }, dpr)).toEqual({ x: 42, y: 24 });
    },
  );
});
