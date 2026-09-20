// --- public/client/deviceSelect.js ---

/**
 * Builds a device <select>'s <option> list from enumerateDevices() output,
 * extracted 2026-09-21 out of SettingsPanel.js when PreJoinSetup.js needed
 * the identical "System default" + labeled-device-list + fall-back-to-
 * default-if-the-stored-id-is-gone logic. Pure DOM building — the caller
 * still owns looking up the <select> element and persisting the chosen
 * value, since SettingsPanel.js and PreJoinSetup.js do that differently
 * (live-apply through a peerManager vs. a bare localStorage write).
 * @param {HTMLSelectElement} select
 * @param {MediaDeviceInfo[]} devices
 * @param {string} storedId - the currently-persisted deviceId for this kind, or ''.
 * @param {string} kindLabel - fallback option text ("Microphone 1") for browsers that haven't granted a label yet.
 */
export function populateDeviceSelect(select, devices, storedId, kindLabel) {
    if (!select) return;
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
    // present — otherwise leave it on "System default" rather than showing
    // a value with no matching <option>.
    select.value = devices.some(d => d.deviceId === storedId) ? storedId : '';
}
