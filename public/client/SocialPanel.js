// --- public/client/SocialPanel.js ---
// A self-building Friends & Messages drawer, reachable from both the lobby
// AND an active room — same "build the DOM in JS, don't duplicate markup
// across index.html/lobby.html" precedent as SettingsPanel.js's
// _buildModal()/RoomRail.js's own header comment.
//
// Owner-reported gap this closes: DMs only existed on the lobby page, so two
// friends already in a call together had no way to message each other
// without leaving the room. Deliberately a right-side drawer overlay (like
// Settings, but visually its own thing — see _buildModal()'s comment), not
// a Discord-style dedicated DM view/navigation — the room stays the main
// view, this just pops on top of it without disconnecting anything.
//
// 2026-09-08, round 2: this used to also own an "Account" tab (login/
// register/sign-out) — the owner's own real-usage reaction was that a tab
// holding nothing but a sign-out button isn't a section, it's an action, and
// account state belongs in each page's existing identity area, not buried
// in a Friends/DM panel. That UI now lives entirely in AccountPanel.js (the
// room's `#topbar-identity-menu` dropdown, or a small self-built identity
// button on the lobby) — see that file's header comment. AccountPanel.js
// and SocialPanel.js are independently constructed by lobby.js/App.js with
// no reference to each other, communicating only via the existing
// `peek:account`/`peek:open-dm`-shaped CustomEvents (see `peek:force-logout`
// below for the one new one this split needed) — this file no longer
// imports or constructs AccountPanel.js at all, and the trigger button
// simply doesn't exist until `peek:account` reports a logged-in session
// ("can't have friends without an account").
import { FriendsPanel } from './FriendsPanel.js';
import { MessagesPanel } from './MessagesPanel.js';
import { trapFocus } from './focusTrap.js';
import { startPresencePolling } from './presencePoll.js';
import { startMessagesPolling } from './messagesPoll.js';

export class SocialPanel {
    constructor() {
        this.modal = document.getElementById('social-modal') || this._buildModal();
        this.trigger = document.getElementById('social-button') || this._buildTrigger();

        this._releaseFocusTrap = null;
        this._loggedIn = false;
        this._stopPresencePolling = null;
        this._stopMessagesPolling = null;

        this._wireCloseHandlers();
        this._wireTrigger();
        this._init();
    }

    async _init() {
        const trust = await fetch('/api/trust').then(r => r.json()).catch(() => null);
        if (!trust?.accounts) return; // trigger stays hidden — accounts aren't enabled on this deployment

        // Constructed only now: each still does its own document.getElementById
        // lookups against the markup _buildModal() already built above — same
        // trick SettingsPanel.js's section controllers rely on to stay simple
        // regardless of which page built the modal.
        this.friendsPanel = new FriendsPanel();
        this.messagesPanel = new MessagesPanel();

        this._wireNav();
        this._wireOpenDm();
        document.addEventListener('peek:account', (e) => this._setLoggedIn(e.detail.loggedIn));

        // AccountPanel.js's own 'peek:account' dispatch (from its session
        // check) may have already fired before this listener was registered
        // — both files do their own independent async trust/session checks
        // with no guaranteed ordering — so check once more directly.
        const me = await fetch('/api/auth/me').then(r => r.ok ? r.json() : null).catch(() => null);
        this._setLoggedIn(!!me);
    }

    _setLoggedIn(loggedIn) {
        this._loggedIn = loggedIn;
        this.trigger.classList.toggle('hidden', !loggedIn);
        if (!loggedIn) {
            this.close();
            document.getElementById('social-unread-badge')?.classList.add('hidden');
        }
        this._updatePolling();
    }

