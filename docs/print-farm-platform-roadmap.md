# PrintKinetix Platform Roadmap

This roadmap turns the July 1, 2026 print-farm automation report into product and engineering slices for this repository. The system should stay split into three planes:

- **Vercel/Supabase cloud control plane:** merchants, users, policy, jobs, command intents, storage, usage, audit, analytics, and public APIs.
- **Windows edge agent:** printer discovery, local network communication, file transfer, command execution, health, retry outbox, media handling, and future slicing workers.
- **Printer adapter plane:** model-aware Bambu integration paths with official modes preferred and local/community modes isolated behind adapters.

The near-term product goal is not to replace Bambu Studio or Bambu Farm Manager. It is to make PrintKinetix a manufacturing workflow layer with merchant APIs, durable command intents, queue visibility, filament accountability, operator alerts, and repeatable recovery.

## Integration Strategy

Use a model-aware adapter strategy instead of one printer driver for everything:

| Mode | Support posture | Best use | Platform handling |
| --- | --- | --- | --- |
| Fleet Hub | Official enterprise path | Large farms, wired sites, MES/ERP/WMS integration | Preferred for H2/Fleet Hub capable enterprise sites |
| Bambu Connect | Official transfer/start path | Supported third-party file transfer and print initiation | Default fallback for most Bambu models |
| LAN Developer Mode | Advanced-user local path | Trusted LAN control where MQTT, FTP, or live camera access is required | Allowed through explicit printer capability flags |
| Community LAN | Community/research path | Diagnostics and fallback behavior | High-risk optional adapter, never the product contract |

The admin dashboard now exposes this model-aware adapter strategy through `plan.platform_strategy` from `GET /api/cloud/farm-automation`.

## Model Families

| Family | Initial strategy | Notes |
| --- | --- | --- |
| P1/X1 era | LAN Developer Mode when explicitly enabled, otherwise Bambu Connect | Useful for local automation, but firmware/API drift must be contained |
| A1/A1 Mini | Bambu Connect first, LAN Developer Mode only when enabled | Keep AMS Lite limits visible in routing and inventory |
| P2 series | LAN Developer Mode or Fleet Hub when present, Bambu Connect fallback | Treat as capability-rich but still probe live features |
| H2 series | Fleet Hub when present, Bambu Connect fallback | Strongest enterprise-adapter candidate |
| Unknown Bambu | Bambu Connect with capability probing | Avoid assuming direct-control support |

## Core Buildout

The attached report maps cleanly to these implementation bands:

| Band | Scope | Current status |
| --- | --- | --- |
| Foundation | Organizations, nodes, merchant API, command intents, print artifacts, usage, setup checks | Partially implemented |
| Edge hardening | Windows edge agent, retry outbox, command polling, local health, package download | Partially implemented |
| Bambu core integration | Model-aware adapters, capability detection, upload/start/pause/resume/cancel | Started through platform strategy and existing local executor |
| Slicing and queue orchestration | Versioned profiles, slice jobs, reservations, retries, operator console | Planned |
| Inventory and maintenance | Spool reservations, AMS slots, maintenance rules, incidents, calibration evidence | Started through Farm Autopilot inventory |
| Enterprise and analytics | SSO, webhooks, Fleet Hub support, reports, exports, policy controls | Planned |

## Reliability Requirements

The Windows edge agent is the operational backbone. Cloud endpoints should create durable command intents; the edge agent should claim, execute, and acknowledge them. Direct Vercel-to-printer control should remain out of bounds.

Minimum edge-agent requirements:

- Run as a Windows Service or service-like runtime.
- Maintain an outbound-only secure connection to Vercel APIs.
- Use idempotent command execution keyed by cloud command IDs.
- Persist result outbox entries until the cloud accepts them.
- Report health, network interfaces, version, and pending local work in heartbeats.
- Keep local printer sessions, retries, and file-transfer loops off Vercel Functions.

## Next Slices

1. Convert `auto_eject` planner items into durable `node_commands` with command preconditions and local confirmation events.
2. Add printer discovery sessions for IP/access-code and PIN-based setup.
3. Add spool reservation/decrement flows tied to merchant job estimated grams and completion events.
4. Add adapter metadata to printer capabilities for Fleet Hub, Bambu Connect, LAN Developer Mode, and community LAN behavior.
5. Add camera snapshot ingestion and failure-detection callbacks.
6. Add webhook subscriptions and replayable webhook deliveries.
7. Add hardware-in-the-loop test fixtures by model family and firmware version.

## Risk Register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Bambu authorization or firmware changes | High | Prefer official paths first; isolate LAN Developer Mode and community adapters |
| Multi-tenant data exposure | High | Keep service-role use server-only; use RLS for future public/user tables; keep merchant keys hashed |
| Windows edge agent offline | Medium | Durable command intents, leases, retry outbox, and health scoring |
| Slicer/version drift | Medium | Version-pin slicer workers and run a regression corpus before dispatch |
| Telemetry/media growth | Medium | Store current-state projections, sample telemetry, and retain media selectively |
