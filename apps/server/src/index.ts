import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { WorldRoom } from './rooms/WorldRoom.js';

const port = Number(process.env.PORT || 2567);
const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'Chien Quoc RTS MMO Server', timestamp: Date.now() });
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

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server
  })
});

// Define persistent world room
gameServer.define('world_room', WorldRoom);

// Start game server
gameServer.listen(port).then(() => {
  console.log(`⚔️  Chien Quoc Game Server is running on http://localhost:${port} and ws://localhost:${port}`);
});
