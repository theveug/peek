// --- public/client/chatAutoScroll.js ---
// Shared "stay pinned to the bottom, unless the user scrolled up to read
// history" behavior for a scrollable chat-style log — extracted 2026-09-10
// out of ChatUI.js so MessagesPanel.js's DM thread gets the identical
// auto-scroll behavior instead of unconditionally jumping to the bottom on
// every render (which used to yank a user reading upward DM history back
// down the instant a live poll tick delivered a new message, unlike room
// chat's own #chat-log).

/**
 * @param {HTMLElement} logEl - the scrollable log container.
 * @param {HTMLElement|null} [composerEl] - the composer bar sitting below the
 *   log (outside it, as a flex sibling) — its height is folded into the
 *   "near enough to bottom" threshold so an auto-growing multi-line composer
 *   doesn't make a user who's actually at the bottom read as "scrolled up."
 * @returns {boolean}
 */
export function isAtBottom(logEl, composerEl) {
    const threshold = (composerEl?.scrollHeight || 0) + 50;
    return (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - threshold);
}

/**
 * Scrolls `logEl` to its current bottom. Downgrades to an instant jump (no
 * 'smooth' behavior) when the OS/browser has reduced-motion enabled — an
 * animated scrollTo() left mid-flight by a system-level "disable animations"
 * setting is what made this feel unresponsive/stuck.
 * @param {HTMLElement} logEl
 * @returns {void}
 */
export function scrollToBottom(logEl) {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => logEl.scrollTo({ top: logEl.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' }));
}

/**
 * Only auto-scrolls if the user was already at (or near) the bottom, so a
 * message arriving while they've scrolled up to read history doesn't yank
 * them back down.
 * @param {HTMLElement} logEl
 * @param {HTMLElement|null} [composerEl]
 * @returns {void}
 */
export function scrollIfAtBottom(logEl, composerEl) {
    if (isAtBottom(logEl, composerEl)) scrollToBottom(logEl);
}

/**
 * Keeps `logEl` pinned to its bottom across a chat-panel drag-resize or a
 * window resize — both reflow message text (word-wrap changes) and shift
 * scrollHeight without firing a 'scroll' event, so a user who was reading
 * live traffic at the bottom would otherwise drift away from it purely from
 * the reflow. The returned tracker's `wasAtBottom` is updated only by real
 * user scrolling (via the 'scroll' listener) and left untouched by the
 * observer's own corrective jumps, so a user who'd deliberately scrolled up
 * to read history is never yanked back down by a resize.
 * @param {HTMLElement} logEl
 * @param {HTMLElement|null} [composerEl]
 * @returns {void}
 */
export function wireAutoScrollResize(logEl, composerEl) {
    if (!logEl || typeof ResizeObserver === 'undefined') return;
    const tracker = { wasAtBottom: true };
    logEl.addEventListener('scroll', () => {
        tracker.wasAtBottom = isAtBottom(logEl, composerEl);
    });
    new ResizeObserver(() => {
        if (tracker.wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
    }).observe(logEl);
}
