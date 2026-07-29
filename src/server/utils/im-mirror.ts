/**
 * im-mirror — transport Session-owned user/assistant delivery to a bound IM
 * channel. Turn owners decide admission; this module only projects payloads
 * and performs the best-effort management API call.
 *
 * The function `mirrorIfChannelBound` posts to Rust's `/api/im/mirror`
 * management API endpoint. Rust looks up which IM channel currently binds
 * the given session id (`peer_sessions[*].session_id == sessionId`) and
 * forwards the text via the channel adapter. If no channel is bound the
 * server returns `{ mirrored: false }` and we silently move on — that's
 * the common case for pure-desktop sessions.
 *
 * What the transport accepts:
 *   * user role: full text with `[From: 桌面端用户消息]` prefix, plus PNG/JPG
 *     attachments inline.
 *   * assistant role: AI text block (one call per content_block_stop). NO
 *     prefix — flows through to IM as plain bot reply, matching the
 *     experience of asking the bot directly.
 *
 * What we do NOT mirror:
 *   * tool_use / tool_result / canUseTool approval cards.
 *   * partial chunks (delta events).
 *   * non-image attachments (PDF / video / arbitrary binary).
 *
 * Failures are best-effort and logged to the unified log; the desktop
 * conversation continues regardless.
 */

import { stripLeadingSystemReminder } from '../../shared/systemReminder';
import type { ResolvedImagePayload } from '../runtimes/types';
import { cancellableFetch } from './cancellation';
import { isSilentAssistantChannelText } from '../session-core/channel-delivery';

export interface MirrorImage {
    mimeType: string;
    /** base64-encoded image data (no `data:` prefix) */
    dataBase64: string;
}

export interface MirrorPayload {
    sessionId: string;
    role: 'user' | 'assistant';
    text?: string;
    images?: MirrorImage[];
}

/**
 * Remove every leading hidden control envelope before a desktop message is
 * copied to IM. Producers must emit one envelope, but historical or malformed
 * input can contain several, so a single peel is not a sufficient disclosure
 * boundary. The depth cap keeps malformed input bounded.
 */
export function visibleDesktopMirrorText(content: string): string {
    let visibleContent = content;
    for (let i = 0; i < 8; i += 1) {
        const stripped = stripLeadingSystemReminder(visibleContent);
        if (stripped === visibleContent) break;
        visibleContent = stripped;
    }
    return visibleContent;
}

/** Convert resolved user images to MirrorImage[] keeping only PNG/JPG (Q5 lockdown). */
// Pre-validation cap MUST stay in sync with Rust's
// `MIRROR_IMAGE_MAX_BYTES = 5MB` in management_api.rs (and its
// `MIRROR_IMAGE_MAX_BASE64_LEN` derivation). Base64 with padding inflates
// to `4 * ceil(bytes / 3)` chars — using a strict `Math.ceil(bytes/3)*4`
// formula matches Rust's exact bound, plus the same 64-char slack for any
// trailing whitespace/newlines. Cap on the encoded length so the guard is
// O(1) without decoding.
const MIRROR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MIRROR_IMAGE_MAX_BASE64_CHARS = Math.ceil(MIRROR_IMAGE_MAX_BYTES / 3) * 4 + 64;

export function resolvedImagesToMirrorImages(
    images: ResolvedImagePayload[] | undefined,
): MirrorImage[] | undefined {
    if (!images || images.length === 0) return undefined;
    const out: MirrorImage[] = [];
    for (const img of images) {
        const mime = img.mimeType.toLowerCase();
        if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/jpg') continue;
        if (img.data.length > MIRROR_IMAGE_MAX_BASE64_CHARS) {
            console.warn(
                `[mirror] dropping oversize image: mime=${mime} base64Len=${img.data.length} cap=${MIRROR_IMAGE_MAX_BASE64_CHARS}`,
            );
            continue;
        }
        out.push({ mimeType: img.mimeType, dataBase64: img.data });
    }
    return out.length > 0 ? out : undefined;
}

/** Concise structural log marker so a quick `grep '\[mirror\]'` surfaces these
 *  in unified logs without dumping verbose payload bodies. */
const LOG = '[mirror]';

/**
 * Best-effort bound-channel delivery. Caller MUST NOT await this on the critical
 * path of message persistence (we don't want IM latency to gate Sidecar
 * forward progress). The promise still resolves so call sites that want to
 * observe completion (tests) can opt in.
 *
 * The function is a no-op when:
 *   * `MYAGENTS_MANAGEMENT_PORT` is unset (Sidecar started without
 *     management API — should not happen in production but safe defaults).
 *   * `payload.text` is empty AND `payload.images` is empty/undefined.
 *
 * Quietly returns instead of throwing on transport / HTTP errors so a
 * misbehaving channel can't bring down the desktop turn.
 */
export async function mirrorIfChannelBound(payload: MirrorPayload): Promise<void> {
    const port = process.env.MYAGENTS_MANAGEMENT_PORT;
    if (!port) return;

    const hasText = !!(payload.text && payload.text.trim().length > 0);
    const hasImages = !!(payload.images && payload.images.length > 0);
    if (!hasText && !hasImages) return;
    if (payload.role === 'assistant' && payload.text && isSilentAssistantChannelText(payload.text)) return;

    const url = `http://127.0.0.1:${port}/api/im/mirror`;
    try {
        const res = await cancellableFetch(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
            { timeoutMs: 10_000 },
        );
        if (!res.ok) {
            console.warn(`${LOG} mirror request returned ${res.status}`);
            return;
        }
        const json = (await res.json().catch(() => null)) as
            | { mirrored?: boolean; textSent?: boolean; imagesSent?: number; imagesSkipped?: number }
            | null;
        if (json?.mirrored) {
            console.log(
                `${LOG} ok role=${payload.role} text=${json.textSent ? 'y' : 'n'} imgs=${json.imagesSent ?? 0}/${json.imagesSkipped ?? 0}`,
            );
        }
    } catch (err) {
        // Connect failure / timeout / abort. Mirror is best-effort.
        console.warn(`${LOG} mirror failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
