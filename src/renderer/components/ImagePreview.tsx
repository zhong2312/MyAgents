import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import {
    bindZoomGestureListeners,
    type ZoomGestureOrigin,
    type ZoomUpdater,
} from '@/utils/zoomGesture';

interface ImagePreviewProps {
    src: string;
    name: string;
    onClose: () => void;
}

interface ImageViewportState {
    scale: number;
    x: number;
    y: number;
    rotation: number;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const ZOOM_STEP = 0.25;
const DOUBLE_CLICK_SCALE = 2;
const PAN_EDGE_PADDING = 48;
const INITIAL_VIEW: ImageViewportState = { scale: 1, x: 0, y: 0, rotation: 0 };

const clampScale = (scale: number) => (
    Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100))
);

export default function ImagePreview({ src, name, onClose }: ImagePreviewProps) {
    const { t } = useTranslation('app');
    const viewportRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const viewRef = useRef<ImageViewportState>(INITIAL_VIEW);
    const dragRef = useRef<{
        pointerId: number;
        clientX: number;
        clientY: number;
        originX: number;
        originY: number;
        captured: boolean;
    } | null>(null);
    const [view, setView] = useState<ImageViewportState>(INITIAL_VIEW);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        viewRef.current = view;
    }, [view]);

    // Cmd+W dismissal: z-[200] matches the component's CSS z-index
    useCloseLayer(() => { onClose(); return true; }, 200);

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const getPanBounds = useCallback((candidate: ImageViewportState) => {
        const viewport = viewportRef.current;
        const image = imageRef.current;
        if (!viewport || !image) return { maxX: 0, maxY: 0 };

        const viewportRect = viewport.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        const viewportWidth = viewport.clientWidth || viewportRect.width;
        const viewportHeight = viewport.clientHeight || viewportRect.height;
        const imageWidth = image.offsetWidth || imageRect.width / Math.max(candidate.scale, 0.01);
        const imageHeight = image.offsetHeight || imageRect.height / Math.max(candidate.scale, 0.01);
        const quarterTurn = Math.abs(candidate.rotation % 180) === 90;
        const scaledWidth = (quarterTurn ? imageHeight : imageWidth) * candidate.scale;
        const scaledHeight = (quarterTurn ? imageWidth : imageHeight) * candidate.scale;

        return {
            maxX: scaledWidth > viewportWidth
                ? (scaledWidth - viewportWidth) / 2 + PAN_EDGE_PADDING
                : 0,
            maxY: scaledHeight > viewportHeight
                ? (scaledHeight - viewportHeight) / 2 + PAN_EDGE_PADDING
                : 0,
        };
    }, []);

    const clampView = useCallback((candidate: ImageViewportState): ImageViewportState => {
        const { maxX, maxY } = getPanBounds(candidate);
        const x = Math.min(maxX, Math.max(-maxX, candidate.x));
        const y = Math.min(maxY, Math.max(-maxY, candidate.y));
        return x === candidate.x && y === candidate.y
            ? candidate
            : { ...candidate, x, y };
    }, [getPanBounds]);

    const applyZoom = useCallback((next: ZoomUpdater, origin?: ZoomGestureOrigin) => {
        setView((current) => {
            const scale = clampScale(typeof next === 'function' ? next(current.scale) : next);
            if (scale === current.scale) return current;

            const viewport = viewportRef.current;
            const rect = viewport?.getBoundingClientRect();
            const centerX = rect ? rect.left + rect.width / 2 : 0;
            const centerY = rect ? rect.top + rect.height / 2 : 0;
            const anchorX = origin ? origin.clientX - centerX : 0;
            const anchorY = origin ? origin.clientY - centerY : 0;
            const ratio = scale / current.scale;

            return clampView({
                ...current,
                scale,
                x: anchorX - (anchorX - current.x) * ratio,
                y: anchorY - (anchorY - current.y) * ratio,
            });
        });
    }, [clampView]);

    const handleZoomIn = useCallback(() => {
        applyZoom((scale) => scale + ZOOM_STEP);
    }, [applyZoom]);

    const handleZoomOut = useCallback(() => {
        applyZoom((scale) => scale - ZOOM_STEP);
    }, [applyZoom]);

    const handleReset = useCallback(() => {
        setView(INITIAL_VIEW);
    }, []);

    const handleRotate = useCallback(() => {
        setView((current) => clampView({
            ...current,
            rotation: (current.rotation + 90) % 360,
        }));
    }, [clampView]);

    const handleDoubleClick = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
        event.preventDefault();
        event.stopPropagation();
        applyZoom(view.scale > 1 ? 1 : DOUBLE_CLICK_SCALE, {
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }, [applyZoom, view.scale]);

    const finishDrag = useCallback((event: PointerEvent) => {
        const drag = dragRef.current;
        const viewport = viewportRef.current;
        if (!viewport || drag?.pointerId !== event.pointerId) return;
        if (drag.captured && viewport.hasPointerCapture(event.pointerId)) {
            event.preventDefault();
            viewport.releasePointerCapture(event.pointerId);
        }
        dragRef.current = null;
        setIsDragging(false);
    }, []);

    const handlePointerDown = useCallback((event: PointerEvent) => {
        if (event.button !== 0 || event.target !== imageRef.current) return;
        const bounds = getPanBounds(viewRef.current);
        if (bounds.maxX === 0 && bounds.maxY === 0) return;

        dragRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            originX: viewRef.current.x,
            originY: viewRef.current.y,
            captured: false,
        };
    }, [getPanBounds]);

    const handlePointerMove = useCallback((event: PointerEvent) => {
        const drag = dragRef.current;
        const viewport = viewportRef.current;
        if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
        if (event.buttons === 0) {
            finishDrag(event);
            return;
        }
        const deltaX = event.clientX - drag.clientX;
        const deltaY = event.clientY - drag.clientY;
        if (!drag.captured) {
            if (Math.hypot(deltaX, deltaY) < 3) return;
            viewport.setPointerCapture(event.pointerId);
            drag.captured = true;
            setIsDragging(true);
        }
        event.preventDefault();
        setView((current) => clampView({
            ...current,
            x: drag.originX + deltaX,
            y: drag.originY + deltaY,
        }));
    }, [clampView, finishDrag]);

    const handlePointerLeave = useCallback((event: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || drag.captured) return;
        dragRef.current = null;
        setIsDragging(false);
    }, []);

    const handleLostPointerCapture = useCallback((event: PointerEvent) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setIsDragging(false);
    }, []);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;

        const removeZoomGestures = bindZoomGestureListeners(viewport, {
            getZoom: () => viewRef.current.scale,
            setZoom: applyZoom,
        });
        const handlePanWheel = (event: WheelEvent) => {
            if (event.ctrlKey) return;
            const bounds = getPanBounds(viewRef.current);
            if (bounds.maxX === 0 && bounds.maxY === 0) return;
            event.preventDefault();
            setView((current) => clampView({
                ...current,
                x: current.x - (bounds.maxX > 0 ? event.deltaX : 0),
                y: current.y - (bounds.maxY > 0 ? event.deltaY : 0),
            }));
        };

        viewport.addEventListener('wheel', handlePanWheel, { passive: false });
        viewport.addEventListener('pointerdown', handlePointerDown);
        viewport.addEventListener('pointermove', handlePointerMove);
        viewport.addEventListener('pointerup', finishDrag);
        viewport.addEventListener('pointercancel', finishDrag);
        viewport.addEventListener('pointerleave', handlePointerLeave);
        viewport.addEventListener('lostpointercapture', handleLostPointerCapture);
        return () => {
            removeZoomGestures();
            viewport.removeEventListener('wheel', handlePanWheel);
            viewport.removeEventListener('pointerdown', handlePointerDown);
            viewport.removeEventListener('pointermove', handlePointerMove);
            viewport.removeEventListener('pointerup', finishDrag);
            viewport.removeEventListener('pointercancel', finishDrag);
            viewport.removeEventListener('pointerleave', handlePointerLeave);
            viewport.removeEventListener('lostpointercapture', handleLostPointerCapture);
        };
    }, [
        applyZoom,
        clampView,
        finishDrag,
        getPanBounds,
        handleLostPointerCapture,
        handlePointerDown,
        handlePointerLeave,
        handlePointerMove,
    ]);

    const reconcileBounds = useCallback(() => {
        setView((current) => clampView(current));
    }, [clampView]);

    useEffect(() => {
        const viewport = viewportRef.current;
        const image = imageRef.current;
        if (!viewport || !image) return;
        const observer = new ResizeObserver(reconcileBounds);
        observer.observe(viewport);
        observer.observe(image);
        return () => observer.disconnect();
    }, [reconcileBounds, src]);

    // Prevent background scroll when modal is open
    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    const canDrag = view.scale > 1 || Math.abs(view.rotation % 180) === 90;

    return createPortal(
        <OverlayBackdrop
            ref={viewportRef}
            onClose={onClose}
            className={`z-[200] select-none overflow-hidden ${isDragging ? 'cursor-grabbing' : canDrag ? 'cursor-grab' : 'cursor-default'}`}
            style={{ touchAction: 'none' }}
            variant="dark"
        >
            {/* Header with title and controls */}
            <div
                className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-6 py-4"
            >
                <span className="text-sm font-medium text-white/90 truncate max-w-[50%]">{name}</span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleZoomOut}
                        disabled={view.scale <= MIN_SCALE}
                        className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:opacity-35 disabled:hover:bg-transparent"
                        title={t('imagePreview.zoomOut')}
                    >
                        <ZoomOut className="h-5 w-5" />
                    </button>
                    <span className="min-w-[3rem] text-center text-xs tabular-nums text-white/60">{Math.round(view.scale * 100)}%</span>
                    <button
                        type="button"
                        onClick={handleZoomIn}
                        disabled={view.scale >= MAX_SCALE}
                        className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.96] disabled:opacity-35 disabled:hover:bg-transparent"
                        title={t('imagePreview.zoomIn')}
                    >
                        <ZoomIn className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        onClick={handleRotate}
                        className="rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.96]"
                        title={t('imagePreview.rotate')}
                    >
                        <RotateCcw className="h-5 w-5" style={{ transform: 'scaleX(-1)' }} />
                    </button>
                    <button
                        type="button"
                        onClick={handleReset}
                        className="rounded-lg px-3 py-2 text-xs text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.96]"
                        title={t('imagePreview.reset')}
                    >
                        {t('imagePreview.reset')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-4 rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.96]"
                        title={t('imagePreview.closeEsc')}
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>
            </div>

            {/* One transform viewport owns pinch, pan, drag, double-click and toolbar zoom. */}
            <div
                className="pointer-events-none absolute left-1/2 top-1/2 will-change-transform"
                style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0)` }}
            >
                <img
                    ref={imageRef}
                    src={src}
                    alt={name}
                    className="pointer-events-auto max-h-[80vh] max-w-[90vw] rounded-lg shadow-2xl will-change-transform"
                    style={{
                        transform: `translate(-50%, -50%) rotate(${view.rotation}deg) scale(${view.scale})`,
                        transformOrigin: 'center',
                    }}
                    draggable={false}
                    onLoad={reconcileBounds}
                    onDoubleClick={handleDoubleClick}
                />
            </div>

            {/* Hint text */}
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap text-xs text-white/50">
                {t('imagePreview.hint')}
            </div>
        </OverlayBackdrop>,
        document.body
    );
}
