# Cloud Control Plane

This project is being split into two runtime surfaces:

1. **Vercel cloud control plane**: hosts browser/admin views and server-side API routes. Vercel talks to Supabase with `SUPABASE_SERVICE_ROLE_KEY`; that key must never be shipped to a Windows NUC or browser bundle.
2. **Local Windows/NUC node**: runs the printer-control software on the same LAN as the Bambu printers. It reaches out to Vercel with an opaque `LOCAL_NODE_TOKEN`, sends heartbeats/status, claims queued commands, and executes LAN-only printer work locally.

The first implemented cloud endpoints are:

```text
POST /api/agent/heartbeat
GET  /api/agent/commands?limit=10
POST /api/agent/command-result
POST /api/agent/events
Authorization: Bearer <LOCAL_NODE_TOKEN>
Content-Type: application/json
```

Request body:

```json
{
  "status": "online",
  "agent_version": "0.1.0",
  "host_info": { "hostname": "print-nuc-01", "os": "Windows 11" },
  "capabilities": { "max_concurrent_jobs": 4, "camera_proxy": true }
}
```

Vercel hashes the bearer token with `NODE_TOKEN_PEPPER`, looks up `farm_nodes.token_hash`, and updates the node heartbeat fields in Supabase. A registered node row must exist before the downloaded agent can connect.

Command claim responses return the node's queued `node_commands` rows after atomically moving them from `queued` to `claimed` through the `claim_node_commands` Supabase RPC. Command result posts move claimed commands through `running`, `succeeded`, or `failed` while filtering by the authenticated node. Event posts accept up to 100 well-formed event rows per request and write them into `node_events` for cloud visibility.

The local Node client lives in `src/cloud/localNodeClient.js` and wraps these outbound calls:

```js
const client = createLocalNodeClient({
  cloudApiUrl: process.env.CLOUD_API_URL,
  token: process.env.LOCAL_NODE_TOKEN,
});

await client.sendHeartbeat({ status: 'online', agent_version: '0.1.0' });
const { commands } = await client.claimCommands({ limit: 10 });
await client.sendEvents([{ event_type: 'printer.status', payload: { state: 'idle' } }]);
```

## Supabase Setup

Create or choose the Supabase project, then apply:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Required Vercel environment variables:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only service/secret key>
NODE_TOKEN_PEPPER=<long random server-side pepper>
```

The migration creates:

- organization and membership tables for human cloud users
- farm nodes with hashed registration tokens
- cloud printer mirrors
- print job, file, command, and event tables
- a private `print-artifacts` storage bucket
- RLS policies for human reads by organization membership
- service-role-only command claiming for Vercel agent APIs
- private Supabase Realtime org topics named `org:<org_id>:...`

## Local Node Registration

Until the provisioning UI exists, create an organization, membership, and node row from a trusted server-side script or Supabase SQL editor. Store only:

```text
sha256("${NODE_TOKEN_PEPPER}:${LOCAL_NODE_TOKEN}")
```

in `farm_nodes.token_hash`.

The local node should store:

```bash
CLOUD_API_URL=https://<vercel-deployment>
LOCAL_NODE_TOKEN=<opaque node token>
CLOUD_COMMAND_POLL_INTERVAL_MS=2000
CLOUD_HEARTBEAT_INTERVAL_MS=30000
```

It should never store `SUPABASE_SERVICE_ROLE_KEY`.

## Running the Windows NUC Node

On the NUC:

1. Install Node.js 24 LTS or newer.
2. Copy `.env.example` to `.env`.
3. Set `CLOUD_API_URL` to the Vercel deployment and `LOCAL_NODE_TOKEN` to the token provisioned for that node.
4. Double-click `Start Cloud Node.bat`, or run:

```bash
npm install
npm run local-node
```

`npm run local-node` starts the existing local printer controller (`server.js`) and also starts the outbound cloud agent. The cloud agent sends heartbeats, claims queued commands, executes supported local actions, and reports command lifecycle status back to Vercel.

Supported cloud command types in this slice:

- `printer.status` with `payload.local_printer_id`
- `printer.pause` with `payload.local_printer_id`
- `printer.resume` with `payload.local_printer_id`
- `printer.stop` with `payload.local_printer_id`
- `printer.gcode` with `payload.local_printer_id` and `payload.gcode`
- `job.start` with `payload.local_job_id`
