import 'dotenv/config';
// Must be imported before any router that defines async route handlers —
// it patches Express to forward rejected promises to the error handler
// below, instead of crashing the process on an unhandled rejection.
import 'express-async-errors';
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
// import path from 'path';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { conferencesRouter } from './routes/conferences';
import { participantsRouter } from './routes/participants';
import { handleSrtBridge } from './ws/srtBridge';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  // origin: (origin, cb) => {
  //   // Allow requests with no origin (curl, mobile apps hitting the proxy)
  //   if (!origin) return cb(null, true);
  //   // Allow localhost and any LAN IP (10.x, 192.168.x, 172.x)
  //   const allowed = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin);
  //   cb(allowed ? null : new Error('Not allowed by CORS'), allowed);
  // },
  credentials: true,
}));
app.use(express.json());
app.use(morgan('combined'));

// Serve HLS segments for dashboard preview
app.use('/hls', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  next();
}, express.static(process.env.HLS_OUTPUT_DIR || '/var/www/hls'));

// REST routes
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/conferences', conferencesRouter);
app.use('/api/conferences', participantsRouter);

// Serve built web-client
// const webClientPath = path.join(__dirname, '../../web-client/dist');
// app.use(express.static(webClientPath));

// // SPA fallback — all non-API routes return index.html
// app.get('*', (req, res) => {
//   if (!req.path.startsWith('/api') && !req.path.startsWith('/hls')) {
//     res.sendFile(path.join(webClientPath, 'index.html'));
//   }
// });

// Health check
app.get('/health', (_, res) => res.json({
  status: 'ok',
  srtTarget: `srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`,
}));

// Global error handler — catches errors forwarded by express-async-errors
// from any route (e.g. Prisma constraint violations) so a single bad
// request returns a 500 instead of taking down the whole process.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket → FFmpeg → SRT bridge
//
// Heartbeat: `ws` has no built-in keepalive. Without this, a connection that
// dies silently (phone loses signal mid-stream, no TCP FIN/RST ever arrives)
// never fires 'close' on the server — so srtBridge's `activeStreams` entry for
// that reporter is never cleaned up, and their next reconnect attempt gets
// rejected with "Stream already active" against a socket that's actually dead.
// Pinging every 15s and terminating anything that missed the last pong bounds
// that stale window to ~15-30s instead of leaving it open indefinitely.
wss.on('connection', (ws, req) => {
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });
  handleSrtBridge(ws, req);
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if ((ws as any).isAlive === false) return ws.terminate();
    (ws as any).isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => clearInterval(heartbeat));

// Last-resort net for rejections outside the Express request lifecycle
// (e.g. WS bridge code, timers) that express-async-errors can't catch —
// log and keep the process alive instead of crashing all live broadcasts.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});

const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] SRT target: srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`);
});
