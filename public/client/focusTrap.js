/**
 * Minimal focus trap for modal overlays (Settings panel, chat image lightbox).
 * Keyboard-only users could previously Tab straight out of an open overlay
 * into the page behind it — the 2026-07-14 accessibility audit's "modals
 * don't trap focus" finding.
 *
 * `trapFocus(container, initialFocus?)` moves focus into the overlay, wraps
 * Tab/Shift+Tab at its edges, and returns a `release()` function that undoes
 * the trap and restores focus to whatever had it before the overlay opened
 * (so closing Settings puts you back on the button that opened it, not at
 * the top of the document).
 *
 * Visibility is checked per-Tab via `getClientRects()` (not `offsetParent`,
 * which is null for position:fixed elements) so controls inside currently
 * hidden settings sections are skipped.
 */

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * @param {HTMLElement} container - the overlay root to confine focus within.
 * @param {HTMLElement} [initialFocus] - element to focus on open; defaults to
 *     the container's first visible focusable.
 * @returns {() => void} release — removes the trap and restores prior focus.
 */
export function trapFocus(container, initialFocus = null) {
    const previouslyFocused = document.activeElement;

    const visibleFocusables = () =>
        [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
            .filter(el => el.getClientRects().length > 0);

    const onKeydown = (e) => {
        if (e.key !== 'Tab') return;
        const focusables = visibleFocusables();
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || !container.contains(active)) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (active === last || !container.contains(active)) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    // Listen on document, not the container — if focus somehow ends up
    // outside the overlay while it's open (e.g. a control got removed),
    // the next Tab still pulls it back in instead of walking the page behind.
    document.addEventListener('keydown', onKeydown, true);

    const target = initialFocus || visibleFocusables()[0];
    target?.focus();

    return function release() {
        document.removeEventListener('keydown', onKeydown, true);
        if (previouslyFocused && typeof previouslyFocused.focus === 'function'
            && document.contains(previouslyFocused)) {
            previouslyFocused.focus();
        }
    };
}
