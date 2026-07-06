// --- public/client/markdown-setup.js ---
// Classic script, loaded right after the self-hosted marked/DOMPurify/hljs
// bundles in index.html — was a tiny inline <script> until 2026-07-07,
// externalized so the Content-Security-Policy can be a strict `script-src
// 'self'` with no 'unsafe-inline'.
//
// Note: the old inline version also passed a `highlight` option here. That
// option was removed from marked in v5 (silently ignored by the unpinned
// CDN build we used to load), so it was dead code — actual syntax
// highlighting happens in ChatUI.addChatMessage(), which runs
// hljs.highlightElement() over each rendered code block *after*
// DOMPurify.sanitize(), and that path is unchanged.
marked.setOptions({
    breaks: true,
});
