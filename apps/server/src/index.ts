import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { WorldRoom } from './rooms/WorldRoom.js';
import { DatabaseService } from './services/DatabaseService.js';
import { AuthError, AuthService } from './services/AuthService.js';
import { createRateLimit } from './services/RateLimiter.js';

const port = Number(process.env.PORT || 2567);
const app = express();

// Auth is a bearer token in a header, never a cookie, so credentialed CORS is
// unnecessary; enabling it would only widen what a hostile origin can read.
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Brute-force and scrypt CPU-exhaustion guard for the unauthenticated routes.
const authRateLimit = createRateLimit({ limit: 10, windowMs: 60_000 });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'Chien Quoc RTS MMO Server', timestamp: Date.now() });
});

/**
 * Maps auth failures to their HTTP status while keeping unexpected errors opaque.
 */
function sendAuthError(res: express.Response, err: unknown) {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[Auth Error]', err);
  res.status(500).json({ error: 'Lỗi hệ thống. Vui lòng thử lại.' });
}

app.post('/auth/register', authRateLimit, async (req, res) => {
  try {
    const result = await AuthService.register(req.body ?? {});
    res.status(201).json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

app.post('/auth/login', authRateLimit, async (req, res) => {
  try {
    const result = await AuthService.login(req.body ?? {});
    res.json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

app.get('/auth/me', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const payload = AuthService.verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
    return;
  }

  res.json({
    user: { id: payload.id, username: payload.username, displayName: payload.displayName }
  });
});

// Colyseus matchmaking endpoints bridge for colyseus.js 0.16 & 0.18 client compatibility
app.all('/matchmake/:method/:param?', async (req, res) => {
  try {
    const { method, param } = req.params;
    const clientOptions = req.method === 'GET' ? req.query : req.body || {};

    if (typeof (matchMaker as any)[method] !== 'function') {
      return res.status(404).json({ error: `Invalid matchmaking method: ${method}` });
    }

    const result = await (matchMaker as any)[method](param, clientOptions);

    // Provide both nested room object (for colyseus.js 0.16) and flat keys (for 0.18)
    const payload = {
      ...result,
      room: {
        name: result.name,
        roomId: result.roomId,
        processId: result.processId,
        publicAddress: result.publicAddress
      },
      sessionId: result.sessionId
    };

    res.json(payload);
  } catch (err: any) {
    console.error(`[MatchMake Error] ${req.params.method}:`, err);
    res.status(err.code || 500).json({ error: err.message });
  }
});

async function start() {
  // Ensure the SQLite file, folder and tables exist before accepting traffic.
  // initialize() throws on failure, so the server never starts on a broken DB.
  await DatabaseService.initialize();

  // Fail at boot rather than on every request when the signing key is missing.
  AuthService.assertConfigured();

  const server = http.createServer(app);

  const gameServer = new Server({
    transport: new WebSocketTransport({
      server
    })
  });

  // Define persistent world room
  gameServer.define('world_room', WorldRoom);

  await gameServer.listen(port);
  console.log(`⚔️  Chien Quoc Game Server is running on http://localhost:${port} and ws://localhost:${port}`);
}

start().catch(async (err) => {
  console.error('❌ [Server] Failed to start:', err);
  // Close the SQLite connection so the process can exit without hanging handles.
  await DatabaseService.disconnect().catch(() => undefined);
  process.exit(1);
});
