import { createSocket } from './net.js';
import { createRtc } from './rtc.js';

const app = document.getElementById('app');
const state = {
  profile: null,
  host: { hosting: false, urls: [] },
  version: '',
  status: 'boot',
  forceSetup: false,
  setupError: '',
  setupMode: 'login', // login | register | forgot
  setupPrefillEmail: '',
  accountGate: false, // force écran login/register même si un compte local existe
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

function toast(text) {
  state.toast = text;
  const el = document.getElementById('toast');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => toast(''), 2600);
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
          <button type="button" class="icon-btn" id="min" aria-label="Cacher la fenêtre">–</button>
        </div>
      </header>
      <div id="statusline" class="statusline" hidden></div>
      <div id="call" class="call" hidden></div>
      <main id="body"></main>
      <div id="toast" class="toast" hidden></div>
      <form id="settings" class="settings" hidden>
        <div class="section">Compte</div>
        <label>Pseudo <input name="pseudo" maxlength="16" required autocomplete="username" /></label>
        <label>Mdp <input name="password" type="password" maxlength="64" placeholder="Inchangé si vide" autocomplete="new-password" /></label>
        <p class="hint" id="settings-feedback" hidden></p>
        <div id="server-settings" hidden>
          <div class="section">Serveur</div>
          <label>Adresse <input name="server" placeholder="IP:3847" /></label>
          <label>Code <input name="code" maxlength="24" placeholder="Optionnel" /></label>
        </div>
        <div id="share-settings"></div>
        <div id="open-combo-settings" hidden>
          <div class="section">Ouverture</div>
          <label>Mot-clé <input name="openCombo" maxlength="16" placeholder="ANGE" autocomplete="off" spellcheck="false" /></label>
          <p class="hint" id="combo-hint"></p>
        </div>
        <div id="size-settings" hidden>
          <div class="section">Taille</div>
          <label class="size-slider">
            <input name="uiSize" type="range" min="0" max="3" step="1" />
            <span id="size-label">Normale</span>
          </label>
        </div>
        <button type="submit" class="primary">OK</button>
        <button type="button" class="ghost" id="close-settings">Fermer</button>
      </form>
    </div>
  `;
  document.getElementById('drag').addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, a, input')) return;
    window.deco.beginDrag();
  });
  document.getElementById('gear').onclick = openSettings;
  document.getElementById('min').onclick = () => window.deco.toggleChat();
  document.getElementById('settings').onsubmit = saveSettings;
  document.getElementById('close-settings').onclick = () => closeSettings();
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
    } else if (state.profile?.pseudo && state.profile?.token) {
      tag.textContent = 'Serveur';
    } else {
      tag.textContent = 'Compte';
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
  if (gear) gear.hidden = currentView() === 'setup';
  if (currentView() === 'setup') forceCloseSettings();
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
        <label>Adresse mail <input name="email" type="email" maxlength="120" required placeholder="toi@mail.com" autocomplete="email" /></label>
        <label>Mot de passe <input name="password" type="password" maxlength="64" required placeholder="XXXXXX" autocomplete="new-password" /></label>
        <label>Pseudo <input name="pseudo" maxlength="16" required placeholder="Pseudo" autocomplete="nickname" /></label>
        <p class="error" id="setup-error"></p>
        <div class="setup-actions">
          <button type="submit" class="primary">Créer le compte</button>
          <button type="button" class="ghost" id="back-login">Déjà un compte</button>
        </div>
      `;
      body.replaceChildren(form);
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
        <label>Nouveau mot de passe <input name="password" type="password" maxlength="64" required placeholder="XXXXXX" autocomplete="new-password" /></label>
        <p class="hint">Réinitialise le compte enregistré sur ce PC.</p>
        <p class="error" id="setup-error"></p>
        <div class="setup-actions">
          <button type="submit" class="primary">Réinitialiser</button>
          <button type="button" class="ghost" id="back-login">Retour</button>
        </div>
      `;
      body.replaceChildren(form);
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
      <label>Mot de passe <input name="password" type="password" maxlength="64" required placeholder="XXXXXX" autocomplete="current-password" /></label>
      <div class="setup-links">
        <button type="button" class="linkish" id="forgot-password">Mot de passe oublié</button>
      </div>
      <p class="error" id="setup-error"></p>
      <div class="setup-actions">
        <div class="setup-row">
          <button type="submit" class="primary">OK</button>
          <button type="button" class="ghost" id="go-register">Créer</button>
        </div>
      </div>
    `;
    body.replaceChildren(form);
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

  form.innerHTML = `
    <label>Serveur <input name="server" required placeholder="IP:3847" /></label>
    <label>Code <input name="code" maxlength="24" placeholder="Optionnel" /></label>
    <p class="error" id="setup-error"></p>
    <button type="submit" class="primary">Rejoindre</button>
    <button type="button" class="ghost" id="host-now">Héberger LAN</button>
  `;
  body.replaceChildren(form);
  form.server.value = state.profile?.serverUrl || 'http://127.0.0.1:3847';
  form.code.value = state.profile?.roomCode || '';
  form.querySelector('#setup-error').textContent = state.setupError || '';
  form.onsubmit = (event) => {
    event.preventDefault();
    joinServer({ server: form.server.value, code: form.code.value, host: false });
  };
  form.querySelector('#host-now').onclick = () => joinServer({
    server: 'http://127.0.0.1:3847',
    code: form.code.value,
    host: true
  });
  fitChatWindow();
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

async function joinServer({ server, code, host }) {
  if (!hasLocalAccount()) {
    state.setupError = 'Crée d’abord ton compte.';
    mountSetup();
    return;
  }
  let serverUrl;
  try {
    serverUrl = normalizeServer(server);
  } catch {
    state.setupError = 'Adresse du serveur invalide.';
    mountSetup();
    return;
  }
  state.profile = await window.deco.saveProfile({
    serverUrl,
    roomCode: String(code || '').trim(),
    hosting: !!host
  });
  if (host) {
    const result = await window.deco.startHost(String(code || '').trim());
    if (!result.ok) {
      state.setupError = result.message || 'Impossible d’héberger le salon.';
      mountSetup();
      return;
    }
    state.host = result;
    state.profile = await window.deco.saveProfile({ hosting: true, serverUrl: 'http://127.0.0.1:3847' });
    toast(`Adresse à donner : ${result.urls[0] || result.self}`);
  }
  state.forceSetup = false;
  state.setupError = '';
  connect();
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
  if (state.host?.hosting && state.host.urls?.length) {
    const share = document.createElement('div');
    share.className = 'share';
    const p = document.createElement('p');
    p.textContent = state.host.urls[0] || '';
    const row = document.createElement('div');
    row.className = 'row';
    row.append(actionButton('Copier', () => window.deco.copy(state.host.urls[0])));
    share.append(p, row);
    root.append(share);
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
  const tip = document.getElementById('settings-feedback');
  if (tip) {
    tip.hidden = true;
    tip.textContent = '';
  }
}

function setSettingsFeedback(text, isError = false) {
  const tip = document.getElementById('settings-feedback');
  if (!tip) {
    if (text) toast(text);
    return;
  }
  tip.hidden = !text;
  tip.textContent = text || '';
  tip.style.color = isError ? 'var(--red)' : 'var(--cyan)';
}

function openSettings() {
  const form = document.getElementById('settings');
  if (!form) return;
  // Setup = écrans dédiés uniquement — jamais le panneau réglages par-dessus.
  if (!hasLocalAccount() || currentView() === 'setup' || !isInSalon()) {
    forceCloseSettings();
    return;
  }
  form.hidden = false;
  form.pseudo.value = state.profile.pseudo || '';
  form.password.value = '';
  form.server.value = state.profile.serverUrl || '';
  form.code.value = state.profile.roomCode || '';
  form.openCombo.value = state.profile.openCombo || 'ANGE';
  setSettingsFeedback('');
  const serverBlock = document.getElementById('server-settings');
  const comboBlock = document.getElementById('open-combo-settings');
  const sizeBlock = document.getElementById('size-settings');
  if (serverBlock) serverBlock.hidden = false;
  if (comboBlock) comboBlock.hidden = false;
  if (sizeBlock) sizeBlock.hidden = false;
  form.server.required = true;
  updateComboHint(form.openCombo.value);
  form.openCombo.oninput = () => updateComboHint(form.openCombo.value);
  bindSizeSlider(form);
  const share = document.getElementById('share-settings');
  if (share) {
    share.replaceChildren();
    if (state.host?.hosting && state.host.urls?.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = state.host.urls[0] || '';
      share.append(p);
    }
  }
  window.deco.saveProfile({ settingsOpen: true }).then((profile) => {
    state.profile = profile;
  });
  fitChatWindow();
}

function updateComboHint(raw) {
  const el = document.getElementById('combo-hint');
  if (!el) return;
  const word = String(raw || 'ANGE').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ANGE';
  const n = Math.max(2, Math.min(16, word.length));
  const win = (0.5 + 0.4 * n).toFixed(1).replace('.', ',');
  el.textContent = `${word} · ${win}s`;
}

const UI_SIZE_ORDER = ['small', 'medium', 'normal', 'large'];
const UI_SIZE_LABELS = {
  small: 'Petite (0,5×)',
  medium: 'Moyenne (0,75×)',
  normal: 'Normale',
  large: 'Grande (1,5×)'
};

function uiSizeFromIndex(index) {
  return UI_SIZE_ORDER[Math.max(0, Math.min(3, Number(index) || 0))] || 'normal';
}

function uiSizeIndex(size) {
  const i = UI_SIZE_ORDER.indexOf(size);
  return i >= 0 ? i : 2;
}

function updateSizeLabel(size) {
  const el = document.getElementById('size-label');
  if (el) el.textContent = UI_SIZE_LABELS[size] || UI_SIZE_LABELS.normal;
}

function bindSizeSlider(form) {
  const slider = form.uiSize;
  if (!slider) return;
  const current = state.profile.uiSize || 'normal';
  slider.value = String(uiSizeIndex(current));
  updateSizeLabel(current);
  slider.oninput = () => {
    const size = uiSizeFromIndex(slider.value);
    updateSizeLabel(size);
    window.deco.saveProfile({ uiSize: size }).then((profile) => {
      state.profile = profile;
    }).catch(() => {});
  };
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
  const form = event.currentTarget;
  const name = form.pseudo.value.trim().replace(/\s+/g, ' ');
  if (name.length < 2) {
    setSettingsFeedback('Pseudo trop court.', true);
    toast('Pseudo trop court.');
    return;
  }
  const patch = {
    pseudo: name,
    settingsOpen: false
  };
  if (form.password.value) {
    try {
      requireNewPassword(form.password.value);
      patch.token = await window.deco.hashPassword(name, form.password.value);
    } catch (err) {
      const msg = err?.message || 'Mot de passe invalide (8 caractères min).';
      setSettingsFeedback(msg, true);
      toast(msg);
      return;
    }
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
  const serverBlock = document.getElementById('server-settings');
  if (serverBlock && !serverBlock.hidden && form.server?.value) {
    try {
      patch.serverUrl = normalizeServer(form.server.value);
      patch.roomCode = form.code.value.trim();
      patch.hosting = false;
    } catch {
      setSettingsFeedback('Adresse serveur invalide.', true);
      toast('Adresse serveur invalide.');
      return;
    }
  }
  try {
    if (state.profile.hosting && patch.serverUrl) {
      await window.deco.stopHost();
      state.host = { hosting: false, urls: [] };
    }
    state.profile = await window.deco.saveProfile(patch);
    form.password.value = '';
    forceCloseSettings();
    toast('Enregistré.');
    if (patch.serverUrl) {
      state.forceSetup = false;
      connect();
    }
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
