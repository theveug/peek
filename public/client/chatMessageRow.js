// --- public/client/chatMessageRow.js ---
// Shared "one chat message" row pieces: a deterministic name→color hash and
// the avatar+sender+timestamp header markup, both extracted 2026-09-10 out
// of ChatUI.js so MessagesPanel.js's DM thread can render as a real mini
// chat log (matching room chat's own look) instead of a separately-styled
// two-sided bubble list — owner-reported: "this just needs to mimic the
// chat panel rather than have a different style and input area... these
// will more than likely need to be done for messages also." ChatUI.js's
// addChatMessage() and MessagesPanel.js's _renderThread() both build their
// message header through messageHeaderHtml() now, so a markup/layout change
// to one automatically reaches the other instead of needing a hand-copy.
//
// Deliberately NOT shared: reactions, replies, @mentions, pins, edit/delete
// ownership, history persistence — those are room-chat concepts a DM thread
// doesn't have (DirectMessagesManager.js cut them for v1, see CLAUDE.md's
// "Accounts, Phase 4" entry). ChatUI.js layers all of that on top of this
// same header shape itself; this module only owns what both surfaces
// genuinely need identically.
import { escapeHtml } from './escapeHtml.js';

/**
 * The local user's own message color in both room chat and DMs — reserved,
 * never handed out by colorForName() (2026-09-10, owner-reported: wanted a
 * safeguard that "the client always has its own unique color that can not
 * be picked by participants" — a message-color hash landing on the same
 * green some peer/DM-partner is using could read as your own message).
 * `SELF_COLOR` is the single source of truth every call site should use
 * instead of a hand-typed literal, so a future palette change can't
 * reintroduce the collision by drifting the two out of sync.
 *
 * A CSS variable reference, not a hex literal (2026-09-10, owner-reported:
 * wanted the avatar/sender-name color and `.chat-message-self`'s background
 * tint — tailwind.css, `color-mix(in srgb, var(--green) 8%, transparent)` —
 * to actually be the same green, not two independently-hardcoded values
 * that happen to look close) — `var(--green)` works fine as an inline style
 * value, and it's the same token used everywhere else in this app "green"
 * means something (mic-on, speaking ring, "online").
 */
export const SELF_COLOR = 'var(--green)';

// Deliberately excludes the *literal hex* SELF_COLOR would otherwise
// resolve to (oklch(0.66-0.8 0.16-0.17 150), i.e. the same green family as
// the old hardcoded '#22c55e') — colorForName() below can never return
// something in that family, so no peer's hashed nickname (room chat) or DM
// partner's username can ever land on a color close enough to read as "you."
const AVATAR_COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#14b8a6', '#06b6d4',
    '#3b82f6', '#a855f7', '#e11d48',
];

/** @param {string} name @returns {string} a deterministic avatar color hashed from the name — never SELF_COLOR, see above. */
export function colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * The one ternary every message-header call site needs: your own messages
 * always get the reserved SELF_COLOR, anyone else's hash to a color that can
 * never collide with it. Use this instead of hand-writing
 * `isSelf ? '#22c55e' : colorForName(sender)` at a new call site.
 * @param {string} name @param {boolean} isSelf @returns {string}
 */
export function colorFor(name, isSelf) {
    return isSelf ? SELF_COLOR : colorForName(name);
}

/**
 * Simple one-char fallback for MessagesPanel.js's use case (single-token
 * account usernames, no spaces — authRoutes.js's USERNAME_RE). ChatUI.js
 * keeps its own injectable version instead (UIController._avatarInitials
 * takes up to 2 chars from a multi-word room nickname), since room
 * nicknames can contain spaces and this simpler version would be wrong
 * there — that's why messageHeaderHtml() below takes a precomputed
 * `initial`/`color` rather than deriving them itself.
 * @param {string} name @returns {string}
 */
export function avatarInitial(name) {
    return name.charAt(0).toUpperCase();
}

/** @param {{avatarUrl: string|null, initial: string, color: string}} opts @returns {string} */
export function avatarHtml({ avatarUrl, initial, color }) {
    return avatarUrl
        ? `<span class="chat-avatar"><img class="avatar-img" src="${avatarUrl}" alt="" /></span>`
        : `<span class="chat-avatar" style="background:${color}">${escapeHtml(initial)}</span>`;
}

/**
 * The `.chat-message` header row (avatar+sender+timestamp) every message
 * row is built around, in both ChatUI.js and MessagesPanel.js.
 * @param {{avatarUrl: string|null, initial: string, color: string, sender: string, timestamp: string}} opts
 * @returns {string}
 */
export function messageHeaderHtml({ avatarUrl, initial, color, sender, timestamp }) {
    return `<div class="flex items-center gap-2 mb-0.5">${avatarHtml({ avatarUrl, initial, color })}<span class="chat-sender font-medium text-xs" style="color:${color}">${escapeHtml(sender)}</span><span class="chat-timestamp text-[10px] ml-auto shrink-0">${escapeHtml(timestamp)}</span></div>`;
}
