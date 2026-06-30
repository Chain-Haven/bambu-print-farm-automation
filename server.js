// server.js — Antigravity Entry Point
import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, runMigrations, closeDb } from './src/db/database.js';
import { seedDefaultProfiles } from './src/db/seeds/default_profiles.js';
import { ensureAdminUser } from './src/auth/auth.js';
import apiRouter from './src/api/router.js';
import { initWebSocket, broadcast } from './src/api/websocket.js';
import { getSupervisor } from './src/runtime/RuntimeSupervisor.js';
import { JobOrchestrator } from './src/services/JobOrchestrator.js';
import TunnelService from './src/services/TunnelService.js';
import { errorHandler } from './src/api/middleware/errorHandler.js';
import { createLogger } from './src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('Server');

const app = express();
const server = createServer(app);

// Middleware
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS (dev)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);

// Error handler
app.use(errorHandler);

// SPA fallback
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Initialize
async function init() {
    try {
        // Database
        await initDb();
        runMigrations();
        seedDefaultProfiles();
        ensureAdminUser();
        log.info('Database initialized');

        // WebSocket
        const wss = initWebSocket(server);
        JobOrchestrator.setWsBroadcast(broadcast);
        TunnelService.setWsBroadcast(broadcast); // Inject into TunnelService

        // Runtime Supervisor
        const supervisor = getSupervisor();
        supervisor.setWsBroadcast(broadcast);
        await supervisor.start();

        // Start server
        const port = parseInt(process.env.PORT) || 3000;
        const host = process.env.HOST || '0.0.0.0';
        server.listen(port, host, () => {
            log.info(`🚀 Antigravity running at http://${host}:${port}`);
            log.info(`   Mode: ${process.env.MOCK_MODE === 'true' ? 'MOCK (simulators)' : 'LIVE'}`);
        });

        // Graceful shutdown
        const shutdown = async () => {
            log.info('Shutting down...');
            await supervisor.stop();
            closeDb();
            server.close();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

    } catch (err) {
        log.error('Init failed', err.message);
        console.error(err);
        process.exit(1);
    }
}

init();
