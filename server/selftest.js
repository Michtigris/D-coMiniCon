const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { start, stop } = require('./index');

const dataFile = path.join(os.tmpdir(), `decominicon-${Date.now()}.json`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitFor(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Délai dépassé en attendant ${type}`)), 3000);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error' && type !== 'error') {
        cleanup();
        reject(new Error(msg.payload.message));
        return;
      }
      if (msg.type === type) {
        cleanup();
        resolve(msg);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
    }
    socket.on('message', onMessage);
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

const { passwordHash } = require('./password');

function identity(pseudo, password = 'test-pass') {
  return {
    userId: crypto.randomUUID(),
    token: passwordHash(pseudo, password),
    password,
    pseudo,
    roomCode: 'salon'
  };
}

async function auth(socket, payload) {
  const pending = waitFor(socket, 'auth:ok');
  socket.send(JSON.stringify({ type: 'auth', payload }));
  const msg = await pending;
  return msg.payload;
}

async function run() {
  const info = await start({ port: 0, host: '127.0.0.1', dataFile, roomCode: 'salon' });
  const wrong = await connect(info.port);
  const refused = waitFor(wrong, 'auth:error');
  wrong.send(JSON.stringify({ type: 'auth', payload: { ...identity('Noa'), roomCode: 'autre' } }));
  const refusal = await refused;
  assert(/code/i.test(refusal.payload.message), 'Le mauvais code doit être refusé.');
  wrong.close();

  const aliceSocket = await connect(info.port);
  const bobSocket = await connect(info.port);
  const alice = identity('Alice');
  const bob = identity('Bob');
  const aliceAuth = await auth(aliceSocket, alice);
  const aliceLobby = waitFor(aliceSocket, 'lobby');
  const bobAuth = await auth(bobSocket, bob);
  const lobby = await aliceLobby;
  assert(lobby.payload.users.some((user) => user.pseudo === 'Bob'), 'Bob doit apparaître dans le salon.');
  assert(aliceAuth.user.pseudo === 'Alice', 'Alice doit être identifiée.');
  assert(bobAuth.user.pseudo === 'Bob', 'Bob doit être identifié.');

  const duplicate = await connect(info.port);
  const taken = waitFor(duplicate, 'auth:error');
  duplicate.send(JSON.stringify({
    type: 'auth',
    payload: { ...identity('alice', 'autre-mdp'), roomCode: 'salon' }
  }));
  const takenMsg = await taken;
  assert(/mot de passe|déjà pris/i.test(takenMsg.payload.message), 'Un mauvais mot de passe / pseudo pris doit être refusé.');
  duplicate.close();

  const incoming = waitFor(bobSocket, 'social');
  aliceSocket.send(JSON.stringify({ type: 'friend:request', payload: { toId: bob.userId } }));
  const asked = await incoming;
  assert(asked.payload.incoming.some((request) => request.pseudo === 'Alice'), 'Bob doit recevoir la demande.');

  const accepted = waitFor(aliceSocket, 'social');
  bobSocket.send(JSON.stringify({
    type: 'friend:accept',
    payload: { requestId: asked.payload.incoming[0].id }
  }));
  const friends = await accepted;
  assert(friends.payload.friends.some((friend) => friend.pseudo === 'Bob'), 'Alice doit avoir Bob en ami.');

  const linkedAlice = waitFor(aliceSocket, 'link:state');
  const linkedBob = waitFor(bobSocket, 'link:state');
  aliceSocket.send(JSON.stringify({ type: 'link', payload: { friendId: bob.userId } }));
  const aliceLink = await linkedAlice;
  const bobLink = await linkedBob;
  assert(aliceLink.payload.partner.pseudo === 'Bob', 'Alice doit être liée à Bob.');
  assert(bobLink.payload.partner.pseudo === 'Alice', 'Bob doit être lié à Alice.');
  assert(bobLink.payload.by === alice.userId, 'Le lien doit indiquer qui l’a demandé.');

  const delivered = waitFor(bobSocket, 'message:new');
  aliceSocket.send(JSON.stringify({ type: 'message', payload: { text: 'Salut Bob' } }));
  const message = await delivered;
  assert(message.payload.message.text === 'Salut Bob', 'Bob doit recevoir le message.');

  const ringing = waitFor(bobSocket, 'call:incoming');
  aliceSocket.send(JSON.stringify({ type: 'call', payload: {} }));
  const call = await ringing;
  assert(call.payload.from.pseudo === 'Alice', 'Bob doit recevoir l’appel.');
  bobSocket.send(JSON.stringify({ type: 'call:answer', payload: { accept: false } }));
  const closed = await waitFor(aliceSocket, 'call:closed');
  assert(closed.payload.reason === 'decline', 'Un refus doit fermer l’appel.');

  aliceSocket.close();
  const resumedSocket = await connect(info.port);
  const resumed = await auth(resumedSocket, alice);
  assert(resumed.link.partner.id === bob.userId, 'Le lien doit reprendre après reconnexion.');
  assert(resumed.link.messages.some((item) => item.text === 'Salut Bob'), 'La conversation doit reprendre.');
  resumedSocket.close();
  bobSocket.close();
}

(async () => {
  let failed = null;
  try {
    await run();
  } catch (err) {
    failed = err;
  } finally {
    await stop();
    fs.rmSync(dataFile, { force: true });
  }
  if (failed) {
    console.error(failed);
    process.exit(1);
  }
  console.log('Salon OK');
  process.exit(0);
})();
