// --- public/client/markdownCodeBlocks.js ---
// Shared post-processing for a container already holding real marked-rendered
// markdown (fenced `<pre><code>` blocks and inline `<code>` spans) — hljs
// syntax highlighting, a declared-```lang label pill, a click-to-copy button
// on fenced blocks, and click-to-copy on inline code chips. Extracted from
// ChatUI.js's `_finalizeMarkdownBody()` (2026-09-09) when MessagesPanel.js
// needed the identical code-block treatment for DM messages (owner-reported:
// DMs should get the same composer features as room chat, code blocks
// included) — the mention/link-preview parts of that pipeline stay
// ChatUI-only, since a DM thread has no participant list to mention against
// and link previews were never built app-wide to begin with.
//
// Callers are expected to have already loaded `hljs` (a global, same as
// everywhere else in this app that syntax-highlights) before calling this.

/**
 * @param {HTMLElement} markdownEl the rendered `.chat-markdown` body element itself
 * @returns {void}
 */
export function finalizeCodeBlocks(markdownEl) {
    markdownEl.querySelectorAll('pre code').forEach((block) => {
        // Read the declared fence language before highlightElement runs —
        // hljs adds its own language-* class when it auto-detects, and only
        // the sender's explicit ```lang should get a label.
        const declaredLang = block.className.match(/language-([\w+#-]+)/)?.[1];

        hljs.highlightElement(block);

        const pre = block.parentElement;
        pre.style.position = 'relative';

        if (declaredLang) {
            const langLabel = document.createElement('span');
            langLabel.className = 'code-lang-label';
            langLabel.textContent = declaredLang;
            pre.appendChild(langLabel);
        }

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '\u{1F4CB}';
        copyBtn.dataset.tip = 'Copy code';
        copyBtn.className = 'copy-btn';

        copyBtn.addEventListener('click', () => {
            // marked always leaves a trailing \n inside the <code> element —
            // trim so pasting into a field doesn't drag a newline along.
            navigator.clipboard.writeText(block.textContent.trim()).then(() => {
                copyBtn.textContent = '✅';
                setTimeout(() => (copyBtn.textContent = '\u{1F4CB}'), 1500);
            });
        });

        pre.appendChild(copyBtn);
    });

    // Inline (single-backtick) code chips are click-to-copy — the chip itself
    // is the button, since an appended button would break inline text flow.
    markdownEl.querySelectorAll('code').forEach((code) => {
        if (code.closest('pre')) return;
        code.dataset.tip = 'Click to copy';
        code.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(code.textContent.trim()).then(() => {
                code.classList.add('inline-code-copied');
                setTimeout(() => code.classList.remove('inline-code-copied'), 1500);
            });
        });
    });
}
