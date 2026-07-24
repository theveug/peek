// --- public/client/SettingsPanel.js ---
// Full-frame settings overlay (redesign Phase 3). Every control here applies +
// persists immediately on change — there's no Save/Cancel step, matching the
// design spec's interaction model (see CLAUDE.md's redesign notes).
import { setTheme, getEffectiveTheme } from './ThemeManager.js';
import { setAccent, getStoredAccent, accentPresetNames, presetColor } from './AccentManager.js';
import { setBackgroundTint, getStoredBackgroundTint, bgTintPresetNames, presetBgColor } from './BackgroundManager.js';
import { setFontScale, getStoredFontScale, fontScaleLabel } from './FontScaleManager.js';
import { trapFocus } from './focusTrap.js';
import { getCustomStatuses, getCustomStatus, upsertCustomStatus, deleteCustomStatus, SWATCHES } from './CustomStatuses.js';
import * as chatHistoryStore from './chatHistoryStore.js';

// Labels for the tri-state mute/deafen pickers in the custom-status form —
// 'none' means "leave as-is," so a status can just as easily auto-unmute/
// undeafen ('off') as it can force mute/deafen on.
const TOGGLE_LABELS = {
    deafen: { none: 'No change', on: 'Deafen', off: 'Undeafen' },
    mute: { none: 'No change', on: 'Mute', off: 'Unmute' },
};

// One-time cleanup for the old 4-way mic-mode picker: 'push-to-mute' used to be
// its own mutually-exclusive mode, now it's a hold-to-force-mute modifier on
// top of 'toggle'/'voice-activity' (see PeerManager's ptmHeld). A user who had
// it selected keeps their existing micKeybind (still meaningful under the new
// design) — this just re-normalizes the stored mode so a picker button shows
// as selected again.
if (typeof localStorage !== 'undefined' && localStorage.getItem('micMode') === 'push-to-mute') {
    localStorage.setItem('micMode', 'toggle');
}

// One-time migration off the old shared 'micKeybind': it used to serve both
// push-to-talk (hold-to-open) and push-to-mute (hold-to-force-mute), picked
// at keydown time by whichever mic mode was active — meaning the two could
// never have different keys, and there was no way to bind a plain
// tap-to-toggle-mute at all. Seeds both new independent slots from the old
// value (only if they haven't been set yet) so an existing user's configured
// key keeps working under whichever mode they're in; from here on each is
// independently editable via Settings → Keybinds.
if (typeof localStorage !== 'undefined') {
    const legacyMicKeybind = localStorage.getItem('micKeybind');
    if (legacyMicKeybind) {
        if (localStorage.getItem('keybindPushToTalk') === null) localStorage.setItem('keybindPushToTalk', legacyMicKeybind);
        if (localStorage.getItem('keybindPushToMute') === null) localStorage.setItem('keybindPushToMute', legacyMicKeybind);
    }
}

export class SettingsPanel {
    // ui/peerManager are optional — on the lobby (pre-room) there's neither, and
    // every field still needs to load/persist to localStorage for whatever room
    // is joined next. Anything that only makes sense with a live connection
    // (status, live quality application, nickname broadcast) is guarded.
    constructor({ ui = null, peerManager = null } = {}) {
        this.ui = ui;
        this.peerManager = peerManager;
        this._keybindListening = false;

        // Single source of truth for the modal's markup — previously this was
        // hand-duplicated as static HTML in both index.html and lobby.html,
        // which is exactly how they drifted out of sync (13 ids ended up
        // present in one copy and missing from the other). Built here once
        // and reused by both pages instead.
        this.modal = document.getElementById('settings-modal') || this._buildModal();

        this._buildAccentSwatches();
        this._buildBackgroundSwatches();
        this._wireNav();
        this._wireProfile();
        this._wireAppearance();
        this._wireFontScale();
        this._wireVideo();
        this._wireAudio();
        this._wireKeybinds();
        this._wireDevices();
        this._wirePrivacy();
        this._wireCloseHandlers();
    }

