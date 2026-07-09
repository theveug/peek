// --- public/client/InvitePopover.js ---
// Top-bar Invite button + popover: room code and a direct link, each with a
// Copy button. Replaces the old #share-button, which just silently copied
// the current URL to the clipboard with no feedback and no room code shown.
export class InvitePopover {
    constructor({ ui, roomCode }) {
        this.ui = ui;
        this.roomCode = roomCode;

        this.button = document.getElementById('invite-button');
        this.popover = document.getElementById('invite-popover');
        if (!this.button || !this.popover) return;

        this._wireToggle();
        this._wireCopyButtons();
        this._wireOutsideClick();
    }

    open() {
        const title = document.getElementById('invite-popover-title');
        if (title) title.textContent = `Invite to ${this.ui.roomName || 'this room'}`;

        const codeField = document.getElementById('invite-code-field');
        if (codeField) codeField.value = this.roomCode;

        const linkField = document.getElementById('invite-link-field');
        const link = `${location.origin}/${this.roomCode}`;
        if (linkField) linkField.value = link;

        this._renderQrCode(link);

        this.popover.classList.remove('hidden');
    }

    // qrcode-generator (public/assets/vendor/qrcode-generator.min.js) — pure
    // client-side, no server round-trip, matches the offline-first rule.
    // typeNumber 0 = auto-pick the smallest QR version that fits the data.
    _renderQrCode(text) {
        const container = document.getElementById('invite-qr-code');
        if (!container || typeof qrcode !== 'function') return;
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        container.innerHTML = qr.createSvgTag({ scalable: true });
    }

    close() {
        this.popover.classList.add('hidden');
    }

    _wireToggle() {
        this.button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.popover.classList.contains('hidden')) this.open();
            else this.close();
        });
    }

    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            if (this.popover.classList.contains('hidden')) return;
            if (this.popover.contains(e.target) || e.target === this.button) return;
            this.close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.popover.classList.contains('hidden')) this.close();
        });
    }

    _wireCopyButtons() {
        document.getElementById('invite-copy-code')?.addEventListener('click', () => {
            navigator.clipboard.writeText(this.roomCode);
            this.ui.showToast('Room code copied');
        });
        document.getElementById('invite-copy-link')?.addEventListener('click', () => {
            navigator.clipboard.writeText(`${location.origin}/${this.roomCode}`);
            this.ui.showToast('Invite link copied');
        });
    }
}
