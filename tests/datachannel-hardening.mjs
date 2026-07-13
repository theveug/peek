// Pure logic test (no browser) for the receive-side validation of
// peer-controlled data-channel and signal payloads — the 2026-07-13
// security-sweep hardening:
//   1. pin/unpin authorization: only a sender our client independently knows
//      to be a moderator (ui.moderatorPeerIds, synced from the server's
//      moderator-update/init) can pin — a non-moderator's pin-message is
//      ignored, as is any malformed messageId,
//   2. poll-create shape validation: non-array options (used to throw inside
//      addPollMessage), absurd option counts, and non-string fields are all
//      rejected; oversized question/option strings are capped,
//   3. reaction validation: non-string or oversized "emoji" strings rejected,
//   4. chat text must be a non-empty string,
//   5. handleSignal survives a missing/null/primitive payload (used to throw
//      on the first property read) and caps a peer-declared nickname at 60.
//
// Run with: npm run test:datachannel
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

function makeUi() {
    const calls = { applyPin: [], addPollMessage: [], addReaction: [], addChatMessage: [], updateParticipantNickname: [], updateParticipantAvatar: [], updateParticipantStatus: [] };
    return {
        calls,
        moderatorPeerIds: new Set(),
        isBlocked: () => false,
        _peerNickname: (id) => `peer-${id}`,
        applyPin: (...a) => calls.applyPin.push(a),
        addPollMessage: (...a) => calls.addPollMessage.push(a),
        addReaction: (...a) => calls.addReaction.push(a),
        addChatMessage: (...a) => calls.addChatMessage.push(a),
        updateTypingIndicator: () => {},
        updateParticipantNickname: (...a) => calls.updateParticipantNickname.push(a),
        updateParticipantAvatar: (...a) => calls.updateParticipantAvatar.push(a),
        updateParticipantStatus: (...a) => calls.updateParticipantStatus.push(a),
    };
}

function makePm() {
    const ui = makeUi();
    const pm = new PeerManager(null, ui);
    return { pm, ui };
}

const dcMsg = (obj) => JSON.stringify(obj);

// --- pin/unpin authorization ---

(function testPinRequiresModerator() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('mallory', dcMsg({ type: 'pin-message', messageId: 'm1' }));
    assert(ui.calls.applyPin.length === 0, "a non-moderator's pin-message is ignored");

    ui.moderatorPeerIds.add('mod');
    pm._handleDataChannelMessage('mod', dcMsg({ type: 'pin-message', messageId: 'm1' }));
    assert(ui.calls.applyPin.length === 1 && ui.calls.applyPin[0][1] === true, "a real moderator's pin applies");

    pm._handleDataChannelMessage('mod', dcMsg({ type: 'unpin-message', messageId: 'm1' }));
    assert(ui.calls.applyPin.length === 2 && ui.calls.applyPin[1][1] === false, "a real moderator's unpin applies");

    pm._handleDataChannelMessage('mallory', dcMsg({ type: 'unpin-message', messageId: 'm1' }));
    assert(ui.calls.applyPin.length === 2, "a non-moderator's unpin is ignored");

    pm._handleDataChannelMessage('mod', dcMsg({ type: 'pin-message', messageId: 42 }));
    assert(ui.calls.applyPin.length === 2, 'a non-string messageId is ignored even from a moderator');
})();

// --- poll-create shape validation ---

(function testPollCreateValidation() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 'p1', question: 'Q?', options: 'not-an-array' }));
    assert(ui.calls.addPollMessage.length === 0, 'non-array options rejected (used to throw in addPollMessage)');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 'p1', question: 'Q?', options: ['only-one'] }));
    assert(ui.calls.addPollMessage.length === 0, 'a single-option poll is rejected');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 'p1', question: 'Q?', options: Array.from({ length: 25 }, (_, i) => `o${i}`) }));
    assert(ui.calls.addPollMessage.length === 0, 'a 25-option poll is rejected (cap 20)');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 'p1', question: 'Q?', options: ['a', 42] }));
    assert(ui.calls.addPollMessage.length === 0, 'non-string option entries are rejected');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 42, question: 'Q?', options: ['a', 'b'] }));
    assert(ui.calls.addPollMessage.length === 0, 'a non-string pollId is rejected');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'poll-create', pollId: 'p2', question: 'x'.repeat(1000), options: ['a'.repeat(500), 'b'] }));
    assert(ui.calls.addPollMessage.length === 1, 'a well-formed poll goes through');
    const [, , question, options] = ui.calls.addPollMessage[0];
    assert(question.length === 300, 'oversized question is capped at 300');
    assert(options[0].length === 150, 'oversized option is capped at 150');
})();

// --- reaction validation ---

(function testReactionValidation() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', dcMsg({ type: 'reaction', messageId: 'm1', emoji: 42 }));
    assert(ui.calls.addReaction.length === 0, 'non-string emoji rejected');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'reaction', messageId: 'm1', emoji: 'x'.repeat(100) }));
    assert(ui.calls.addReaction.length === 0, 'a 100-char "emoji" is rejected (cap 32)');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'reaction', messageId: 42, emoji: '👍' }));
    assert(ui.calls.addReaction.length === 0, 'non-string messageId rejected');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'reaction', messageId: 'm1', emoji: '👨‍👩‍👧‍👦' }));
    assert(ui.calls.addReaction.length === 1, 'a long ZWJ-sequence emoji still fits under the cap');
})();

// --- chat text guard ---

(function testChatTextMustBeString() {
    const { pm, ui } = makePm();
    pm._handleDataChannelMessage('A', dcMsg({ type: 'chat', messageId: 'm1', text: 42 }));
    assert(ui.calls.addChatMessage.length === 0, 'non-string chat text rejected');
    assert(!pm._chatMessageOwners.has('m1'), 'rejected chat never registers message ownership');

    pm._handleDataChannelMessage('A', dcMsg({ type: 'chat', messageId: 'm1', text: 'hello' }));
    assert(ui.calls.addChatMessage.length === 1, 'normal chat goes through');
})();

// --- handleSignal payload hardening ---

await (async function testSignalPayloadHardening() {
    const { pm, ui } = makePm();
    // Each of these used to throw (unhandled rejection) on the payload.x read.
    await pm.handleSignal({ type: 'nickname-update', from: 'A', payload: null });
    await pm.handleSignal({ type: 'avatar-update', from: 'A' });
    await pm.handleSignal({ type: 'status-update', from: 'A', payload: 'junk-string' });
    assert(true, 'nickname/avatar/status updates with missing, null, or primitive payloads no longer throw');

    assert(ui.calls.updateParticipantAvatar.length === 0, 'a payload with no avatarDataUrl never reaches updateParticipantAvatar');

    await pm.handleSignal({ type: 'nickname-update', from: 'A', payload: { nickname: 'n'.repeat(500) } });
    const captured = ui.calls.updateParticipantNickname.find(a => a[1] && a[1].length > 0);
    assert(captured && captured[1].length === 60, 'a peer-declared nickname is capped at 60 on receive');

    await pm.handleSignal({ type: 'nickname-update', from: 'A', payload: { nickname: 12345 } });
    const last = ui.calls.updateParticipantNickname.at(-1);
    assert(last[1] === '', 'a non-string nickname is normalized to empty (ignored) instead of rendered');
})();

console.log('\nAll data-channel/signal hardening tests passed.');
