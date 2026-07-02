const INTEGRATION_MODES = [
    {
        mode: 'fleet_hub',
        label: 'Fleet Hub',
        officiality: 'official',
        best_for: 'Enterprise farms, wired sites, and MES/ERP/WMS integration paths.',
        risk_level: 'low',
    },
    {
        mode: 'bambu_connect',
        label: 'Bambu Connect',
        officiality: 'official',
        best_for: 'Supported third-party file transfer and print initiation.',
        risk_level: 'low',
    },
    {
        mode: 'lan_developer_mode',
        label: 'LAN Developer Mode',
        officiality: 'advanced_user',
        best_for: 'Trusted local networks that need direct MQTT, live stream, and FTP control.',
        risk_level: 'medium',
    },
    {
        mode: 'community_lan',
        label: 'Community LAN Adapter',
        officiality: 'community',
        best_for: 'Diagnostics and fallback behavior where official paths are insufficient.',
        risk_level: 'high',
    },
];

const MODEL_PROFILES = {
    p1_series: {
        model_family: 'p1_series',
        label: 'P1/X1 era farm printers',
        default_mode: 'bambu_connect',
        local_mode: 'lan_developer_mode',
        fallback_mode: 'bambu_connect',
        capabilities: ['lan_mode', 'developer_mode', 'ams', 'low_rate_camera', 'auto_eject_possible'],
    },
    a1_series: {
        model_family: 'a1_series',
        label: 'A1 and A1 Mini',
        default_mode: 'bambu_connect',
        local_mode: 'lan_developer_mode',
        fallback_mode: 'lan_developer_mode',
        capabilities: ['lan_mode', 'developer_mode', 'ams_lite', 'single_ams_lite_limit'],
    },
    p2_series: {
        model_family: 'p2_series',
        label: 'P2 series',
        default_mode: 'bambu_connect',
        local_mode: 'lan_developer_mode',
        fallback_mode: 'bambu_connect',
        capabilities: ['lan_mode', 'developer_mode', 'multi_ams', 'native_skip_object'],
    },
    h2_series: {
        model_family: 'h2_series',
        label: 'H2 series',
        default_mode: 'bambu_connect',
        local_mode: 'fleet_hub',
        fallback_mode: 'bambu_connect',
        capabilities: ['fleet_hub', 'ethernet', 'high_rate_camera', 'ai_detection'],
    },
    generic_bambu: {
        model_family: 'generic_bambu',
        label: 'Generic Bambu printer',
        default_mode: 'bambu_connect',
        local_mode: 'lan_developer_mode',
        fallback_mode: 'lan_developer_mode',
        capabilities: ['model_capability_probe_required'],
    },
};

const RISK_REGISTER = [
    {
        risk: 'bambu_authorization_changes',
        severity: 'high',
        mitigation: 'Prefer Fleet Hub and Bambu Connect first; keep LAN Developer Mode behind capability flags.',
    },
    {
        risk: 'unofficial_lan_protocol_drift',
        severity: 'high',
        mitigation: 'Isolate community LAN behavior behind adapters and regression-test by model and firmware.',
    },
    {
        risk: 'windows_edge_agent_offline',
        severity: 'medium',
        mitigation: 'Use durable command intents, leases, retry outbox, and local health reporting.',
    },
    {
        risk: 'telemetry_volume_growth',
        severity: 'medium',
        mitigation: 'Sample telemetry, retain current-state projections, and store media selectively.',
    },
];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isOnline(value) {
    return String(value || '').toLowerCase() === 'online';
}

function hasCapability(capabilities, ...keys) {
    return keys.some((key) => capabilities[key] === true || capabilities[key] === 'true');
}

export function detectBambuModelFamily(model) {
    const normalized = String(model || '').toLowerCase();
    if (/\bh2[cds]?\b/.test(normalized) || normalized.includes('h2d') || normalized.includes('h2 pro')) {
        return 'h2_series';
    }
    if (/\bp2[sc]?\b/.test(normalized) || normalized.includes('p2s')) {
        return 'p2_series';
    }
    if (/\ba1\b/.test(normalized) || normalized.includes('a1 mini') || normalized.includes('a1 combo')) {
        return 'a1_series';
    }
    if (/\bp1[ps]?\b/.test(normalized) || normalized.includes('p1s') || normalized.includes('x1c')) {
        return 'p1_series';
    }
    return 'generic_bambu';
}

