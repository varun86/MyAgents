import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface ImagePreviewProps {
    src: string;
    name: string;
    onClose: () => void;
}

export default function ImagePreview({ src, name, onClose }: ImagePreviewProps) {
    const { t } = useTranslation('app');
    const [scale, setScale] = useState(1);
    const [rotation, setRotation] = useState(0);

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

    const handleZoomIn = useCallback(() => {
        setScale((s) => Math.min(s + 0.25, 3));
    }, []);

    const handleZoomOut = useCallback(() => {
        setScale((s) => Math.max(s - 0.25, 0.25));
    }, []);

    const handleReset = useCallback(() => {
        setScale(1);
        setRotation(0);
    }, []);

    const handleRotate = useCallback(() => {
        setRotation((r) => (r + 90) % 360);
    }, []);

    // Prevent background scroll when modal is open
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
        };
    }, []);

    return createPortal(
        <OverlayBackdrop onClose={onClose} className="z-[200]" variant="dark">
            {/* Header with title and controls */}
            <div
                className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4"
            >
                <span className="text-sm font-medium text-white/90 truncate max-w-[50%]">{name}</span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleZoomOut}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title={t('imagePreview.zoomOut')}
                    >
                        <ZoomOut className="h-5 w-5" />
                    </button>
                    <span className="text-xs text-white/60 min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
                    <button
                        type="button"
                        onClick={handleZoomIn}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title={t('imagePreview.zoomIn')}
                    >
                        <ZoomIn className="h-5 w-5" />
                    </button>
                    <button
                        type="button"
                        onClick={handleRotate}
                        className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title={t('imagePreview.rotate')}
                    >
                        <RotateCcw className="h-5 w-5" style={{ transform: 'scaleX(-1)' }} />
                    </button>
                    <button
                        type="button"
                        onClick={handleReset}
                        className="rounded-lg px-3 py-2 text-xs text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title={t('imagePreview.reset')}
                    >
                        {t('imagePreview.reset')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-4 rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                        title={t('imagePreview.closeEsc')}
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>
            </div>

            {/* Image container */}
            <div
                className="relative flex items-center justify-center"
            >
                <img
                    src={src}
                    alt={name}
                    className="max-h-[80vh] max-w-[90vw] rounded-lg shadow-2xl transition-transform duration-200"
                    style={{
                        transform: `scale(${scale}) rotate(${rotation}deg)`,
                    }}
                    draggable={false}
                />
            </div>

            {/* Hint text */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/50">
                {t('imagePreview.hint')}
            </div>
        </OverlayBackdrop>,
        document.body
    );
}
