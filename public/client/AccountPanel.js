// --- public/client/AccountPanel.js ---
// Lobby-only login/register popover (accounts Phase 1b) — wires the existing
// /api/auth/* routes (see AuthManager.js/authRoutes.js) into a real UI.
// Markup lives statically in lobby.html (public/lobby.html), same pattern
// InvitePopover.js uses (a fixed toolbar location, unlike RoomRail.js's
// self-built-into-body approach, which exists to handle mounting on
// multiple pages with different toolbar shapes — not needed here).
//
// #account-button starts hidden in the markup and is only revealed once
// /api/trust confirms this deployment actually has accounts turned on — the
// lobby has no WebSocket connection at all (unlike the room page), so this
// is the only way it can learn that. Never show a login button that 404s.
export class AccountPanel {
    constructor() {
        this.button = document.getElementById('account-button');
        this.popover = document.getElementById('account-popover');
        if (!this.button || !this.popover) return;

        this.mode = 'login'; // 'login' | 'register'
        this._init();
    }

    async _init() {
        const trust = await fetch('/api/trust').then(r => r.json()).catch(() => null);
        if (!trust?.accounts) return; // stays hidden — accounts aren't enabled on this deployment

        this.button.classList.remove('hidden');
        this._wireToggle();
        this._wireOutsideClick();
        this._wireModeToggle();
        this._wireSubmit();
        this._wireLogout();
        await this._refreshSessionState();
    }

    open() {
        this.popover.classList.remove('hidden');
    }

    close() {
        this.popover.classList.add('hidden');
    }

    _wireToggle() {
        this.button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.popover.classList.contains('hidden') ? this.open() : this.close();
        });
    }

    // Same document-level click/Escape idiom as InvitePopover.js. No
    // focusTrap: this is a small anchored popover, not a full-screen modal —
    // the same exemption InvitePopover already relies on (see CLAUDE.md's
    // "Modal focus traps" standing rule).
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

    _wireModeToggle() {
        const link = document.getElementById('account-mode-toggle');
        link?.addEventListener('click', (e) => {
            e.preventDefault();
            this.mode = this.mode === 'login' ? 'register' : 'login';
            this._applyMode();
        });
        this._applyMode();
    }

    _applyMode() {
        const isRegister = this.mode === 'register';
        document.getElementById('account-popover-title').textContent = isRegister ? 'Register' : 'Log in';
        document.getElementById('account-confirm-field').classList.toggle('hidden', !isRegister);
        document.getElementById('account-submit').textContent = isRegister ? 'Register' : 'Log in';
        document.getElementById('account-mode-toggle').textContent =
            isRegister ? 'Already have an account? Log in' : 'Need an account? Register';
        document.getElementById('account-error').classList.add('hidden');
    }

    _wireSubmit() {
        const submitBtn = document.getElementById('account-submit');
        submitBtn.addEventListener('click', async () => {
            const errorEl = document.getElementById('account-error');
            errorEl.classList.add('hidden');

            const username = document.getElementById('account-username').value;
            const password = document.getElementById('account-password').value;

            // No password-reset exists in Phase 1 — a mistyped password on
            // registration has no recovery path, so catching a typo here
            // client-side matters more than it usually would.
            if (this.mode === 'register') {
                const confirm = document.getElementById('account-confirm-password').value;
                if (password !== confirm) {
                    errorEl.textContent = 'Passwords do not match';
                    errorEl.classList.remove('hidden');
                    return;
                }
            }

            submitBtn.disabled = true;
            try {
                const endpoint = this.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                // No res.ok gate — same convention lobby.js's /api/validate-room
                // call already uses: parse the body, branch on an app-level field.
                const body = await res.json();
                if (body.error) {
                    errorEl.textContent = body.error;
                    errorEl.classList.remove('hidden');
                    return;
                }
                this._afterAuthSuccess(body);
            } catch {
                errorEl.textContent = 'Could not reach the server — try again';
                errorEl.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
            }
        });
    }

    _afterAuthSuccess({ username }) {
        // Convenience default, never destructive: only pre-fills an EMPTY
        // nickname — an existing chosen display name is never overwritten
        // by logging in. Nickname (per-room display name, SettingsPanel.js)
        // and account username (login identity) are deliberately kept
        // separate concepts, same split Discord draws between an account
        // and a per-server display name.
        if (!localStorage.getItem('nickname')) localStorage.setItem('nickname', username);
        this._renderState({ username });
        this.close();
    }

    _wireLogout() {
        document.getElementById('account-logout').addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
            this._renderState(null);
        });
    }

    async _refreshSessionState() {
        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._renderState(me);
    }

    _renderState(me) {
        const loggedIn = !!me;
        document.getElementById('account-form-view').classList.toggle('hidden', loggedIn);
        document.getElementById('account-logged-in-view').classList.toggle('hidden', !loggedIn);
        if (loggedIn) {
            document.getElementById('account-logged-in-as').textContent = `Logged in as ${me.username}`;
        } else {
            document.getElementById('account-username').value = '';
            document.getElementById('account-password').value = '';
            const confirmField = document.getElementById('account-confirm-password');
            if (confirmField) confirmField.value = '';
        }
    }
}
