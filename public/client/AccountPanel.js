// --- public/client/AccountPanel.js ---
// Login/register/logout (accounts Phase 1b) — wires the existing /api/auth/*
// routes (see AuthManager.js/authRoutes.js) into real UI, now living entirely
// in each page's identity area rather than as its own section of a Friends/
// Messages panel (2026-09-08, round 2 of the polish pass — round 1 had put
// a bare "sign in / sign out" tab inside SocialPanel.js's modal, which the
// owner correctly called out: with nothing else in it, that's not a section,
// it's an action, and it belongs where the app's existing identity/status
// affordances already live). See CLAUDE.md's "Accounts, identity-area
// redesign" Key Conventions entry for the fuller reasoning.
//
// Two independent UI surfaces, exactly one of which exists per page load:
// - Room: `#topbar-identity-menu` (built by index.html, wired by
//   TopbarIdentity.js for status/settings) already has a "you are this
//   person" dropdown — this file adds two more rows to it directly
//   (`#topbar-identity-signin` / `#topbar-identity-account-info`) without
//   TopbarIdentity.js needing to know anything changed, the same
//   low-coupling way that file's own status rows and Settings row coexist.
// - Lobby: no identity element exists at all, so this file self-builds a
//   small one (`_buildLobbyIdentityTrigger()`) — same self-building
//   precedent as RoomRail.js/SocialPanel.js, deliberately lighter than the
//   room's avatar/status pill since there's no call presence to show here.
//
// The actual login/register form is a small anchored popover (reusing the
// existing `.quick-settings-popover.topbar-popover` treatment every other
// topbar popover in this app already uses), inserted as a sibling inside
// whichever `.quick-status-dropdown`-style wrapper is relevant — the room's
// existing one, or the lobby's own new one — so it gets identical absolute
// positioning for free, no fixed-position JS math needed.
import { pullAndApplySettings } from './AccountSettingsSync.js';

export class AccountPanel {
    constructor() {
        this.mode = 'login'; // 'login' | 'register'
        this.popover = null;
        this._init();
    }

    async _init() {
        const trust = await fetch('/api/trust').then(r => r.json()).catch(() => null);
        if (!trust?.accounts) return; // nothing shown anywhere on this deployment

        const dropdown = this._wireRoomIdentityRows() || this._buildLobbyIdentityTrigger();
        if (!dropdown) return; // neither surface exists — shouldn't happen on either real page

        this._buildLoginPopover(dropdown);
        document.addEventListener('peek:force-logout', () => this.forceLoggedOut());

        await this._refreshSessionState();
    }

    // --- Room identity dropdown (#topbar-identity-menu, static in index.html) ---

