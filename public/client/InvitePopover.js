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

        const { subject, body } = this._buildEmailContent(link);

        const emailLink = document.getElementById('invite-email-link');
        if (emailLink) emailLink.href = this._buildMailtoHref(subject, body);

        const templateField = document.getElementById('invite-email-template');
        if (templateField) templateField.value = `Subject: ${subject}\n\n${body}`;

        this.popover.classList.remove('hidden');
    }

    // sessionStorage['roomPassword'] (not this.roomCode/this constructor) is
    // the same flat per-tab key App.js already reads/writes for joining —
    // read fresh here rather than cached at construction time, since it can
    // be set *after* the popover is built (entering a password to join).
    // Shared by both the mailto link and the plain-text template field below
    // it (for anyone without a mail client configured to catch mailto:) so
    // the two can never drift out of sync with each other.
    _buildEmailContent(link) {
        const password = sessionStorage.getItem('roomPassword');
        const subject = 'Join me on Peek';
        let body = `Hey,\n\nJoin me for a call on Peek — just click the link below, no account or install needed:\n${link}\n\nRoom code: ${this.roomCode}`;
        if (password) body += `\nPassword: ${password}`;
        body += '\n\nSee you there!';
        return { subject, body };
    }

    _buildMailtoHref(subject, body) {
        return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
        document.getElementById('invite-copy-email-template')?.addEventListener('click', () => {
            const field = document.getElementById('invite-email-template');
            if (field) navigator.clipboard.writeText(field.value);
            this.ui.showToast('Email template copied');
        });
    }
}
