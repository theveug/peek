// Pure logic test (no browser) for the receive-side file-transfer authorization
// gates in PeerManager._handleDataChannelMessage — the 2026-07-13 security-sweep
// fixes:
//   1. consent gate: a file-start for an offer the local user hasn't accepted is
//      ignored — the sender waiting for file-accept is honor-system, a modified
//      client can skip straight to file-start, which used to deliver the file
//      with the Accept/Decline card still on screen,
//   2. sender binding: a file-start (or file-end) from a peer other than the one
//      who made the offer is ignored — sendFileToAll hands the same fileId to
//      every recipient, so in a 3+ room another peer knows it and could hijack
//      the slot with substituted content under the real sender's filename,
//   3. declined offers stay dead: file-start after a decline is ignored,
//   4. filename sanitization: path segments ("../../evil.png", "..\\evil.png")
//      are reduced to a basename before the allowlist check or any consumer
//      (zip-slip guard for the recap/download-all export), and a non-string
//      fileName is auto-declined instead of throwing.
//
// Run with: npm run test:file-authz

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

/** Minimal UIController mock recording the calls the file pipeline makes. */
function makeUi() {
    const calls = { addFileMessage: [], addSystemMessage: [], showFileOffer: [], ensureFileGroup: [], updateFileProgress: [] };
    return {
        calls,
        isBlocked: () => false,
        _peerNickname: (id) => `peer-${id}`,
        ensureFileGroup: (...a) => calls.ensureFileGroup.push(a),
        addSystemMessage: (...a) => calls.addSystemMessage.push(a),
        showFileOffer: (...a) => calls.showFileOffer.push(a),
        updateFileProgress: (...a) => calls.updateFileProgress.push(a),
        removeFileProgress: () => {},
        addFileMessage: (...a) => calls.addFileMessage.push(a),
    };
}

function makePm() {
    const ui = makeUi();
    const pm = new PeerManager(null, ui);
    return { pm, ui };
}

const offerMsg = (fileId, over = {}) => JSON.stringify({
    type: 'file-offer', fileId, fileName: 'photo.png', fileSize: 1000, ...over,
});
const startMsg = (fileId) => JSON.stringify({ type: 'file-start', fileId, totalChunks: 1 });
const endMsg = (fileId) => JSON.stringify({ type: 'file-end', fileId });

(function testFileStartBeforeAcceptIsIgnored() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f1'));
    assert(ui.calls.showFileOffer.length === 1, 'offer renders the Accept/Decline prompt (auto-accept off)');

    pm._handleDataChannelMessage('A', startMsg('f1'));
    assert(!pm.incomingTransfers['f1'], 'file-start before the user accepts registers NO transfer (consent bypass closed)');

    pm._handleDataChannelMessage('A', new ArrayBuffer(500));
    pm._handleDataChannelMessage('A', endMsg('f1'));
    assert(ui.calls.addFileMessage.length === 0, 'chunks + file-end for an unaccepted offer deliver nothing');
    assert(pm._offeredFiles['f1'], 'the pending offer itself is still intact (user can still accept normally)');
})();

(function testAcceptedOfferDeliversNormally() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f2'));
    const onAccept = ui.calls.showFileOffer[0][4]; // (nickname, fileId, fileName, size, onAccept, onDecline, groupId)
    onAccept(); // the real accept wiring, exactly as the UI button invokes it

    pm._handleDataChannelMessage('A', startMsg('f2'));
    assert(!!pm.incomingTransfers['f2'], 'file-start after a real accept registers the transfer');

    pm._handleDataChannelMessage('A', new ArrayBuffer(1000));
    pm._handleDataChannelMessage('A', endMsg('f2'));
    assert(ui.calls.addFileMessage.length === 1, 'accepted transfer delivers via addFileMessage');
    assert(!pm.incomingTransfers['f2'], 'delivered transfer is cleaned up');
})();

(function testAutoAcceptStillWorks() {
    localStorage.setItem('autoAcceptFiles', '1');
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f3'));
    assert(ui.calls.showFileOffer.length === 0, 'auto-accept skips the prompt');
    pm._handleDataChannelMessage('A', startMsg('f3'));
    assert(!!pm.incomingTransfers['f3'], 'auto-accepted offer allows file-start (accepted flag set by the auto path)');
    localStorage.removeItem('autoAcceptFiles');
})();

(function testCrossPeerFileStartHijackIsIgnored() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f4'));
    ui.calls.showFileOffer[0][4](); // accept A's offer

    // Peer B knows the fileId (same id goes to every recipient of a broadcast
    // send) and tries to claim the accepted slot.
    pm._handleDataChannelMessage('B', startMsg('f4'));
    assert(!pm.incomingTransfers['f4'], "another peer's file-start for A's fileId is ignored");
    assert(pm._offeredFiles['f4'], "A's accepted offer survives the hijack attempt");

    // A's own transfer then proceeds untouched.
    pm._handleDataChannelMessage('A', startMsg('f4'));
    assert(pm.incomingTransfers['f4']?.from === 'A', "A's own file-start still works after the attempt");
})();

(function testCrossPeerFileEndIsIgnored() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f5'));
    ui.calls.showFileOffer[0][4]();
    pm._handleDataChannelMessage('A', startMsg('f5'));
    pm._handleDataChannelMessage('A', new ArrayBuffer(400));

    pm._handleDataChannelMessage('B', endMsg('f5'));
    assert(ui.calls.addFileMessage.length === 0, "another peer's forged file-end doesn't finalize A's in-flight transfer");
    assert(!!pm.incomingTransfers['f5'], 'the in-flight transfer survives the forged file-end');

    pm._handleDataChannelMessage('A', endMsg('f5'));
    assert(ui.calls.addFileMessage.length === 1, "A's real file-end still delivers");
})();

(function testDeclinedOfferStaysDead() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f6'));
    ui.calls.showFileOffer[0][5](); // decline
    pm._handleDataChannelMessage('A', startMsg('f6'));
    assert(!pm.incomingTransfers['f6'], 'file-start after a decline is ignored');
})();

(function testFilenamePathSegmentsAreStripped() {
    const { pm } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f7', { fileName: '../../evil.png' }));
    assert(pm._offeredFiles['f7']?.fileName === 'evil.png', 'forward-slash traversal reduces to a basename (zip-slip guard)');

    pm._handleDataChannelMessage('A', offerMsg('f8', { fileName: '..\\..\\evil2.png' }));
    assert(pm._offeredFiles['f8']?.fileName === 'evil2.png', 'backslash traversal reduces to a basename too');

    pm._handleDataChannelMessage('A', offerMsg('f9', { fileName: 'files/../nested/ok.png' }));
    assert(pm._offeredFiles['f9']?.fileName === 'ok.png', 'embedded path segments are stripped');
})();

(function testMalformedFileNameIsDeclinedNotThrown() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', offerMsg('f10', { fileName: 12345 }));
    assert(!pm._offeredFiles['f10'], 'a non-string fileName is auto-declined (used to throw in _isFileAllowed)');
    assert(ui.calls.addSystemMessage.some(a => String(a[0]).startsWith('Blocked incoming file')), 'the decline surfaces as a blocked-file system message');

    pm._handleDataChannelMessage('A', offerMsg('f11', { fileName: '....' }));
    assert(!pm._offeredFiles['f11'], 'a dots-only name sanitizes to empty and is declined');
})();

console.log('\nAll file-transfer authorization tests passed.');
