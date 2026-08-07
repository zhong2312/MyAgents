import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ImagePreview from './ImagePreview';

function setViewerGeometry(viewport: HTMLElement, image: HTMLImageElement) {
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 800 },
  });
  Object.defineProperties(image, {
    offsetWidth: { configurable: true, value: 600 },
    offsetHeight: { configurable: true, value: 700 },
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  });
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    x: 200,
    y: 50,
    top: 50,
    left: 200,
    right: 800,
    bottom: 750,
    width: 600,
    height: 700,
    toJSON: () => ({}),
  });
}

function renderPreview() {
  const onClose = vi.fn();
  render(<ImagePreview src="data:image/png;base64,AAAA" name="long.png" onClose={onClose} />);
  const image = screen.getByRole('img', { name: 'long.png' }) as HTMLImageElement;
  const mover = image.parentElement as HTMLElement;
  const viewport = mover.parentElement as HTMLElement;
  setViewerGeometry(viewport, image);
  fireEvent.load(image);
  return { viewport, image, onClose, mover };
}

describe('ImagePreview viewport interactions', () => {
  it('makes the advertised double-click toggle zoom and keeps toolbar state in sync', () => {
    const { viewport, image, mover } = renderPreview();

    const setPointerCapture = vi.fn();
    Object.assign(viewport, {
      setPointerCapture,
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 600, clientY: 400 });
    fireEvent.doubleClick(image, { clientX: 600, clientY: 400 });
    expect(screen.getByText('200%')).toBeInTheDocument();
    expect(image.style.transform).toContain('scale(2)');
    expect(mover.style.transform).toBe('translate3d(-100px, 0px, 0)');
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerDown(image, { button: 0, pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.pointerUp(image, { pointerId: 2, clientX: 600, clientY: 400 });
    fireEvent.doubleClick(image, { clientX: 600, clientY: 400 });
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(image.style.transform).toContain('scale(1)');
    expect(mover.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(screen.getByText('双击放大 · 捏合缩放 · 双指或拖拽移动 · 按 Esc 关闭')).toBeInTheDocument();
  });

  it('supports Chromium ctrl-wheel and macOS WKWebView gesture pinch', () => {
    const { viewport } = renderPreview();

    fireEvent.wheel(viewport, {
      ctrlKey: true,
      deltaY: -50,
      clientX: 500,
      clientY: 400,
    });
    expect(screen.getByText('150%')).toBeInTheDocument();

    const start = new Event('gesturestart', { bubbles: true, cancelable: true });
    const change = new Event('gesturechange', { bubbles: true, cancelable: true });
    Object.defineProperties(change, {
      scale: { value: 1.5 },
      clientX: { value: 500 },
      clientY: { value: 400 },
    });
    act(() => {
      viewport.dispatchEvent(start);
      viewport.dispatchEvent(change);
    });
    expect(screen.getByText('225%')).toBeInTheDocument();
  });

  it('pans a zoomed long image with two-finger wheel and mouse drag, then fully resets', () => {
    const { viewport, image, mover } = renderPreview();
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(viewport, {
      setPointerCapture,
      hasPointerCapture: () => true,
      releasePointerCapture,
    });

    fireEvent.doubleClick(image, { clientX: 500, clientY: 400 });
    fireEvent.wheel(viewport, { deltaY: 120 });
    expect(mover.style.transform).toBe('translate3d(0px, -120px, 0)');

    fireEvent.pointerDown(image, {
      button: 0,
      pointerId: 7,
      clientX: 500,
      clientY: 400,
    });
    expect(setPointerCapture).not.toHaveBeenCalled();
    fireEvent.pointerMove(viewport, {
      pointerId: 7,
      buttons: 1,
      clientX: 540,
      clientY: 460,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(mover.style.transform).toBe('translate3d(40px, -60px, 0)');
    fireEvent.pointerUp(viewport, { pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByTitle('旋转'));
    expect(image.style.transform).toContain('rotate(90deg)');
    fireEvent.click(screen.getByTitle('重置'));
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(mover.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(image.style.transform).toContain('rotate(0deg) scale(1)');
  });

  it('clears a pending drag that ends outside the image without capturing on hover', () => {
    const { viewport, image } = renderPreview();
    const setPointerCapture = vi.fn();
    Object.assign(viewport, {
      setPointerCapture,
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
    });

    fireEvent.doubleClick(image, { clientX: 500, clientY: 400 });
    fireEvent.pointerDown(image, {
      button: 0,
      buttons: 1,
      pointerId: 9,
      clientX: 500,
      clientY: 400,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 9,
      buttons: 0,
      clientX: 502,
      clientY: 400,
    });
    fireEvent.pointerMove(image, {
      pointerId: 9,
      buttons: 0,
      clientX: 540,
      clientY: 400,
    });

    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it('clamps two-finger pan at every overflowing edge', () => {
    const { viewport, image, mover } = renderPreview();

    fireEvent.doubleClick(image, { clientX: 500, clientY: 400 });
    fireEvent.wheel(viewport, { deltaX: 10_000, deltaY: 10_000 });
    expect(mover.style.transform).toBe('translate3d(-148px, -348px, 0)');

    fireEvent.wheel(viewport, { deltaX: -20_000, deltaY: -20_000 });
    expect(mover.style.transform).toBe('translate3d(148px, 348px, 0)');
  });

  it('keeps backdrop and Escape dismissal working around the full-surface viewport', () => {
    const { viewport, mover, onClose } = renderPreview();

    expect(mover).toHaveClass('pointer-events-none');
    fireEvent.mouseDown(mover);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(viewport);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
