import { describe, expect, it, vi } from 'vitest';

import { bindZoomGestureListeners, type ZoomUpdater } from './zoomGesture';

function applyZoom(current: number, next: ZoomUpdater): number {
  return typeof next === 'function' ? next(current) : next;
}

describe('bindZoomGestureListeners', () => {
  it('normalizes Chromium ctrl-wheel and WebKit gesture events into one zoom protocol', () => {
    const element = document.createElement('div');
    let zoom = 1;
    const setZoom = vi.fn((next: ZoomUpdater) => {
      zoom = applyZoom(zoom, next);
    });
    const cleanup = bindZoomGestureListeners(element, {
      getZoom: () => zoom,
      setZoom,
    });

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -25,
      clientX: 320,
      clientY: 240,
    });
    element.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(zoom).toBe(1.25);
    expect(setZoom).toHaveBeenLastCalledWith(expect.any(Function), {
      clientX: 320,
      clientY: 240,
    });

    const start = new Event('gesturestart', { bubbles: true, cancelable: true });
    const change = new Event('gesturechange', { bubbles: true, cancelable: true });
    Object.defineProperties(change, {
      scale: { value: 1.6 },
      clientX: { value: 400 },
      clientY: { value: 300 },
    });
    element.dispatchEvent(start);
    element.dispatchEvent(change);
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(zoom).toBe(2);
    expect(setZoom).toHaveBeenLastCalledWith(2, {
      clientX: 400,
      clientY: 300,
    });

    cleanup();
    element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -50 }));
    expect(setZoom).toHaveBeenCalledTimes(2);
  });

  it('leaves ordinary two-finger wheel events for the consumer pan owner', () => {
    const element = document.createElement('div');
    const setZoom = vi.fn();
    const cleanup = bindZoomGestureListeners(element, {
      getZoom: () => 1,
      setZoom,
    });

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    element.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();

    cleanup();
  });
});
