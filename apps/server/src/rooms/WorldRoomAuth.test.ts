import { beforeEach, describe, expect, it, vi } from 'vitest';

// `onAuth` is the room's only identity check, so it is exercised here without a
// database: the account lookup and the token verifier are both stubbed.
vi.mock('../services/DatabaseService.js', () => ({ DatabaseService: {} }));

vi.mock('../services/AuthService.js', () => ({
  AuthService: { verifyToken: vi.fn(), findById: vi.fn() }
}));

const { WorldRoom } = await import('./WorldRoom.js');
const { AuthService } = await import('../services/AuthService.js');

const verifyToken = vi.mocked(AuthService.verifyToken);
const findById = vi.mocked(AuthService.findById);

function tokenPayload(overrides: Partial<{ id: string; username: string; displayName: string }> = {}) {
  return { id: 'user-1', username: 'theanh', displayName: 'theanh', exp: Date.now() + 60_000, ...overrides };
}

/**
 * `onAuth` is the join gate for ownership: the id it returns becomes the owner of
 * every entity the player creates, so it must be backed by a real account.
 */
describe('WorldRoom.onAuth', () => {
  beforeEach(() => {
    verifyToken.mockReset();
    findById.mockReset();
  });

  it('rejects a token it did not issue', async () => {
    verifyToken.mockReturnValue(null);

    await expect(WorldRoom.onAuth('forged')).rejects.toMatchObject({ code: 525 });
    expect(findById).not.toHaveBeenCalled();
  });

  it('rejects a valid token whose account no longer exists', async () => {
    // Regression: after a database reset the old token still verified, so the
    // join spawned an empire under a dead account id. Its first save then died on
    // the display name the live account already owned (P2002 on `players.name`).
    verifyToken.mockReturnValue(tokenPayload());
    findById.mockResolvedValue(null);

    await expect(WorldRoom.onAuth('stale-token')).rejects.toMatchObject({ code: 525 });
  });

  it('returns the identity stored in the database, not the token claims', async () => {
    verifyToken.mockReturnValue(tokenPayload({ displayName: 'Old Name' }));
    findById.mockResolvedValue({ id: 'user-1', username: 'theanh', displayName: 'New Name' });

    await expect(WorldRoom.onAuth('token')).resolves.toEqual({
      userId: 'user-1',
      username: 'theanh',
      displayName: 'New Name'
    });
  });
});
