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
import { pullAndApplySettings } from './AccountSettingsSync.js';

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

    // Not a real <form> element (this popover's markup is plain divs, like
    // every other quick-settings popover in this app), so Enter doesn't
    // submit for free — each input's own keydown listener below is what
    // makes Enter behave the way a real form would. Extracted to a named
    // function (rather than left inline on the button's click handler) so
    // both the click and every keydown listener can call the exact same
    // path, same pattern FriendsPanel.js/MessagesPanel.js already use for
    // their own single-input composers.
    _wireSubmit() {
        const submitBtn = document.getElementById('account-submit');

        const submit = async () => {
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
        };

        submitBtn.addEventListener('click', submit);
        for (const id of ['account-username', 'account-password', 'account-confirm-password']) {
            document.getElementById(id).addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
            });
        }
    }

    _afterAuthSuccess({ username }) {
        // Unconditional, not just a fallback for an empty field: a shared
        // machine with several people each logging into their own account
        // needs the room-display nickname to actually follow whoever's
        // logged in, not whatever the last person who used this browser
        // left behind — see _wireLogout()'s matching clear below.
        localStorage.setItem('nickname', username);
        this._renderState({ username });
        this.close();
        pullAndApplySettings();
    }

    _wireLogout() {
        document.getElementById('account-logout').addEventListener('click', async () => {
            await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
            // Clears the nickname this account's login stamped on it above,
            // so the next person to use this browser (a different account,
            // or no account at all) doesn't inherit this account's name —
            // falls back to the app's existing 'Anonymous' default.
            localStorage.removeItem('nickname');
            // Reset to 'login' mode — without this, logging out while the
            // popover happened to be in 'register' mode (e.g. right after
            // registering) left it stuck there: still showing the confirm-
            // password field, still validating a same-page-session re-login
            // attempt as a registration (found while testing Enter-to-submit,
            // 2026-09-07 — a fresh page load was never affected, only a
            // logout followed by a same-session re-login with no reload
            // in between).
            this.mode = 'login';
            this._applyMode();
            this._renderState(null);
        });
    }

    async _refreshSessionState() {
        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._renderState(me);
        if (me) pullAndApplySettings();
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
        // Accounts Phase 2: FriendsPanel.js has no session concept of its own
        // (friends only makes sense for a logged-in identity) — this is the
        // only signal it needs to show/hide its own button.
        document.dispatchEvent(new CustomEvent('peek:account', { detail: { loggedIn } }));
    }
}
