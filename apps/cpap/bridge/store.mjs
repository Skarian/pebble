import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, writeFile, chmod} from 'node:fs/promises';
import {dirname} from 'node:path';

function encryptionKey(secret) {
  if (!secret || secret.length < 16) {
    throw new Error('CPAP_BRIDGE_SECRET must be at least 16 characters');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function encryptJson(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url')
  };
}

export function decryptJson(value, secret) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(value.iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.data, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export class SessionStore {
  constructor(path, secret) {
    this.path = path;
    this.secret = secret;
    this.sessions = {};
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
        this.sessions = parsed.sessions;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async save() {
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({version: 1, sessions: this.sessions}, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  async create(credentials) {
    const token = randomBytes(32).toString('base64url');
    this.sessions[tokenHash(token)] = encryptJson(credentials, this.secret);
    await this.save();
    return token;
  }

  get(token) {
    const encrypted = this.sessions[tokenHash(token || '')];
    return encrypted ? decryptJson(encrypted, this.secret) : null;
  }

  async update(token, credentials) {
    const key = tokenHash(token || '');
    if (!this.sessions[key]) {
      return false;
    }
    this.sessions[key] = encryptJson(credentials, this.secret);
    await this.save();
    return true;
  }

  async revoke(token) {
    const key = tokenHash(token || '');
    const existed = Boolean(this.sessions[key]);
    delete this.sessions[key];
    if (existed) {
      await this.save();
    }
    return existed;
  }
}
