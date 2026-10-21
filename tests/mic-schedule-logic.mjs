// Pure logic test for MicSchedule.js — no browser needed. Covers window
// matching (incl. past-midnight wrap), apply-once-per-window, manual changes
// holding until the next switch, baseline restore, window-to-window handoff
// keeping the original baseline, and forced re-apply on edit.

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
};
globalThis.window = { dispatchEvent: () => {} };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };

const { isInWindow, evaluateMicSchedule, saveMicSchedules, getMicSchedules } = await import('../public/client/MicSchedule.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(2026, 0, 1); d.setHours(h, m, 0, 0); return d; };

// Apply callback that writes back to storage the way App.js's does.
const applied = [];
const apply = (settings, schedule) => {
    applied.push({ settings, id: schedule?.id ?? null });
    localStorage.setItem('noiseSuppression', settings.noiseSuppression ? '1' : '0');
    localStorage.setItem('micMode', settings.micMode);
    localStorage.setItem('micThreshold', String(settings.micThreshold));
};

// --- window matching ---
{
    const day = { start: '09:00', end: '17:00' };
    assert(isInWindow(day, at('09:00')), 'start is inclusive');
    assert(!isInWindow(day, at('17:00')), 'end is exclusive');
    assert(!isInWindow(day, at('08:59')), 'before start is outside');
    const night = { start: '22:00', end: '07:00' };
    assert(isInWindow(night, at('23:30')) && isInWindow(night, at('06:59')), 'overnight window wraps midnight');
    assert(!isInWindow(night, at('12:00')), 'overnight window excludes midday');
    assert(!isInWindow({ start: '10:00', end: '10:00' }, at('10:00')), 'start === end is empty');
}

// --- apply once, manual change holds, baseline restored ---
{
    storage.clear();
    localStorage.setItem('noiseSuppression', '0');
    localStorage.setItem('micMode', 'toggle');
    localStorage.setItem('micThreshold', '0.03');
    saveMicSchedules([{ id: 'eve', label: 'Evening', enabled: true, start: '18:00', end: '23:00', noiseSuppression: true, micMode: null, micThreshold: 0.07 }]);
    assert(getMicSchedules().length === 1, 'schedule persisted');

    evaluateMicSchedule(apply, false, at('12:00'));
    assert(applied.length === 0, 'nothing applied outside any window with no baseline');

    evaluateMicSchedule(apply, false, at('18:00'));
    assert(applied.length === 1 && applied[0].id === 'eve', 'window start applies the schedule');
    assert(applied[0].settings.noiseSuppression === true && applied[0].settings.micThreshold === 0.07, 'scheduled values applied');
    assert(applied[0].settings.micMode === 'toggle', 'unset field keeps the baseline value');

    localStorage.setItem('noiseSuppression', '0'); // manual change mid-window
    evaluateMicSchedule(apply, false, at('19:00'));
    assert(applied.length === 1, 'no re-apply within the same window (manual change holds)');

    evaluateMicSchedule(apply, false, at('23:00'));
    assert(applied.length === 2 && applied[1].id === null, 'window end restores the baseline');
    assert(applied[1].settings.noiseSuppression === false && applied[1].settings.micThreshold === 0.03, 'baseline values restored');
    assert(localStorage.getItem('micScheduleBaseline') === null, 'baseline cleared after restore');
}

// --- reload mid-window doesn't re-apply ---
{
    applied.length = 0;
    evaluateMicSchedule(apply, false, at('20:00'));
    localStorage.setItem('micMode', 'voice-activity'); // manual
    evaluateMicSchedule(apply, false, at('20:30')); // simulated fresh page load: same persisted active id
    assert(applied.length === 1, 'a reload mid-window does not re-apply over a manual change');
    evaluateMicSchedule(apply, true, at('20:30'));
    assert(applied.length === 2, 'force (schedule edited) re-applies');
    evaluateMicSchedule(apply, false, at('23:30'));
}

// --- back-to-back windows keep the original baseline ---
{
    storage.clear();
    applied.length = 0;
    localStorage.setItem('noiseSuppression', '0');
    localStorage.setItem('micMode', 'toggle');
    localStorage.setItem('micThreshold', '0.03');
    saveMicSchedules([
        { id: 'a', enabled: true, start: '18:00', end: '20:00', micMode: 'push-to-talk' },
        { id: 'b', enabled: true, start: '20:00', end: '22:00', noiseSuppression: true },
    ]);
    evaluateMicSchedule(apply, false, at('18:30'));
    evaluateMicSchedule(apply, false, at('20:30'));
    assert(applied[1].id === 'b' && applied[1].settings.micMode === 'toggle', 'second window falls back to the ORIGINAL baseline, not window A\'s values');
    evaluateMicSchedule(apply, false, at('22:30'));
    assert(applied[2].id === null && applied[2].settings.micMode === 'toggle' && applied[2].settings.noiseSuppression === false, 'end of the chain restores the pre-schedule settings');
}

// --- disabling the active schedule restores immediately on edit ---
{
    storage.clear();
    applied.length = 0;
    localStorage.setItem('noiseSuppression', '0');
    saveMicSchedules([{ id: 'x', enabled: true, start: '08:00', end: '09:00', noiseSuppression: true }]);
    evaluateMicSchedule(apply, false, at('08:15'));
    saveMicSchedules([{ id: 'x', enabled: false, start: '08:00', end: '09:00', noiseSuppression: true }]);
    evaluateMicSchedule(apply, true, at('08:16'));
    assert(applied.length === 2 && applied[1].id === null && applied[1].settings.noiseSuppression === false, 'disabling the active schedule restores the baseline');
}

console.log('\nAll mic-schedule logic tests passed.');
