// --- public/client/AccountSettingsSync.js ---
// Accounts Phase 1c: syncs a small, fixed set of client preferences (color
// scheme + device selection) to a logged-in account. Circular import with
// ThemeManager.js/AccentManager.js/BackgroundManager.js is intentional and
// safe — every use here happens inside a function body invoked later, never
// at module-evaluation time, so both sides are fully initialized by the time
// either calls into the other. Don't "fix" this cycle.
import { setTheme, getEffectiveTheme } from './ThemeManager.js';
import { setAccent } from './AccentManager.js';
import { setBackgroundTint } from './BackgroundManager.js';

const SYNC_KEYS = ['theme', 'accentHue', 'bgTint', 'camDeviceId', 'micDeviceId', 'speakerDeviceId'];
const DEBOUNCE_MS = 750;

// Fetched once per page load, not per call — avoids a guaranteed-404 PUT on
// every color-scheme/device change on a deployment that never turned
// accounts on, mirroring AccountPanel.js's own /api/trust gate.
let accountsEnabled = false;
const trustReady = fetch('/api/trust').then(r => r.json()).then(t => { accountsEnabled = !!t.accounts; }).catch(() => {});

let pendingTimer = null;

// Reads fresh off localStorage at push time — the caller's setter runs
// synchronously before this fires, so this always reflects what's actually
// live, matching every other "read localStorage at point of use" call site
// in this codebase (e.g. toggleCam()'s own localStorage.getItem calls).
function collectLocal() {
    const out = {};
    for (const key of SYNC_KEYS) {
        const v = localStorage.getItem(key);
        // `!== null`, not a truthy check: micDeviceId/speakerDeviceId
        // legitimately store '' to mean "explicit system default" — a
        // truthy check would silently drop that preference from every push.
        if (v !== null) out[key] = v;
    }
    return out;
}

function pushNow() {
    fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: collectLocal() }),
        keepalive: true,
    }).catch(() => {}); // best-effort: 401 (not logged in) or a network error both silently no-op
}

/** Call after any of the 6 synced setters changes localStorage. Debounced and coalesced — a burst of swatch clicks becomes one request. */
export function syncPreference() {
    if (!accountsEnabled) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { pendingTimer = null; pushNow(); }, DEBOUNCE_MS);
}

// Flushes a pending debounced push when the tab is going away — otherwise a
// swatch click immediately followed by closing the tab loses that final
// change. 'pagehide' (not 'beforeunload', which defeats bfcache) +
// keepalive:true is the standard flush-on-unload pattern.
document.addEventListener('pagehide', () => {
    if (!pendingTimer) return;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    if (accountsEnabled) pushNow();
});

/** Called right after login/register and on every already-logged-in page load. */
export async function pullAndApplySettings() {
    await trustReady;
    if (!accountsEnabled) return;

    const settings = await fetch('/api/auth/settings').then(r => r.ok ? r.json() : null).catch(() => null);
    if (!settings) return; // 401 or network error — leave local state as-is

    if (Object.keys(settings).length === 0) {
        // First login ever for this account, nothing saved yet — bootstrap
        // the account from whatever this browser already has instead of
        // leaving an empty settings blob after the very first login.
        syncPreference();
        return;
    }

    if (settings.theme) setTheme(settings.theme);
    if (settings.accentHue) setAccent(settings.accentHue);
    if (settings.bgTint) setBackgroundTint(settings.bgTint, getEffectiveTheme() === 'light');

    // Device IDs: no PeerManager/UIController exists on the lobby page to
    // hot-apply these to — a plain write is enough; toggleCam()/toggleMic()
    // pick it up the next time this browser actually opens that device,
    // same as an existing local device switch made while the device is off.
    // `!== undefined`, not truthy: an explicit "" (system default) pulled
    // from the account must actually apply, not be skipped.
    if (settings.camDeviceId !== undefined) localStorage.setItem('camDeviceId', settings.camDeviceId);
    if (settings.micDeviceId !== undefined) localStorage.setItem('micDeviceId', settings.micDeviceId);
    if (settings.speakerDeviceId !== undefined) localStorage.setItem('speakerDeviceId', settings.speakerDeviceId);
}
