import { randomInt, randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import {
  equalDigest, hashOpaqueToken, hashPassword, hashVerificationCode, randomToken, sha256, verifyPassword
} from './crypto.mjs';
import { MemoryCloudSaveRepository, MemorySessionRepository, MemoryUserRepository } from './repositories.mjs';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
const publicUser = ({ passwordHash, verification, ...user }) => structuredClone(user);

export class MangoService {
  constructor({ config, users, sessions, saves, verificationDelivery, clock = () => Date.now() }) {
    if (!config) throw new TypeError('config is required');
    this.config = config;
    this.users = users ?? new MemoryUserRepository();
    this.sessions = sessions ?? new MemorySessionRepository();
    this.saves = saves ?? new MemoryCloudSaveRepository();
    this.verificationDelivery = verificationDelivery ?? (async () => {});
    this.clock = clock;
  }

  async register({ email, password }) {
    email = normalizeEmail(email);
    if (!emailPattern.test(email) || email.length > 254) fail('INVALID_EMAIL', 'email is invalid');
    if (this.users.getByEmail(email)) fail('EMAIL_TAKEN', 'email is already registered');
    const passwordHash = await hashPassword(password);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.clock();
    const user = this.users.create({
      id: randomUUID(), email, status: 'pending_email_verification', passwordHash,
      verification: {
        codeHash: hashVerificationCode(email, code, this.config.tokenPepper),
        expiresAt: now + this.config.verificationTtlMs,
        attempts: 0
      },
      createdAt: now, verifiedAt: null
    });
    await this.verificationDelivery({ to: email, code, expiresAt: user.verification.expiresAt });
    return publicUser(user);
  }

  verifyEmail({ email, code }) {
    email = normalizeEmail(email);
    const user = this.users.getByEmail(email);
    if (!user) fail('INVALID_VERIFICATION', 'verification is invalid');
    if (user.status === 'active') return publicUser(user);
    if (user.status !== 'pending_email_verification') fail('INVALID_STATE', 'user cannot be verified');
    if (user.verification.expiresAt <= this.clock()) fail('VERIFICATION_EXPIRED', 'verification code expired');
    user.verification.attempts += 1;
    if (user.verification.attempts > 10) {
      this.users.update(user);
      fail('VERIFICATION_LOCKED', 'too many verification attempts');
    }
    const actual = hashVerificationCode(email, String(code), this.config.tokenPepper);
    if (!equalDigest(actual, user.verification.codeHash)) {
      this.users.update(user);
      fail('INVALID_VERIFICATION', 'verification is invalid');
    }
    user.status = 'active';
    user.verifiedAt = this.clock();
    user.verification = null;
    return publicUser(this.users.update(user));
  }

  async login({ email, password }) {
    const user = this.users.getByEmail(normalizeEmail(email));
    if (!user || !(await verifyPassword(password, user.passwordHash))) fail('INVALID_CREDENTIALS', 'email or password is incorrect');
    if (user.status !== 'active') fail('EMAIL_NOT_VERIFIED', 'email verification is required');
    return this.#createSession(user.id, randomUUID());
  }

  authenticate(accessToken) {
    const { id, secret } = this.#parseToken(accessToken, 'INVALID_ACCESS_TOKEN');
    const session = this.sessions.get(id);
    if (!session || session.revokedAt || session.accessExpiresAt <= this.clock() ||
        session.accessHash !== hashOpaqueToken(secret, this.config.tokenPepper)) {
      fail('INVALID_ACCESS_TOKEN', 'access token is invalid or expired');
    }
    return { userId: session.userId, sessionId: session.id };
  }

  refresh(refreshToken) {
    const { id, secret } = this.#parseToken(refreshToken, 'INVALID_REFRESH_TOKEN');
    const session = this.sessions.get(id);
    const matches = session && session.refreshHash === hashOpaqueToken(secret, this.config.tokenPepper);
    if (!matches) fail('INVALID_REFRESH_TOKEN', 'refresh token is invalid');
    if (session.revokedAt) {
      if (session.rotatedTo) this.#revokeFamily(session.familyId, 'refresh_reuse');
      fail('REFRESH_REVOKED', 'refresh token has been revoked');
    }
    if (session.refreshExpiresAt <= this.clock()) {
      session.revokedAt = this.clock();
      session.revokeReason = 'expired';
      this.sessions.update(session);
      fail('REFRESH_EXPIRED', 'refresh token expired');
    }
    const replacement = this.#createSession(session.userId, session.familyId);
    session.revokedAt = this.clock();
    session.revokeReason = 'rotated';
    session.rotatedTo = replacement.sessionId;
    this.sessions.update(session);
    return replacement;
  }

  revoke(refreshToken) {
    const { id, secret } = this.#parseToken(refreshToken, 'INVALID_REFRESH_TOKEN');
    const session = this.sessions.get(id);
    if (!session || session.refreshHash !== hashOpaqueToken(secret, this.config.tokenPepper)) {
      fail('INVALID_REFRESH_TOKEN', 'refresh token is invalid');
    }
    this.#revokeFamily(session.familyId, 'user_revoked');
  }

  listCloudSaves(accessToken) {
    const { userId } = this.authenticate(accessToken);
    return this.saves.list(userId);
  }

  createCloudSave(accessToken, { id, name, data }) {
    const { userId } = this.authenticate(accessToken);
    this.#validateSaveInput(id, name, data);
    const bytes = Buffer.from(data);
    const now = this.clock();
    const checksum = sha256(bytes);
    return this.saves.create({ id, userId, name, version: 1, size: bytes.length, checksum, createdAt: now, updatedAt: now },
      { version: 1, data: bytes, size: bytes.length, checksum, createdAt: now });
  }

  putCloudSnapshot(accessToken, saveId, { expectedVersion, data, name }) {
    const { userId } = this.authenticate(accessToken);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail('INVALID_VERSION', 'expectedVersion must be a positive integer');
    this.#validateSaveInput(saveId, name, data, true);
    const bytes = Buffer.from(data);
    const now = this.clock();
    const snapshot = { version: expectedVersion + 1, data: bytes, size: bytes.length, checksum: sha256(bytes), createdAt: now };
    return this.saves.appendSnapshot(userId, saveId, expectedVersion, snapshot, { name });
  }

  getCloudSnapshot(accessToken, saveId, version) {
    const { userId } = this.authenticate(accessToken);
    const snapshot = this.saves.getSnapshot(userId, saveId, version);
    if (!snapshot) fail('SNAPSHOT_NOT_FOUND', 'cloud snapshot does not exist');
    return snapshot;
  }

  #createSession(userId, familyId) {
    const now = this.clock();
    const id = randomUUID();
    const accessSecret = randomToken();
    const refreshSecret = randomToken();
    this.sessions.put({
      id, familyId, userId,
      accessHash: hashOpaqueToken(accessSecret, this.config.tokenPepper),
      refreshHash: hashOpaqueToken(refreshSecret, this.config.tokenPepper),
      accessExpiresAt: now + this.config.accessTtlMs,
      refreshExpiresAt: now + this.config.refreshTtlMs,
      createdAt: now, revokedAt: null, revokeReason: null, rotatedTo: null
    });
    return {
      sessionId: id,
      accessToken: `${id}.${accessSecret}`,
      refreshToken: `${id}.${refreshSecret}`,
      accessExpiresAt: now + this.config.accessTtlMs,
      refreshExpiresAt: now + this.config.refreshTtlMs
    };
  }

  #parseToken(token, code) {
    const split = typeof token === 'string' ? token.indexOf('.') : -1;
    if (split < 1 || split === token.length - 1) fail(code, 'token is malformed');
    return { id: token.slice(0, split), secret: token.slice(split + 1) };
  }

  #revokeFamily(familyId, reason) {
    const now = this.clock();
    for (const session of this.sessions.listByFamily(familyId)) {
      if (!session.revokedAt) {
        session.revokedAt = now;
        session.revokeReason = reason;
        this.sessions.update(session);
      }
    }
  }

  #validateSaveInput(id, name, data, nameOptional = false) {
    if (!idPattern.test(String(id ?? ''))) fail('INVALID_SAVE_ID', 'save id is invalid');
    if ((!nameOptional || name !== undefined) && (typeof name !== 'string' || !name.trim() || name.length > 128)) {
      fail('INVALID_SAVE_NAME', 'save name must contain 1-128 characters');
    }
    if (!(data instanceof Uint8Array)) fail('INVALID_SNAPSHOT', 'snapshot data must be a Uint8Array');
    if (data.byteLength > this.config.maxSnapshotBytes) fail('SNAPSHOT_TOO_LARGE', 'snapshot exceeds configured limit');
  }
}
