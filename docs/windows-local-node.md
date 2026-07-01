# Windows Local Node Setup

Use one Windows computer or NUC on the same local network as the Bambu printers. Vercel stays the cloud control plane, while the Windows node performs LAN-only printer operations.

## Secure Connection Model

- The Windows node needs HTTPS outbound access to the Vercel deployment.
- Do not expose the Windows node or printer ports to the public internet.
- The Windows node stores `LOCAL_NODE_TOKEN` only.
- Never put `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_ADMIN_TOKEN`, `NODE_TOKEN_PEPPER`, or `MERCHANT_API_KEY_PEPPER` on the Windows node.
- Printer traffic stays on the LAN through Bambu MQTT and FTPS.

## Provision The Node

1. Open `/cloud` on the Vercel deployment.
2. Enter `CLOUD_ADMIN_TOKEN`.
3. Use **Windows Quickstart** to create or reuse the organization, provision the node, and download the prefilled ZIP.
4. Copy the one-time `LOCAL_NODE_TOKEN` only if you need to inspect or repair `.env`.
5. Use **Local Printer Sync** after the Windows node is running to queue `Discover LAN Printers` and `Sync Printer Inventory`.

The cloud management endpoints are:

```text
POST /api/cloud/nodes
POST /api/cloud/node-package
POST /api/cloud/commands
GET  /api/cloud/setup
GET  /api/cloud/overview
```

## Install On Windows

1. Install Node.js 24 LTS or newer.
2. Extract the ZIP to `C:\PrintKinetix`.
3. Confirm `.env` contains:

```bash
CLOUD_API_URL=https://bambu-print-farm-automation.vercel.app
LOCAL_NODE_TOKEN=<opaque node token>
CLOUD_COMMAND_POLL_INTERVAL_MS=2000
CLOUD_COMMAND_MAX_POLL_INTERVAL_MS=30000
CLOUD_HEARTBEAT_INTERVAL_MS=30000
CLOUD_REQUEST_TIMEOUT_MS=15000
CLOUD_RETRY_MAX_ATTEMPTS=4
CLOUD_RETRY_BASE_DELAY_MS=500
CLOUD_RETRY_MAX_DELAY_MS=10000
CLOUD_RESULT_OUTBOX_PATH=./data/cloud-result-outbox.json
CLOUD_RESULT_OUTBOX_FLUSH_LIMIT=25
CLOUD_RESULT_OUTBOX_MAX_ENTRIES=1000
```

4. Double-click `Start Cloud Node.bat`.
5. Open `http://localhost:3000` on the Windows computer.
6. Add each Bambu printer with the printer LAN IP or hostname, serial number, and access code.
7. Make sure Bambu LAN/Developer mode is enabled on each printer.
8. Return to `/cloud` and confirm the node heartbeat is online.
9. Queue **Discover LAN Printers** to confirm the Windows computer can see Bambu SSDP broadcasts.
10. Queue **Sync Printer Inventory** to send local printer, AMS, and filament snapshots back through the cloud command result.

## Optional Startup Task

Create a Windows Task Scheduler task that runs at login:

```text
Program: C:\PrintKinetix\Start Cloud Node.bat
Start in: C:\PrintKinetix
```

Use a dedicated Windows account for the node if possible. Keep Windows patched and allow outbound HTTPS in the local firewall.

## Agent API

The node authenticates with:

```text
Authorization: Bearer <LOCAL_NODE_TOKEN>
```

It calls:

```text
POST /api/agent/heartbeat
GET  /api/agent/commands?limit=10
POST /api/agent/command-result
POST /api/agent/events
```

The agent uses bounded retries and request timeouts for these outbound calls. If Vercel, Supabase, DNS, or the internet connection is temporarily unavailable after a command runs locally, final command results are written to `./data/cloud-result-outbox.json` and replayed before the next command claim.

## Printer Discovery And Sync

Admin operators can queue these from `/cloud` after selecting a Windows node:

```json
{
  "command_type": "cloud.printers.discover",
  "payload": {
    "scan_cidrs": ["192.168.1.0/24"],
    "wait_ms": 1500
  }
}
```

```json
{
  "command_type": "cloud.printers.sync",
  "payload": {
    "scan_cidrs": ["192.168.1.0/24"],
    "include_saved_printers": true,
    "sync_ams": true,
    "sync_filament": true
  }
}
```

`cloud.printers.discover` reports Bambu SSDP discoveries visible from the Windows machine. `cloud.printers.sync` reports registered local printers, live connection state, AMS tray counts, and saved filament snapshots where available.

## Merchant Print Flow

1. A merchant submits a ready `.gcode`, `.3mf`, or `.gcode.3mf` file to `POST /api/public/print-jobs`.
2. Vercel stores the artifact in the private `print-artifacts` bucket.
3. Vercel routes for fastest fulfillment based on node, printer, material, color, capacity, and readiness.
4. Vercel queues `cloud.print.ready` for the selected local node.
5. The Windows node claims the command, downloads the signed artifact URL, wraps raw `.gcode` into `.gcode.3mf` when needed, uploads to the printer over LAN FTPS, and starts the print over MQTT.
6. The node reports command state and operational events back to Vercel.

Source-model uploads such as `.stl`, `.obj`, `.step`, and `.stp` are accepted and usage-tracked, but remain `needs_slicing` until slicer automation is attached.

## Command Shape

```json
{
  "command_type": "cloud.print.ready",
  "payload": {
    "local_printer_id": "printer-1",
    "download_url": "https://...",
    "original_name": "part.gcode.3mf",
    "content_type": "application/octet-stream",
    "plate_number": 1,
    "use_ams": true,
    "ams_mapping": []
  }
}
```

## Verification

- `/api/cloud/setup` returns `ready: true`.
- `/cloud` shows the node as online after `Start Cloud Node.bat` runs.
- `/api/agent/heartbeat` receives regular heartbeats.
- `/api/agent/commands` claims queued work.
- `/api/agent/command-result` records `running`, then `succeeded` or `failed`.

If the node is offline, check `.env`, outbound HTTPS to Vercel, Node.js version, and local antivirus/firewall rules.

If printers are split across multiple Windows network adapters, VLANs, or subnets, keep the Windows computer routed to each printer network. The node heartbeat reports its non-loopback IPv4 interfaces so the cloud operator can confirm which networks the node can see.
