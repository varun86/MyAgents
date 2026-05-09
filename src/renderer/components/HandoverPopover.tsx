/**
 * HandoverPopover — pick an IM channel to push the current desktop session to.
 *
 * Shown when user clicks the 📤 icon next to the session title (Chat.tsx).
 * Lists ALL online channels of the current workspace's Agent (one Agent per
 * workspace, multiple channels per Agent — Q3·A locked).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

import { handoverSessionToChannel } from '@/api/sessionHandoverClient';
import { useToast } from './Toast';

export interface HandoverChannelCandidate {
    agentId: string;
    agentName: string;
    channelId: string;
    channelType: string;
    channelName: string;
    /** Localized platform label (e.g. "飞书") */
    platformLabel: string;
}

interface HandoverPopoverProps {
    sessionId: string;
    workspacePath: string;
    candidates: HandoverChannelCandidate[];
    anchorEl: HTMLElement;
    onClose: () => void;
    onSuccess?: (channel: HandoverChannelCandidate) => void;
}

export default function HandoverPopover({
    sessionId,
    workspacePath,
    candidates,
    anchorEl,
    onClose,
    onSuccess,
}: HandoverPopoverProps) {
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pending, setPending] = useState<string | null>(null); // channelId being submitted
    const toast = useToast();

    const rect = anchorEl.getBoundingClientRect();
    // Popover anchored top-right of button so it grows downward & leftward
    const top = rect.bottom + 8;
    const right = window.innerWidth - rect.right;

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popoverRef.current && !popoverRef.current.contains(target) && !anchorEl.contains(target)) {
                onClose();
            }
        };
        const t = setTimeout(() => document.addEventListener('mousedown', handler), 0);
        return () => {
            clearTimeout(t);
            document.removeEventListener('mousedown', handler);
        };
    }, [anchorEl, onClose]);

    const handleSelect = async (candidate: HandoverChannelCandidate) => {
        if (pending) return;
        setPending(candidate.channelId);
        try {
            const res = await handoverSessionToChannel({
                sessionId,
                agentId: candidate.agentId,
                channelId: candidate.channelId,
                workspacePath,
            });
            if (res.ok) {
                toast.success(`已交接到 ${candidate.platformLabel} · ${candidate.channelName}`);
                onSuccess?.(candidate);
                onClose();
            } else {
                toast.error('交接失败');
            }
        } catch (err) {
            console.error('[HandoverPopover] handover failed:', err);
            toast.error(`交接失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setPending(null);
        }
    };

    return createPortal(
        <div
            ref={popoverRef}
            className="fixed z-50 w-72 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg"
            style={{ top, right }}
        >
            <div className="border-b border-[var(--line-subtle)] px-3 py-2 text-[12px] font-medium text-[var(--ink)]">
                推送对话到 IM 继续
            </div>
            {candidates.length === 0 ? (
                <div className="px-3 py-4 text-[12px] text-[var(--ink-muted)]">
                    没有可用的 channel。前往设置启用至少一个 IM 渠道。
                </div>
            ) : (
                <ul className="max-h-72 overflow-y-auto">
                    {candidates.map((c) => (
                        <li key={c.channelId}>
                            <button
                                type="button"
                                disabled={pending !== null}
                                onClick={() => handleSelect(c)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                                <span className="shrink-0 font-medium text-[var(--ink)]">{c.platformLabel}</span>
                                <span className="shrink-0 text-[var(--ink-subtle)]">·</span>
                                <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">
                                    {c.agentName} / {c.channelName}
                                </span>
                                {pending === c.channelId && (
                                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ink-muted)]" />
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="border-t border-[var(--line-subtle)] px-3 py-2 text-[11px] leading-relaxed text-[var(--ink-subtle)]">
                选中的 channel 当前对话会被替换为此 session，原对话保留在历史中。
            </div>
        </div>,
        document.body,
    );
}
