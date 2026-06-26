import { type CSSProperties, type HTMLAttributes, type MouseEvent, useCallback, useRef } from 'react';
import { isTauri } from '@/api/tauriClient';

const MYAGENTS_TITLEBAR_DRAG_REGION_ATTR = 'data-myagents-titlebar-drag-region';

export function isMacPlatform(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform?.toLowerCase().includes('mac');
}

function stopTitlebarMouseEvent(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();
}

async function startMacTitlebarDrag() {
    if (!isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_macos_safe_drag_window');
}

async function toggleWindowMaximize() {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (await win.isMaximized()) {
        await win.unmaximize();
    } else {
        await win.maximize();
    }
}

interface TitlebarDragRegionProps extends HTMLAttributes<HTMLDivElement> {
    className?: string;
    style?: CSSProperties;
}

export default function TitlebarDragRegion({
    className = '',
    style,
    children,
    ...rest
}: TitlebarDragRegionProps) {
    const doubleClickStartRef = useRef<{ x: number; y: number } | null>(null);
    const useSafeMacDrag = isMacPlatform();

    const handleMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) return;
        stopTitlebarMouseEvent(event);

        if (event.detail === 2) {
            doubleClickStartRef.current = { x: event.clientX, y: event.clientY };
            return;
        }

        void startMacTitlebarDrag().catch((error) => {
            console.error('Failed to start macOS titlebar drag:', error);
        });
    }, []);

    const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.detail !== 2) return;
        stopTitlebarMouseEvent(event);

        const start = doubleClickStartRef.current;
        doubleClickStartRef.current = null;
        if (!start || start.x !== event.clientX || start.y !== event.clientY) return;

        void toggleWindowMaximize().catch((error) => {
            console.error('Failed to toggle window maximize:', error);
        });
    }, []);

    if (useSafeMacDrag) {
        return (
            <div
                {...rest}
                className={className}
                style={style}
                {...{ [MYAGENTS_TITLEBAR_DRAG_REGION_ATTR]: true }}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
            >
                {children}
            </div>
        );
    }

    return (
        <div
            {...rest}
            className={className}
            style={style}
            data-tauri-drag-region
        >
            {children}
        </div>
    );
}
