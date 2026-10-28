/**
 * Scheduled mic settings — time windows during which noise suppression, mic
 * mode and/or mic sensitivity switch to different values (e.g. a noisy
 * household in the evening, a quiet room during the day). Pure client-side
 * preference data, same tier as CustomStatuses.js — no server involvement.
 *
 * Semantics (deliberate): a schedule is applied once, at the moment its window
 * starts. A manual change made during the window holds until the next
 * scheduled switch. When the window ends, the settings that were in effect
 * just before it started (the "baseline") are restored.
 *
 * State lives in localStorage so it survives a reload mid-window without
 * re-applying over a manual change:
 *   micSchedules          — the user's schedule list
 *   micScheduleActiveId   — id of the window currently applied ('' = none)
 *   micScheduleBaseline   — settings snapshot taken when entering a window
 */

const SCHEDULES_KEY = 'micSchedules';
const ACTIVE_KEY = 'micScheduleActiveId';
const BASELINE_KEY = 'micScheduleBaseline';
export const MAX_MIC_SCHEDULES = 8;
const MIC_MODES = ['toggle', 'push-to-talk', 'voice-activity'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_THRESHOLD = 0.03;

/** Sensitivity levels offered by the schedule editor — the same 10 steps as
 * Settings' slider (0.01-0.10, lower = more sensitive). */
export const SENSITIVITY_LEVELS = Array.from({ length: 10 }, (_, i) => Number(((i + 1) / 100).toFixed(2)));

function _sanitize(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null;
    return {
        id: s.id,
        label: typeof s.label === 'string' ? s.label.slice(0, 40) : '',
        enabled: s.enabled !== false,
        start: TIME_RE.test(s.start) ? s.start : '18:00',
        end: TIME_RE.test(s.end) ? s.end : '23:00',
        // Each setting is optional: null = leave it as whatever the baseline is.
        noiseSuppression: typeof s.noiseSuppression === 'boolean' ? s.noiseSuppression : null,
        micMode: MIC_MODES.includes(s.micMode) ? s.micMode : null,
        micThreshold: Number.isFinite(s.micThreshold) && s.micThreshold >= 0.01 && s.micThreshold <= 0.1 ? s.micThreshold : null,
    };
}

/** @returns {Array<object>} the stored schedules, validated. */
export function getMicSchedules() {
    try {
        const raw = JSON.parse(localStorage.getItem(SCHEDULES_KEY) || '[]');
        return Array.isArray(raw) ? raw.map(_sanitize).filter(Boolean).slice(0, MAX_MIC_SCHEDULES) : [];
    } catch {
        return [];
    }
}

/**
 * Persists the list and tells a running scheduler to re-evaluate immediately
 * (an edit to the active window re-applies it — editing is an explicit act).
 * @param {Array<object>} list
 */
export function saveMicSchedules(list) {
    localStorage.setItem(SCHEDULES_KEY, JSON.stringify(list.map(_sanitize).filter(Boolean).slice(0, MAX_MIC_SCHEDULES)));
    window.dispatchEvent(new CustomEvent('peek:mic-schedules-changed'));
}

/** @returns {object} a new enabled schedule with every setting left unchanged. */
export function newMicSchedule() {
    return _sanitize({ id: `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, label: '', enabled: true, start: '18:00', end: '23:00' });
}

function _minutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Whether `date` falls inside the window — end-exclusive, and a window whose
 * end is before its start wraps past midnight (e.g. 22:00 → 07:00).
 * start === end is treated as empty, not all-day.
 */
export function isInWindow(schedule, date) {
    const now = date.getHours() * 60 + date.getMinutes();
    const start = _minutes(schedule.start);
    const end = _minutes(schedule.end);
    if (start === end) return false;
    return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

/** @returns {object|null} the first enabled schedule covering `date`. */
export function activeMicSchedule(list, date = new Date()) {
    return list.find(s => s.enabled && isInWindow(s, date)) || null;
}

/** The current values of every schedulable setting. */
function _snapshot() {
    return {
        noiseSuppression: localStorage.getItem('noiseSuppression') === '1',
        micMode: MIC_MODES.includes(localStorage.getItem('micMode')) ? localStorage.getItem('micMode') : 'toggle',
        micThreshold: parseFloat(localStorage.getItem('micThreshold')) || DEFAULT_THRESHOLD,
    };
}

function _readBaseline() {
    try {
        const b = JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null');
        if (!b || typeof b !== 'object') return null;
        return {
            noiseSuppression: !!b.noiseSuppression,
            micMode: MIC_MODES.includes(b.micMode) ? b.micMode : 'toggle',
            micThreshold: Number.isFinite(b.micThreshold) ? b.micThreshold : DEFAULT_THRESHOLD,
        };
    } catch {
        return null;
    }
}

/**
 * Evaluates the schedule and, on a window transition (or `force`), calls
 * `apply(settings, schedule)` with the full target settings — `schedule` is
 * null when restoring the baseline.
 * @param {(settings: object, schedule: object|null) => void} apply
 * @param {boolean} [force=false]
 */
export function evaluateMicSchedule(apply, force = false, date = new Date()) {
    const active = activeMicSchedule(getMicSchedules(), date);
    const activeId = active?.id || '';
    const prevId = localStorage.getItem(ACTIVE_KEY) || '';
    if (activeId === prevId && !force) return;

    const baseline = _readBaseline();
    if (!active) {
        localStorage.removeItem(ACTIVE_KEY);
        if (!baseline) return;
        localStorage.removeItem(BASELINE_KEY);
        apply(baseline, null);
        return;
    }

    // Only snapshot on the way IN from unscheduled time — moving straight from
    // one window to another keeps the original baseline, so the end of the
    // second window still restores what you had before the first.
    const base = baseline || _snapshot();
    if (!baseline) localStorage.setItem(BASELINE_KEY, JSON.stringify(base));
    localStorage.setItem(ACTIVE_KEY, activeId);
    apply({
        noiseSuppression: active.noiseSuppression ?? base.noiseSuppression,
        micMode: active.micMode ?? base.micMode,
        micThreshold: active.micThreshold ?? base.micThreshold,
    }, active);
}

/**
 * Runs the scheduler: immediately, every 30s, when the tab becomes visible
 * again, and whenever the schedule list is edited.
 * @param {(settings: object, schedule: object|null) => void} apply
 * @returns {() => void} stop
 */
export function startMicScheduler(apply) {
    const tick = () => evaluateMicSchedule(apply);
    const onEdit = () => evaluateMicSchedule(apply, true);
    const onVisible = () => { if (!document.hidden) tick(); };
    tick();
    const interval = setInterval(tick, 30000);
    window.addEventListener('peek:mic-schedules-changed', onEdit);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
        clearInterval(interval);
        window.removeEventListener('peek:mic-schedules-changed', onEdit);
        document.removeEventListener('visibilitychange', onVisible);
    };
}