function chooseAdapter(printer) {
    const capabilities = isPlainObject(printer.capabilities) ? printer.capabilities : {};
    const modelFamily = detectBambuModelFamily(printer.model || printer.name || printer.local_printer_id);
    const profile = MODEL_PROFILES[modelFamily] || MODEL_PROFILES.generic_bambu;
    const fleetReady = hasCapability(capabilities, 'fleet_hub', 'fleetHub', 'fleet_hub_api');
    const lanDeveloperReady = hasCapability(capabilities, 'lan_mode', 'lanMode')
        && hasCapability(capabilities, 'developer_mode', 'developerMode', 'mqtt');
    let recommendedMode = profile.default_mode;
    let fallbackMode = profile.fallback_mode;
    let riskLevel = 'medium';

    if (fleetReady) {
        recommendedMode = 'fleet_hub';
        fallbackMode = 'bambu_connect';
        riskLevel = 'low';
    } else if (lanDeveloperReady && ['p1_series', 'p2_series'].includes(modelFamily)) {
        recommendedMode = 'lan_developer_mode';
        fallbackMode = 'bambu_connect';
        riskLevel = 'medium';
    } else if (modelFamily === 'h2_series' && !fleetReady) {
        recommendedMode = 'bambu_connect';
        fallbackMode = 'fleet_hub';
        riskLevel = 'medium';
    }

    const nextActions = [];
    if (!isOnline(printer.status)) {
        nextActions.push('Bring the printer online and confirm the Windows edge agent can see it.');
    }
    if (recommendedMode === 'lan_developer_mode' && !lanDeveloperReady) {
        nextActions.push('Enable LAN Mode and Developer Mode before direct local control.');
    }
    if (recommendedMode === 'fleet_hub' && !fleetReady) {
        nextActions.push('Pair the printer through Fleet Hub before enterprise API control.');
    }
    if (recommendedMode === 'bambu_connect') {
        nextActions.push('Use Bambu Connect as the supported file transfer and print-start path.');
    }

    return {
        printer_id: printer.printer_id,
        local_printer_id: printer.local_printer_id || null,
        name: printer.name || printer.local_printer_id || printer.printer_id,
        model: printer.model || 'unknown',
        model_family: modelFamily,
        recommended_mode: recommendedMode,
        fallback_mode: fallbackMode,
        risk_level: riskLevel,
        capability_profile: profile.capabilities,
        next_actions: nextActions,
    };
}

function readinessGate(gate, label, ready, blocked, nextAction) {
    return {
        gate,
        label,
        status: ready ? 'ready' : (blocked ? 'blocked' : 'needs_configuration'),
        next_action: ready ? 'No action needed.' : nextAction,
    };
}

// A node claiming "online" only counts if it has actually heartbeated recently
// (default heartbeat interval is 30s; allow generous slack for slow links and
// serverless clock drift). Nodes without last_seen_at are treated as fresh so
// stores that never populated the column keep working.
const NODE_ONLINE_STALE_MS = 10 * 60 * 1000;

function isNodeFreshlyOnline(node, nowMs) {
    if (!isOnline(node.status)) return false;
    if (!node.last_seen_at) return true;
    const lastSeen = Date.parse(node.last_seen_at);
    if (!Number.isFinite(lastSeen)) return true;
    return nowMs - lastSeen <= NODE_ONLINE_STALE_MS;
}

// Loaded AMS filament synced from a printer heartbeat counts as traceable
// inventory: the material/color data is live from the device, so the gate
// must not stay blocked just because no manual spool rows were entered.
function printerHasLoadedFilament(printer) {
    const sources = [
        printer?.capabilities?.ams_trays,
        printer?.capabilities?.trays,
        printer?.status_snapshot?.ams,
    ];
    return sources.some((source) => hasTrayWithFilament(source));
}

function hasTrayWithFilament(source) {
    if (Array.isArray(source)) return source.some((item) => hasTrayWithFilament(item));
    if (!isPlainObject(source)) return false;
    if (source.material || source.tray_type || source.type || source.color || source.color_hex || source.tray_color) {
        return true;
    }
    return ['tray', 'trays', 'ams', 'ams_trays', 'filaments', 'slots']
        .some((key) => hasTrayWithFilament(source[key]));
}

