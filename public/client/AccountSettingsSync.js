// --- public/client/AccountSettingsSync.js ---
// Accounts Phase 1c/1d: syncs a small, fixed set of client preferences to a
// logged-in account. Circular import with ThemeManager.js/AccentManager.js/
// BackgroundManager.js is intentional and safe — every use here happens
// inside a function body invoked later, never at module-evaluation time, so
// both sides are fully initialized by the time either calls into the other.
// Don't "fix" this cycle.
import { setTheme, getEffectiveTheme } from './ThemeManager.js';
import { setAccent } from './AccentManager.js';
import { setBackgroundTint } from './BackgroundManager.js';

// Account-wide (Phase 1c) — meaningful on every device, so one shared value
// per account is correct here.
const GLOBAL_KEYS = ['theme', 'accentHue', 'bgTint'];
// Per-(user,device) (Phase 1d) — a camera/mic/speaker id is only meaningful
// on the physical machine it was picked on. Syncing these account-wide (the
// original Phase 1c behavior) meant a phone and a desktop under the same
// account constantly overwrote each other's pick — see peekDeviceId below.
const DEVICE_KEYS = ['camDeviceId', 'micDeviceId', 'speakerDeviceId'];
const DEBOUNCE_MS = 750;

// Fetched once per page load, not per call — avoids a guaranteed-404 PUT on
// every color-scheme/device change on a deployment that never turned
// accounts on, mirroring AccountPanel.js's own /api/trust gate.
let accountsEnabled = false;
const trustReady = fetch('/api/trust').then(r => r.json()).then(t => { accountsEnabled = !!t.accounts; }).catch(() => {});

let pendingTimer = null;

// Identifies THIS browser install, not the current login session —
// deliberately never cleared on logout, so it keeps meaning "this
// phone"/"this desktop" regardless of which account (or none) is currently
// using it. Same opaque-random-token-in-localStorage shape as creatorToken/
// session tokens elsewhere in this app, just with no server-side validation
// needed (it's a grouping key, not a credential).
function getOrCreateDeviceId() {
    let id = localStorage.getItem('peekDeviceId');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('peekDeviceId', id);
    }
    return id;
}

// Reads fresh off localStorage at push time — the caller's setter runs
// synchronously before this fires, so this always reflects what's actually
// live, matching every other "read localStorage at point of use" call site
// in this codebase (e.g. toggleCam()'s own localStorage.getItem calls).
function collectLocal(keys) {
    const out = {};
    for (const key of keys) {
        const v = localStorage.getItem(key);
        // `!== null`, not a truthy check: micDeviceId/speakerDeviceId
        // legitimately store '' to mean "explicit system default" — a
        // truthy check would silently drop that preference from every push.
        if (v !== null) out[key] = v;
    }
    return out;
}

// Fires both requests together whenever anything synced changes, rather
// than tracking which of the two buckets a given change belongs to — both
// payloads are tiny, and this keeps syncPreference() a single, uniform
// choke point for all 6 setters.
function pushNow() {
    fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: collectLocal(GLOBAL_KEYS) }),
        keepalive: true,
    }).catch(() => {}); // best-effort: 401 (not logged in) or a network error both silently no-op

    fetch('/api/auth/device-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: getOrCreateDeviceId(), settings: collectLocal(DEVICE_KEYS) }),
        keepalive: true,
    }).catch(() => {});
}

/** Call after any of the 6 synced setters changes localStorage. Debounced and coalesced — a burst of swatch clicks becomes one pair of requests. */
export function syncPreference() {
    if (!accountsEnabled) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; pushNow(); }, DEBOUNCE_MS);
}

/**
 * Call after SettingsPanel.js's avatar picker sets or clears
 * `localStorage['avatarDataUrl']` (2026-09-10, owner-reported: a locally-set
 * avatar never carried over into an account, so DMs — which have no P2P
 * broadcast to fall back on — showed initials only even for an account
 * whose owner clearly had a custom avatar set). Deliberately NOT bundled
 * into `syncPreference()`/`pushNow()` above: an avatar data URL can be up to
 * ~40,000 chars (a real photo, not a tiny string), so resending it on every
 * unrelated theme/accent/device change would be wasteful — this fires its
 * own request instead, immediately (no debounce needed — an avatar pick is
 * a deliberate one-off action, not a rapid-fire slider like accent swatches).
 * @returns {void}
 */
