(() => {
    const script = document.currentScript;
    const params = new URLSearchParams();
    if (script.dataset.global === 'true') params.set('global', '1');
    else if (script.dataset.sessionId) params.set('session_id', script.dataset.sessionId);
    else return;

    const source = new EventSource(`/api/live/events?${params}`);
    let reloadTimer;
    const pauseReload = () => {
        window.pauseLiveUpdateReload = true;
        clearTimeout(reloadTimer);
    };
    document.addEventListener('submit', (event) => {
        pauseReload();
        setTimeout(() => {
            if (event.defaultPrevented && !event.target.closest('form[data-async-status]')) {
                window.pauseLiveUpdateReload = false;
            }
        }, 0);
    }, true);
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest('a[href]');
        if (!link || link.target || link.hasAttribute('download')) return;
        const destination = new URL(link.href, window.location.href);
        if (destination.origin !== window.location.origin
            || (destination.pathname === window.location.pathname && destination.search === window.location.search)) return;

        pauseReload();
        setTimeout(() => {
            if (event.defaultPrevented) window.pauseLiveUpdateReload = false;
        }, 0);
    }, true);
    window.addEventListener('pagehide', () => clearTimeout(reloadTimer));
    source.addEventListener('update', () => {
        if (window.pauseLiveUpdateReload) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => window.location.reload(), 100);
    });
})();
