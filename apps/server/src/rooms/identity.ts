import { Client } from '@colyseus/core';

/**
 * Identity resolved by `WorldRoom.onAuth` and exposed to the room as
 * `client.auth`. It carries the verified account, never client-supplied options.
 */
export interface RoomAuth {
  /** `User.id` — the stable ownership key for every entity and DB row. */
  userId: string;
  username: string;
  displayName: string;
}

/**
 * The ownership key of the client that sent a message: the account id, never the
 * socket session id.
 *
 * A session id changes on every refresh, reconnect and second tab, so keying
 * ownership on it lost the empire on each re-entry. `onAuth` runs before every
 * join and rejects unauthenticated connections, so a missing `auth` here can
 * only mean a bug in the auth wiring: returns `''`, which matches no player and
 * therefore refuses the command instead of granting ownership.
 */
export function ownerIdOf(client: Client): string {
  return (client.auth as Partial<RoomAuth> | undefined)?.userId ?? '';
}