export function syncAvatar() {
    if (!accountsEnabled) return;
    fetch('/api/auth/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: localStorage.getItem('avatarDataUrl') || null }),
        keepalive: true,
    }).catch(() => {}); // best-effort: 401 (not logged in) or a network error both silently no-op
}

// Flushes a pending debounced push when the tab is going away — otherwise a
// swatch click immediately followed by closing the tab loses that final
// change. 'pagehide' (not 'beforeunload', which defeats bfcache) +
// keepalive:true is the standard flush-on-unload pattern.
// Guarded so this module can be imported by the repo's Node-based pure-logic
// tests (pulled in transitively via PeerManager.js) without a real browser's
// document global.
if (typeof document !== 'undefined') {
    document.addEventListener('pagehide', () => {
        if (!pendingTimer) return;
        clearTimeout(pendingTimer);
        pendingTimer = null;
        if (accountsEnabled) pushNow();
    });
}

/** Called right after login/register and on every already-logged-in page load. */
export async function pullAndApplySettings() {
    await trustReady;
    if (!accountsEnabled) return;

    // Three independent bootstrap checks, not one: an account might already
    // have global settings from a previous device's first login, while THIS
    // device has never saved its own device-settings row yet (or vice
    // versa), and separately again for the avatar (2026-09-10) — a room-only
    // avatar set before ever registering has nowhere else to have reached
    // the account from.
    const [globalSettings, deviceSettings, avatarResult] = await Promise.all([
        fetch('/api/auth/settings').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/auth/device-settings?deviceId=${encodeURIComponent(getOrCreateDeviceId())}`)
            .then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/auth/avatar').then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    let bootstrapNeeded = false;
    let avatarBootstrapNeeded = false;

    if (globalSettings === null) {
        // 401 or network error — leave local state as-is.
    } else if (Object.keys(globalSettings).length === 0) {
        bootstrapNeeded = true; // nothing saved for this account yet
    } else {
        if (globalSettings.theme) setTheme(globalSettings.theme);
        if (globalSettings.accentHue) setAccent(globalSettings.accentHue);
        if (globalSettings.bgTint) setBackgroundTint(globalSettings.bgTint, getEffectiveTheme() === 'light');
    }

    if (deviceSettings === null) {
        // 401 or network error — leave local state as-is.
    } else if (Object.keys(deviceSettings).length === 0) {
        bootstrapNeeded = true; // nothing saved for THIS device yet
    } else {
        // No PeerManager/UIController exists on the lobby page to hot-apply
        // these to — a plain write is enough; toggleCam()/toggleMic() pick
        // it up the next time this browser actually opens that device, same
        // as an existing local device switch made while the device is off.
        // `!== undefined`, not truthy: an explicit "" (system default)
        // pulled from the account must actually apply, not be skipped.
        if (deviceSettings.camDeviceId !== undefined) localStorage.setItem('camDeviceId', deviceSettings.camDeviceId);
        if (deviceSettings.micDeviceId !== undefined) localStorage.setItem('micDeviceId', deviceSettings.micDeviceId);
        if (deviceSettings.speakerDeviceId !== undefined) localStorage.setItem('speakerDeviceId', deviceSettings.speakerDeviceId);
    }

    if (avatarResult === null) {
        // 401 or network error — leave local state as-is.
    } else if (!avatarResult.avatar) {
        // Account has no avatar saved yet — if this device already has a
        // local one (the exact gap that prompted this feature: a room-only
        // avatar set before ever registering, or set on a device that never
        // pushed it up), push it as a one-time bootstrap instead of the
        // account silently staying avatar-less forever.
        if (localStorage.getItem('avatarDataUrl')) avatarBootstrapNeeded = true;
    } else {
        // The account already has one — it's the cross-device source of
        // truth, so it wins over whatever (if anything) this device had.
        localStorage.setItem('avatarDataUrl', avatarResult.avatar);
    }

    if (bootstrapNeeded) syncPreference();
    if (avatarBootstrapNeeded) syncAvatar();
}
