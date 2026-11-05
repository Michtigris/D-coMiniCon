import { createSocket } from './net.js';
import { createRtc } from './rtc.js';
import { syncCameraActions } from './camera/runner.js';

const app = document.getElementById('app');
const state = {
  settingsPage: 'main', // main | experimental | camera
  profile: null,
  host: { hosting: false, urls: [] },
  version: '',
  status: 'boot',
  forceSetup: false,
  setupError: '',
  setupMode: 'login', // login | register | forgot
  setupPrefillEmail: '',
  accountGate: false, // force écran login/register même si un compte local existe
  hubMode: 'home', // home | host | join
  me: null,
  users: [],
  friends: [],
  incoming: [],
  outgoing: [],
  groups: [],
  activeGroup: null,
  groupMessages: [],
  partner: null,
  messages: [],
  browsing: false,
  myCam: false,
  partnerCam: false,
  remoteStream: null,
  localStream: null,
  call: null,
  unread: 0,
  toast: ''
};

let net = null;
let rtc = null;
let live = false;
let authing = false;
let queue = [];
let mounted = '';
let toastTimer = 0;

function pairKey(a, b) {
  return [a, b].sort().join(':');
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeServer(input) {
  const trimmed = String(input || '').trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProto);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function mergeMessages(current, extra) {
  const map = new Map();
  for (const message of [...current, ...extra]) {
    if (message?.id) map.set(message.id, message);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

function currentView() {
  if (state.forceSetup || !state.profile?.pseudo || !state.me) return 'setup';
  if (state.partner && !state.browsing) return 'chat';
  return 'salon';
}

function feedbackText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return '';
}

function toast(text) {
  const msg = feedbackText(text);
  state.toast = msg;
  const el = document.getElementById('toast');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg;
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => toast(''), 2600);
}

function pushBadge() {
  window.deco.badge({
    connected: state.status === 'online',
    unread: state.unread,
    partner: state.partner?.pseudo || '',
    partnerOnline: !!(state.partner && state.partner.online),
    call: state.call?.role === 'in' ? state.call.pseudo : ''
  });
}

function hardStopMedia() {
  state.myCam = false;
  state.localStream = null;
  state.remoteStream = null;
  rtc?.stop();
  rtc = null;
}

function viewOf(payload) {
  if (state.forceSetup || !state.profile?.pseudo) return 'setup';
  if (!state.me && payload !== 'allow-salon') return 'setup';
  if (state.activeGroup && !state.browsing) return 'group';
  if (state.partner && !state.browsing) return 'chat';
  return 'salon';
}

function shell() {
  app.innerHTML = `
    <div class="shell">
      <header class="top" id="drag">
        <div class="brand-row">
          <div class="brand">DécoMiniCon</div>
          <span class="app-version" id="app-version"></span>
          <span class="tag" id="tagline"></span>
        </div>
        <div class="top-actions">
          <button type="button" class="icon-btn" id="gear" aria-label="Réglages">⚙</button>
        </div>
      </header>
      <div id="statusline" class="statusline" hidden></div>
      <div id="call" class="call" hidden></div>
      <main id="body"></main>
      <div id="toast" class="toast" hidden></div>
      <form id="settings" class="settings" hidden>
        <div id="settings-page-main" class="settings-stack">
          <label class="field">Pseudo
            <input name="pseudo" maxlength="16" required autocomplete="username" />
          </label>
          <p class="hint is-error" id="pseudo-cooldown" hidden></p>
          <p class="hint is-error" id="settings-feedback" hidden></p>
          <div id="server-settings" hidden>
            <label class="field">Adresse <input name="server" placeholder="IP:3847" /></label>
            <label class="field">Code <input name="code" maxlength="24" placeholder="Optionnel" /></label>
          </div>
          <div id="share-settings" hidden></div>
          <div id="open-combo-settings" hidden>
            <label class="field">Mot-clé
              <input name="openCombo" maxlength="16" placeholder="ANGE" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <div id="size-settings" hidden>
            <label class="field size-slider">Taille
              <input name="uiSize" type="range" min="0" max="3" step="1" />
              <span class="size-marks" id="size-marks" aria-hidden="true">
                <span data-size="small">S</span>
                <span data-size="medium">M</span>
                <span data-size="normal">L</span>
                <span data-size="large">XL</span>
              </span>
            </label>
          </div>
          <button type="button" class="settings-link" id="open-experimental">Expérimental</button>
          <button type="submit" class="primary">Enregistrer</button>
        </div>
        <div id="settings-page-experimental" class="settings-stack" hidden>
          <button type="button" class="settings-back" data-back="main">← Retour</button>
          <div class="camera-diode-head experimental-master">
            <div class="camera-diode-title">Expérimental</div>
            <button type="button" class="power-toggle off" id="experimental-master" aria-pressed="false">
              <span class="power-knob"></span>
              <span class="power-label">OFF</span>
            </button>
          </div>
          <button type="button" class="settings-link" id="open-camera-actions">Action caméra</button>
        </div>
        <div id="settings-page-camera" class="settings-stack" hidden>
          <button type="button" class="settings-back" data-back="experimental">← Retour</button>
          <div id="camera-diodes" class="camera-diodes"></div>
        </div>
      </form>
    </div>
  `;
  document.getElementById('drag').addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, a, input')) return;
    window.deco.beginDrag();
  });
  document.getElementById('gear').onclick = openSettings;
  document.getElementById('settings').onsubmit = saveSettings;
  window.addEventListener('focus', () => {
    state.unread = 0;
    pushBadge();
  });
}

const BUDDY_LINES = [
  'Salut ! DécoMiniCon, eh !',
  'Désolé, j’ouvre la tête quand je parle, c’est normal au Canada.',
  'Tape ton mot-clé secret pour me retrouver !',
  'Aboot… euh, à bientôt !',
  'Je suis pas un virus, je suis juste goofy.',
  'Masque-moi si tu dois cacher le salon, sorry !'
];

function bindBuddy(el) {
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  let speaking = false;
  let nextSide = 'right';
  let flipTimer = 0;
  const FLIP_MS = 340;
  const flipSide = () => {
    el.classList.remove('talk-left', 'talk-right');
    void el.offsetWidth;
    el.classList.add('talking', nextSide === 'right' ? 'talk-right' : 'talk-left');
    nextSide = nextSide === 'right' ? 'left' : 'right';
  };
  const stopTalk = () => {
    speaking = false;
    clearInterval(flipTimer);
    flipTimer = 0;
    el.classList.remove('talking', 'talk-left', 'talk-right');
  };
  const talk = () => {
    if (speaking) return;
    speaking = true;
    flipSide();
    flipTimer = setInterval(flipSide, FLIP_MS);
    const line = BUDDY_LINES[Math.floor(Math.random() * BUDDY_LINES.length)];
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(line);
      utter.lang = 'fr-FR';
      utter.rate = 1.05;
      utter.pitch = 1.35;
      utter.onend = stopTalk;
      utter.onerror = stopTalk;
      window.speechSynthesis.speak(utter);
    } catch {
      setTimeout(stopTalk, 1600);
    }
  };
  el.addEventListener('pointerenter', talk);
  el.addEventListener('click', (event) => {
    event.preventDefault();
    talk();
  });
}

function renderBody() {
  const view = currentView();
  if (view !== mounted) {
    mounted = view;
    if (view === 'setup') mountSetup();
    else if (view === 'salon') mountSalon();
    else if (view === 'group') mountGroup();
    else mountChat();
  } else if (view === 'salon') {
    fillSalon();
  } else if (view === 'group') {
    syncGroupMessages();
  }
  renderChrome();
}

