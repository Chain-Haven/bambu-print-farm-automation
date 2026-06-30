// public/js/ws.js — WebSocket client for live updates

class WsClient {
    constructor() {
        this.ws = null;
        this.listeners = new Map();
        this.reconnectInterval = 3000;
        this.reconnectTimer = null;
    }

    connect() {
        const token = localStorage.getItem('ag_token');
        if (!token) return;

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/ws?token=${token}`;

        try {
            this.ws = new WebSocket(url);
            this.ws.onopen = () => console.log('[WS] Connected');
            this.ws.onmessage = (e) => this._handleMessage(e);
            this.ws.onclose = () => { console.log('[WS] Disconnected'); this._scheduleReconnect(); };
            this.ws.onerror = () => { };
        } catch (e) { this._scheduleReconnect(); }
    }

    disconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) { this.ws.close(); this.ws = null; }
    }

    on(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }

    off(type, callback) {
        const cbs = this.listeners.get(type);
        if (cbs) this.listeners.set(type, cbs.filter(cb => cb !== callback));
    }

    _handleMessage(event) {
        try {
            const msg = JSON.parse(event.data);
            const cbs = this.listeners.get(msg.type) || [];
            cbs.forEach(cb => cb(msg.data, msg));
            // Also fire wildcard listeners
            (this.listeners.get('*') || []).forEach(cb => cb(msg));
        } catch (e) { }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectInterval);
    }
}

window.ws = new WsClient();
