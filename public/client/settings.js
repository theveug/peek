document.addEventListener('DOMContentLoaded', () => {
    const nicknameInput = document.getElementById('nickname');
    const muteToggle = document.getElementById('mute-sounds');
    const resSelect = document.getElementById('res');
    const fpsSelect = document.getElementById('fps');
    const maxMessagesInput = document.getElementById('max-messages');
    const cancelButton = document.getElementById('cancel-settings');

    // Load saved settings
    nicknameInput.value = localStorage.getItem('nickname') || '';
    muteToggle.checked = localStorage.getItem('muteSounds') === '1';
    resSelect.value = localStorage.getItem('screenShareRes') || '1280x720';
    fpsSelect.value = localStorage.getItem('screenShareFps') || '30';
    maxMessagesInput.value = localStorage.getItem('maxMessages') || '100';

    // Save on submit
    document.getElementById('settings-form').addEventListener('submit', (e) => {
        e.preventDefault();

        localStorage.setItem('nickname', nicknameInput.value.trim());
        localStorage.setItem('muteSounds', muteToggle.checked ? '1' : '0');
        localStorage.setItem('screenShareRes', resSelect.value);
        localStorage.setItem('screenShareFps', fpsSelect.value);
        localStorage.setItem('maxMessages', maxMessagesInput.value);

        alert('Settings saved!');

        const sessionId = localStorage.getItem('lastSessionId');
        if (sessionId) {
            window.location.href = `/session/${sessionId}`;
        } else {
            window.location.href = '/';
        }
    });

    // Cancel button returns without saving
    cancelButton.addEventListener('click', (e) => {
        e.preventDefault();
        const sessionId = localStorage.getItem('lastSessionId');
        if (sessionId) {
            window.location.href = `/session/${sessionId}`;
        } else {
            window.location.href = '/';
        }
    });
});