function renderChrome() {
  const ver = document.getElementById('app-version');
  if (ver) ver.textContent = state.version ? `v${state.version}` : '';
  const tag = document.getElementById('tagline');
  const view = currentView();
  if (tag) {
    if (view === 'chat' && state.partner) {
      tag.textContent = state.partner.online ? state.partner.pseudo : `${state.partner.pseudo} · off`;
    } else if (view === 'salon') {
      tag.textContent = 'Salon';
    } else if (view === 'group' && state.activeGroup) {
      tag.textContent = state.activeGroup.name || 'Groupe';
    } else {
      tag.textContent = '';
    }
  }
  const line = document.getElementById('statusline');
  if (line) {
    line.hidden = state.status === 'online' || state.status === 'setup' || state.status === 'boot';
    line.textContent = state.status === 'connecting' ? 'Connexion…' : 'Hors ligne…';
  }
  renderCall();
  const foot = document.getElementById('foot');
  if (foot && state.profile) {
    try {
      foot.textContent = `v${state.version} · ${new URL(state.profile.serverUrl).host}`;
    } catch {
      foot.textContent = `v${state.version}`;
    }
  }
  const input = document.getElementById('text');
  const send = document.getElementById('send');
  const offline = state.status !== 'online';
  if (input) input.disabled = offline;
  if (send) send.disabled = offline;
  const gear = document.getElementById('gear');
  // Réglages dès qu’un compte local existe (hub / salon / seul).
  if (gear) gear.hidden = !hasLocalAccount() || inAccountGate();
  if (inAccountGate()) forceCloseSettings();
  pushBadge();
  fitChatWindow();
}

/** Hauteur fenêtre : compacte sur setup, pleine (plafond actuel) sinon. */
function fitChatWindow() {
  if (typeof window.deco?.fitChat !== 'function') return;
  const run = () => {
    const settings = document.getElementById('settings');
    const settingsOpen = !!(settings && !settings.hidden);
    if (currentView() !== 'setup' && !settingsOpen) {
      window.deco.fitChat(1e9);
      return;
    }
    const top = document.querySelector('.top');
    const status = document.getElementById('statusline');
    const call = document.getElementById('call');
    const body = document.getElementById('body');
    let h = 2;
    const addBox = (el) => {
      if (!el || el.hidden) return;
      h += el.getBoundingClientRect().height;
    };
    addBox(top);
    addBox(status);
    addBox(call);
    if (settingsOpen) {
      h += Math.ceil(settings.scrollHeight) + 6;
    } else if (body?.firstElementChild) {
      h += Math.ceil(body.firstElementChild.scrollHeight);
    }
    window.deco.fitChat(Math.ceil(h));
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

function renderCall() {
  const box = document.getElementById('call');
  if (!box) return;
  const key = state.call ? `${state.call.role}:${state.call.pseudo}` : '';
  if (box.dataset.key === key) {
    box.hidden = !state.call;
    return;
  }
  box.dataset.key = key;
  box.hidden = !state.call;
  box.replaceChildren();
  if (!state.call) return;
  const p = document.createElement('p');
  const row = document.createElement('div');
  row.className = 'row';
  if (state.call.role === 'in') {
    p.textContent = `${state.call.pseudo} t’appelle.`;
    row.append(actionButton('Décrocher', () => answerCall(true)), actionButton('Refuser', () => answerCall(false)));
  } else {
    p.textContent = `Appel vers ${state.call.pseudo}…`;
    row.append(actionButton('Annuler', () => net?.send({ type: 'call:cancel', payload: {} })));
  }
  box.append(p, row);
}

function actionButton(label, onclick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = onclick;
  return button;
}

function hasLocalAccount() {
  return !!(state.profile?.userId && state.profile?.token && state.profile?.pseudo);
}

function inAccountGate() {
  return !hasLocalAccount() || state.accountGate;
}

function prefillEmailValue() {
  return state.setupPrefillEmail || state.profile?.email || '';
}

function goToLoginWithEmail(email, message = '') {
  state.setupPrefillEmail = email || '';
  state.setupMode = 'login';
  state.accountGate = true;
  state.setupError = message;
  mountSetup();
}

function isInSalon() {
  return !!(state.me && !state.forceSetup);
}

function normalizeEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    throw new Error('Adresse mail invalide.');
  }
  return email;
}

function requireNewPassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 64) {
    throw new Error('Le mot de passe doit faire au moins 8 caractères.');
  }
  return value;
}

const PWD_PLACEHOLDER = '. . . . . . . .';
const ICON_EYE = '<svg class="pwd-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>';
const ICON_EYE_OFF = '<svg class="pwd-eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.3 2.2 2.2 3.3l3.1 3.1C3.6 7.7 2.2 9.5 1.5 11c.8 1.8 3.2 5.4 6.8 7l-2 2 1.1 1.1 13.4-13.4-1.1-1.1-2.2 2.2C15.2 5.5 13.6 5 12 5c-1.2 0-2.4.3-3.5.8L6.2 3.5 3.3 2.2zM12 7a4 4 0 0 1 3.7 2.5l-1.5 1.5A2 2 0 0 0 12 9a2 2 0 0 0-2 2c0 .4.1.8.3 1.1L8.7 13.7A4 4 0 0 1 12 7zm0 12c5 0 9-4.5 10-7-.5-1.3-1.6-3-3.2-4.4l-1.5 1.5c1.1 1 1.9 2.2 2.3 2.9-1.1 1.8-3.9 5-7.6 5a8.7 8.7 0 0 1-3.3-.6l-1.6 1.6c1.5.7 3.1 1 4.9 1z"/></svg>';

function passwordFieldHtml({ label = 'Mot de passe', name = 'password', autocomplete = 'current-password' } = {}) {
  return `
    <label class="pwd-field">${label}
      <span class="pwd-wrap">
        <input name="${name}" type="password" maxlength="64" required placeholder="${PWD_PLACEHOLDER}" autocomplete="${autocomplete}" />
        <button type="button" class="pwd-toggle is-empty" aria-label="Afficher le mot de passe" title="Afficher / masquer" disabled>
          ${ICON_EYE}${ICON_EYE_OFF}
        </button>
      </span>
    </label>
  `;
}

function bindPasswordToggle(root) {
  root.querySelectorAll('.pwd-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const btn = wrap.querySelector('.pwd-toggle');
    if (!input || !btn) return;

    const sync = () => {
      const empty = !input.value;
      const shown = input.type === 'text';
      btn.classList.toggle('is-empty', empty);
      btn.classList.toggle('is-on', shown);
      btn.disabled = empty;
      btn.setAttribute('aria-label', shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      if (empty && shown) input.type = 'password';
    };

    btn.onclick = () => {
      if (!input.value) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      sync();
    };
    input.addEventListener('input', sync);
    sync();
  });
}

