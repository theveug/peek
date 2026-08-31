/**
 * Shared caret-pixel-position math for the chat composer's caret-anchored
 * popovers (`MentionAutocomplete.js`'s `@`, `EmojiAutocomplete.js`'s `:`) —
 * extracted 2026-08-31 when the second one needed the exact same trick
 * rather than a copy-pasted duplicate.
 *
 * A `<textarea>` has no API of its own for "pixel coords of the caret" —
 * `caretRect()` uses the standard hidden "mirror div" technique: an
 * off-screen div styled to match the textarea's text metrics (font,
 * padding, border, wrapping) holds the text up to the caret plus a marker
 * span; the marker's rect within that div is the caret's rect within the
 * textarea. Both callers share one lazily-created mirror element — it's
 * fully overwritten and re-measured on every call, so there's no shared
 * mutable state to worry about between them.
 */

// Only properties that affect text layout/wrapping need mirroring — colors
// and backgrounds are irrelevant since the mirror is never actually shown.
const MIRRORED_PROPS = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
    'letterSpacing', 'textTransform', 'wordSpacing', 'tabSize',
];

let mirrorEl = null;
function ensureMirror() {
    if (mirrorEl) return mirrorEl;
    mirrorEl = document.createElement('div');
    const s = mirrorEl.style;
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.top = '0';
    s.left = '-9999px';
    s.whiteSpace = 'pre-wrap';
    s.wordWrap = 'break-word';
    s.overflowWrap = 'break-word';
    s.borderStyle = 'solid';
    s.borderColor = 'transparent';
    document.body.appendChild(mirrorEl);
    return mirrorEl;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {{left: number, bottom: number}} viewport-relative coords just below the caret.
 */
export function caretRect(textarea) {
    const mirror = ensureMirror();
    const computed = getComputedStyle(textarea);
    MIRRORED_PROPS.forEach((p) => { mirror.style[p] = computed[p]; });
    mirror.style.width = `${textarea.clientWidth}px`;

    mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
    const marker = document.createElement('span');
    marker.textContent = '​'; // zero-width — gives an empty/trailing line real height to measure
    mirror.appendChild(marker);

    const taRect = textarea.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();

    return {
        left: taRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft,
        bottom: taRect.top + (markerRect.bottom - mirrorRect.top) - textarea.scrollTop,
    };
}
