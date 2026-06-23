import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { conferencesRouter } from './routes/conferences';
import { participantsRouter } from './routes/participants';
import { handleSrtBridge } from './ws/srtBridge';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL }));
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

// Health check
app.get('/health', (_, res) => res.json({
  status: 'ok',
  srtTarget: `srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`,
}));

// WebSocket → FFmpeg → SRT bridge
wss.on('connection', handleSrtBridge);

const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] SRT target: srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`);
});