    /** @returns {HTMLElement|null} the `.quick-status-dropdown` wrapper to hang
     * the login popover off, or null if this markup doesn't exist (lobby). */
    _wireRoomIdentityRows() {
        const signInRow = document.getElementById('topbar-identity-signin');
        const accountInfo = document.getElementById('topbar-identity-account-info');
        if (!signInRow || !accountInfo) return null;

        this._signInEl = signInRow;
        this._accountInfoEl = accountInfo;
        this._accountLabelEl = document.getElementById('topbar-identity-account-label');

        signInRow.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('topbar-identity-menu')?.classList.add('hidden');
            this._openPopover();
        });
        document.getElementById('topbar-identity-signout')?.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('topbar-identity-menu')?.classList.add('hidden');
            this._logout();
        });

        return signInRow.closest('.quick-status-dropdown');
    }

    // --- Lobby identity trigger (no equivalent markup exists — self-built) ---

    /** @returns {HTMLElement|null} the wrapper to hang the login popover off. */
    _buildLobbyIdentityTrigger() {
        const toolbar = document.querySelector('.lobby-toolbar');
        if (!toolbar) return null;

        const wrap = document.createElement('div');
        wrap.className = 'quick-status-dropdown';
        wrap.innerHTML = `
            <button type="button" id="lobby-account-button" class="lobby-account-btn" data-tip="Account">
                <span class="material-symbols-rounded" style="font-size:1.125rem;">person</span>
                <span id="lobby-account-label">Sign in</span>
            </button>
            <div id="lobby-account-menu" class="quick-status-menu hidden">
                <button type="button" id="lobby-account-signout" class="quick-status-option">
                    <span class="material-symbols-rounded" style="font-size:1rem;">logout</span>Sign out
                </button>
            </div>
        `;
        toolbar.appendChild(wrap);

        this._lobbyBtn = wrap.querySelector('#lobby-account-button');
        this._lobbyLabel = wrap.querySelector('#lobby-account-label');
        this._lobbyMenu = wrap.querySelector('#lobby-account-menu');

        this._lobbyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._loggedIn) this._lobbyMenu.classList.toggle('hidden');
            else this._openPopover();
        });
        wrap.querySelector('#lobby-account-signout').addEventListener('click', (e) => {
            e.stopPropagation();
            this._lobbyMenu.classList.add('hidden');
            this._logout();
        });
        document.addEventListener('click', (e) => {
            if (this._lobbyMenu.classList.contains('hidden')) return;
            if (wrap.contains(e.target)) return;
            this._lobbyMenu.classList.add('hidden');
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._lobbyMenu.classList.add('hidden');
        });

        return wrap;
    }

    // --- Login/register popover (shared shape, one instance, wherever it lives) ---

    _buildLoginPopover(parent) {
        const el = document.createElement('div');
        el.id = 'account-login-popover';
        el.className = 'quick-settings-popover topbar-popover hidden';
        el.innerHTML = `
            <div class="quick-settings-header" id="account-popover-title">Log in</div>
            <div class="settings-field">
                <div class="settings-label">Username</div>
                <input type="text" id="account-username" class="settings-text-input" autocomplete="username" />
            </div>
            <div class="settings-field">
                <div class="settings-label">Password</div>
                <input type="password" id="account-password" class="settings-text-input" autocomplete="current-password" />
            </div>
            <div class="settings-field hidden" id="account-confirm-field">
                <div class="settings-label">Confirm password</div>
                <input type="password" id="account-confirm-password" class="settings-text-input" autocomplete="new-password" />
            </div>
            <div id="account-error" class="lobby-error hidden"></div>
            <button type="button" id="account-submit" class="lobby-btn-primary" style="width:100%;">Log in</button>
            <p class="settings-section-subcopy" style="margin:0.75rem 0 0;text-align:center;">
                <a href="#" id="account-mode-toggle">Need an account? Register</a>
            </p>
        `;
        parent.appendChild(el);
        this.popover = el;

        this._wireModeToggle();
        this._wireSubmit();
        this._wireOutsideClick();
    }

    _openPopover() {
        this._applyMode();
        this.popover.classList.remove('hidden');
        document.getElementById('account-username')?.focus();
    }

    _closePopover() {
        this.popover.classList.add('hidden');
    }

    // Same document-level click/Escape idiom as InvitePopover.js. No
    // focusTrap: this is a small anchored popover, not a full-screen modal —
    // the same exemption InvitePopover.js already relies on (see CLAUDE.md's
    // "Modal focus traps" standing rule).
    _wireOutsideClick() {
        document.addEventListener('click', (e) => {
            if (this.popover.classList.contains('hidden')) return;
            if (this.popover.contains(e.target)) return;
            if (this._signInEl?.contains(e.target) || this._lobbyBtn?.contains(e.target)) return;
            this._closePopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.popover.classList.contains('hidden')) this._closePopover();
        });
    }

    _wireModeToggle() {
        const link = document.getElementById('account-mode-toggle');
        link?.addEventListener('click', (e) => {
            e.preventDefault();
            this.mode = this.mode === 'login' ? 'register' : 'login';
            this._applyMode();
        });
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

    // Not a real <form> element (plain divs, like every other quick-settings
    // popover in this app), so Enter doesn't submit for free — each input's
    // own keydown listener below is what makes Enter behave like a real form.
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
        // left behind — see _logout()'s matching clear below.
        localStorage.setItem('nickname', username);
        this._renderState({ username });
        this._closePopover();
        pullAndApplySettings();
    }

    async _logout() {
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        // Clears the nickname this account's login stamped on it above, so
        // the next person to use this browser (a different account, or no
        // account at all) doesn't inherit this account's name — falls back
        // to the app's existing 'Anonymous' default.
        localStorage.removeItem('nickname');
        this.mode = 'login';
        this._renderState(null);
    }

    /**
     * Bug fix (2026-09-07 real-usage audit), now triggered via a
     * `peek:force-logout` CustomEvent rather than a direct method call —
     * AccountPanel.js and SocialPanel.js are independently constructed by
     * lobby.js/App.js with no reference to each other (same decoupling as
     * `peek:account`/`peek:open-dm` elsewhere in this app), so
     * `presencePoll.js`/`messagesPoll.js`'s `onSessionExpired` callback
     * (wired in SocialPanel.js) dispatches this event on a real 401 instead
     * of calling a method on an instance it doesn't have.
     */
    forceLoggedOut() {
        this.mode = 'login';
        this._renderState(null);
    }

    async _refreshSessionState() {
        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._renderState(me);
        if (me) pullAndApplySettings();
    }

    _renderState(me) {
        const loggedIn = !!me;
        this._loggedIn = loggedIn;

        if (this._signInEl) {
            this._signInEl.classList.toggle('hidden', loggedIn);
            this._accountInfoEl.classList.toggle('hidden', !loggedIn);
            if (loggedIn) this._accountLabelEl.textContent = `Signed in as ${me.username}`;
        }
        if (this._lobbyBtn) {
            this._lobbyLabel.textContent = loggedIn ? me.username : 'Sign in';
            if (!loggedIn) this._lobbyMenu.classList.add('hidden');
        }
        if (!loggedIn) {
            document.getElementById('account-username').value = '';
            document.getElementById('account-password').value = '';
            const confirmField = document.getElementById('account-confirm-password');
            if (confirmField) confirmField.value = '';
        }

        // FriendsPanel.js/MessagesPanel.js/SocialPanel.js have no session
        // concept of their own (friends only make sense for a logged-in
        // identity) — this is the only signal they need.
        document.dispatchEvent(new CustomEvent('peek:account', { detail: { loggedIn } }));
    }
}