function mountSetup() {
  const body = document.getElementById('body');
  const form = document.createElement('form');
  form.className = 'setup';
  // Jamais le panneau réglages pendant le setup (sinon il masque l’adresse serveur).
  forceCloseSettings();

  if (inAccountGate()) {
    const mode = state.setupMode === 'register' || state.setupMode === 'forgot' ? state.setupMode : 'login';
    state.setupMode = mode;
    if (mode === 'register') {
      form.innerHTML = `
        <label>Pseudo <input name="pseudo" maxlength="16" required placeholder="pseudo" autocomplete="nickname" /></label>
        <label>Adresse mail <input name="email" type="email" maxlength="120" required placeholder="toi@mail.com" autocomplete="email" /></label>
        ${passwordFieldHtml({ autocomplete: 'new-password' })}
        <p class="error" id="setup-error"></p>
        <div class="setup-actions">
          <button type="submit" class="primary">Créer le compte</button>
          <button type="button" class="ghost" id="back-login">Déjà un compte</button>
        </div>
      `;
      body.replaceChildren(form);
      bindPasswordToggle(form);
      form.email.value = prefillEmailValue();
      form.querySelector('#setup-error').textContent = state.setupError || '';
      form.onsubmit = (event) => {
        event.preventDefault();
        createAccount({
          email: form.email.value,
          password: form.password.value,
          pseudo: form.pseudo.value
        });
      };
      form.querySelector('#back-login').onclick = () => {
        state.setupPrefillEmail = form.email.value.trim().toLowerCase();
        state.setupError = '';
        state.setupMode = 'login';
        mountSetup();
      };
      fitChatWindow();
      return;
    }
    if (mode === 'forgot') {
      form.innerHTML = `
        <label>Adresse mail <input name="email" type="email" maxlength="120" required placeholder="toi@mail.com" autocomplete="email" /></label>
        ${passwordFieldHtml({ label: 'Nouveau mot de passe', autocomplete: 'new-password' })}
        <p class="hint">Réinitialise le compte enregistré sur ce PC.</p>
        <p class="error" id="setup-error"></p>
        <div class="setup-actions">
          <button type="submit" class="primary">Réinitialiser</button>
          <button type="button" class="ghost" id="back-login">Retour</button>
        </div>
      `;
      body.replaceChildren(form);
      bindPasswordToggle(form);
      form.email.value = prefillEmailValue();
      form.querySelector('#setup-error').textContent = state.setupError || '';
      form.onsubmit = (event) => {
        event.preventDefault();
        resetLocalPassword({
          email: form.email.value,
          password: form.password.value
        });
      };
      form.querySelector('#back-login').onclick = () => {
        state.setupError = '';
        state.setupMode = 'login';
        mountSetup();
      };
      fitChatWindow();
      return;
    }

    form.innerHTML = `
      <label>Adresse mail <input name="email" type="email" maxlength="120" required placeholder="toi@mail.com" autocomplete="email" /></label>
      ${passwordFieldHtml({ autocomplete: 'current-password' })}
      <div class="setup-links">
        <button type="button" class="linkish" id="go-register">Créer</button>
        <button type="button" class="linkish" id="forgot-password">Mot de passe oublié</button>
      </div>
      <p class="error" id="setup-error"></p>
      <div class="setup-actions">
        <button type="submit" class="primary">Enregistrer</button>
      </div>
    `;
    body.replaceChildren(form);
    bindPasswordToggle(form);
    form.email.value = prefillEmailValue();
    form.querySelector('#setup-error').textContent = state.setupError || '';
    form.onsubmit = (event) => {
      event.preventDefault();
      loginAccount({
        email: form.email.value,
        password: form.password.value
      });
    };
    form.querySelector('#go-register').onclick = () => {
      state.setupPrefillEmail = form.email.value.trim().toLowerCase();
      state.setupError = '';
      state.setupMode = 'register';
      mountSetup();
    };
    form.querySelector('#forgot-password').onclick = () => {
      state.setupPrefillEmail = form.email.value.trim().toLowerCase();
      state.setupError = '';
      state.setupMode = 'forgot';
      mountSetup();
    };
    fitChatWindow();
    return;
  }

  mountHub(body);
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 5; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function mountHub(body) {
  const mode = state.hubMode === 'host' || state.hubMode === 'join' ? state.hubMode : 'home';
  state.hubMode = mode;
  const form = document.createElement('form');
  form.className = 'setup hub';

  if (mode === 'host') {
    form.innerHTML = `
      <label>Nom du salon <input name="roomName" maxlength="32" required placeholder="ex. soirée" autocomplete="off" /></label>
      <p class="error" id="setup-error"></p>
      <div class="setup-actions">
        <button type="submit" class="primary">Héberger</button>
        <button type="button" class="ghost" id="hub-back">Retour</button>
      </div>
    `;
    body.replaceChildren(form);
    if (state.profile?.roomName) form.roomName.value = state.profile.roomName;
    form.querySelector('#setup-error').textContent = state.setupError || '';
    form.onsubmit = (event) => {
      event.preventDefault();
      hostSalon(form.roomName.value);
    };
    form.querySelector('#hub-back').onclick = () => {
      state.setupError = '';
      state.hubMode = 'home';
      mountSetup();
    };
    fitChatWindow();
    return;
  }

  if (mode === 'join') {
    form.innerHTML = `
      <label>Code <input name="code" maxlength="5" required placeholder="ABCDE" autocomplete="off" spellcheck="false" /></label>
      <p class="error" id="setup-error"></p>
      <div class="setup-actions">
        <button type="submit" class="primary">Rejoindre</button>
        <button type="button" class="ghost" id="hub-back">Retour</button>
      </div>
    `;
    body.replaceChildren(form);
    form.code.value = (state.profile?.roomCode || '').slice(0, 5);
    form.code.addEventListener('input', () => {
      form.code.value = form.code.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    });
    form.querySelector('#setup-error').textContent = state.setupError || '';
    form.onsubmit = (event) => {
      event.preventDefault();
      joinSalonByCode(form.code.value);
    };
    form.querySelector('#hub-back').onclick = () => {
      state.setupError = '';
      state.hubMode = 'home';
      mountSetup();
    };
    fitChatWindow();
    return;
  }

  form.innerHTML = `
    <p class="error" id="setup-error"></p>
    <div class="setup-actions">
      <button type="button" class="primary" id="hub-join">Rejoindre</button>
      <button type="button" class="ghost" id="hub-host">Héberger</button>
    </div>
  `;
  body.replaceChildren(form);
  form.querySelector('#setup-error').textContent = state.setupError || '';
  form.querySelector('#hub-join').onclick = () => {
    state.setupError = '';
    state.hubMode = 'join';
    mountSetup();
  };
  form.querySelector('#hub-host').onclick = () => {
    state.setupError = '';
    state.hubMode = 'host';
    mountSetup();
  };
  fitChatWindow();
}

async function discoverServerByCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(wanted)) return null;
  const hosts = typeof window.deco.lanCandidates === 'function'
    ? await window.deco.lanCandidates()
    : ['127.0.0.1'];
  const port = 3847;
  const hits = await Promise.all(hosts.map(async (ip) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 400);
    try {
      const res = await fetch(`http://${ip}:${port}/health`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.ok && String(data.roomCode || '').toUpperCase() === wanted) {
        return {
          url: `http://${ip}:${port}`,
          roomName: data.roomName || '',
          members: Number(data.members) || 0,
          maxMembers: Number(data.maxMembers) || 2
        };
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    return null;
  }));
  return hits.find(Boolean) || null;
}

async function hostSalon(rawName) {
  const roomName = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (roomName.length < 2) {
    state.setupError = 'Le nom doit faire au moins 2 caractères.';
    state.hubMode = 'host';
    mountSetup();
    return;
  }
  const roomCode = makeRoomCode();
  state.setupError = '';
  try {
    const result = await window.deco.startHost({ roomCode, roomName });
    if (!result?.ok) {
      state.setupError = result?.message || 'Impossible d’héberger le salon.';
      state.hubMode = 'host';
      mountSetup();
      return;
    }
    state.host = result;
    state.profile = await window.deco.saveProfile({
      hosting: true,
      roomCode,
      roomName,
      serverUrl: 'http://127.0.0.1:3847',
      settingsOpen: false
    });
    state.forceSetup = false;
    state.hubMode = 'home';
    toast('Salon ouvert');
    connect();
  } catch (err) {
    state.setupError = err?.message || 'Impossible d’héberger le salon.';
    state.hubMode = 'host';
    mountSetup();
  }
}

async function joinSalonByCode(rawCode) {
  const roomCode = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (roomCode.length !== 5) {
    state.setupError = 'Le code fait 5 lettres.';
    state.hubMode = 'join';
    mountSetup();
    return;
  }
  state.setupError = 'Recherche du salon…';
  mountSetup();
  const found = await discoverServerByCode(roomCode);
  if (!found) {
    state.setupError = 'Aucun salon trouvé avec ce code sur le réseau.';
    state.hubMode = 'join';
    mountSetup();
    return;
  }
  if (found.members >= (found.maxMembers || 2)) {
    state.setupError = `Salon complet (${found.maxMembers || 2}/${found.maxMembers || 2}).`;
    state.hubMode = 'join';
    mountSetup();
    return;
  }
  state.profile = await window.deco.saveProfile({
    hosting: false,
    roomCode,
    roomName: found.roomName || '',
    serverUrl: found.url,
    settingsOpen: false
  });
  state.forceSetup = false;
  state.setupError = '';
  state.hubMode = 'home';
  connect();
}