function buildReadiness({ overview, automationPlan, now }) {
    const nodes = asArray(overview.nodes);
    const printers = asArray(overview.printers);
    const commands = asArray(overview.commands);
    const featureMap = automationPlan?.feature_map || {};
    const summary = automationPlan?.summary || {};
    const nowMs = now().getTime();

    return [
        readinessGate(
            'edge_agent_online',
            'Windows edge agent online',
            nodes.some((node) => isNodeFreshlyOnline(node, nowMs)),
            true,
            'Provision a node in Farm Nodes, download the Windows package, and double-click "Start Farm Node.bat" (no install needed).',
        ),
        readinessGate(
            'printer_inventory',
            'Printer inventory registered',
            printers.length > 0,
            true,
            'On the node computer open http://localhost:3000, add LAN printers (discovery finds them automatically), then wait for the next heartbeat to mirror them here.',
        ),
        readinessGate(
            'command_intents',
            'Durable command intents',
            commands.length > 0,
            false,
            'Queue one cloud command (e.g. Discover LAN Printers in Local Printer Sync) through the online node.',
        ),
        readinessGate(
            'smart_material_queue',
            'Smart material queue',
            featureMap.smart_queue === true,
            true,
            'Enable smart material queueing in Farm Autopilot.',
        ),
        readinessGate(
            'inventory_traceability',
            'Spool and AMS inventory',
            Number(summary.spools_total || 0) > 0 || printers.some(printerHasLoadedFilament),
            true,
            'Load filament into an AMS (it syncs automatically) or add spool inventory with material, color, and grams remaining.',
        ),
        readinessGate(
            'auto_ejection_policy',
            'Auto-ejection policy',
            featureMap.auto_ejection === true,
            false,
            'Enable auto-ejection policy and verify bed-clear behavior per printer.',
        ),
        readinessGate(
            'failure_detection',
            'Failure detection hooks',
            featureMap.failure_detection_hooks === true,
            false,
            'Configure a camera AI or operator-alert integration.',
        ),
        readinessGate(
            'operator_alerting',
            'Operator alerting',
            featureMap.alerting_hooks === true,
            false,
            'Configure Slack, email, SMS, or webhook alerting.',
        ),
    ];
}

function buildRoadmapPhases(readiness) {
    const statusByGate = Object.fromEntries(readiness.map((gate) => [gate.gate, gate.status]));
    const ready = (...gates) => gates.every((gate) => statusByGate[gate] === 'ready');
    const started = (...gates) => gates.some((gate) => statusByGate[gate] === 'ready');

    return [
        {
            phase: 'foundation',
            label: 'Foundation',
            status: ready('edge_agent_online', 'printer_inventory', 'command_intents') ? 'ready' : 'in_progress',
            scope: 'Tenancy, agent enrollment, printer records, durable command intents, logs, and health.',
        },
        {
            phase: 'edge_hardening',
            label: 'Edge hardening',
            status: started('edge_agent_online') ? 'in_progress' : 'blocked',
            scope: 'Windows Service lifecycle, discovery, leases, reconnects, local cache, and normalized events.',
        },
        {
            phase: 'bambu_core_integration',
            label: 'Bambu core integration',
            status: started('printer_inventory') ? 'in_progress' : 'blocked',
            scope: 'P1S, A1, P2S, and H2 adapter strategy with capability detection and fallback modes.',
        },
        {
            phase: 'slicing_queue_orchestration',
            label: 'Slicing and queue orchestration',
            status: ready('smart_material_queue', 'command_intents') ? 'in_progress' : 'blocked',
            scope: 'Versioned profiles, slice jobs, queue policies, reservations, retries, and operator console.',
        },
        {
            phase: 'inventory_maintenance',
            label: 'Inventory and maintenance',
            status: ready('inventory_traceability') ? 'in_progress' : 'blocked',
            scope: 'Spool reservations, AMS slots, maintenance rules, incidents, calibration evidence, and depletion workflows.',
        },
        {
            phase: 'enterprise_analytics',
            label: 'Enterprise and analytics',
            status: ready('operator_alerting', 'failure_detection') ? 'in_progress' : 'blocked',
            scope: 'SSO, webhooks, Fleet Hub support, reporting, exports, and policy controls.',
        },
    ];
}

export function buildPlatformStrategy({
    overview = {},
    automationPlan = {},
    now = () => new Date(),
} = {}) {
    const printers = asArray(overview.printers);
    const readiness = buildReadiness({ overview, automationPlan, now });

    return {
        integration_modes: INTEGRATION_MODES,
        model_profiles: Object.values(MODEL_PROFILES),
        printer_adapters: printers.map(chooseAdapter),
        readiness,
        roadmap_phases: buildRoadmapPhases(readiness),
        risks: RISK_REGISTER,
    };
}
