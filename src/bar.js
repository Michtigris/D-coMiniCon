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
let nextSide = 'right';
let animTimer = 0;

function stopAnim() {
  clearTimeout(animTimer);
  logo.classList.remove('talking', 'talk-left', 'talk-right');
}

function startAnim() {
  stopAnim();
  logo.classList.add('talking', nextSide === 'right' ? 'talk-right' : 'talk-left');
  nextSide = nextSide === 'right' ? 'left' : 'right';
}

logo.addEventListener('pointerenter', () => {
  startAnim();
});

logo.addEventListener('pointerleave', () => {
  // Laisse finir un cycle puis ferme la bouche
  animTimer = setTimeout(stopAnim, 180);
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

window.deco.on('game:result', () => {
  // rien à afficher : le logo est masqué avec l’app
});
