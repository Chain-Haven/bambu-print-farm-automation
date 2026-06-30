// public/js/api.js — API client with auth handling

class ApiClient {
    constructor() {
        this.baseUrl = '/api';
        this.token = localStorage.getItem('ag_token');
    }

    setToken(token) {
        this.token = token;
        localStorage.setItem('ag_token', token);
    }

    clearToken() {
        this.token = null;
        localStorage.removeItem('ag_token');
    }

    get isAuthenticated() {
        return !!this.token;
    }

    async request(method, path, body = null, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const config = { method, headers };
        if (body && method !== 'GET') {
            config.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const res = await fetch(`${this.baseUrl}${path}`, config);

        if (res.status === 401) {
            this.clearToken();
            window.location.hash = '#/login';
            throw new Error('Authentication required');
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    async upload(path, formData) {
        const headers = {};
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers, body: formData });
        if (res.status === 401) { this.clearToken(); window.location.hash = '#/login'; throw new Error('Auth required'); }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    // Auth
    async login(username, password) {
        const data = await this.request('POST', '/auth/login', { username, password });
        this.setToken(data.token);
        return data;
    }

    logout() { this.clearToken(); window.location.hash = '#/login'; }
    me() { return this.request('GET', '/auth/me'); }

    // Printers
    getPrinters() { return this.request('GET', '/printers'); }
    discoverPrinters() { return this.request('GET', '/printers/discover'); }
    getPrinter(id) { return this.request('GET', `/printers/${id}`); }
    createPrinter(data) { return this.request('POST', '/printers', data); }
    updatePrinter(id, data) { return this.request('PATCH', `/printers/${id}`, data); }
    deletePrinter(id) { return this.request('DELETE', `/printers/${id}`); }
    testPrinter(id) { return this.request('POST', `/printers/${id}/test-connection`); }
    testPrinterConnectionParams(params) { return this.request('POST', '/printers/test-connection-params', params); }
    getPrinterAms(id) { return this.request('GET', `/printers/${id}/ams`); }
    setAmsTray(id, trayId, data) { return this.request('PUT', `/printers/${id}/ams/${trayId}`, data); }
    clearAmsTray(id, trayId) { return this.request('DELETE', `/printers/${id}/ams/${trayId}`); }
    syncAms(id) { return this.request('POST', `/printers/${id}/ams/sync`); }
    getPrinterPreflight(id) { return this.request('GET', `/printers/${id}/preflight`); }
    getPrinterDiagnostics(id) { return this.request('GET', `/printers/${id}/diagnostics`); }
    recheckPrinter(id) { return this.request('POST', `/printers/${id}/recheck`); }
    sendControl(id, body) { return this.request('POST', `/printers/${id}/control`, body); }
    getOverrides(id) { return this.request('GET', `/printers/${id}/overrides`); }
    setOverride(id, key, value) { return this.request('PUT', `/printers/${id}/overrides`, { key, value }); }

    // Accessories
    getAccessories() { return this.request('GET', '/accessories'); }
    getAccessory(id) { return this.request('GET', `/accessories/${id}`); }
    createAccessory(data) { return this.request('POST', '/accessories', data); }
    deleteAccessory(id) { return this.request('DELETE', `/accessories/${id}`); }
    testAccessory(id) { return this.request('POST', `/accessories/${id}/test-connection`); }
    executeAccessory(id, action, params) { return this.request('POST', `/accessories/${id}/execute`, { action, params }); }

    // Commands
    enqueueCommand(data) { return this.request('POST', '/commands', data); }
    getCommands(params) { return this.request('GET', `/commands?${new URLSearchParams(params)}`); }

    // Jobs
    getJobs(params = {}) { return this.request('GET', `/jobs?${new URLSearchParams(params)}`); }
    getJob(id) { return this.request('GET', `/jobs/${id}`); }
    submitJob(formData) { return this.upload('/jobs/submit', formData); }
    updateJob(id, data) { return this.request('PATCH', `/jobs/${id}`, data); }
    cancelJob(id) { return this.request('POST', `/jobs/${id}/cancel`); }
    startJob(id) { return this.request('POST', `/jobs/${id}/start`); }
    getJobDownloadUrl(id, type = 'transformed') {
        return `${this.baseUrl}/jobs/${id}/download?type=${type}&token=${this.token}`;
    }
    deleteJob(id) { return this.request('DELETE', `/jobs/${id}`); }
    clearJobHistory() { return this.request('DELETE', '/jobs/history'); }

    // Job Templates
    getJobTemplates() { return this.request('GET', '/job-templates'); }
    getJobTemplate(id) { return this.request('GET', `/job-templates/${id}`); }
    createJobTemplate(formData) { return this.upload('/job-templates', formData); }
    updateJobTemplate(id, data) { return this.request('PATCH', `/job-templates/${id}`, data); }
    deleteJobTemplate(id) { return this.request('DELETE', `/job-templates/${id}`); }
    submitFromTemplate(id, overrides = {}) { return this.request('POST', `/job-templates/${id}/submit`, overrides); }

    // G-code
    getProfiles() { return this.request('GET', '/gcode/profiles'); }
    createProfile(data) { return this.request('POST', '/gcode/profiles', data); }
    updateProfile(id, data) { return this.request('PATCH', `/gcode/profiles/${id}`, data); }
    deleteProfile(id) { return this.request('DELETE', `/gcode/profiles/${id}`); }

    // Slicer
    getSliceBackends() { return this.request('GET', '/slice/backends'); }
    sliceModel(formData) { return this.upload('/slice', formData); }

    // Events
    getEvents(params = {}) { return this.request('GET', `/events?${new URLSearchParams(params)}`); }
    getEntityEvents(type, id) { return this.request('GET', `/events/${type}/${id}`); }

    // System
    getSystemStatus() { return this.request('GET', '/system/status'); }

    // Tunnel
    getTunnelStatus() { return this.request('GET', '/system/tunnel/status'); }
    startTunnel() { retu