const view = new URLSearchParams(location.search).get('view') || 'chat';
document.body.dataset.view = view;
if (view === 'bar') import('./bar.js');
else import('./chat.js');
