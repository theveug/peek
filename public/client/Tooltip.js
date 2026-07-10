/**
 * Instant app-styled tooltips replacing native `title` attributes, which have
 * a fixed ~1s OS-controlled delay and can't be styled. Put the text in a
 * `data-tip` attribute (plus optional `data-tip-pos="top|bottom|left|right"`,
 * default "top", auto-flipped when there's no room at a viewport edge) and
 * call initTooltips() once per page. Styles live in tailwind.css's
 * "Tooltips" section (`.app-tooltip`).
 *
 * One pair of document-level delegated listeners covers every current and
 * future `[data-tip]` element, so dynamically built controls (participant
 * cards, chat hover bars, saved-room rows) need no extra wiring. A
 * MutationObserver does two jobs: mirrors each `data-tip` into `aria-label`
 * (the `title` attributes this replaces were the accessible name for these
 * mostly icon-only controls), and live-updates the open bubble when the
 * hovered control's tip changes under the pointer (e.g. Block → Unblock
 * right after a click). Mouse/pen hover only — no tap-tooltips on touch.
 */

const SHOW_DELAY_MS = 100;
const GAP_PX = 6;
const EDGE_PX = 4;

let bubble = null;
let currentTarget = null;
let showTimer = 0;

function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'app-tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.style.display = 'none';
    document.body.appendChild(bubble);
    return bubble;
}

/** Positions the bubble next to target, flipping/clamping at viewport edges. */
function position(target) {
    const r = target.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    let pos = target.getAttribute('data-tip-pos') || 'top';

    if (pos === 'top' && r.top - b.height - GAP_PX < EDGE_PX) pos = 'bottom';
    else if (pos === 'bottom' && r.bottom + b.height + GAP_PX > innerHeight - EDGE_PX) pos = 'top';
    else if (pos === 'left' && r.left - b.width - GAP_PX < EDGE_PX) pos = 'right';
    else if (pos === 'right' && r.right + b.width + GAP_PX > innerWidth - EDGE_PX) pos = 'left';

    let top, left;
    switch (pos) {
        case 'bottom': top = r.bottom + GAP_PX; left = r.left + r.width / 2 - b.width / 2; break;
        case 'left':   top = r.top + r.height / 2 - b.height / 2; left = r.left - b.width - GAP_PX; break;
        case 'right':  top = r.top + r.height / 2 - b.height / 2; left = r.right + GAP_PX; break;
        default:       top = r.top - b.height - GAP_PX; left = r.left + r.width / 2 - b.width / 2;
    }
    bubble.style.top = `${Math.max(EDGE_PX, Math.min(top, innerHeight - b.height - EDGE_PX))}px`;
    bubble.style.left = `${Math.max(EDGE_PX, Math.min(left, innerWidth - b.width - EDGE_PX))}px`;
}

function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    ensureBubble();
    currentTarget = target;
    bubble.textContent = text;
    bubble.style.display = '';
    position(target);
}

function hide() {
    clearTimeout(showTimer);
    showTimer = 0;
    currentTarget = null;
    if (bubble) bubble.style.display = 'none';
}

function mirrorAriaLabel(el) {
    const text = el.getAttribute('data-tip');
    if (text) el.setAttribute('aria-label', text);
}

let initialized = false;

/** Wires the delegated listeners + observer. Safe to call more than once. */
export function initTooltips() {
    if (initialized) return;
    initialized = true;

    document.addEventListener('pointerover', (e) => {
        if (e.pointerType === 'touch') return;
        const target = e.target.closest?.('[data-tip]');
        if (!target || target === currentTarget) return;
        clearTimeout(showTimer);
        showTimer = setTimeout(() => show(target), SHOW_DELAY_MS);
    });

    document.addEventListener('pointerout', (e) => {
        const target = e.target.closest?.('[data-tip]');
        if (target && !(e.relatedTarget && target.contains(e.relatedTarget))) hide();
    });

    // Keyboard accessibility: focused controls show their tip immediately.
    document.addEventListener('focusin', (e) => {
        const target = e.target.closest?.('[data-tip]');
        if (target) show(target);
    });
    document.addEventListener('focusout', hide);

    // The bubble is position:fixed, so any scroll shifts its anchor under it.
    window.addEventListener('scroll', hide, true);

    document.querySelectorAll('[data-tip]').forEach(mirrorAriaLabel);
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'attributes') {
                mirrorAriaLabel(m.target);
                if (m.target === currentTarget) show(currentTarget);
            } else {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('[data-tip]')) mirrorAriaLabel(node);
                    node.querySelectorAll?.('[data-tip]').forEach(mirrorAriaLabel);
                }
            }
        }
        // The hovered control may have been removed outright (attachment chip
        // ×, saved-room Remove) — don't leave its bubble orphaned on screen.
        if (currentTarget && !currentTarget.isConnected) hide();
    });
    observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-tip'],
    });
}
