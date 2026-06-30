// src/api/websocket.js — WebSocket server for live updates
import { WebSocketServer } from 'ws';
import { verifyToken } from '../auth/auth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WebSocket');

let wss = null;

/**
 * Initialize WebSocket server on an existing HTTP server.
 */
export function initWebSocket(server) {
    wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
        // Extract token from query string
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (token) {
            const user = verifyToken(token);
            if (!user) {
                ws.close(4001, 'Invalid token');
                return;
            }
            ws.user = user;
        }

        log.info(`WebSocket client connected (${wss.clients.size} total)`);

        ws.on('close', () => {
            log.debug(`WebSocket client disconnected (${wss.clients.size} remaining)`);
        });

        ws.on('error', (err) => {
            log.error(`WebSocket error: ${err.message}`);
        });

        // Send initial status
        ws.send(JSON.stringify({ type: 'connected', data: { timestamp: new Date().toISOString() } }));
    });

    return wss;
}

/**
 * Broadcast a message to all connected clients.
 */
export function broadcast(message) {
    if (!wss) return;
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
        if (client.readyState === 1) { // OPEN
            client.send(data);
        }
    }
}

export default { initWebSocket, broadcast };