    // Builds the modal's DOM and appends it to <body> — the full superset of
    // controls (in-room's old copy was the superset; lobby's was a strict
    // subset by id, confirmed during the consolidation). Controls that only
    // make sense with a live connection are marked `settings-live-only` and
    // hidden by `_refreshAll()` when there's no peerManager (lobby) — see
    // that method. `focusTrap.js` and every `_wire*`/`_refresh*` method below
    // are agnostic to whether this node was parsed from static HTML or built
    // here; only the constructor cared, which is why this was safe to extract.
    _buildModal() {
        const modal = document.createElement('div');
        modal.id = 'settings-modal';
        modal.className = 'fixed inset-0 z-100 hidden';
        modal.innerHTML = `
            <div class="settings-overlay">
                <div class="settings-nav">
                    <div class="settings-nav-title">SETTINGS</div>
                    <button type="button" class="settings-nav-item active" data-settings-section="profile">
                        <span class="material-symbols-rounded">person</span>Profile
                    </button>
                    <button type="button" class="settings-nav-item" data-settings-section="appearance">
                        <span class="material-symbols-rounded">palette</span>Appearance
                    </button>
                    <button type="button" class="settings-nav-item" data-settings-section="video">
                        <span class="material-symbols-rounded">screen_share</span>Screen &amp; Video
                    </button>
                    <button type="button" class="settings-nav-item" data-settings-section="audio">
                        <span class="material-symbols-rounded">mic</span>Audio &amp; Mic
                    </button>
                    <button type="button" class="settings-nav-item" data-settings-section="keybinds">
                        <span class="material-symbols-rounded">keyboard</span>Keybinds
                    </button>
                    <button type="button" class="settings-nav-item" data-settings-section="privacy">
                        <span class="material-symbols-rounded">shield</span>Privacy &amp; P2P
                    </button>
                    <div class="settings-nav-spacer"></div>
                    <div class="settings-nav-footer"><b>Peek</b><br>No account. No database. Settings stay on this device.
                    </div>
                </div>

                <div class="settings-content">
                    <button type="button" id="close-settings" class="settings-close-btn" data-tip="Close">
                        <span class="settings-close-btn-icon"><span class="material-symbols-rounded">close</span></span>
                        <span class="settings-close-btn-esc">ESC</span>
                    </button>

                    <div class="settings-section-body">

                        <!-- Profile -->
                        <div class="settings-section active" data-settings-panel="profile">
                            <h1>Profile</h1>
                            <p class="settings-section-subcopy">Your name and status, visible to everyone in the room.</p>
                            <div class="settings-field">
                                <div class="settings-label">Avatar</div>
                                <div class="settings-avatar-row">
                                    <div id="settings-avatar-preview" class="settings-avatar-preview">?</div>
                                    <button type="button" id="settings-avatar-pick" class="settings-avatar-btn">Change photo</button>
                                    <button type="button" id="settings-avatar-remove" class="settings-avatar-btn" style="display:none">Remove</button>
                                    <input type="file" id="settings-avatar-input" accept="image/*" class="hidden" />
                                </div>
                            </div>
                            <div class="settings-field">
                                <label for="settings-nickname" class="settings-label">Nickname</label>
                                <input type="text" id="settings-nickname" class="settings-text-input" maxlength="60" />
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Status</div>
                                <div id="status-picker" class="flex gap-2">
                                    <button type="button" data-status="online"
                                        class="status-pick flex items-center gap-1.5 px-3 py-1.5 rounded-lg surface-input text-xs font-medium transition-all"
                                        data-tip="Online">
                                        <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span> Online
                                    </button>
                                    <button type="button" data-status="away"
                                        class="status-pick flex items-center gap-1.5 px-3 py-1.5 rounded-lg surface-input text-xs font-medium transition-all"
                                        data-tip="Away">
                                        <span class="w-2.5 h-2.5 rounded-full bg-yellow-500 inline-block"></span> Away
                                    </button>
                                    <button type="button" data-status="dnd"
                                        class="status-pick flex items-center gap-1.5 px-3 py-1.5 rounded-lg surface-input text-xs font-medium transition-all"
                                        data-tip="Do Not Disturb">
                                        <span class="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span> DND
                                    </button>
                                </div>
                            </div>
                            <div class="settings-field">
                                <label for="settings-status-text" class="settings-label">Status message</label>
                                <input type="text" id="settings-status-text" class="settings-text-input"
                                    placeholder="e.g. In a meeting" maxlength="60" />
                            </div>
                            <div class="settings-field">
                                <label for="settings-away-timeout" class="settings-label">Away after</label>
                                <select id="settings-away-timeout" class="settings-text-input">
                                    <option value="5">5 minutes</option>
                                    <option value="10">10 minutes</option>
                                    <option value="15">15 minutes</option>
                                    <option value="30">30 minutes</option>
                                </select>
                                <p class="text-[10px] text-muted mt-1">How long without mouse/keyboard/touch input before
                                    you're marked Away — also drives Audio &amp; Mic's "Auto-deafen when away", if that's
                                    turned on.</p>
                            </div>
                            <div class="settings-field" style="margin-bottom:0;">
                                <div class="settings-label">Custom statuses</div>
                                <p class="text-[10px] text-muted mt-1" style="margin-bottom:0.625rem;">Save your own
                                    reusable statuses — pick a color, base status, and what happens when you switch to
                                    it. Shows up alongside Online/Away/DND in the topbar menu.</p>
                                <div id="custom-status-list" class="flex flex-col gap-1.5" style="margin-bottom:0.625rem;"></div>
                                <div id="custom-status-form" class="hidden"></div>
                                <button type="button" id="custom-status-add-btn" class="settings-avatar-btn">+ New
                                    status</button>
                            </div>
                        </div>

                        <!-- Appearance -->
                        <div class="settings-section" data-settings-panel="appearance">
                            <h1>Appearance</h1>
                            <p class="settings-section-subcopy">Make Peek yours. Changes apply instantly and save to this
                                device.</p>
                            <div class="settings-label">Theme</div>
                            <div class="settings-segmented" id="settings-theme-picker" style="margin-bottom:1.875rem;">
                                <button type="button" data-theme="system"><span
                                        class="material-symbols-rounded">brightness_auto</span>System</button>
                                <button type="button" data-theme="dark"><span
                                        class="material-symbols-rounded">dark_mode</span>Dark</button>
                                <button type="button" data-theme="light"><span
                                        class="material-symbols-rounded">light_mode</span>Light</button>
                            </div>
                            <div class="settings-label">Accent color</div>
                            <div class="settings-accent-swatches" id="settings-accent-picker"></div>
                            <div class="settings-label">Background tint</div>
                            <div class="settings-accent-swatches" id="settings-bg-picker"></div>
                            <div class="settings-field">
                                <label for="settings-font-scale" class="settings-label">Text size — <span
                                        id="settings-font-scale-value">Default</span></label>
                                <input id="settings-font-scale" type="range" min="0.85" max="1.3" step="0.05"
                                    class="w-full" />
                                <p class="text-[10px] text-muted mt-1">Scales the whole interface up or down from the
                                    default size.</p>
                            </div>
                            <div class="settings-label">Preview</div>
                            <div class="settings-preview-card">
                                <div class="settings-preview-header">
                                    <span
                                        style="width:1.75rem;height:1.75rem;border-radius:0.5rem;background:var(--accent);color:var(--accentText);display:flex;align-items:center;justify-content:center;"><span
                                            class="material-symbols-rounded"
                                            style="font-size:1.0625rem;">screen_share</span></span>Peek
                                </div>
                                <div class="settings-preview-body">
                                    <div style="display:flex;gap:0.75rem;">
                                        <span
                                            style="width:2.375rem;height:2.375rem;border-radius:0.6875rem;background:var(--accent);color:var(--accentText);font-weight:800;font-size:0.8125rem;display:flex;align-items:center;justify-content:center;flex:none;">YO</span>
                                        <div>
                                            <div style="font-weight:700;color:var(--t1);font-size:0.875rem;">you</div>
                                            <div style="color:var(--t1);font-size:0.875rem;margin-top:0.125rem;">looks good with this
                                                accent</div>
                                        </div>
                                    </div>
                                    <div style="display:flex;gap:0.625rem;">
                                        <button type="button"
                                            style="border:none;border-radius:0.5625rem;background:var(--accent);color:var(--accentText);font-weight:700;font-size:0.8125rem;padding:0.5rem 1rem;">Share
                                            screen</button>
                                        <button type="button"
                                            style="border:1px solid var(--border);border-radius:0.5625rem;background:var(--bg4);color:var(--t1);font-weight:600;font-size:0.8125rem;padding:0.5rem 1rem;">Invite</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Screen & Video -->
                        <div class="settings-section" data-settings-panel="video">
                            <h1>Screen &amp; Video</h1>
                            <p class="settings-section-subcopy">Quality auto-caps as the room grows, and restores when peers
                                leave.</p>
                            <div class="settings-field">
                                <label for="settings-cam-device" class="settings-label">Camera</label>
                                <select id="settings-cam-device" class="settings-text-input">
                                    <option value="">System default</option>
                                </select>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Voice-only mode</div>
                                    <div class="settings-toggle-row-desc">Don't automatically watch anyone's video —
                                        saves bandwidth if you're just here for the call. You can still click any tile to
                                        watch it.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox"
                                        id="settings-audio-only-mode" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Screen share resolution</div>
                                <div class="settings-segmented" id="settings-res-picker">
                                    <button type="button" data-value="1280x720">720p</button>
                                    <button type="button" data-value="1920x1080">1080p</button>
                                    <button type="button" data-value="2560x1440">1440p</button>
                                    <button type="button" data-value="source">Source</button>
                                </div>
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Screen share frame rate</div>
                                <div class="settings-segmented" id="settings-fps-picker">
                                    <button type="button" data-value="10">10 fps</button>
                                    <button type="button" data-value="15">15 fps</button>
                                    <button type="button" data-value="30">30 fps</button>
                                    <button type="button" data-value="60">60 fps</button>
                                </div>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Share system audio</div>
                                    <div class="settings-toggle-row-desc">Off by default — when on, whatever's playing
                                        through your speakers (video/game audio, notification sounds, etc.) is sent
                                        along with your screen share. Leave this off if you don't want peers to hear
                                        things like your own volume-change chime or other app sounds.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-share-system-audio" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Webcam resolution</div>
                                <div class="settings-segmented" id="settings-cam-res-picker">
                                    <button type="button" data-value="640x360">360p</button>
                                    <button type="button" data-value="640x480">480p</button>
                                    <button type="button" data-value="1280x720">720p</button>
                                    <button type="button" data-value="source">Source</button>
                                </div>
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Webcam frame rate</div>
                                <div class="settings-segmented" id="settings-cam-fps-picker">
                                    <button type="button" data-value="10">10 fps</button>
                                    <button type="button" data-value="15">15 fps</button>
                                    <button type="button" data-value="24">24 fps</button>
                                    <button type="button" data-value="30">30 fps</button>
                                </div>
                            </div>
                            <div class="settings-toggle-row settings-live-only">
                                <div>
                                    <div class="settings-toggle-row-title">Background blur</div>
                                    <div class="settings-toggle-row-desc">Blurs what's behind you on your webcam. Runs
                                        entirely in your browser before your video is ever sent — nothing leaves your
                                        device.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-background-blur" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Automatically focus on whoever's speaking</div>
                                    <div class="settings-toggle-row-desc">Switches the focused view to the active speaker
                                        while you're already in focus view.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-follow-speaker" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-field">
                                <label for="settings-max-messages" class="settings-label">Max chat messages kept</label>
                                <input type="number" id="settings-max-messages" class="settings-text-input"
                                    style="max-width:7.5rem;" min="10" max="500" />
                            </div>
                        </div>

                        <!-- Audio & Mic -->
                        <div class="settings-section" data-settings-panel="audio">
                            <h1>Audio &amp; Mic</h1>
                            <p class="settings-section-subcopy">Audio keeps flowing when the tab is backgrounded — only
                                video pauses.</p>
                            <div class="settings-field">
                                <label for="settings-mic-device" class="settings-label">Microphone</label>
                                <select id="settings-mic-device" class="settings-text-input">
                                    <option value="">System default</option>
                                </select>
                            </div>
                            <div class="settings-field">
                                <label for="settings-speaker-device" class="settings-label">Speaker</label>
                                <select id="settings-speaker-device" class="settings-text-input">
                                    <option value="">System default</option>
                                </select>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Mute notification sounds</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-mute" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Desktop notifications for @mentions</div>
                                    <div class="settings-toggle-row-desc">Shows an OS notification when someone @mentions
                                        you while this window isn't focused. Handled entirely by your browser — nothing
                                        leaves your device.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox"
                                        id="settings-desktop-notifications" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row settings-live-only">
                                <div>
                                    <div class="settings-toggle-row-title">Noise suppression</div>
                                    <div class="settings-toggle-row-desc">Filters background noise out of your mic (RNNoise).
                                        Runs entirely in your browser before your audio is ever sent — nothing leaves your
                                        device.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-noise-suppression" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row settings-live-only">
                                <div>
                                    <div class="settings-toggle-row-title">Auto-deafen when away</div>
                                    <div class="settings-toggle-row-desc">Mutes your mic and incoming audio automatically
                                        once you're marked Away (see Profile → "Away after" for the timeout), and undoes
                                        it when you come back — unless you deafened yourself manually, which this leaves
                                        alone.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-auto-deafen-away" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Play audio from screen shares</div>
                                    <div class="settings-toggle-row-desc">Off by default. Turn on to hear system audio
                                        from peers who've opted in to sharing it — this is separate from hearing them
                                        talk, which always works.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox" id="settings-play-share-audio" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-field">
                                <label for="settings-volume" class="settings-label">Notification volume — <span
                                        id="settings-volume-value">30%</span></label>
                                <input id="settings-volume" type="range" min="0" max="1" step="0.01" class="w-full" />
                            </div>
                            <div class="settings-field settings-live-only">
                                <label for="settings-master-volume" class="settings-label">Call volume — <span
                                        id="settings-master-volume-value">100%</span></label>
                                <input id="settings-master-volume" type="range" min="0" max="1" step="0.01"
                                    class="w-full" />
                            </div>
                            <div class="settings-field">
                                <div class="settings-label">Mic mode</div>
                                <div id="settings-mic-room-rule" class="dock-popover-note" style="display:none">This room
                                    enforces push-to-talk (set by the room creator) — your own preference below will apply
                                    again in other rooms.</div>
                                <div class="settings-segmented" id="settings-mic-mode-picker" style="width:100%;">
                                    <button type="button" data-mic-mode="toggle"
                                        style="flex:1;justify-content:center;">Toggle</button>
                                    <button type="button" data-mic-mode="push-to-talk"
                                        style="flex:1;justify-content:center;">Push to Talk</button>
                                    <button type="button" data-mic-mode="voice-activity"
                                        style="flex:1;justify-content:center;">Voice Activity</button>
                                </div>
                            </div>
                            <p class="text-[10px] text-muted mb-3">Push-to-talk/mute and deafen keys are set in
                                Settings &rarr; Keybinds.</p>
                            <div id="mic-threshold-row" class="settings-field hidden">
                                <label for="settings-mic-threshold" class="settings-label">Mic sensitivity — <span
                                        id="settings-mic-threshold-value">Medium</span></label>
                                <input id="settings-mic-threshold" type="range" min="0.01" max="0.1" step="0.01"
                                    class="w-full" />
                                <p class="text-[10px] text-muted mt-1">Only transmits while you're speaking above this level
                                    — lower is more sensitive.</p>
                            </div>
                            <div id="mic-hold-time-row" class="settings-field hidden">
                                <label for="settings-mic-hold-time" class="settings-label">Mic hold time — <span
                                        id="settings-mic-hold-time-value">0.4s</span></label>
                                <input id="settings-mic-hold-time" type="range" min="150" max="1500" step="50"
                                    class="w-full" />
                                <p class="text-[10px] text-muted mt-1">How long transmission stays open after you stop
                                    speaking — raise this if pauses between words or sentences get cut off.</p>
                            </div>
                            <div id="mic-meter-row" class="settings-field hidden">
                                <label class="settings-label">Mic level</label>
                                <div class="mic-meter">
                                    <div class="mic-meter-fill" id="mic-meter-fill"></div>
                                    <div class="mic-meter-threshold-line" id="mic-meter-threshold-line"></div>
                                </div>
                                <p class="text-[10px] text-muted mt-1" id="mic-meter-hint">Speak normally — the bar should
                                    clear the vertical line while talking and settle below it at rest.</p>
                            </div>
                        </div>

                        <!-- Keybinds -->
                        <div class="settings-section" data-settings-panel="keybinds">
                            <h1>Keybinds</h1>
                            <p class="settings-section-subcopy">Every bindable key in one place. Assign the same key to
                                more than one action if you want one button to do several things, or give each its own key
                                — your choice.</p>
                            <div id="keybinds-list"></div>
                        </div>

                        <!-- Privacy & P2P -->
                        <div class="settings-section" data-settings-panel="privacy">
                            <h1>Privacy &amp; P2P</h1>
                            <p class="settings-section-subcopy">Peek never stores anything on a server — most of this is how
                                it always works, not a setting to turn on.</p>
                            <div class="settings-info-card">
                                <span class="material-symbols-rounded">lan</span>
                                <div>
                                    <div class="settings-info-card-title">Peer-to-peer mesh</div>
                                    <div class="settings-info-card-desc">Media and messages travel directly between
                                        participants wherever possible.</div>
                                </div>
                            </div>
                            <div class="settings-info-card">
                                <span class="material-symbols-rounded">memory</span>
                                <div>
                                    <div class="settings-info-card-title">In-memory only</div>
                                    <div class="settings-info-card-desc">Nothing is written to a database. The room
                                        disappears when the last person leaves.</div>
                                </div>
                            </div>
                            <div class="settings-info-card">
                                <span class="material-symbols-rounded">visibility_off</span>
                                <div>
                                    <div class="settings-info-card-title">The signalling server never sees your content
                                    </div>
                                    <div class="settings-info-card-desc">It only helps peers find each other — chat, files,
                                        and media never pass through it.</div>
                                </div>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Auto-accept files in this room</div>
                                    <div class="settings-toggle-row-desc">Only enable for people you trust — skips the
                                        per-file accept prompt.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox"
                                        id="settings-auto-accept-files" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Save chat history on this device</div>
                                    <div class="settings-toggle-row-desc">Keeps a local copy of your chat text so it's
                                        here when you rejoin this room. Only ever stored in your browser — never sent
                                        anywhere, and other peers can't tell it's on.</div>
                                </div>
                                <label class="settings-switch"><input type="checkbox"
                                        id="settings-chat-history-enabled" /><span
                                        class="settings-switch-track"></span></label>
                            </div>
                            <div class="settings-field hidden" id="chat-history-days-field">
                                <label for="settings-chat-history-days" class="settings-label">Keep history for</label>
                                <select id="settings-chat-history-days" class="settings-text-input">
                                    <option value="1">1 day</option>
                                    <option value="3">3 days</option>
                                    <option value="7">7 days</option>
                                    <option value="14">14 days</option>
                                    <option value="30">30 days</option>
                                </select>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Clear chat history</div>
                                    <div class="settings-toggle-row-desc">Wipes locally-saved chat text for every room,
                                        separately from every other preference below.</div>
                                </div>
                                <button type="button" id="settings-clear-chat-history" class="settings-danger-btn">Clear
                                    history</button>
                            </div>
                            <div class="settings-toggle-row">
                                <div>
                                    <div class="settings-toggle-row-title">Clear all local data</div>
                                    <div class="settings-toggle-row-desc">Wipes everything Peek has saved in this browser —
                                        nickname, theme &amp; appearance, mic/video preferences, saved rooms (including
                                        their passwords), and chat history. Doesn't affect anyone else or end your current
                                        call.</div>
                                </div>
                                <button type="button" id="settings-clear-data" class="settings-danger-btn">Clear
                                    data</button>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        return modal;
    }

    // Read by App.js's global keydown/keyup listeners (push-to-talk/mute,
    // toggle-mute, deafen) so they pause while a Keybinds-tab row is
    // mid-capture, rather than reacting to the very keypress being captured.
    isKeybindListening() {
        return this._keybindListening;
    }

    // `section` optionally jumps straight to a nav tab (e.g. the mic-options
    // popover's "Keybinds ▸" link) — omitted, it leaves whatever tab was last
    // active, same as before this param existed.
    open(section = null) {
        if (!this.modal) return;
        this._refreshAll();
        if (section) {
            this.modal.querySelectorAll('.settings-nav-item').forEach(b => {
                b.classList.toggle('active', b.dataset.settingsSection === section);
            });
            this.modal.querySelectorAll('.settings-section').forEach(panel => {
                panel.classList.toggle('active', panel.dataset.settingsPanel === section);
            });
        }
        this.modal.classList.remove('hidden');
        this._startMicMeter();
        // Keep Tab inside the overlay while it's open; released (and prior
        // focus restored) in close(). Idempotence guard in case open() is
        // ever called while already open — don't stack a second trap.
        if (!this._releaseFocusTrap) this._releaseFocusTrap = trapFocus(this.modal);
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.add('hidden');
        this._stopMicMeter();
        this._releaseFocusTrap?.();
        this._releaseFocusTrap = null;
    }

    // --- Nav ---

    _wireNav() {
        const items = this.modal.querySelectorAll('.settings-nav-item');
        items.forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.dataset.settingsSection;
                items.forEach(b => b.classList.toggle('active', b === btn));
                this.modal.querySelectorAll('.settings-section').forEach(panel => {
                    panel.classList.toggle('active', panel.dataset.settingsPanel === section);
                });
            });
        });
    }

    _wireCloseHandlers() {
        document.getElementById('close-settings')?.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) this.close();
        });
    }

    // --- Devices (mic/speaker/camera) ---

    // Change handlers persist regardless of context, but only *live-apply* a
    // switch when there's an active connection to apply it to — switchMicrophone/
    // switchCamera/setAudioOutputDevice each persist their own localStorage key
    // internally when called, so the lobby (no peerManager/ui) branch has to
    // persist explicitly instead, since `?.` there would skip the call (and
    // therefore the persist) entirely rather than just skipping the live part.
    _wireDevices() {
        document.getElementById('settings-mic-device')?.addEventListener('change', (e) => {
            const id = e.target.value || null;
            if (this.peerManager) this.peerManager.switchMicrophone(id);
            else localStorage.setItem('micDeviceId', id || '');
        });
        document.getElementById('settings-speaker-device')?.addEventListener('change', (e) => {
            const id = e.target.value || '';
            if (this.ui) this.ui.setAudioOutputDevice(id);
            else localStorage.setItem('speakerDeviceId', id);
        });
        document.getElementById('settings-cam-device')?.addEventListener('change', (e) => {
            const id = e.target.value || null;
            if (this.peerManager) this.peerManager.switchCamera(id);
            else localStorage.setItem('camDeviceId', id || '');
        });

        // Devices can change while Settings happens to be open (a USB headset
        // plugged in, a laptop lid opened) — refresh the option lists live
        // rather than only on the next open().
        navigator.mediaDevices?.addEventListener?.('devicechange', () => {
            if (!this.modal.classList.contains('hidden')) this._refreshDevices();
        });
    }

    /**
     * Populates all three device <select>s from enumerateDevices(). Device
     * labels are only populated by the browser once mic/cam permission has
     * been granted at least once (the same limitation already noted in
     * App.js for camera-count detection) — before that, options just show a
     * generic "Microphone 1"-style fallback.
     * @returns {Promise<void>}
     */
    async _refreshDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        let devices;
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            return;
        }
        this._populateDeviceSelect('settings-mic-device', devices.filter(d => d.kind === 'audioinput'), 'micDeviceId', 'Microphone');
        this._populateDeviceSelect('settings-speaker-device', devices.filter(d => d.kind === 'audiooutput'), 'speakerDeviceId', 'Speaker');
        this._populateDeviceSelect('settings-cam-device', devices.filter(d => d.kind === 'videoinput'), 'camDeviceId', 'Camera');
    }

    _populateDeviceSelect(selectId, devices, storageKey, kindLabel) {
        const select = document.getElementById(selectId);
        if (!select) return;
        const current = localStorage.getItem(storageKey) || '';
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'System default';
        select.appendChild(defaultOption);
        devices.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `${kindLabel} ${i + 1}`;
            select.appendChild(opt);
        });
        // Only select the stored preference if that device is still actually
        // present — otherwise leave it on "System default" rather than
        // showing a value with no matching <option>.
        select.value = devices.some(d => d.deviceId === current) ? current : '';
    }

    _refreshAll() {
        // Controls that only make sense with a live connection (noise
        // suppression, background blur, call volume, deafen keybind,
        // auto-deafen) — hidden on the lobby (no peerManager), where
        // toggling them either couldn't apply anything live or, worse,
        // wouldn't even persist (several of their handlers are themselves
        // `this.peerManager?.`/`this.ui?.`-gated with no fallback
        // localStorage write). peerManager is fixed for this instance's
        // whole lifetime (set once at construction, on either page), so this
        // only needs recomputing here, not on every keystroke.
        this.modal.querySelectorAll('.settings-live-only').forEach(el => {
            el.classList.toggle('hidden', !this.peerManager);
        });
        this._refreshDevices(); // async, not awaited — selects populate a beat after the modal opens
        this._refreshProfile();
        this._refreshAppearance();
        this._refreshVideo();
        this._refreshAudio();
        this._refreshKeybinds();
        this._refreshPrivacy();
    }

    // --- Profile ---

    _wireProfile() {
        const nickname = document.getElementById('settings-nickname');
        nickname?.addEventListener('change', () => {
            const value = nickname.value.trim();
            localStorage.setItem('nickname', value);
            this.peerManager?.broadcastNickname();
            if (this.peerManager?.peerId) {
                this.ui.updateParticipantNickname(this.peerManager.peerId, value);
            }
        });

        this.modal.querySelectorAll('#status-picker .status-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this.peerManager) return; // no live connection yet (lobby) — nothing to set status on
                this.peerManager.setManualStatus(btn.dataset.status);
                this._highlightStatus();
            });
        });

        const statusText = document.getElementById('settings-status-text');
        statusText?.addEventListener('change', () => {
            const value = statusText.value.trim().slice(0, 60);
            statusText.value = value;
            localStorage.setItem('statusText', value);
            this.peerManager?.setStatusText(value);
        });

        // How long without mouse/keyboard/touch input before the idle timer
        // in App.js marks you Away — read fresh from localStorage there on
        // every timer reset, so this takes effect immediately, no reconnect
        // needed. Also gates the opt-in "Auto-deafen when away" toggle,
        // since that piggybacks on the same away transition.
        document.getElementById('settings-away-timeout')?.addEventListener('change', (e) => {
            localStorage.setItem('awayTimeoutMinutes', e.target.value);
        });

        this._wireAvatar();
        this._wireCustomStatuses();
    }

    _refreshProfile() {
        const nickname = document.getElementById('settings-nickname');
        if (nickname) nickname.value = localStorage.getItem('nickname') || '';
        const statusText = document.getElementById('settings-status-text');
        if (statusText) statusText.value = localStorage.getItem('statusText') || '';
        const awayTimeout = document.getElementById('settings-away-timeout');
        if (awayTimeout) awayTimeout.value = localStorage.getItem('awayTimeoutMinutes') || '15';
        this._highlightStatus();
        this._refreshAvatarPreview();
        this._renderCustomStatusList();
    }

    // --- Custom statuses ---
    // User-defined reusable quick statuses, listed here for create/edit/delete;
    // TopbarIdentity.js is what actually applies one (setManualStatus/setStatusText
    // plus the local mute/deafen/drop-streams side effects) — this section only
    // ever touches the CustomStatuses.js-owned localStorage list.

    _wireCustomStatuses() {
        document.getElementById('custom-status-add-btn')?.addEventListener('click', () => {
            this._openCustomStatusForm(null);
        });
    }

    _renderCustomStatusList() {
        const list = document.getElementById('custom-status-list');
        if (!list) return;
        list.innerHTML = '';
        const statuses = getCustomStatuses();
        if (!statuses.length) {
            list.innerHTML = '<div class="text-[11px] text-muted">No custom statuses yet.</div>';
            return;
        }
        statuses.forEach((status) => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between gap-2 px-3 py-2 rounded-lg surface-input';

            const left = document.createElement('div');
            left.className = 'flex items-center gap-2 min-w-0';
            const dot = document.createElement('span');
            dot.className = 'quick-status-dot';
            dot.style.background = status.color;
            const name = document.createElement('span');
            name.className = 'text-xs font-medium truncate';
            name.textContent = status.label; // user-entered — textContent only, never innerHTML
            left.append(dot, name);

            const actions = document.createElement('div');
            actions.className = 'flex items-center gap-1 shrink-0';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'settings-avatar-btn';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => this._openCustomStatusForm(status.id));
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'settings-danger-btn';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => {
                deleteCustomStatus(status.id);
                this._renderCustomStatusList();
            });
            actions.append(editBtn, delBtn);

            row.append(left, actions);
            list.appendChild(row);
        });
    }

    /**
     * Opens the inline create/edit form for a custom status — rebuilt from
     * scratch each time (same disposable-innerHTML approach as the rest of
     * this panel) rather than kept alive, since it's only ever open one at a
     * time and never needs to preserve state across opens.
     * @param {?string} editingId - null to create a new status
     */
    _openCustomStatusForm(editingId) {
        const existing = editingId ? getCustomStatus(editingId) : null;
        const form = document.getElementById('custom-status-form');
        if (!form) return;

        let selectedColor = existing?.color || SWATCHES[0];
        let selectedBase = existing?.baseStatus || 'online';
        let selectedDeafen = existing?.deafen || 'none';
        let selectedMute = existing?.mute || 'none';

        const toggleSegmentHTML = (id) => `
            <div class="settings-segmented" id="${id}">
                <button type="button" data-value="none">No change</button>
                <button type="button" data-value="on">On</button>
                <button type="button" data-value="off">Off</button>
            </div>
        `;

        form.innerHTML = `
            <div class="settings-field">
                <label for="custom-status-label-input" class="settings-label">Label</label>
                <input type="text" id="custom-status-label-input" class="settings-text-input" maxlength="40"
                    placeholder="e.g. In a meeting" />
            </div>
            <div class="settings-field">
                <div class="settings-label">Color</div>
                <div class="settings-accent-swatches" id="custom-status-color-picker" style="margin-bottom:0;"></div>
            </div>
            <div class="settings-field">
                <div class="settings-label">Shows as</div>
                <div class="settings-segmented" id="custom-status-base-picker">
                    <button type="button" data-value="online">Online</button>
                    <button type="button" data-value="away">Away</button>
                    <button type="button" data-value="dnd">DND</button>
                </div>
            </div>
            <div class="settings-field">
                <div class="settings-label">Deafen</div>
                ${toggleSegmentHTML('custom-status-deafen-picker')}
            </div>
            <div class="settings-field">
                <div class="settings-label">Microphone</div>
                ${toggleSegmentHTML('custom-status-mute-picker')}
            </div>
            <div class="settings-toggle-row">
                <div><div class="settings-toggle-row-title">Stop screen share &amp; camera</div></div>
                <label class="settings-switch"><input type="checkbox" id="custom-status-dropstreams-toggle" /><span
                        class="settings-switch-track"></span></label>
            </div>
            <div class="flex gap-2">
                <button type="button" id="custom-status-save-btn" class="settings-avatar-btn">Save</button>
                <button type="button" id="custom-status-cancel-btn" class="settings-avatar-btn">Cancel</button>
            </div>
        `;
        form.classList.remove('hidden');
        document.getElementById('custom-status-add-btn')?.classList.add('hidden');

        const labelInput = document.getElementById('custom-status-label-input');
        labelInput.value = existing?.label || '';
        labelInput.focus();

        const colorPicker = document.getElementById('custom-status-color-picker');
        SWATCHES.forEach((color) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-accent-swatch';
            btn.style.background = color;
            btn.classList.toggle('active', color === selectedColor);
            btn.innerHTML = '<span class="material-symbols-rounded icon-filled">check</span>';
            btn.addEventListener('click', () => {
                selectedColor = color;
                colorPicker.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
            });
            colorPicker.appendChild(btn);
        });

        const basePicker = document.getElementById('custom-status-base-picker');
        basePicker.querySelectorAll('button').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.value === selectedBase);
            btn.addEventListener('click', () => {
                selectedBase = btn.dataset.value;
                basePicker.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
            });
        });

        // Deafen/mute are tri-state ('none'/'on'/'off') rather than a plain
        // switch — 'off' is what lets a status auto-unmute/undeafen (e.g. a
        // "Back" status reversing what "Lunch" forced on), not just force
        // them on. Labels come from TOGGLE_LABELS since "on"/"off" alone
        // don't read clearly per field ("Mute" vs "Unmute").
        const wireTogglePicker = (id, field, get, set) => {
            const picker = document.getElementById(id);
            picker.querySelectorAll('button').forEach((btn) => {
                btn.textContent = TOGGLE_LABELS[field][btn.dataset.value];
                btn.classList.toggle('active', btn.dataset.value === get());
                btn.addEventListener('click', () => {
                    set(btn.dataset.value);
                    picker.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
                });
            });
        };
        wireTogglePicker('custom-status-deafen-picker', 'deafen', () => selectedDeafen, (v) => { selectedDeafen = v; });
        wireTogglePicker('custom-status-mute-picker', 'mute', () => selectedMute, (v) => { selectedMute = v; });

        document.getElementById('custom-status-dropstreams-toggle').checked = !!existing?.dropStreams;

        const close = () => {
            form.classList.add('hidden');
            form.innerHTML = '';
            document.getElementById('custom-status-add-btn')?.classList.remove('hidden');
        };

        document.getElementById('custom-status-cancel-btn').addEventListener('click', close);
        document.getElementById('custom-status-save-btn').addEventListener('click', () => {
            const label = labelInput.value.trim();
            if (!label) {
                labelInput.focus();
                return;
            }
            upsertCustomStatus({
                id: existing?.id,
                label,
                color: selectedColor,
                baseStatus: selectedBase,
                deafen: selectedDeafen,
                mute: selectedMute,
                dropStreams: document.getElementById('custom-status-dropstreams-toggle').checked,
            });
            close();
            this._renderCustomStatusList();
        });
    }

    /**
     * Wires the avatar picker: "Change photo" opens the hidden file input,
     * "Remove" clears it. The picked file never leaves this method as raw
     * bytes — see _processAvatarFile()'s canvas round-trip.
     * @returns {void}
     */
    _wireAvatar() {
        const pickBtn = document.getElementById('settings-avatar-pick');
        const removeBtn = document.getElementById('settings-avatar-remove');
        const input = document.getElementById('settings-avatar-input');
        if (!pickBtn || !removeBtn || !input) return;

        pickBtn.addEventListener('click', () => input.click());

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.value = ''; // allow re-picking the same file later
            if (!file) return;
            let dataUrl;
            try {
                dataUrl = await this._processAvatarFile(file);
            } catch {
                return; // not a readable image — silently no-op, same as a cancelled picker
            }
            localStorage.setItem('avatarDataUrl', dataUrl);
            this._refreshAvatarPreview();
            this.peerManager?.broadcastAvatar();
            if (this.peerManager?.peerId) {
                this.ui.updateParticipantAvatar(this.peerManager.peerId, dataUrl);
            }
        });

        removeBtn.addEventListener('click', () => {
            localStorage.removeItem('avatarDataUrl');
            this._refreshAvatarPreview();
            this.peerManager?.broadcastAvatar();
            if (this.peerManager?.peerId) {
                this.ui.updateParticipantAvatar(this.peerManager.peerId, '');
            }
        });
    }

    /**
     * Downscales/re-encodes a picked image file through an off-screen
     * canvas before it's ever broadcast — this is the actual security
     * boundary, not just a size optimization. Loading the file into
     * `createImageBitmap` and drawing it never executes embedded script
     * content (browsers treat images as non-executable regardless of
     * format, e.g. an SVG with an embedded `<script>`), and `toDataURL`
     * can only ever emit genuine re-encoded raster bytes in the format we
     * ask for — never SVG/HTML/anything else. Receivers additionally
     * distrust the result (see PeerManager's avatar-update validation) in
     * case a modified client skips this step entirely.
     * @param {File} file
     * @returns {Promise<string>} a `data:image/webp` (or `image/jpeg` fallback) URL.
     */
    async _processAvatarFile(file) {
        const bitmap = await createImageBitmap(file);
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Cover-crop: scale so the shorter side fills `size`, center-crop the rest.
        const scale = Math.max(size / bitmap.width, size / bitmap.height);
        const w = bitmap.width * scale;
        const h = bitmap.height * scale;
        ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
        bitmap.close?.();

        let dataUrl = canvas.toDataURL('image/webp', 0.85);
        // Browsers that can't encode WebP silently fall back to PNG from
        // toDataURL — detect that and force JPEG (smaller than PNG) instead.
        if (!dataUrl.startsWith('data:image/webp')) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        }
        return dataUrl;
    }

    /** Syncs the settings preview circle + Remove button visibility from localStorage. */
    _refreshAvatarPreview() {
        const preview = document.getElementById('settings-avatar-preview');
        const removeBtn = document.getElementById('settings-avatar-remove');
        if (!preview) return;
        const dataUrl = localStorage.getItem('avatarDataUrl');
        if (dataUrl) {
            preview.innerHTML = '';
            const img = document.createElement('img');
            img.src = dataUrl;
            preview.appendChild(img);
            if (removeBtn) removeBtn.style.display = '';
        } else {
            const nickname = localStorage.getItem('nickname') || '?';
            preview.textContent = nickname.charAt(0).toUpperCase();
            if (removeBtn) removeBtn.style.display = 'none';
        }
    }

    _highlightStatus() {
        const current = this.peerManager?.status || 'online';
        this.modal.querySelectorAll('#status-picker .status-pick').forEach(b => {
            const active = b.dataset.status === current;
            b.classList.toggle('ring-1', active);
            b.classList.toggle('ring-indigo-500', active);
        });
    }

    // --- Appearance ---

    _buildAccentSwatches() {
        const container = document.getElementById('settings-accent-picker');
        if (!container) return;
        accentPresetNames().forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-accent-swatch';
            btn.dataset.tip = name.charAt(0).toUpperCase() + name.slice(1);
            btn.dataset.accent = name;
            btn.style.background = presetColor(name);
            btn.innerHTML = '<span class="material-symbols-rounded icon-filled">check</span>';
            btn.addEventListener('click', () => {
                setAccent(name);
                this._refreshAppearance();
            });
            container.appendChild(btn);
        });
    }

    _buildBackgroundSwatches() {
        const container = document.getElementById('settings-bg-picker');
        if (!container) return;
        bgTintPresetNames().forEach(name => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-accent-swatch';
            btn.dataset.tip = name.charAt(0).toUpperCase() + name.slice(1);
            btn.dataset.bg = name;
            btn.style.background = presetBgColor(name);
            btn.innerHTML = '<span class="material-symbols-rounded icon-filled">check</span>';
            btn.addEventListener('click', () => {
                setBackgroundTint(name, getEffectiveTheme() === 'light');
                this._refreshAppearance();
            });
            container.appendChild(btn);
        });
    }

    _wireAppearance() {
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                setTheme(btn.dataset.theme);
                this._refreshAppearance();
            });
        });
    }

    _refreshAppearance() {
        // getEffectiveTheme() always resolves to 'dark'/'light' (it's what
        // actually gets painted) — but the picker also needs to distinguish
        // "explicitly light" from "currently resolves to light via the OS,"
        // so the System button highlights correctly instead of never lighting
        // up. No explicit localStorage['theme'] means the user is following
        // the system preference.
        const current = localStorage.getItem('theme') || 'system';
        this.modal.querySelectorAll('#settings-theme-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === current);
        });

        const currentAccent = getStoredAccent();
        this.modal.querySelectorAll('#settings-accent-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.accent === currentAccent);
        });

        const currentBgTint = getStoredBackgroundTint();
        this.modal.querySelectorAll('#settings-bg-picker button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.bg === currentBgTint);
        });
    }

    /**
     * Wires the "Text size" slider — a flat multiplier on top of the fluid
     * clamp() base font-size (`tailwind.css`'s "Fluid base font-size"
     * section), applied live on every `input` event (not just `change`) so
     * the whole UI visibly rescales while dragging, same immediate-feedback
     * feel as every other Settings control.
     * @returns {void}
     */
    _wireFontScale() {
        const slider = document.getElementById('settings-font-scale');
        const label = document.getElementById('settings-font-scale-value');
        if (!slider) return;

        const current = getStoredFontScale();
        slider.value = String(current);
        if (label) label.textContent = fontScaleLabel(current);

        slider.addEventListener('input', () => {
            const applied = setFontScale(parseFloat(slider.value));
            if (label) label.textContent = fontScaleLabel(applied);
        });
    }

    // --- Screen & Video ---

    _wireSegmented(containerId, storageKey, onApply) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem(storageKey, btn.dataset.value);
                container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
                onApply?.();
            });
        });
    }

    _highlightSegmented(containerId, storageKey, fallback) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const current = localStorage.getItem(storageKey) || fallback;
        container.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.dataset.value === current);
        });
    }

    _wireVideo() {
        this._wireSegmented('settings-res-picker', 'screenShareRes', () => this.peerManager?.applyQualitySettings());
        this._wireSegmented('settings-fps-picker', 'screenShareFps', () => this.peerManager?.applyQualitySettings());
        this._wireSegmented('settings-cam-res-picker', 'camRes', () => this.peerManager?.applyCamQualitySettings());
        this._wireSegmented('settings-cam-fps-picker', 'camFps', () => this.peerManager?.applyCamQualitySettings());

        document.getElementById('settings-follow-speaker')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            localStorage.setItem('followActiveSpeaker', checked ? '1' : '0');
            if (checked && this.ui) this.ui.autoFocusPaused = false; // re-enabling counts as "resume following"
        });

        document.getElementById('settings-audio-only-mode')?.addEventListener('change', (e) => {
            localStorage.setItem('audioOnlyMode', e.target.checked ? '1' : '0');
        });

        // setBackgroundBlur() itself persists the localStorage value and, if the
        // camera is already on, live-swaps the processing pipeline — see PeerManager.js.
        document.getElementById('settings-background-blur')?.addEventListener('change', (e) => {
            this.peerManager?.setBackgroundBlur(e.target.checked);
        });

        // Only takes effect on the *next* share — getDisplayMedia's audio
        // constraint is fixed for the lifetime of an active capture, there's
        // no way to add/drop system audio from a share already in progress.
        document.getElementById('settings-share-system-audio')?.addEventListener('change', (e) => {
            localStorage.setItem('shareSystemAudio', e.target.checked ? '1' : '0');
        });

        document.getElementById('settings-max-messages')?.addEventListener('change', (e) => {
            localStorage.setItem('maxMessages', e.target.value);
        });
    }

    _refreshVideo() {
        this._highlightSegmented('settings-res-picker', 'screenShareRes', '1280x720');
        this._highlightSegmented('settings-fps-picker', 'screenShareFps', '30');
        this._highlightSegmented('settings-cam-res-picker', 'camRes', '640x480');
        this._highlightSegmented('settings-cam-fps-picker', 'camFps', '30');

        const followSpeaker = document.getElementById('settings-follow-speaker');
        if (followSpeaker) followSpeaker.checked = localStorage.getItem('followActiveSpeaker') === '1';

        const audioOnlyMode = document.getElementById('settings-audio-only-mode');
        if (audioOnlyMode) audioOnlyMode.checked = localStorage.getItem('audioOnlyMode') === '1';

        const backgroundBlur = document.getElementById('settings-background-blur');
        if (backgroundBlur) backgroundBlur.checked = localStorage.getItem('backgroundBlur') === '1';

        const shareSystemAudio = document.getElementById('settings-share-system-audio');
        if (shareSystemAudio) shareSystemAudio.checked = localStorage.getItem('shareSystemAudio') === '1';

        const maxMessages = document.getElementById('settings-max-messages');
        if (maxMessages) maxMessages.value = localStorage.getItem('maxMessages') || '100';
    }

    // --- Audio & Mic ---

    _wireAudio() {
        document.getElementById('settings-mute')?.addEventListener('change', (e) => {
            localStorage.setItem('muteSounds', e.target.checked ? '1' : '0');
        });

        // Enabling desktop notifications is the natural moment to ask the
        // browser for permission (a permission prompt out of nowhere at page
        // load would be hostile). If the user denies it — or the browser has
        // it hard-blocked from before — the toggle snaps back off rather than
        // sitting checked-but-inert.
        document.getElementById('settings-desktop-notifications')?.addEventListener('change', async (e) => {
            if (e.target.checked) {
                if (typeof Notification === 'undefined') {
                    e.target.checked = false;
                    this.ui?.showToast?.('This browser doesn\'t support desktop notifications');
                    return;
                }
                let perm = Notification.permission;
                if (perm === 'default') perm = await Notification.requestPermission();
                if (perm !== 'granted') {
                    e.target.checked = false;
                    localStorage.setItem('desktopNotifications', '0');
                    this.ui?.showToast?.('Notifications are blocked — allow them in your browser\'s site settings first');
                    return;
                }
            }
            localStorage.setItem('desktopNotifications', e.target.checked ? '1' : '0');
        });

        document.getElementById('settings-noise-suppression')?.addEventListener('change', (e) => {
            this.peerManager?.setNoiseSuppression(e.target.checked);
        });

        const volume = document.getElementById('settings-volume');
        const volumeValue = document.getElementById('settings-volume-value');
        volume?.addEventListener('input', (e) => {
            if (volumeValue) volumeValue.textContent = `${Math.round(e.target.value * 100)}%`;
            localStorage.setItem('soundVolume', e.target.value);
        });

        const masterVolume = document.getElementById('settings-master-volume');
        const masterVolumeValue = document.getElementById('settings-master-volume-value');
        masterVolume?.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            if (masterVolumeValue) masterVolumeValue.textContent = `${Math.round(value * 100)}%`;
            this.ui?.setMasterCallVolume(value);
        });

        this.modal.querySelectorAll('#settings-mic-mode-picker button').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem('micMode', btn.dataset.micMode);
                this._refreshMicMode();
            });
        });

        const micThreshold = document.getElementById('settings-mic-threshold');
        micThreshold?.addEventListener('input', (e) => {
            localStorage.setItem('micThreshold', e.target.value);
            this._updateMicThresholdLabel(parseFloat(e.target.value));
        });

        const micHoldTime = document.getElementById('settings-mic-hold-time');
        micHoldTime?.addEventListener('input', (e) => {
            localStorage.setItem('micHoldTime', e.target.value);
            this._updateMicHoldTimeLabel(parseFloat(e.target.value));
        });

        document.getElementById('settings-auto-deafen-away')?.addEventListener('change', (e) => {
            localStorage.setItem('autoDeafenOnAway', e.target.checked ? '1' : '0');
        });

        document.getElementById('settings-play-share-audio')?.addEventListener('change', (e) => {
            localStorage.setItem('playShareAudio', e.target.checked ? '1' : '0');
            this.ui?.applyPlayShareAudio();
        });
    }

    // Keys every major browser reserves for its own use and deliberately
    // never lets page JS override via preventDefault (a security/usability
    // guarantee, not a bug) — F11 fullscreen is the one that actually got
    // reported, F5/F12 are the same class of always-wins browser shortcut.
    // Binding one to any action still fires that action, it just *also* does
    // the browser's own thing at the same time.
    _RESERVED_KEYBIND_CODES = new Set(['F11', 'F5', 'F12']);

    // Every bindable action in one declarative list — the single source of
    // truth for the Keybinds tab's rows (see _wireKeybinds/_refreshKeybinds).
    // Adding a future action (e.g. a camera or screen-share toggle) means
    // adding one entry here, not a hand-copied markup block.
    _KEYBIND_ACTIONS = [
        {
            id: 'pushToTalk', storageKey: 'keybindPushToTalk', label: 'Push to Talk',
            desc: 'Hold to open your mic. Active while Mic Mode (Audio & Mic) is set to Push to Talk.',
        },
        {
            id: 'pushToMute', storageKey: 'keybindPushToMute', label: 'Push to Mute',
            desc: 'Hold to force-mute, even mid-speech in Voice Activity mode. Active while Mic Mode is Toggle or Voice Activity.',
        },
        {
            id: 'toggleMute', storageKey: 'keybindToggleMute', label: 'Toggle Mute',
            desc: 'Tap to mute/unmute your mic — same as clicking the mic button. Works in any mic mode.',
        },
        {
            id: 'toggleDeafen', storageKey: 'deafenKeybind', label: 'Toggle Deafen',
            desc: 'Instantly mutes your mic and incoming audio — tap again to undo.',
        },
    ];

    // Shared click-then-press-a-key capture, used for every row in the
    // Keybinds tab — previously this exact sequence (click primes listening,
    // keydown captures+persists, blur reverts an abandoned capture) was
    // hand-duplicated per field, which is exactly how the mic/deafen copies
    // drifted (one had a reserved-key warning, the other didn't).
    _wireKeybindCapture(input, clearBtn, storageKey, hintEl) {
        if (input) {
            input.addEventListener('click', () => {
                this._keybindListening = true;
                input.value = 'Press a key...';
                input.classList.add('ring-1', 'ring-indigo-500');
            });

            input.addEventListener('keydown', (e) => {
                if (!this._keybindListening) return;
                e.preventDefault();
                e.stopPropagation();
                localStorage.setItem(storageKey, e.code);
                input.value = e.code;
                input.classList.remove('ring-1', 'ring-indigo-500');
                this._keybindListening = false;
                this._updateKeybindWarning(hintEl, e.code);
            });

            input.addEventListener('blur', () => {
                if (this._keybindListening) {
                    input.value = localStorage.getItem(storageKey) || '';
                    input.classList.remove('ring-1', 'ring-indigo-500');
                    this._keybindListening = false;
                }
            });
        }

        clearBtn?.addEventListener('click', () => {
            localStorage.setItem(storageKey, '');
            if (input) input.value = '';
            this._updateKeybindWarning(hintEl, '');
        });
    }

    _updateKeybindWarning(hintEl, code) {
        if (!hintEl) return;
        if (this._RESERVED_KEYBIND_CODES.has(code)) {
            hintEl.textContent = `${code} is reserved by your browser (fullscreen/reload/devtools) and can't be fully overridden — it'll still fire this action, but the browser's own shortcut will fire too. Pick a different key if that's a problem.`;
            hintEl.classList.add('text-yellow-400');
        } else {
            hintEl.textContent = hintEl.dataset.defaultHint || '';
            hintEl.classList.remove('text-yellow-400');
        }
    }

    // --- Keybinds ---

    _wireKeybinds() {
        const list = document.getElementById('keybinds-list');
        if (!list) return;
        this._KEYBIND_ACTIONS.forEach(action => {
            const row = document.createElement('div');
            row.className = 'settings-toggle-row';
            row.innerHTML = `
                <div>
                    <div class="settings-toggle-row-title">${action.label}</div>
                    <div class="settings-toggle-row-desc" id="keybind-hint-${action.id}">${action.desc}</div>
                </div>
                <div class="settings-keybind-row settings-keybind-row-compact">
                    <input type="text" id="keybind-input-${action.id}" readonly class="settings-keybind-input"
                        placeholder="Click then press a key..." />
                    <button type="button" id="keybind-clear-${action.id}"
                        class="text-xs text-muted hover:text-foreground px-2 py-1">&times;</button>
                </div>`;
            list.appendChild(row);

            const hintEl = row.querySelector(`#keybind-hint-${action.id}`);
            hintEl.dataset.defaultHint = action.desc;
            this._wireKeybindCapture(
                row.querySelector(`#keybind-input-${action.id}`),
                row.querySelector(`#keybind-clear-${action.id}`),
                action.storageKey,
                hintEl,
            );
        });
    }

    _refreshKeybinds() {
        this._KEYBIND_ACTIONS.forEach(action => {
            const input = document.getElementById(`keybind-input-${action.id}`);
            if (input) input.value = localStorage.getItem(action.storageKey) || '';
            this._updateKeybindWarning(document.getElementById(`keybind-hint-${action.id}`), localStorage.getItem(action.storageKey) || '');
        });
    }

    _refreshMicMode() {
        // A 'ptt' room rule overrides the personal preference: the picker shows
        // (and every mode-dependent row follows) the enforced push-to-talk mode,
        // with the buttons disabled and a "Room rule" note explaining why. The
        // stored localStorage preference is never modified. On the lobby (no
        // peerManager) this is always unenforced.
        const enforced = this.peerManager?.micPolicy === 'ptt';
        const micMode = enforced ? 'push-to-talk' : (localStorage.getItem('micMode') || 'toggle');
        this.modal.querySelectorAll('#settings-mic-mode-picker button').forEach(b => {
            b.classList.toggle('active', b.dataset.micMode === micMode);
            b.disabled = enforced;
        });
        const ruleNote = document.getElementById('settings-mic-room-rule');
        if (ruleNote) ruleNote.style.display = enforced ? '' : 'none';

        const thresholdRow = document.getElementById('mic-threshold-row');
        if (thresholdRow) thresholdRow.classList.toggle('hidden', micMode !== 'voice-activity');
        const threshold = parseFloat(localStorage.getItem('micThreshold')) || 0.03;
        const thresholdInput = document.getElementById('settings-mic-threshold');
        if (thresholdInput) thresholdInput.value = String(threshold);
        this._updateMicThresholdLabel(threshold);

        const holdTimeRow = document.getElementById('mic-hold-time-row');
        if (holdTimeRow) holdTimeRow.classList.toggle('hidden', micMode !== 'voice-activity');
        const holdTime = parseFloat(localStorage.getItem('micHoldTime')) || 400;
        const holdTimeInput = document.getElementById('settings-mic-hold-time');
        if (holdTimeInput) holdTimeInput.value = String(holdTime);
        this._updateMicHoldTimeLabel(holdTime);

        const meterRow = document.getElementById('mic-meter-row');
        // Also hidden without peerManager (lobby) — there's no live mic
        // stream to meter there, and `_startMicMeter()` already no-ops in
        // that case, so an unhidden-but-static meter would just look broken.
        if (meterRow) meterRow.classList.toggle('hidden', micMode !== 'voice-activity' || !this.peerManager);

        this.ui?.updateMicModeBadge?.(micMode);
    }

    // Live mic-level meter + threshold marker, shown alongside the sensitivity
    // slider (voice-activity mode only) so tuning it isn't guesswork — speak
    // and watch where your level actually sits relative to the line. Runs for
    // as long as the Settings panel is open (cheap: one interval, one DOM
    // write), not just while the Audio & Mic section is the active tab.
    _startMicMeter() {
        this._stopMicMeter();
        if (!this.peerManager) return;
        this._micMeterInterval = setInterval(() => this._updateMicMeter(), 100);
        this._updateMicMeter();
    }

    _stopMicMeter() {
        if (this._micMeterInterval) {
            clearInterval(this._micMeterInterval);
            this._micMeterInterval = null;
        }
    }

    _updateMicMeter() {
        const fill = document.getElementById('mic-meter-fill');
        const thresholdLine = document.getElementById('mic-meter-threshold-line');
        const hint = document.getElementById('mic-meter-hint');
        if (!fill) return;

        // Rough ceiling for a normal speaking voice's RMS level on this
        // analyser (see PeerManager._localMicLevel) — not a hard limit, just
        // what maps to a "full" bar for a readable meter.
        const METER_MAX = 0.3;
        const threshold = parseFloat(localStorage.getItem('micThreshold')) || 0.03;
        if (thresholdLine) thresholdLine.style.left = `${Math.min(1, threshold / METER_MAX) * 100}%`;

        const hasLiveMic = !!this.peerManager?.micStream && this.peerManager.micEnabled;
        if (!hasLiveMic) {
            fill.style.width = '0%';
            fill.classList.remove('mic-meter-fill-active');
            if (hint) hint.textContent = 'Turn on your mic to see live levels while you tune this.';
            return;
        }

        const { level, speaking } = this.peerManager.pollSelfMicActivity();
        fill.style.width = `${Math.min(1, level / METER_MAX) * 100}%`;
        fill.classList.toggle('mic-meter-fill-active', speaking);
        if (hint) hint.textContent = "Speak normally — the bar should clear the vertical line while talking and settle below it at rest.";
    }

    _updateMicThresholdLabel(threshold) {
        const label = document.getElementById('settings-mic-threshold-value');
        if (!label) return;
        label.textContent = threshold <= 0.02 ? 'High' : threshold <= 0.06 ? 'Medium' : 'Low';
    }

    _updateMicHoldTimeLabel(ms) {
        const label = document.getElementById('settings-mic-hold-time-value');
        if (!label) return;
        label.textContent = `${(ms / 1000).toFixed(2).replace(/0$/, '')}s`;
    }

    _refreshAudio() {
        const mute = document.getElementById('settings-mute');
        if (mute) mute.checked = localStorage.getItem('muteSounds') === '1';

        // Reflects the stored preference AND current browser permission — a
        // permission revoked in site settings since the toggle was enabled
        // shows as off (matching what will actually happen), not checked-but-dead.
        const desktopNotifs = document.getElementById('settings-desktop-notifications');
        if (desktopNotifs) {
            desktopNotifs.checked = localStorage.getItem('desktopNotifications') === '1'
                && typeof Notification !== 'undefined' && Notification.permission === 'granted';
        }

        const noiseSuppression = document.getElementById('settings-noise-suppression');
        if (noiseSuppression) noiseSuppression.checked = localStorage.getItem('noiseSuppression') === '1';

        const autoDeafenAway = document.getElementById('settings-auto-deafen-away');
        if (autoDeafenAway) autoDeafenAway.checked = localStorage.getItem('autoDeafenOnAway') === '1';

        const playShareAudio = document.getElementById('settings-play-share-audio');
        if (playShareAudio) playShareAudio.checked = localStorage.getItem('playShareAudio') === '1';

        const vol = localStorage.getItem('soundVolume') || '0.3';
        const volume = document.getElementById('settings-volume');
        const volumeValue = document.getElementById('settings-volume-value');
        if (volume) volume.value = vol;
        if (volumeValue) volumeValue.textContent = `${Math.round(vol * 100)}%`;

        const masterVol = this.ui?.masterCallVolume ?? 1;
        const masterVolume = document.getElementById('settings-master-volume');
        const masterVolumeValue = document.getElementById('settings-master-volume-value');
        if (masterVolume) masterVolume.value = String(masterVol);
        if (masterVolumeValue) masterVolumeValue.textContent = `${Math.round(masterVol * 100)}%`;

        this._refreshMicMode();
    }

    // --- Privacy & P2P ---

    _wirePrivacy() {
        document.getElementById('settings-auto-accept-files')?.addEventListener('change', (e) => {
            localStorage.setItem('autoAcceptFiles', e.target.checked ? '1' : '0');
        });

        const historyToggle = document.getElementById('settings-chat-history-enabled');
        const daysField = document.getElementById('chat-history-days-field');
        historyToggle?.addEventListener('change', (e) => {
            localStorage.setItem('chatHistoryEnabled', e.target.checked ? '1' : '0');
            daysField?.classList.toggle('hidden', !e.target.checked);
        });
        document.getElementById('settings-chat-history-days')?.addEventListener('change', (e) => {
            localStorage.setItem('chatHistoryDays', e.target.value);
        });

        // Lighter-weight sibling of "Clear all local data" below — wipes only
        // chatHistoryStore.js's IndexedDB data, not every other preference.
        // Same two-step armed-confirm pattern as that button.
        const clearHistoryBtn = document.getElementById('settings-clear-chat-history');
        if (clearHistoryBtn) {
            const defaultLabel = clearHistoryBtn.textContent;
            let confirming = false;
            let resetTimer = null;

            clearHistoryBtn.addEventListener('click', () => {
                if (!confirming) {
                    confirming = true;
                    clearHistoryBtn.textContent = 'Click again to confirm';
                    clearHistoryBtn.classList.add('confirming');
                    resetTimer = setTimeout(() => {
                        confirming = false;
                        clearHistoryBtn.textContent = defaultLabel;
                        clearHistoryBtn.classList.remove('confirming');
                    }, 4000);
                    return;
                }

                clearTimeout(resetTimer);
                chatHistoryStore.clearAll();
                confirming = false;
                clearHistoryBtn.classList.remove('confirming');
                clearHistoryBtn.textContent = 'Cleared';
                this.ui?.showToast?.('Chat history cleared', 'info');
                setTimeout(() => (clearHistoryBtn.textContent = defaultLabel), 1500);
            });
        }

        // No confirm-before-destructive-action pattern exists elsewhere in the
        // app to reuse (removing a saved room / kicking a peer both fire
        // immediately) — this is a two-step "click again to confirm" button
        // rather than a native confirm() dialog, to stay in the app's own
        // visual language instead of a jarring native popup.
        const clearBtn = document.getElementById('settings-clear-data');
        if (clearBtn) {
            const defaultLabel = clearBtn.textContent;
            let confirming = false;
            let resetTimer = null;

            clearBtn.addEventListener('click', () => {
                if (!confirming) {
                    confirming = true;
                    clearBtn.textContent = 'Click again to confirm';
                    clearBtn.classList.add('confirming');
                    resetTimer = setTimeout(() => {
                        confirming = false;
                        clearBtn.textContent = defaultLabel;
                        clearBtn.classList.remove('confirming');
                    }, 4000);
                    return;
                }

                clearTimeout(resetTimer);
                localStorage.clear();
                chatHistoryStore.clearAll();
                clearBtn.textContent = 'Cleared — reloading...';
                this.ui?.showToast?.('Local data cleared', 'info');
                setTimeout(() => window.location.reload(), 600);
            });
        }
    }

    _refreshPrivacy() {
        const autoAccept = document.getElementById('settings-auto-accept-files');
        if (autoAccept) autoAccept.checked = localStorage.getItem('autoAcceptFiles') === '1';

        const historyToggle = document.getElementById('settings-chat-history-enabled');
        const historyEnabled = localStorage.getItem('chatHistoryEnabled') === '1';
        if (historyToggle) historyToggle.checked = historyEnabled;
        document.getElementById('chat-history-days-field')?.classList.toggle('hidden', !historyEnabled);
        const daysSelect = document.getElementById('settings-chat-history-days');
        if (daysSelect) daysSelect.value = localStorage.getItem('chatHistoryDays') || '7';
    }
}
