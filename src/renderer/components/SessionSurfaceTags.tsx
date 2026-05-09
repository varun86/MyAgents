/**
 * SessionSurfaceTags — top-bar badge cluster + handover button for the
 * current Chat tab's session.
 *
 * Layout (immediately after session title, before the right-side action group):
 *
 *   pure desktop, has channels available           → [📤 handover button]
 *   pure desktop, no channels                      → (nothing)
 *   channel-bound                                  → [●飞书] (button hidden — mutual exclusion)
 *   channel-bound + cron                           → [●飞书][●定时]
 *   pure desktop + cron                            → [●定时][📤]
 *
 * The mutual exclusion between the channel pill and the handover button
 * matches the user's mental model: "the button only makes sense when this
 * session isn't currently the channel's bound session".
 *
 * Phase A (this commit): renders pills only. Handover button is wired in
 * Phase B by passing `onHandoverClick` + a non-empty `availableChannels`.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send } from 'lucide-react';

import SessionTagBadge from './SessionTagBadge';
import type { SessionTag } from '@/hooks/useTaskCenterData';
import type { ChannelSurface, CronSurface } from '@/hooks/useSessionSurfaces';

export interface SessionSurfaceTagsProps {
    channel: ChannelSurface | null;
    cron: CronSurface | null;
    /**
     * If set AND channel is null, renders the handover button.
     * The handler receives no args — the popover handles channel selection.
     */
    onHandoverClick?: (anchorEl: HTMLElement) => void;
    /**
     * Whether handover is allowed right now (Q10). Caller computes:
     *
     *   canHandover = isPureDesktopSession
     *              && availableChannels.length > 0
     *              && !isBackgroundSession
     *              && session.source not from IM
     *
     * If false, the handover button is hidden even when channel is null.
     */
    canHandover?: boolean;
}

export default function SessionSurfaceTags({
    channel,
    cron,
    onHandoverClick,
    canHandover = false,
}: SessionSurfaceTagsProps) {
    const tags: SessionTag[] = [];
    if (channel) tags.push({ type: 'im', platform: channel.platformLabel });
    if (cron) tags.push({ type: 'cron' });

    // Channel pill is interactive — clicking shows a tiny info popover (Phase A).
    // We render it inside an unstyled button so click works without breaking
    // the existing SessionTagBadge styling.
    const [channelInfoAnchor, setChannelInfoAnchor] = useState<HTMLElement | null>(null);

    const showHandoverButton = !channel && canHandover && !!onHandoverClick;

    if (tags.length === 0 && !showHandoverButton) return null;

    return (
        <>
            <div className="flex shrink-0 items-center gap-1">
                {/* Cron tag is non-interactive — informational only */}
                {cron && <SessionTagBadge tag={{ type: 'cron' }} />}

                {/* Channel pill — clickable to show info */}
                {channel && (
                    <button
                        type="button"
                        onClick={(e) => setChannelInfoAnchor(e.currentTarget)}
                        title={`${channel.agentName} · ${channel.channelName}`}
                        className="cursor-pointer rounded-full transition-opacity hover:opacity-80"
                    >
                        <SessionTagBadge tag={{ type: 'im', platform: channel.platformLabel }} />
                    </button>
                )}

                {/* Handover button — mutual exclusive with channel pill */}
                {showHandoverButton && (
                    <button
                        type="button"
                        onClick={(e) => onHandoverClick(e.currentTarget)}
                        title="推送到 IM 继续"
                        className="flex items-center justify-center rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                        <Send className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* Channel info popover */}
            {channel && channelInfoAnchor && (
                <ChannelInfoPopover
                    channel={channel}
                    anchorEl={channelInfoAnchor}
                    onClose={() => setChannelInfoAnchor(null)}
                />
            )}
        </>
    );
}

// ============================================================================
// Channel info popover (Phase A — read-only)
// ============================================================================

interface ChannelInfoPopoverProps {
    channel: ChannelSurface;
    anchorEl: HTMLElement;
    onClose: () => void;
}

function ChannelInfoPopover({ channel, anchorEl, onClose }: ChannelInfoPopoverProps) {
    const popoverRef = useRef<HTMLDivElement | null>(null);

    // Position below anchor (left-aligned)
    const rect = anchorEl.getBoundingClientRect();
    const top = rect.bottom + 6;
    const left = rect.left;

    // Click-outside dismiss
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popoverRef.current && !popoverRef.current.contains(target) && !anchorEl.contains(target)) {
                onClose();
            }
        };
        // Defer one tick so the click that opened the popover doesn't immediately close it
        const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handler);
        };
    }, [anchorEl, onClose]);

    return createPortal(
        <div
            ref={popoverRef}
            className="fixed z-50 w-64 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-[12px] shadow-lg"
            style={{ top, left }}
        >
            <div className="mb-1 flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                <span className="font-medium text-[var(--ink)]">{channel.platformLabel}</span>
                <span className="text-[var(--ink-subtle)]">·</span>
                <span className="text-[var(--ink-muted)]">{channel.agentName}</span>
            </div>
            <div className="text-[var(--ink-muted)]">
                {channel.channelName}
            </div>
            <div className="mt-2 border-t border-[var(--line-subtle)] pt-2 text-[11px] text-[var(--ink-subtle)]">
                此对话当前路由到该 channel。在 channel 端发送消息会到这个 session；桌面端的消息也会镜像过去。
            </div>
        </div>,
        document.body,
    );
}
