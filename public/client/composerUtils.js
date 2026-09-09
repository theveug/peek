// --- public/client/composerUtils.js ---
// Small helpers shared by every chat-style composer in this app — the room
// composer (App.js) originally, MessagesPanel.js's DM composer added
// 2026-09-09 for feature parity with it (code blocks + an emoji picker,
// owner-reported: "can we not reuse the same input area as chat"). Extracted
// here once a second composer needed the identical mechanics, same
// "extract on second use" precedent as composerCaret.js.

/**
 * Inserts `text` at `el`'s current caret position (replacing any selection),
 * leaving the caret immediately after the inserted text.
 * @param {HTMLTextAreaElement|HTMLInputElement} el
 * @param {string} text
 * @returns {void}
 */
export function insertAtCaret(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
}

/**
 * Wires a "+" button to toggle its dropup menu open/closed — outside-click
 * and Escape both close it, and clicking any option inside it closes it too
 * (each option's own click handler, registered separately by the caller,
 * still runs). Multiple instances coexist safely — each only tracks its own
 * btn/menu pair, and the outside-click/Escape listeners are per-instance so
 * one composer's open menu doesn't close because of a click inside another.
 * @param {HTMLElement} btn
 * @param {HTMLElement} menu
 * @returns {void}
 */
/**
 * Grows `el` (a `<textarea>`) to fit its content, up to whatever CSS
 * max-height it already has (`.chat-composer-input`'s `max-height: 6em`) —
 * `overflow: auto` takes over from there, scrolling internally rather than
 * growing further. Call on every `input` event, and after any programmatic
 * insert (an emoji/code-fence pick) that can change the line count.
 * @param {HTMLTextAreaElement} el
 * @returns {void}
 */
export function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

/**
 * Discord-style: Enter inside an unclosed ``` fence should insert a newline
 * instead of sending, since a fenced code block is the one case where you
 * actually want multiple lines without reaching for Shift+Enter every time
 * (Shift+Enter always inserts a newline regardless — plain `<textarea>`
 * default behavior, not intercepted here or by either composer's own
 * keydown handler). Originally App.js-only; MessagesPanel.js's DM composer
 * needed the identical check once its own "Code block" +-menu option
 * (2026-09-09) made typing a real multi-line fence possible there too —
 * without it, every Enter mid-fence would send the message half-typed.
 * @param {string} text
 * @param {number} caretPos
 * @returns {boolean}
 */
export function isInsideOpenCodeFence(text, caretPos) {
    const fenceCount = (text.slice(0, caretPos).match(/```/g) || []).length;
    return fenceCount % 2 === 1;
}

export function wireComposerPlusMenu(btn, menu) {
    if (!btn || !menu) return;
    const close = () => menu.classList.add('hidden');
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    menu.querySelectorAll('button').forEach((option) => {
        option.addEventListener('click', close);
    });
    document.addEventListener('click', (e) => {
        if (menu.classList.contains('hidden')) return;
        if (menu.contains(e.target) || e.target === btn) return;
        close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) close();
    });
}
