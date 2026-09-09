// --- public/client/composerUtils.js ---
// Small helpers shared by every chat-style composer in this app — the room
// composer (App.js) originally, MessagesPanel.js's DM composer added
// 2026-09-09 for feature parity with it (code blocks + an emoji picker,
// owner-reported: "can we not reuse the same input area as chat"). Extracted
// here once a second composer needed the identical mechanics, same
// "extract on second use" precedent as composerCaret.js.
//
// wireComposerExtras()/wireEnterToSend() (2026-09-10) go a step further: they
// own the actual wiring, not just the pieces it's built from — App.js and
// MessagesPanel.js each used to hand-duplicate the "+" menu's code-block/
// emoji click handlers and the code-fence-aware Enter-to-send keydown
// listener almost verbatim (owner-reported the DM composer "wasn't quite
// working right" after being cloned by hand; a real shared call site is
// what keeps the two from drifting apart again as chat composer features
// grow). App.js's file-attach/poll buttons stay wired separately by App.js
// itself — those have no DM equivalent — wireComposerPlusMenu() (below)
// already closes the menu generically on a click on *any* button inside it,
// so mixing shared and composer-specific buttons in the same menu needs no
// special-casing here.
import { openEmojiPicker } from './EmojiPicker.js';
import { openCodeBlockPicker } from './CodeBlockPicker.js';

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

/**
 * Wires a composer's "Code block" +-menu option: opens `CodeBlockPicker.js`'s
 * language picker anchored at `anchorEl` (the persistent "+" trigger, not
 * `btn` itself — see the anchor-to-the-trigger note in the callers this
 * replaced) and inserts a ` ```lang ` fence at the caret, wrapping any
 * current selection. Removes `btn` entirely on a page with no `hljs` global
 * (the lobby never loads it) — a fence there would just be literal
 * backticks with nothing to highlight them.
 * @param {HTMLElement|null} btn
 * @param {HTMLElement} anchorEl
 * @param {HTMLTextAreaElement} input
 * @returns {void}
 */
export function wireCodeBlockButton(btn, anchorEl, input) {
    if (!btn) return;
    if (typeof hljs === 'undefined') {
        btn.remove();
        return;
    }
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openCodeBlockPicker(anchorEl, (lang) => {
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? input.value.length;
            const selected = input.value.slice(start, end);
            const openFence = '```' + lang + '\n';
            insertAtCaret(input, openFence + selected + '\n```');
            if (!selected) {
                // Nothing was selected to wrap — drop the caret on the blank
                // line between the fences instead of after the closing one,
                // so typing the code itself needs no extra navigation.
                const caret = start + openFence.length;
                input.selectionStart = input.selectionEnd = caret;
            }
            // insertAtCaret mutates .value directly (no real 'input' event),
            // so a plain input-event auto-grow listener never sees this.
            autoGrowTextarea(input);
            input.focus();
        });
    });
}

/**
 * Wires a composer's "Add emoji" +-menu option: opens `EmojiPicker.js`
 * anchored at `anchorEl` and inserts the picked emoji at the caret.
 * @param {HTMLElement|null} btn
 * @param {HTMLElement} anchorEl
 * @param {HTMLTextAreaElement} input
 * @returns {void}
 */
export function wireEmojiButton(btn, anchorEl, input) {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEmojiPicker(anchorEl, (emoji) => {
            insertAtCaret(input, emoji);
            autoGrowTextarea(input);
            input.focus();
        });
    });
}

/**
 * The full "+" composer menu wiring shared by the room composer (App.js) and
 * MessagesPanel.js's DM composer: open/close (`wireComposerPlusMenu`) plus
 * the code-block and emoji options, both anchored back at `plusBtn` (not
 * `codeBlockBtn`/`emojiBtn` themselves — by the time either option's click
 * handler runs, the menu's own close-on-option-click listener has already
 * hidden it, which would zero out that button's own
 * `getBoundingClientRect()`). `codeBlockBtn`/`emojiBtn` are optional so a
 * composer without one (there isn't one today, but a future minimal
 * composer might omit either) can just not pass it.
 * @param {{plusBtn: HTMLElement, plusMenu: HTMLElement, codeBlockBtn?: HTMLElement|null, emojiBtn?: HTMLElement|null, input: HTMLTextAreaElement}} opts
 * @returns {void}
 */
export function wireComposerExtras({ plusBtn, plusMenu, codeBlockBtn, emojiBtn, input }) {
    wireComposerPlusMenu(plusBtn, plusMenu);
    wireCodeBlockButton(codeBlockBtn, plusBtn, input);
    wireEmojiButton(emojiBtn, plusBtn, input);
}

/**
 * Discord-style Enter-to-send: plain Enter sends, Shift+Enter always inserts
 * a newline (default textarea behavior, left alone), and Enter inside an
 * unclosed ``` fence also inserts a newline rather than sending (see
 * `isInsideOpenCodeFence` above) — shared by the room composer and
 * MessagesPanel.js's DM composer so both composers' send-on-Enter rules stay
 * identical as they evolve, rather than each keeping its own hand-copy.
 * @param {HTMLTextAreaElement} input
 * @param {() => void} onSend
 * @returns {void}
 */
export function wireEnterToSend(input, onSend) {
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (isInsideOpenCodeFence(input.value, input.selectionStart)) return;
        e.preventDefault();
        onSend();
    });
}