async function createAccount({ email, password, pseudo }) {
  let mail;
  let pwd;
  try {
    mail = normalizeEmail(email);
    pwd = requireNewPassword(password);
  } catch (err) {
    state.setupError = err?.message || 'Informations invalides.';
    state.setupMode = 'register';
    mountSetup();
    return;
  }
  if (hasLocalAccount() && state.profile?.email && state.profile.email.toLowerCase() === mail) {
    goToLoginWithEmail(mail, 'Un compte existe déjà avec cette adresse.');
    return;
  }
  const name = String(pseudo || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    state.setupError = 'Le pseudo doit faire au moins 2 caractères.';
    state.setupMode = 'register';
    mountSetup();
    return;
  }
  let token;
  try {
    token = await window.deco.hashPassword(name, pwd);
  } catch (err) {
    state.setupError = err?.message || 'Mot de passe invalide.';
    state.setupMode = 'register';
    mountSetup();
    return;
  }
  state.profile = await window.deco.saveProfile({
    userId: state.profile.userId || crypto.randomUUID(),
    token,
    pseudo: name,
    email: mail,
    pseudoChangedAt: Date.now(),
    settingsOpen: false
  });
  state.forceSetup = true;
  goToLoginWithEmail(mail, '');
  toast('Compte créé — connecte-toi');
}

async function loginAccount({ email, password }) {
  let mail;
  try {
    mail = normalizeEmail(email);
  } catch (err) {
    state.setupError = err?.message || 'Adresse mail invalide.';
    state.setupMode = 'login';
    mountSetup();
    return;
  }
  const profile = state.profile;
  if (!profile?.userId || !profile?.token || !profile?.pseudo) {
    state.setupError = 'Aucun compte sur ce PC. Appuie sur Créer.';
    state.setupMode = 'login';
    mountSetup();
    return;
  }
  if (profile.email && profile.email.toLowerCase() !== mail) {
    state.setupError = 'Cette adresse ne correspond pas au compte de ce PC.';
    state.setupMode = 'login';
    mountSetup();
    return;
  }
  let token;
  try {
    token = await window.deco.hashPassword(profile.pseudo, password);
  } catch (err) {
    state.setupError = err?.message || 'Mot de passe incorrect.';
    state.setupMode = 'login';
    mountSetup();
    return;
  }
  if (token !== profile.token) {
    state.setupError = 'Mot de passe incorrect.';
    state.setupMode = 'login';
    mountSetup();
    return;
  }
  state.profile = await window.deco.saveProfile({ email: mail, settingsOpen: false });
  state.setupError = '';
  state.setupPrefillEmail = mail;
  state.setupMode = 'login';
  state.accountGate = false;
  state.forceSetup = true;
  toast('Connecté');
  mountSetup();
}

async function resetLocalPassword({ email, password }) {
  let mail;
  let pwd;
  try {
    mail = normalizeEmail(email);
    pwd = requireNewPassword(password);
  } catch (err) {
    state.setupError = err?.message || 'Informations invalides.';
    state.setupMode = 'forgot';
    mountSetup();
    return;
  }
  const profile = state.profile;
  if (!profile?.userId || !profile?.pseudo || !profile?.token) {
    state.setupError = 'Aucun compte local à réinitialiser. Crée un compte.';
    state.setupMode = 'forgot';
    mountSetup();
    return;
  }
  if (profile.email && profile.email.toLowerCase() !== mail) {
    state.setupError = 'Adresse incorrecte pour ce PC.';
    state.setupMode = 'forgot';
    mountSetup();
    return;
  }
  let token;
  try {
    token = await window.deco.hashPassword(profile.pseudo, pwd);
  } catch (err) {
    state.setupError = err?.message || 'Mot de passe invalide.';
    state.setupMode = 'forgot';
    mountSetup();
    return;
  }
  state.profile = await window.deco.saveProfile({
    email: mail,
    token,
    settingsOpen: false
  });
  goToLoginWithEmail(mail, '');
  toast('Mot de passe mis à jour');
}

function mountSalon() {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="salon" id="salon"></div><p class="foot" id="foot"></p>';
  fillSalon();
}

function fillSalon() {
  const root = document.getElementById('salon');
  if (!root || !state.me) return;
  root.replaceChildren();
  const roomName = state.host?.roomName || state.profile?.roomName || '';
  const roomCode = state.host?.roomCode || state.profile?.roomCode || '';
  if (roomName || roomCode) {
    const card = document.createElement('article');
    card.className = 'room-card';
    const top = document.createElement('div');
    top.className = 'room-card-top';
    const title = document.createElement('h2');
    title.textContent = roomName || 'Salon';
    const code = document.createElement('button');
    code.type = 'button';
    code.className = 'room-code';
    code.textContent = roomCode || '—';
    code.title = 'Copier le code';
    code.onclick = () => {
      if (!roomCode) return;
      window.deco.copy(roomCode);
      toast('Code copié');
    };
    top.append(title, code);
    card.append(top);
    const meta = document.createElement('p');
    meta.className = 'hint';
    const online = (state.users || []).filter((u) => u.online).length || 1;
    meta.textContent = `${online}/2 · clique le code pour le copier`;
    card.append(meta);
    root.append(card);
  }
  if (state.partner || state.activeGroup) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-link';
    back.textContent = state.activeGroup
      ? `← ${state.activeGroup.name}`
      : `← ${state.partner.pseudo}`;
    back.onclick = () => {
      state.browsing = false;
      renderBody();
      if (state.activeGroup) syncGroupMessages();
      else {
        syncMessages();
        updateMedia();
      }
    };
    root.append(back);
  }

  const add = document.createElement('form');
  add.className = 'composer';
  add.innerHTML = '<input name="pseudo" maxlength="16" placeholder="Ami…" /><button type="submit">+</button>';
  add.onsubmit = (event) => {
    event.preventDefault();
    const pseudo = add.pseudo.value.trim();
    if (!pseudo) return;
    net?.send({ type: 'friend:request', payload: { pseudo } });
    add.pseudo.value = '';
    toast('Envoyé');
  };
  root.append(sectionTitle('Ami'), add);

  if (state.incoming.length) {
    root.append(sectionTitle('Demandes'));
    for (const request of state.incoming) root.append(requestRow(request));
  }
  const friends = [...state.friends].sort((a, b) => a.pseudo.localeCompare(b.pseudo, 'fr'));
  if (friends.length) {
    root.append(sectionTitle('Amis'));
    for (const friend of friends) root.append(personRow(friend, 'friend'));
  }

  root.append(sectionTitle('Groupes'));
  const create = document.createElement('form');
  create.className = 'setup';
  create.style.padding = '0';
  create.innerHTML = `
    <label>Groupe <input name="name" maxlength="32" placeholder="Nom" required /></label>
    <div id="group-picks"></div>
    <button type="submit" class="primary">Créer</button>
  `;
  const picks = create.querySelector('#group-picks');
  for (const friend of friends) {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" value="${friend.id}" /> ${friend.pseudo}`;
    picks.append(label);
  }
  create.onsubmit = (event) => {
    event.preventDefault();
    const memberIds = [...create.querySelectorAll('#group-picks input:checked')].map((input) => input.value);
    net?.send({ type: 'group:create', payload: { name: create.name.value.trim(), memberIds } });
    create.name.value = '';
    toast('OK');
  };
  root.append(create);
  for (const group of state.groups) root.append(groupRow(group));

  const others = state.users.filter((user) => user.id !== state.me.id && !friends.some((friend) => friend.id === user.id));
  if (others.length) {
    root.append(sectionTitle('En ligne'));
    for (const user of others) root.append(personRow(user, 'other'));
  }
}

