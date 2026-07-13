// Pure logic test (no browser) for PeerManager's avatar-update allowlist —
// persisting the one-off forged-peer verification done when custom avatars
// shipped (2026-07-12) as a real regression test. The receive side must
// independently distrust any peer-declared avatarDataUrl (a modified client
// can skip the canvas re-encode entirely):
//   - only data:image/(webp|jpeg|png);base64 with a pure base64 body passes,
//   - '' passes (the "avatar removed" signal),
//   - svg+xml / text/html / javascript: / oversized / non-string payloads
//     are all dropped outright — never sanitized-and-used,
//   - the allowlist is format-based, not sender-based: a well-formed payload
//     from any peer is accepted.
//
// Run with: npm run test:avatar

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
};

const { PeerManager } = await import('../public/client/PeerManager.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function makePm() {
    const calls = [];
    const ui = {
        updateParticipantAvatar: (...a) => calls.push(a),
    };
    const pm = new PeerManager(null, ui);
    return { pm, calls };
}

async function sendAvatar(pm, value) {
    await pm.handleSignal({ type: 'avatar-update', from: 'A', payload: { avatarDataUrl: value } });
}

await (async function testValidFormatsAccepted() {
    const { pm, calls } = makePm();
    await sendAvatar(pm, 'data:image/webp;base64,UklGRgAAAABXRUJQ');
    await sendAvatar(pm, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    await sendAvatar(pm, 'data:image/png;base64,iVBORw0KGgo=');
    assert(calls.length === 3, 'well-formed webp/jpeg/png data URLs are accepted (format-based, not sender-based)');

    await sendAvatar(pm, '');
    assert(calls.length === 4 && calls[3][1] === '', "'' (avatar removed) is accepted");
})();

await (async function testDangerousPayloadsDropped() {
    const { pm, calls } = makePm();
    await sendAvatar(pm, 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+');
    assert(calls.length === 0, 'svg+xml is dropped (scriptable format)');

    await sendAvatar(pm, 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==');
    assert(calls.length === 0, 'text/html is dropped');

    await sendAvatar(pm, 'javascript:alert(1)');
    assert(calls.length === 0, 'javascript: URLs are dropped');

    await sendAvatar(pm, 'data:image/png;base64,abc"onerror="alert(1)');
    assert(calls.length === 0, 'attribute-breakout characters fail the base64-alphabet check');

    await sendAvatar(pm, 'data:image/png;base64,' + 'A'.repeat(50000));
    assert(calls.length === 0, 'an oversized payload (>40k chars) is dropped');

    await sendAvatar(pm, 12345);
    await sendAvatar(pm, { evil: true });
    await sendAvatar(pm, null);
    assert(calls.length === 0, 'non-string payloads are dropped without throwing');

    await sendAvatar(pm, 'data:image/png;base64,'); // empty body
    assert(calls.length === 0, 'an empty base64 body fails the pattern (requires at least one char)');
})();

console.log('\nAll avatar-validation tests passed.');
