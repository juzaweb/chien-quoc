import crypto from 'crypto';
import { prisma } from './DatabaseService.js';
import { normalizeForComparison } from '../utils/normalizeName.js';

const PASSWORD_KEY_LENGTH = 64;
const SALT_BYTES = 16;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const USERNAME_PATTERN = /^[a-z0-9_.-]{3,24}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 24;
const MIN_SECRET_LENGTH = 16;

/**
 * Control characters, line/paragraph separators, and zero-width characters.
 * `displayName` is rendered in the HUD and written to server logs, so a
 * newline here would let a player forge log lines or break the UI.
 */
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/;

/** Public shape of an account, safe to send to the client. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

/** Claims embedded in an issued token. */
export interface AuthTokenPayload extends AuthUser {
  exp: number;
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
}

/**
 * Raised for expected auth failures (bad input, duplicate account, wrong
 * password). The HTTP layer maps `status` onto the response code so internal
 * details never leak.
 */
export class AuthError extends Error {
  public readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/**
 * Stateless account service: scrypt password hashes stored in SQLite and
 * HMAC-signed bearer tokens (no external auth/JWT dependency).
 *
 * Uses raw SQL, so the column names below are the physical snake_case names
 * from `prisma/schema.prisma`'s `@map`/`@@map`, not the Prisma field names.
 */
export class AuthService {
  private static cachedSecret: string | null = null;