    // Builds the drawer's DOM and appends it to <body>. Deliberately NOT a
    // clone of SettingsPanel.js's full-bleed overlay + left-nav-sidebar shape
    // (round 1 of this feature did exactly that, and it read as "Settings,
    // but slightly different" rather than its own surface) — a right-anchored
    // partial-width drawer with a lighter backdrop instead, which also
    // happens to leave more of the room visible while messaging. Only the
    // close button borrows `.settings-close-btn` (a generic icon-button
    // treatment, not settings-specific in anything but name) and the tab
    // switcher borrows `.settings-segmented` (the same segmented-control
    // class the screen/cam quality pickers already use elsewhere) — neither
    // pulls in the nav-sidebar/sticky-header chrome that made this look like
    // a Settings clone. Every id-based lookup below is its own distinct id
    // (social-unread-badge, close-social-panel, etc.) so this can coexist in
    // the DOM with #settings-modal without collisions.
    _buildModal() {
        const modal = document.createElement('div');
        modal.id = 'social-modal';
        modal.className = 'fixed inset-0 z-100 hidden';
        modal.innerHTML = `
            <div class="social-backdrop"></div>
            <div class="social-drawer">
                <div class="social-header">
                    <h2 class="social-header-title">Friends &amp; Messages</h2>
                    <button type="button" id="close-social-panel" class="settings-close-btn" data-tip="Close">
                        <span class="settings-close-btn-icon"><span class="material-symbols-rounded">close</span></span>
                        <span class="settings-close-btn-esc">ESC</span>
                    </button>
                </div>

                <div class="settings-segmented social-tabs">
                    <button type="button" data-social-tab="friends">Friends</button>
                    <button type="button" class="active" data-social-tab="messages">Messages</button>
                </div>

                <div class="social-body">
                    <div class="social-tab-panel" data-social-panel="friends">
                        <div id="friends-action-error" class="lobby-error hidden"></div>

                        <div class="settings-field">
                            <div class="settings-label">Add friend</div>
                            <input type="text" id="friends-add-username" class="settings-text-input"
                                placeholder="Username" style="max-width:none;" />
                            <div id="friends-add-error" class="lobby-error hidden"></div>
                            <button type="button" id="friends-add-submit" class="lobby-btn-primary"
                                style="width:100%;margin-top:0.5rem;">Send request</button>
                        </div>

                        <div class="settings-label" style="margin-top:1rem;">Requests</div>
                        <div id="friends-incoming-list" class="quick-banned-list"></div>

                        <div class="settings-label" style="margin-top:1rem;">Friends</div>
                        <div id="friends-list" class="quick-banned-list"></div>

                        <div class="settings-label" style="margin-top:1rem;">Sent</div>
                        <div id="friends-outgoing-list" class="quick-banned-list"></div>

                        <div class="settings-label" style="margin-top:1rem;">Blocked</div>
                        <div id="friends-blocked-list" class="quick-banned-list"></div>
                    </div>

                    <div class="social-tab-panel active" data-social-panel="messages">
                        <div class="quick-settings-header messages-section-header">
                            <button type="button" id="messages-back-btn" class="hidden messages-back-btn" data-tip="Back to conversations">
                                <span class="material-symbols-rounded">arrow_back</span>
                            </button>
                            <span id="messages-popover-title">Messages</span>
                        </div>

                        <div id="messages-inbox-view">
                            <div id="messages-inbox-list" class="quick-banned-list"></div>
                        </div>

                        <div id="messages-conversation-view" class="hidden">
                            <div id="messages-thread" class="messages-thread"></div>
                            <div class="chat-composer">
                                <textarea id="messages-input" rows="1" placeholder="Message"
                                    class="chat-composer-input" maxlength="4000"></textarea>
                                <button type="button" id="messages-send-btn" data-tip="Send" class="chat-composer-send shrink-0">
                                    <span class="material-symbols-rounded">send</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    // Self-inserted into whichever toolbar the host page actually has —
    // .topbar-right in-room, .lobby-toolbar on the lobby — mirroring that
    // toolbar's own existing icon-button class so it matches Invite/Leave/
    // Settings (room) or the theme/settings buttons (lobby) without a second
    // set of button styles to maintain. Falls back to <body> defensively;
    // should never actually happen since both pages always have one of these.
    _buildTrigger() {
        const wrap = document.createElement('div');
        wrap.className = 'flex items-center relative';

        const roomToolbar = document.querySelector('.topbar-right');
        const lobbyToolbar = document.querySelector('.lobby-toolbar');
        const btnClass = roomToolbar ? 'topbar-icon-btn' : 'lobby-icon-btn';

        wrap.innerHTML = `
            <button type="button" id="social-button" class="${btnClass} hidden" data-tip="Friends &amp; Messages">
                <span class="material-symbols-rounded">mail</span>
                <span id="social-unread-badge" class="hidden messages-unread-badge"></span>
            </button>
        `;

        const container = roomToolbar || lobbyToolbar;
        if (container) {
            // Room page: land before the divider that precedes the identity
            // dropdown, alongside Invite/Leave/Settings. Lobby: no such
            // divider in this toolbar, so just append where the old three
            // buttons used to sit.
            const divider = container.querySelector('.topbar-divider');
            if (divider) container.insertBefore(wrap, divider);
            else container.appendChild(wrap);
        } else {
            document.body.appendChild(wrap);
        }

        return wrap.querySelector('#social-button');
    }

    open(tab = null) {
        if (!this.modal) return;
        this._activateTab(tab || this.modal.querySelector('.social-tabs button.active')?.dataset.socialTab || 'messages');
        this.modal.classList.remove('hidden');
        // Idempotence guard in case open() is ever called while already
        // open — don't stack a second trap (same guard SettingsPanel uses).
        if (!this._releaseFocusTrap) this._releaseFocusTrap = trapFocus(this.modal);
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this._releaseFocusTrap?.();
        this._releaseFocusTrap = null;
    }

    _wireTrigger() {
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.modal.classList.contains('hidden') ? this.open() : this.close();
        });
    }

    _wireCloseHandlers() {
        this.modal.querySelector('#close-social-panel')?.addEventListener('click', () => this.close());
        this.modal.querySelector('.social-backdrop')?.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) this.close();
        });
    }

    // --- Tabs ---

    _activateTab(tab) {
        this.modal.querySelectorAll('.social-tabs button').forEach(b => {
            b.classList.toggle('active', b.dataset.socialTab === tab);
        });
        this.modal.querySelectorAll('.social-tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.socialPanel === tab);
        });
        this._onTabShown(tab);
    }

    _wireNav() {
        this.modal.querySelectorAll('.social-tabs button').forEach(btn => {
            btn.addEventListener('click', () => this._activateTab(btn.dataset.socialTab));
        });
    }

    // Each sub-panel refetches fresh on becoming visible rather than trusting
    // whatever it last rendered — same "never trust stale local state"
    // precedent FriendsPanel.js's own _refresh() already followed as a
    // popover's open().
    _onTabShown(tab) {
        if (tab === 'friends') this.friendsPanel?.onShow();
        else if (tab === 'messages') this.messagesPanel?.onShow();
    }

    // FriendsPanel.js's "Message" row action dispatches this (no direct
    // reference between the two sub-panels — same cross-module signal shape
    // as peek:account). MessagesPanel.js has its own listener on the same
    // event that shows the actual conversation; this one just makes sure the
    // whole drawer is open and the Messages tab is the one showing. Order
    // between the two listeners doesn't matter — MessagesPanel.onShow() is
    // idempotent w.r.t. an already-open conversation (see its own header
    // comment), so whichever runs second doesn't undo the other.
    _wireOpenDm() {
        document.addEventListener('peek:open-dm', () => this.open('messages'));
    }

    // Accounts Phase 3/4 polling (moved here from lobby.js, which used to
    // wire this ad hoc) — both pollers must actually stop on logout, not
    // just go unused: presence's poll call is this account's own heartbeat
    // server-side (see friendsRoutes.js's GET /api/friends/presence), so a
    // poller left running against a logged-out session would 401 forever.
    _updatePolling() {
        if (this._loggedIn) {
            // onSessionExpired (real-usage audit fix): a poller 401 means
            // this tab's session was invalidated elsewhere (e.g. logged out
            // in another tab). SocialPanel.js has no reference to
            // AccountPanel.js's instance (independently constructed, see this
            // file's header comment), so it dispatches 'peek:force-logout'
            // instead of calling a method directly — AccountPanel.js listens
            // for that itself and re-dispatches 'peek:account', which
            // re-enters _setLoggedIn() on the else branch below to stop both
            // pollers.
            if (!this._stopPresencePolling) {
                this._stopPresencePolling = startPresencePolling(
                    (presence) => this.friendsPanel.setOnline(presence),
                    () => document.dispatchEvent(new CustomEvent('peek:force-logout')),
                );
            }
            if (!this._stopMessagesPolling) {
                this._stopMessagesPolling = startMessagesPolling(
                    (conversations) => this.messagesPanel.setConversations(conversations),
                    () => document.dispatchEvent(new CustomEvent('peek:force-logout')),
                );
            }
        } else {
            this._stopPresencePolling?.();
            this._stopPresencePolling = null;
            this._stopMessagesPolling?.();
            this._stopMessagesPolling = null;
        }
    }
}
