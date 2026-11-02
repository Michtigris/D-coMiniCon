const crypto = require('crypto');

function cleanPassword(password) {
  const value = String(password || '');
  if (value.length < 4 || value.length > 64) {
    throw new Error('Le mot de passe doit faire entre 4 et 64 caractères.');
  }
  return value;
}

function passwordHash(pseudo, password) {
  const name = String(pseudo || '').trim().toLowerCase();
  if (!name) throw new Error('Pseudo manquant.');
  const pwd = cleanPassword(password);
  const salt = `decominicon:v1:${name}`;
  return crypto.scryptSync(pwd, salt, 32).toString('hex');
}

module.exports = { cleanPassword, passwordHash };
