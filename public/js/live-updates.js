(() => {
    const script = document.currentScript;
    const params = new URLSearchParams();
    if (script.dataset.global === 'true') params.set('global', '1');
    else if (script.dataset.sessionId) params.set('session_id', script.dataset.sessionId);
    else return;

    const source = new EventSource(`/api/live/events?${params}`);
    let reloadTimer;
    source.addEventListener('update', () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => window.location.reload(), 100);
    });
})();