  /**
   * Registers a new account and returns it together with a signed token.
   */
  public static async register(input: {
    username?: unknown;
    displayName?: unknown;
    password?: unknown;
  }): Promise<{ user: AuthUser; token: string }> {
    const username = this.normalizeUsername(input.username);
    const password = this.validatePassword(input.password);
    const displayName = this.normalizeDisplayName(input.displayName, username);

    const existing = await this.findByUsername(username);
    if (existing) {
      throw new AuthError('Tên đăng nhập đã được sử dụng.', 409);
    }

    // `Player.name` is the display name shown in-game and stays unique so two
    // accounts cannot look identical. Ownership is `Player.id` (the account id),
    // so this check only guards readability, not the empire.
    // Comparison uses a normalized key because SQLite's lower() only folds ASCII
    // (so "Đại Việt" and "đại việt" would otherwise both be allowed).
    const displayNameKey = normalizeForComparison(displayName);

    // Compared in JS: SQLite cannot fold diacritics, and empires are few.
    const existingPlayers = await prisma.$queryRaw<{ name: string }[]>`
      SELECT "name" FROM "players"
    `;
    if (existingPlayers.some((p) => normalizeForComparison(p.name) === displayNameKey)) {
      throw new AuthError('Tên lãnh chúa này đã có người sử dụng.', 409);
    }

    const nameTaken = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "users" WHERE "display_name_key" = ${displayNameKey} LIMIT 1
    `;
    if (nameTaken.length > 0) {
      throw new AuthError('Tên lãnh chúa này đã có người sử dụng.', 409);
    }

    const id = crypto.randomUUID();
    const passwordHash = await this.hashPassword(password);

    try {
      await prisma.$executeRaw`
        INSERT INTO "users" ("id", "username", "display_name", "display_name_key", "password_hash")
        VALUES (${id}, ${username}, ${displayName}, ${displayNameKey}, ${passwordHash})
      `;
    } catch {
      // A unique index raced with another registration; report it as a conflict
      // rather than leaking the driver's error text.
      throw new AuthError('Tên đăng nhập hoặc tên lãnh chúa đã được sử dụng.', 409);
    }

    const user: AuthUser = { id, username, displayName };
    return { user, token: this.signToken(user) };
  }

  /**
   * Verifies credentials and returns the account with a fresh token.
   */
  public static async login(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<{ user: AuthUser; token: string }> {
    const username = this.normalizeUsername(input.username);
    const password = typeof input.password === 'string' ? input.password : '';

    const row = await this.findByUsername(username);
    // Compare against a dummy hash when the account is missing so the response
    // time does not reveal whether a username exists.
    const storedHash = row?.passwordHash ?? (await this.getDummyHash());
    const valid = await this.verifyPassword(password, storedHash);

    if (!row || !valid) {
      throw new AuthError('Sai tên đăng nhập hoặc mật khẩu.', 401);
    }

    await prisma.$executeRaw`
      UPDATE "users" SET "last_login_at" = CURRENT_TIMESTAMP WHERE "id" = ${row.id}
    `;

    const user: AuthUser = { id: row.id, username: row.username, displayName: row.displayName };
    return { user, token: this.signToken(user) };
  }

  /**
   * Resolves a bearer token into its account, or `null` when invalid/expired.
   */
  public static verifyToken(token: string | null | undefined): AuthTokenPayload | null {
    if (!token) return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [encodedPayload, signature] = parts;
    const expected = crypto
      .createHmac('sha256', this.getSecret())
      .update(encodedPayload)
      .digest('base64url');

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return null;
    }

    let payload: AuthTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (
      typeof payload?.exp !== 'number' ||
      payload.exp < Date.now() ||
      typeof payload.id !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.displayName !== 'string'
    ) {
      return null;
    }

    return payload;
  }

  /** Signs claims into `base64url(payload).hmac` form. */
  private static signToken(user: AuthUser): string {
    const payload: AuthTokenPayload = { ...user, exp: Date.now() + TOKEN_TTL_MS };
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.getSecret())
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  }

  /**
   * Validates the signing configuration once at startup.
   *
   * Called before the server accepts traffic so a production deployment without
   * AUTH_SECRET fails loudly at boot instead of returning 500 on every login.
   */
  public static assertConfigured(): void {
    this.getSecret();
  }

  /**
   * Resolves the HMAC signing key.
   *
   * Fails closed: a predictable key lets anyone forge a token for any account,
   * so the server refuses to issue or verify tokens rather than silently
   * accepting the hardcoded development value in production. The insecure
   * fallback is only allowed outside production, and only with a loud warning.
   */
  private static getSecret(): string {
    if (this.cachedSecret) return this.cachedSecret;

    const fromEnv = process.env.AUTH_SECRET;
    if (fromEnv && fromEnv.length >= MIN_SECRET_LENGTH) {
      this.cachedSecret = fromEnv;
      return this.cachedSecret;
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `[AuthService] AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters in production.`
      );
    }

    console.warn(
      '⚠️  [AuthService] AUTH_SECRET is not set. Using an insecure development secret.'
    );
    this.cachedSecret = 'chien-quoc-insecure-development-secret';
    return this.cachedSecret;
  }

  private static async findByUsername(username: string): Promise<UserRow | null> {
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT "id", "username", "display_name" AS "displayName", "password_hash" AS "passwordHash"
      FROM "users"
      WHERE "username" = ${username}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private static async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES).toString('base64');
    const derived = await this.scrypt(password, salt);
    return `scrypt$${salt}$${derived.toString('base64')}`;
  }

  private static async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !expected) return false;

    const expectedBuffer = Buffer.from(expected, 'base64');
    const actual = await this.scrypt(password, salt);
    if (actual.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(actual, expectedBuffer);
  }

  private static scrypt(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      });
    });
  }

  private static dummyHash: string | null = null;

  private static async getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      this.dummyHash = await this.hashPassword('chien-quoc-dummy-password');
    }
    return this.dummyHash;
  }

  private static normalizeUsername(value: unknown): string {
    const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new AuthError(
        'Tên đăng nhập phải dài 3-24 ký tự, chỉ gồm chữ thường, số và _ . -',
        422
      );
    }
    return username;
  }

  private static validatePassword(value: unknown): string {
    const password = typeof value === 'string' ? value : '';
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new AuthError(
        `Mật khẩu phải có từ ${MIN_PASSWORD_LENGTH} đến ${MAX_PASSWORD_LENGTH} ký tự.`,
        422
      );
    }
    return password;
  }

  private static normalizeDisplayName(value: unknown, fallback: string): string {
    const raw = (typeof value === 'string' ? value.trim() : '') || fallback;

    // Checked before whitespace collapsing: a newline would otherwise be
    // silently rewritten to a space, hiding the fact that the player tried to
    // inject a log line. Reject it instead of guessing their intent.
    if (FORBIDDEN_NAME_CHARS.test(raw)) {
      throw new AuthError('Tên lãnh chúa chứa ký tự không hợp lệ.', 422);
    }

    // Collapse inner whitespace so "Đại  Việt" and "Đại Việt" cannot both exist
    // as visually identical lords.
    const displayName = raw.replace(/\s+/g, ' ');

    if (displayName.length < 2 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new AuthError(
        `Tên lãnh chúa phải có từ 2 đến ${MAX_DISPLAY_NAME_LENGTH} ký tự.`,
        422
      );
    }

    return displayName;
  }
}
