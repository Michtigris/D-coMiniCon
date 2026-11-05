const view = new URLSearchParams(location.search).get('view') || 'chat';
document.body.dataset.view = view;

function applyScale(z) {
  const scale = Number(z);
  const value = Number.isFinite(scale) && scale > 0 ? scale : 1;
  document.documentElement.style.setProperty('--ui-scale', String(value));
  document.documentElement.dataset.uiScale = String(value);
}

applyScale(1);
if (window.deco?.on) {
  window.deco.on('ui:scale', applyScale);
}
if (window.deco?.getProfile) {
  window.deco.getProfile().then((profile) => {
    const map = { small: 0.7, medium: 0.85, normal: 1, large: 1.25 };
    applyScale(map[profile?.uiSize] || 1);
  }).catch(() => {});
}

if (view === 'bar') import('./bar.js');
else import('./chat.js');
