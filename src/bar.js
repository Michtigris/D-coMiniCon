const app = document.getElementById('app');
let last = { connected: false, unread: 0, partner: '', call: '' };
let visible = true;
let flashing = false;
let flashTimer = 0;

app.innerHTML = `
  <div class="dock" id="dock">
    <button type="button" class="grip" id="grip" aria-label="Déplacer">
      <i></i><i></i><i></i>
    </button>
    <button type="button" class="chev" id="chev" aria-label="Afficher ou cacher la conversation">▾</button>
    <button type="button" class="big" id="hide">
      <span>
        <strong>Masquer</strong>
        <em id="sub">Salon</em>
      </span>
    </button>
    <button type="button" class="count" id="count" hidden>1</button>
  </div>
`;

const dock = document.getElementById('dock');
const sub = document.getElementById('sub');
const count = document.getElementById('count');
const chev = document.getElementById('chev');

function subtitle(badge) {
  if (badge.call) return `${badge.call} t’appelle`;
  if (badge.partner) return badge.connected ? badge.partner : `${badge.partner} · hors ligne`;
  return badge.connected ? 'Salon' : 'Hors ligne';
}

function render(badge) {
  last = { ...last, ...(badge || {}) };
  dock.classList.toggle('ringing', !!last.call);
  dock.classList.toggle('off', !last.connected);
  if (!flashing) sub.textContent = subtitle(last);
  const showCount = !last.call && last.unread > 0;
  count.hidden = !showCount && !last.call;
  count.textContent = last.call ? 'Appel' : String(last.unread);
}

document.getElementById('grip').addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  window.deco.beginDrag();
});

document.getElementById('hide').addEventListener('click', () => window.deco.hideGame());
chev.addEventListener('click', () => window.deco.toggleChat());
count.addEventListener('click', () => window.deco.showChat());

window.deco.on('badge', render);
window.deco.on('chat:visible', (info) => {
  visible = !!info.visible;
  const linked = info.linked !== undefined ? !!info.linked : visible;
  const openUp = info.openUp !== false;
  // Même logique que la bordure : sans menu lié → bouton « ouvrir » (un clic suffit).
  chev.textContent = linked ? '▾' : '▴';
  chev.setAttribute('aria-label', linked ? 'Cacher la conversation' : 'Afficher la conversation');
  dock.classList.toggle('solo', !linked);
  dock.classList.toggle('open-up', !!(linked && openUp));
  dock.classList.toggle('open-down', !!(linked && !openUp));
  if (!linked) {
    dock.classList.add('solo');
    dock.classList.remove('open-up', 'open-down');
  }
});
window.deco.on('game:result', (result) => {
  flashing = true;
  if (result.stashed) sub.textContent = 'Tape ANGE pour revenir';
  else sub.textContent = result.ok ? `« ${result.title} » masqué` : result.reason;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashing = false;
    sub.textContent = subtitle(last);
  }, 2200);
});