function groupRow(group) {
  const row = document.createElement('div');
  row.className = 'person';
  const dot = document.createElement('i');
  dot.className = 'dot on';
  const name = document.createElement('span');
  name.textContent = `${group.name} · ${group.members.length}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'mini primary';
  open.textContent = 'Ouvrir';
  open.onclick = () => {
    state.browsing = false;
    state.partner = null;
    state.activeGroup = group;
    state.groupMessages = [];
    net?.send({ type: 'group:open', payload: { groupId: group.id } });
    renderBody();
  };
  row.append(dot, name, open);
  return row;
}

function mountGroup() {
  const body = document.getElementById('body');
  const group = state.activeGroup;
  body.innerHTML = `
    <section class="chat">
      <div class="row-actions">
        <button type="button" class="text-btn" id="salon-btn">Salon</button>
        <button type="button" class="text-btn" id="leave-group">Quitter</button>
      </div>
      <div class="stage"><div id="messages" class="messages"></div></div>
      <form class="composer" id="composer">
        <input id="text" maxlength="2000" autocomplete="off" placeholder="Écrire dans ${group?.name || 'le groupe'}…" />
        <button type="submit" id="send">OK</button>
      </form>
    </section>
  `;
  document.getElementById('salon-btn').onclick = () => {
    state.browsing = true;
    renderBody();
  };
  document.getElementById('leave-group').onclick = () => {
    if (!state.activeGroup) return;
    net?.send({ type: 'group:leave', payload: { groupId: state.activeGroup.id } });
    state.activeGroup = null;
    state.groupMessages = [];
    state.browsing = true;
    renderBody();
  };
  document.getElementById('composer').onsubmit = (event) => {
    event.preventDefault();
    const input = document.getElementById('text');
    const text = input.value.trim();
    if (!text || !state.activeGroup) return;
    net?.send({ type: 'group:message', payload: { groupId: state.activeGroup.id, text } });
    input.value = '';
  };
  syncGroupMessages();
}

function syncGroupMessages() {
  const box = document.getElementById('messages');
  if (!box || !state.activeGroup) return;
  box.replaceChildren();
  for (const message of state.groupMessages) {
    const mine = message.from === state.me?.id;
    const bubble = document.createElement('div');
    bubble.className = mine ? 'bubble mine' : 'bubble theirs';
    const author = state.activeGroup.members.find((user) => user.id === message.from)?.pseudo || '…';
    bubble.innerHTML = `${mine ? '' : `<strong>${author}</strong><br>`}${escapeHtml(message.text)}<time>${new Date(message.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</time>`;
    box.append(bubble);
  }
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'section';
  el.textContent = text;
  return el;
}

function personRow(user, kind) {
  const row = document.createElement('div');
  row.className = 'person';
  const dot = document.createElement('i');
  dot.className = user.online ? 'dot on' : 'dot off';
  const name = document.createElement('span');
  name.textContent = user.pseudo;
  const button = document.createElement('button');
  button.type = 'button';
  if (kind === 'friend') {
    button.className = 'mini primary';
    button.textContent = 'Lier';
    button.onclick = () => net?.send({ type: 'link', payload: { friendId: user.id } });
  } else if (state.outgoing.some((request) => request.to === user.id)) {
    button.className = 'mini';
    button.textContent = 'Envoyée';
    button.disabled = true;
  } else if (state.incoming.some((request) => request.from === user.id)) {
    button.className = 'mini';
    button.textContent = 'En attente';
    button.disabled = true;
  } else {
    button.className = 'mini';
    button.textContent = 'Demander';
    button.onclick = () => net?.send({ type: 'friend:request', payload: { toId: user.id } });
  }
  row.append(dot, name, button);
  return row;
}

function requestRow(request) {
  const row = document.createElement('div');
  row.className = 'person request';
  const name = document.createElement('span');
  name.textContent = request.pseudo;
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'mini primary';
  yes.textContent = 'Oui';
  yes.onclick = () => net?.send({ type: 'friend:accept', payload: { requestId: request.id } });
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'mini';
  no.textContent = 'Non';
  no.onclick = () => net?.send({ type: 'friend:decline', payload: { requestId: request.id } });
  row.append(name, yes, no);
  return row;
}

function mountChat() {
  const body = document.getElementById('body');
  body.innerHTML = `
    <section class="chat">
      <div class="row-actions">
        <button type="button" class="text-btn" id="call-btn">Appeler</button>
        <button type="button" class="text-btn" id="salon-btn">Salon</button>
        <button type="button" class="text-btn" id="unlink-btn">Délier</button>
      </div>
      <div class="stage">
        <div id="messages" class="messages"></div>
        <div id="video-layer" class="video-layer" hidden>
          <video id="remote" autoplay playsinline></video>
          <p id="video-wait">Connexion de la caméra…</p>
        </div>
        <video id="local" class="pip" autoplay playsinline muted hidden></video>
      </div>
      <form class="composer" id="composer">
        <input id="text" maxlength="2000" autocomplete="off" />
        <button type="submit" id="send">OK</button>
      </form>
      <button type="button" class="cam" id="cam">Mode cam</button>
    </section>
  `;
  const partner = state.partner?.pseudo || 'ton ami';
  document.getElementById('text').placeholder = `Écrire à ${partner}…`;
  document.getElementById('call-btn').onclick = () => {
    if (!state.partner?.online) {
      toast(`${state.partner?.pseudo || 'Ton ami'} n’est pas en ligne.`);
      return;
    }
    state.call = { role: 'out', pseudo: state.partner.pseudo };
    net?.send({ type: 'call', payload: {} });
    renderCall();
    pushBadge();
  };
  document.getElementById('salon-btn').onclick = () => {
    state.browsing = true;
    renderBody();
  };
  document.getElementById('unlink-btn').onclick = () => {
    hardStopMedia();
    net?.send({ type: 'cam', payload: { on: false } });
    net?.send({ type: 'link', payload: { friendId: null } });
  };
  document.getElementById('composer').onsubmit = (event) => {
    event.preventDefault();
    const input = document.getElementById('text');
    const text = input.value.trim();
    if (!text) return;
    if (state.status !== 'online' || !net?.send({ type: 'message', payload: { text } })) {
      toast('Message non envoyé, le salon est injoignable.');
      return;
    }
    input.value = '';
  };
  document.getElementById('cam').onclick = toggleCam;
  syncMessages();
  updateMedia();
}

function syncMessages() {
  const box = document.getElementById('messages');
  if (!box) return;
  const nodes = [...box.children];
  let same = nodes.length <= state.messages.length;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].dataset.id !== state.messages[i]?.id) same = false;
  }
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  if (!same) {
    box.replaceChildren(...state.messages.map(bubble));
    box.scrollTop = box.scrollHeight;
    return;
  }
  for (let i = nodes.length; i < state.messages.length; i += 1) box.append(bubble(state.messages[i]));
  if (near || nodes.length === 0) box.scrollTop = box.scrollHeight;
}

function bubble(message) {
  const el = document.createElement('div');
  el.className = message.from === state.me?.id ? 'bubble mine' : 'bubble theirs';
  el.dataset.id = message.id;
  const text = document.createElement('span');
  text.textContent = message.text;
  const time = document.createElement('time');
  time.textContent = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(message.ts);
  el.append(text, time);
  return el;
}

function updateMedia() {
  const layer = document.getElementById('video-layer');
  const remote = document.getElementById('remote');
  const local = document.getElementById('local');
  const messages = document.getElementById('messages');
  const cam = document.getElementById('cam');
  if (!layer) return;
  layer.hidden = !state.partnerCam;
  if (messages) messages.hidden = !!state.partnerCam;
  if (remote) remote.srcObject = state.partnerCam ? state.remoteStream : null;
  const wait = document.getElementById('video-wait');
  if (wait) wait.hidden = !!state.remoteStream;
  if (local) {
    local.hidden = !state.localStream;
    local.srcObject = state.localStream;
  }
  if (cam) {
    cam.textContent = state.myCam ? 'Couper la cam' : 'Mode cam';
    cam.classList.toggle('on', state.myCam);
  }
}

function ensureRtc() {
  if (rtc || !state.me || !state.partner) return rtc;
  rtc = createRtc({
    polite: state.me.id > state.partner.id,
    send: (data) => net?.send({ type: 'signal', payload: { data } }),
    onRemote: (stream) => {
      state.remoteStream = stream;
      updateMedia();
    }
  });
  return rtc;
}

async function toggleCam() {
  if (!state.partner) return;
  if (state.myCam) {
    hardStopMedia();
    net?.send({ type: 'cam', payload: { on: false } });
    updateMedia();
    pushBadge();
    return;
  }
  try {
    ensureRtc();
    state.localStream = await rtc.startCamera();
    state.myCam = true;
    net?.send({ type: 'cam', payload: { on: true } });
    updateMedia();
    pushBadge();
  } catch (err) {
    console.error(err);
    toast('Webcam refusée. Autorise la caméra pour DécoMiniCon dans Windows.');
  }
}

function answerCall(accept) {
  net?.send({ type: 'call:answer', payload: { accept } });
  state.call = null;
  renderCall();
  pushBadge();
}

function connect() {
  net?.stop();
  state.status = 'connecting';
  if (!state.me) {
    const body = document.getElementById('body');
    if (body) body.innerHTML = '<p class="intro">Connexion au salon…</p>';
    mounted = 'wait';
  }
  renderChrome();
  net = createSocket(state.profile.serverUrl, {
    onOpen: () => {
      authing = true;
      queue = [];
      live = false;
      net.send({
        type: 'auth',
        payload: {
          userId: state.profile.userId,
          token: state.profile.token,
          pseudo: state.profile.pseudo,
          roomCode: state.profile.roomCode || ''
        }
      });
    },
    onClose: () => {
      if (state.status === 'online') {
        state.status = 'off';
        renderChrome();
        return;
      }
      if (state.status === 'off') return;
      net?.stop();
      state.forceSetup = true;
      state.status = 'setup';
      state.setupError = 'Serveur injoignable. Vérifie l’adresse, ou héberge le salon sur ce PC.';
      if (mounted === 'setup') {
        const el = document.getElementById('setup-error');
        if (el) el.textContent = state.setupError;
      } else renderBody();
    },
    onEvent: handle
  });
}

async function handle(msg) {
  if (authing && msg.type !== 'auth:ok' && msg.type !== 'auth:error') {
    queue.push(msg);
    return;
  }
  await dispatch(msg);
}

async function dispatch(msg) {
  if (msg.type === 'auth:ok') {
    authing = true;
    await applyAuth(msg.payload);
    authing = false;
    const pending = queue;
    queue = [];
    for (const item of pending) await dispatch(item);
    return;
  }
  if (msg.type === 'auth:error') {
    authing = false;
    queue = [];
    net?.stop();
    state.forceSetup = true;
    state.status = 'setup';
    state.setupError = msg.payload?.message || 'Entrée refusée.';
    state.hubMode = /complet/i.test(state.setupError) ? 'join' : state.hubMode;
    state.me = null;
    renderBody();
    return;
  }
  if (msg.type === 'lobby') {
    state.users = msg.payload.users || [];
    if (state.partner) {
      const fresh = state.users.find((user) => user.id === state.partner.id);
      if (fresh) state.partner = { ...state.partner, ...fresh };
    }
    state.friends = state.friends.map((friend) => state.users.find((user) => user.id === friend.id) || friend);
    renderBody();
    return;
  }
  if (msg.type === 'social') {
    const known = new Set(state.incoming.map((request) => request.id));
    state.friends = msg.payload.friends || [];
    state.incoming = msg.payload.incoming || [];
    state.outgoing = msg.payload.outgoing || [];
    state.groups = msg.payload.groups || [];
    if (state.activeGroup) {
      state.activeGroup = state.groups.find((group) => group.id === state.activeGroup.id) || null;
      if (!state.activeGroup) {
        state.groupMessages = [];
        state.browsing = true;
      }
    }
    if (live) {
      for (const request of state.incoming) {
        if (!known.has(request.id)) {
          window.deco.notify({ title: 'DécoMiniCon', body: `${request.pseudo} veut être ton ami.`, kind: 'friend' });
        }
      }
    }
    renderBody();
    return;
  }
  if (msg.type === 'group:state') {
    state.activeGroup = msg.payload.group;
    state.groupMessages = msg.payload.messages || [];
    state.browsing = false;
    state.partner = null;
    renderBody();
    return;
  }
  if (msg.type === 'group:message') {
    const message = msg.payload.message;
    if (state.activeGroup?.id === message.groupId) {
      if (!state.groupMessages.some((item) => item.id === message.id)) state.groupMessages.push(message);
      syncGroupMessages();
      if (live && message.from !== state.me?.id && !document.hasFocus()) {
        state.unread += 1;
        window.deco.notify({ title: state.activeGroup.name, body: message.text, kind: 'message' });
        pushBadge();
      }
    }
    return;
  }
  if (msg.type === 'link:state') {
    await applyLink(msg.payload);
    return;
  }
  if (msg.type === 'message:new') {
    const message = msg.payload.message;
    if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message);
    if (state.partner) await window.deco.saveHistory(pairKey(state.me.id, state.partner.id), state.messages);
    syncMessages();
    if (live && message.from !== state.me?.id && !document.hasFocus()) {
      state.unread += 1;
      const author = state.partner?.pseudo || 'Ton binôme';
      window.deco.notify({ title: author, body: message.text, kind: 'message' });
    }
    pushBadge();
    return;
  }
  if (msg.type === 'call:incoming') {
    state.call = { role: 'in', pseudo: msg.payload.from.pseudo };
    window.deco.notify({ title: 'Appel', body: `${msg.payload.from.pseudo} t’appelle.`, kind: 'call' });
    renderCall();
    pushBadge();
    return;
  }
  if (msg.type === 'call:result') {
    const outgoing = state.call?.role === 'out' ? state.call.pseudo : '';
    state.call = null;
    renderCall();
    if (outgoing && msg.payload.accept) toast(`${outgoing} a décroché.`);
    pushBadge();
    return;
  }
  if (msg.type === 'call:closed') {
    const role = state.call?.role;
    const pseudo = state.call?.pseudo;
    state.call = null;
    renderCall();
    pushBadge();
    const reason = msg.payload?.reason;
    if (reason === 'offline') toast(`${pseudo || 'Ton ami'} n’est pas en ligne.`);
    else if (reason === 'decline' && role === 'out') toast('Appel refusé.');
    else if (reason === 'timeout') toast('Pas de réponse.');
    else if (reason === 'cancel' && role === 'in') toast('Appel annulé.');
    return;
  }
  if (msg.type === 'cam:state') {
    if (msg.payload.userId === state.partner?.id) {
      state.partnerCam = !!msg.payload.on;
      if (!state.partnerCam) state.remoteStream = null;
      updateMedia();
      pushBadge();
    }
    return;
  }
  if (msg.type === 'signal') {
    ensureRtc();
    try {
      await rtc?.signal(msg.payload.data);
    } catch (err) {
      console.error(err);
    }
    return;
  }
  if (msg.type === 'error') toast(msg.payload?.message || 'Erreur.');
}

async function applyAuth(payload) {
  state.status = 'online';
  state.forceSetup = false;
  state.setupError = '';
  state.me = payload.user;
  state.users = payload.users || [];
  state.friends = payload.friends || [];
  state.incoming = payload.incoming || [];
  state.outgoing = payload.outgoing || [];
  state.groups = payload.groups || [];
  if (payload.user?.id) {
    state.profile = await window.deco.saveProfile({
      userId: payload.user.id,
      pseudo: payload.user.pseudo || state.profile.pseudo
    });
  }
  if (payload.link?.partner) await applyLink(payload.link, { quiet: true });
  else {
    state.partner = null;
    state.messages = [];
    state.partnerCam = false;
    hardStopMedia();
    const remember = state.profile?.lastPartnerId;
    if (remember && (state.friends || []).some((f) => f.id === remember)) {
      net?.send({ type: 'link', payload: { friendId: remember } });
    } else {
      renderBody();
    }
  }
  live = true;
  renderChrome();
  if (state.profile?.settingsOpen) openSettings();
}

async function applyLink(payload, { quiet = false } = {}) {
  const previous = state.partner?.id || null;
  const next = payload.partner?.id || null;
  if (previous !== next) hardStopMedia();
  state.partner = payload.partner;
  state.partnerCam = !!payload.partnerCam && !!payload.partner;
  if (payload.partner) {
    state.activeGroup = null;
    state.groupMessages = [];
  }
  if (!payload.partner) {
    state.messages = [];
    state.browsing = false;
    state.profile = await window.deco.saveProfile({ lastPartnerId: null, lastView: 'salon' });
  } else {
    const pair = pairKey(state.me.id, payload.partner.id);
    const local = await window.deco.readHistory(pair);
    state.messages = mergeMessages(local, payload.messages || []);
    await window.deco.saveHistory(pair, state.messages);
    if (!quiet && live && payload.by && payload.by !== state.me.id) {
      window.deco.notify({
        title: 'DécoMiniCon',
        body: `${payload.partner.pseudo} s’est lié avec toi.`,
        kind: 'link'
      });
    }
    state.browsing = false;
    state.profile = await window.deco.saveProfile({
      lastPartnerId: payload.partner.id,
      lastView: 'chat'
    });
  }
  renderBody();
  syncMessages();
  updateMedia();
  renderChrome();
}

function forceCloseSettings() {
  const form = document.getElementById('settings');
  if (form) form.hidden = true;
  const body = document.getElementById('body');
  if (body) body.hidden = false;
  state.settingsPage = 'main';
  showSettingsPage('main');
  const tip = document.getElementById('settings-feedback');
  if (tip) {
    tip.hidden = true;
    tip.textContent = '';
  }
}

const CAMERA_DIODES = [
  { id: 1, name: 'Triangle' },
  { id: 2, name: 'Réflexion' },
  { id: 3, name: 'Pincé', handsSwitch: true },
  { id: 4, name: 'Points', handsSwitch: true },
  { id: 5, name: 'Mains en l’air', handsSwitch: true },
  { id: 6, name: 'UWU' }
];

const CAMERA_SHORTCUTS = [
  { id: 'ctrl+c', label: 'Ctrl + C' },
  { id: 'ctrl+v', label: 'Ctrl + V' },
  { id: 'ctrl+x', label: 'Ctrl + X' },
  { id: 'ctrl+z', label: 'Ctrl + Z' },
  { id: 'ctrl+a', label: 'Ctrl + A' },
  { id: 'ctrl+s', label: 'Ctrl + S' },
  { id: 'alt+tab', label: 'Alt + Tab' },
  { id: 'win+d', label: 'Win + D' },
  { id: 'win+e', label: 'Win + E' },
  { id: 'win+tab', label: 'Win + Tab' },
  { id: 'alt+f4', label: 'Alt + F4' },
  { id: 'ctrl+win+left', label: 'Ctrl + Windows + ←' },
  { id: 'ctrl+win+right', label: 'Ctrl + Windows + →' }
];

function cameraConfig() {
  const base = {
    enabled: false,
    diodes: {
      1: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 },
      2: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 },
      3: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 },
      4: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 },
      5: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 },
      6: { on: false, action: 'none', shortcut: 'ctrl+c', app: '', url: '', hands: 2 }
    }
  };
  const src = state.profile?.cameraActions;
  if (!src || typeof src !== 'object') return base;
  base.enabled = !!src.enabled;
  if (!src.diodes) return base;
  for (let i = 1; i <= 6; i += 1) {
    const key = String(i);
    const d = src.diodes[key];
    if (!d || typeof d !== 'object') continue;
    base.diodes[key] = {
      on: !!d.on,
      action: ['none', 'shortcut', 'app', 'url'].includes(d.action) ? d.action : 'none',
      shortcut: d.shortcut || 'ctrl+c',
      app: d.app || '',
      url: d.url || '',
      hands: Number(d.hands) === 1 ? 1 : 2
    };
  }
  return base;
}

function setPowerToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const label = btn.querySelector('.power-label');
  if (label) label.textContent = on ? 'ON' : 'OFF';
}

function syncExperimentalMasterUi() {
  const cfg = cameraConfig();
  const btn = document.getElementById('experimental-master');
  setPowerToggle(btn, cfg.enabled);
}

function showSettingsPage(page) {
  state.settingsPage = page;
  const main = document.getElementById('settings-page-main');
  const experimental = document.getElementById('settings-page-experimental');
  const camera = document.getElementById('settings-page-camera');
  const pages = [
    [main, 'main'],
    [experimental, 'experimental'],
    [camera, 'camera']
  ];
  for (const [el, name] of pages) {
    if (!el) continue;
    const on = page === name;
    el.hidden = !on;
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
    el.style.display = on ? '' : 'none';
  }
  const form = document.getElementById('settings');
  if (form?.pseudo) form.pseudo.required = page === 'main';
  if (page === 'experimental') syncExperimentalMasterUi();
  if (page === 'camera') renderCameraDiodes();
  fitChatWindow();
}

function bindSettingsNav() {
  const openExp = document.getElementById('open-experimental');
  if (openExp) {
    openExp.onclick = () => showSettingsPage('experimental');
  }
  const openCam = document.getElementById('open-camera-actions');
  if (openCam) {
    openCam.onclick = () => showSettingsPage('camera');
  }
  document.querySelectorAll('.settings-back').forEach((btn) => {
    btn.onclick = () => showSettingsPage(btn.dataset.back || 'main');
  });
  const master = document.getElementById('experimental-master');
  if (master) {
    master.onclick = async () => {
      const next = cameraConfig();
      next.enabled = !next.enabled;
      state.profile = await window.deco.saveProfile({ cameraActions: next });
      syncCameraActions(state.profile.cameraActions);
      syncExperimentalMasterUi();
    };
  }
}

async function patchCameraDiode(id, patch) {
  const next = cameraConfig();
  const key = String(id);
  next.diodes[key] = { ...next.diodes[key], ...patch };
  state.profile = await window.deco.saveProfile({ cameraActions: next });
  syncCameraActions(state.profile.cameraActions);
}

function renderCameraDiodes() {
  const root = document.getElementById('camera-diodes');
  if (!root) return;
  const cfg = cameraConfig();
  root.replaceChildren();
  for (const meta of CAMERA_DIODES) {
    const diode = cfg.diodes[String(meta.id)];
    const row = document.createElement('div');
    row.className = 'camera-diode';
    row.dataset.id = String(meta.id);

    const head = document.createElement('div');
    head.className = 'camera-diode-head';

    const title = document.createElement('div');
    title.className = 'camera-diode-title';
    title.textContent = `${meta.id}. ${meta.name}`;

    const headRight = document.createElement('div');
    headRight.className = 'camera-diode-tools';

    if (meta.handsSwitch) {
      const hands = document.createElement('div');
      hands.className = 'hands-switch';
      hands.setAttribute('role', 'group');
      hands.setAttribute('aria-label', 'Nombre de mains');
      for (const n of [1, 2]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `hands-opt${(diode.hands || 2) === n ? ' on' : ''}`;
        btn.textContent = String(n);
        btn.title = n === 1 ? '1 main' : '2 mains';
        btn.onclick = async () => {
          await patchCameraDiode(meta.id, { hands: n });
          renderCameraDiodes();
        };
        hands.append(btn);
      }
      headRight.append(hands);
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `power-toggle ${diode.on ? 'on' : 'off'}`;
    toggle.setAttribute('aria-pressed', diode.on ? 'true' : 'false');
    toggle.innerHTML = `<span class="power-knob"></span><span class="power-label">${diode.on ? 'ON' : 'OFF'}</span>`;
    toggle.onclick = async () => {
      await patchCameraDiode(meta.id, { on: !diode.on });
      renderCameraDiodes();
    };

    headRight.append(toggle);
    head.append(title, headRight);

    const action = document.createElement('select');
    action.className = 'camera-action';
    for (const opt of [
      { value: 'none', label: 'Rien' },
      { value: 'shortcut', label: 'Exécuter un raccourci' },
      { value: 'app', label: 'Ouvrir une application' },
      { value: 'url', label: 'Ouvrir une page' }
    ]) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === diode.action) o.selected = true;
      action.append(o);
    }
    action.onchange = async () => {
      await patchCameraDiode(meta.id, { action: action.value });
      renderCameraDiodes();
    };

    row.append(head, action);

    if (diode.action === 'shortcut') {
      const shortcuts = document.createElement('select');
      shortcuts.className = 'camera-detail';
      for (const opt of CAMERA_SHORTCUTS) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = opt.label;
        if (opt.id === diode.shortcut) o.selected = true;
        shortcuts.append(o);
      }
      shortcuts.onchange = async () => {
        await patchCameraDiode(meta.id, { shortcut: shortcuts.value });
      };
      row.append(shortcuts);
    } else if (diode.action === 'app') {
      const input = document.createElement('input');
      input.className = 'camera-detail';
      input.type = 'text';
      input.placeholder = 'Nom menu Démarrer (ChatGPT, Explorateur…)';
      input.value = diode.app || '';
      input.onchange = async () => {
        await patchCameraDiode(meta.id, { app: input.value.trim() });
      };
      row.append(input);
    } else if (diode.action === 'url') {
      const input = document.createElement('input');
      input.className = 'camera-detail';
      input.type = 'url';
      input.placeholder = 'https://…';
      input.value = diode.url || '';
      input.onchange = async () => {
        await patchCameraDiode(meta.id, { url: input.value.trim() });
      };
      row.append(input);
    }

    root.append(row);
  }
}

function setSettingsFeedback(text, isError = false) {
  const tip = document.getElementById('settings-feedback');
  const msg = feedbackText(text);
  if (!tip) {
    if (msg) toast(msg);
    return;
  }
  tip.hidden = !msg;
  tip.textContent = msg;
  tip.classList.toggle('is-error', !!isError);
}

const PSEUDO_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function pseudoCooldownLeft() {
  const at = Number(state.profile?.pseudoChangedAt) || 0;
  if (!at) return 0;
  return Math.max(0, at + PSEUDO_COOLDOWN_MS - Date.now());
}

function formatCooldown(ms) {
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (ms >= day) return `${Math.ceil(ms / day)} j`;
  if (ms >= hour) return `${Math.ceil(ms / hour)} h`;
  const min = Math.max(1, Math.ceil(ms / (60 * 1000)));
  return `${min} min`;
}

function syncPseudoCooldownUi(form) {
  const tip = document.getElementById('pseudo-cooldown');
  const input = form?.pseudo;
  const left = pseudoCooldownLeft();
  const locked = left > 0;
  if (input) {
    input.disabled = locked;
    input.title = locked ? `Dispo dans ${formatCooldown(left)}` : '1 semaine entre chaque changement';
  }
  if (!tip) return;
  if (locked) {
    tip.hidden = false;
    tip.textContent = `Verrouillé ${formatCooldown(left)}`;
  } else {
    tip.hidden = true;
    tip.textContent = '';
  }
}

function openSettings() {
  const form = document.getElementById('settings');
  if (!form) return;
  // Compte login/register : pas de réglages. Hub / salon / seul : OK.
  if (!hasLocalAccount() || inAccountGate()) {
    forceCloseSettings();
    return;
  }
  form.hidden = false;
  const body = document.getElementById('body');
  if (body) body.hidden = true;
  showSettingsPage('main');
  bindSettingsNav();
  form.pseudo.value = state.profile.pseudo || '';
  form.openCombo.value = state.profile.openCombo || 'ANGE';
  setSettingsFeedback('');
  syncPseudoCooldownUi(form);
  const serverBlock = document.getElementById('server-settings');
  const comboBlock = document.getElementById('open-combo-settings');
  const sizeBlock = document.getElementById('size-settings');
  if (serverBlock) serverBlock.hidden = true;
  if (comboBlock) comboBlock.hidden = false;
  if (sizeBlock) sizeBlock.hidden = false;
  if (form.server) form.server.required = false;
  bindSizeSlider(form);
  const share = document.getElementById('share-settings');
  if (share) {
    share.replaceChildren();
    share.hidden = true;
  }
  window.deco.saveProfile({ settingsOpen: true }).then((profile) => {
    state.profile = profile;
  });
  fitChatWindow();
}

const UI_SIZE_ORDER = ['small', 'medium', 'normal', 'large'];

function uiSizeFromIndex(index) {
  return UI_SIZE_ORDER[Math.max(0, Math.min(3, Number(index) || 0))] || 'normal';
}

function uiSizeIndex(size) {
  const i = UI_SIZE_ORDER.indexOf(size);
  return i >= 0 ? i : 2;
}

function updateSizeMarks(size) {
  const root = document.getElementById('size-marks');
  if (!root) return;
  root.querySelectorAll('[data-size]').forEach((el) => {
    el.classList.toggle('on', el.dataset.size === size);
  });
}

function bindSizeSlider(form) {
  const slider = form.uiSize;
  if (!slider) return;
  const current = state.profile.uiSize || 'normal';
  slider.value = String(uiSizeIndex(current));
  updateSizeMarks(current);
  slider.oninput = () => {
    updateSizeMarks(uiSizeFromIndex(slider.value));
  };
  const applySize = () => {
    const size = uiSizeFromIndex(slider.value);
    updateSizeMarks(size);
    if (size === (state.profile?.uiSize || 'normal')) return;
    window.deco.saveProfile({ uiSize: size }).then((profile) => {
      state.profile = profile;
      requestAnimationFrame(() => fitChatWindow());
    }).catch(() => {});
  };
  slider.onchange = applySize;
  slider.onpointerup = applySize;
}

function closeSettings() {
  forceCloseSettings();
  window.deco.saveProfile({ settingsOpen: false }).then((profile) => {
    state.profile = profile;
  }).catch(() => {});
  fitChatWindow();
}

async function saveSettings(event) {
  event.preventDefault();
  if (state.settingsPage !== 'main') return;
  const form = event.currentTarget;
  const currentName = String(state.profile?.pseudo || '');
  const name = form.pseudo.value.trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    setSettingsFeedback('Pseudo trop court.', true);
    toast('Pseudo trop court.');
    return;
  }
  const renaming = name !== currentName;
  if (renaming) {
    const left = pseudoCooldownLeft();
    if (left > 0) {
      const msg = `Pseudo verrouillé encore ${formatCooldown(left)}.`;
      setSettingsFeedback(msg, true);
      toast(msg);
      syncPseudoCooldownUi(form);
      return;
    }
  }
  const patch = {
    settingsOpen: false
  };
  if (renaming) {
    patch.pseudo = name;
    patch.pseudoChangedAt = Date.now();
  }
  const comboBlock = document.getElementById('open-combo-settings');
  if (comboBlock && !comboBlock.hidden) {
    const combo = String(form.openCombo?.value || 'ANGE').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (combo.length < 2) {
      setSettingsFeedback('Mot-clé trop court (2–16 lettres/chiffres).', true);
      toast('Mot-clé trop court (2–16 lettres/chiffres).');
      return;
    }
    patch.openCombo = combo.slice(0, 16);
  }
  const sizeBlock = document.getElementById('size-settings');
  if (sizeBlock && !sizeBlock.hidden && form.uiSize) {
    patch.uiSize = uiSizeFromIndex(form.uiSize.value);
  }
  try {
    state.profile = await window.deco.saveProfile(patch);
    forceCloseSettings();
    toast('Enregistré.');
  } catch (err) {
    const msg = err?.message || 'Impossible d’enregistrer.';
    setSettingsFeedback(msg, true);
    toast(msg);
  }
}

async function init() {
  state.profile = await window.deco.getProfile();
  state.host = await window.deco.hostInfo();
  state.version = await window.deco.version();
  shell();
  syncCameraActions(state.profile?.cameraActions);
  window.deco.on('notify:click', () => {
    state.browsing = false;
    renderBody();
    if (state.activeGroup) syncGroupMessages();
    else syncMessages();
    if (state.profile?.settingsOpen) openSettings();
  });
  window.deco.on('chat:refit', () => fitChatWindow());
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => fitChatWindow()).catch(() => {});
  }
  if (state.profile.pseudo && state.profile.userId && state.profile.token) {
    if (state.profile.serverUrl) connect();
    else {
      state.forceSetup = true;
      await window.deco.saveProfile({ settingsOpen: false });
      state.profile.settingsOpen = false;
      renderBody();
    }
    // Réglages (serveur / mot-clé) seulement une fois dans le salon — pas à l’écran compte.
  } else {
    state.forceSetup = true;
    await window.deco.saveProfile({ settingsOpen: false });
    state.profile.settingsOpen = false;
    renderBody();
  }
}

init();
