const app = document.getElementById('app');

app.innerHTML = `
  <button type="button" class="buddy bar-logo" id="logo" title="Glisser · double-clic = Masquer · clic droit = menu" aria-label="DécoMiniCon">
    <span class="buddy-stage">
      <span class="buddy-top"></span>
      <span class="buddy-bottom"></span>
    </span>
    <span class="bar-badge" id="badge" hidden>0</span>
  </button>
`;

const logo = document.getElementById('logo');
const badge = document.getElementById('badge');
const FLIP_MS = 340;
let nextSide = 'right';
let flipTimer = 0;
let closeTimer = 0;
let hovering = false;

function stopAnim() {
  clearInterval(flipTimer);
  flipTimer = 0;
  clearTimeout(closeTimer);
  closeTimer = 0;
  logo.classList.remove('talking', 'talk-left', 'talk-right');
}

function flipSide() {
  logo.classList.remove('talk-left', 'talk-right');
  // Force un redémarrage propre de l’anim à chaque côté
  void logo.offsetWidth;
  logo.classList.add('talking', nextSide === 'right' ? 'talk-right' : 'talk-left');
  nextSide = nextSide === 'right' ? 'left' : 'right';
}

function startHoverTalk() {
  hovering = true;
  clearTimeout(closeTimer);
  closeTimer = 0;
  if (!flipTimer) {
    flipSide();
    flipTimer = setInterval(() => {
      if (hovering) flipSide();
    }, FLIP_MS);
  }
}

logo.addEventListener('pointerenter', startHoverTalk);

logo.addEventListener('pointerleave', () => {
  hovering = false;
  clearInterval(flipTimer);
  flipTimer = 0;
  // Ferme la bouche seulement après un court temps hors hover
  closeTimer = setTimeout(stopAnim, 160);
});

logo.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    event.preventDefault();
    window.deco.popupMenu();
    return;
  }
  if (event.button !== 0) return;
  window.deco.beginDrag();
});

logo.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  hovering = false;
  stopAnim();
  window.deco.hideGame();
});

logo.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.deco.popupMenu();
});

window.deco.on('badge', (info) => {
  const unread = Number(info?.unread) || 0;
  const call = !!info?.call;
  const show = call || unread > 0;
  badge.hidden = !show;
  badge.textContent = call ? '!' : (unread > 9 ? '9+' : String(unread));
  logo.classList.toggle('ringing', call);
  logo.classList.toggle('off', info && info.connected === false);
});
