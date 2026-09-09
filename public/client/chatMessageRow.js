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

const AVATAR_COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
    '#f97316', '#eab308', '#22c55e', '#14b8a6',
    '#06b6d4', '#3b82f6', '#a855f7', '#e11d48',
];

/** @param {string} name @returns {string} a deterministic avatar color hashed from the name. */
export function colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
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
