import { Client } from '/Users/dev/projects/chien-quoc/apps/client/node_modules/@colyseus/sdk/build/index.mjs';

const base = 'http://localhost:2567';
const username = `probe${Date.now()}`;

const res = await fetch(`${base}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, displayName: `Probe${Date.now()}`, password: 'password123' })
});

if (!res.ok) {
  console.log('REGISTER FAILED', res.status, await res.text());
  process.exit(1);
}

const { token, user } = await res.json();
console.log(`registered user=${user.username} tokenLen=${token.length}`);

const client = new Client(base);
client.auth.token = token;

try {
  const room = await client.joinOrCreate('world_room', {});
  console.log(`GOOD: joined sessionId=${room.sessionId} roomId=${room.roomId}`);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const me = room.state?.players?.get?.(room.sessionId);
  console.log(`players=${room.state?.players?.size} me=${me ? me.name : 'missing'}`);
  await room.leave();
} catch (err) {
  console.log(`BAD: join failed code=${err.code} msg=${err.message}`);
  process.exit(1);
}

process.exit(0);
