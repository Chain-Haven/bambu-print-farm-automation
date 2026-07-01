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

The bootstrap cloud management surface is:

```text
GET  /cloud
GET  /api/cloud/setup
GET  /api/cloud/overview?org_id=<org_id>&limit=50
POST /api/cloud/organizations
POST /api/cloud/nodes
POST /api/cloud/node-package
POST /api/cloud/commands
GET  /api/cloud/farm-automation
PATCH /api/cloud/farm-automation
GET  /api/cloud/merchant-settings
PATCH /api/cloud/merchant-settings
GET  /api/cloud/merchants?status=<status>&limit=50
POST /api/cloud/merchants
POST /api/cloud/merchant-setup-token
GET  /api/cloud/merchant-api-keys?merchant_id=<merchant_id>
POST /api/cloud/merchant-api-keys
DELETE /api/cloud/merchant-api-keys
GET  /api/cloud/merchant-jobs?merchant_id=<merchant_id>&limit=50
GET  /api/cloud/merchant-usage?merchant_id=<merchant_id>&limit=50
GET  /api/cloud/admin/migrations
POST /api/cloud/admin/migrations
Authorization: Bearer <CLOUD_ADMIN_TOKEN>
Content-Type: application/json
```

`/cloud` calls the Vercel API routes above. The browser never receives the Supabase service key. `CLOUD_ADMIN_TOKEN` is a bootstrap secret for early operations; replace it with Supabase Auth and role-aware server checks before broader operator access.

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
CLOUD_ADMIN_TOKEN=<long random bootstrap admin token>
```

The admin migration runner also requires a direct Postgres connection in Vercel
production, because Supabase REST cannot execute DDL migration files. Prefer the
non-pooling URL for migrations:

```bash
POSTGRES_URL_NON_POOLING=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
```

Accepted fallbacks, in order, are `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, or all
of the split variables `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
and `POSTGRES_DATABASE` with optional `POSTGRES_PORT`. Keep these values
server-side only; never paste them into the browser or the Windows NUC `.env`.

The migration creates:

- organization and membership tables for human cloud users
- farm nodes with hashed registration tokens
- cloud printer mirrors
- print job, file, command, and event tables
- a private `print-artifacts` storage bucket
- RLS policies for human reads by organization membership
- service-role-only command claiming for Vercel agent APIs
- private Supabase Realtime org topics named `org:<org_id>:...`

## Admin Migration Runner

`GET /api/cloud/admin/migrations` is an admin-only dry-run/status endpoint.
`POST /api/cloud/admin/migrations` applies only committed, allowlisted files from
`supabase/migrations`; it never accepts arbitrary SQL. The current allowlist is:

- `20260701050000_merchant_api_v2_adapter_backbone.sql`
- `20260701153253_merchant_shipping_claims.sql`

Each pending migration is applied in a transaction and recorded in
`supabase_migrations.schema_migrations`; already-recorded versions are skipped.
Malformed JSON, non-object JSON, unknown migration filenames, and body fields such
as `sql`, `query`, or `statement` are rejected before a Postgres client is
created. Browser responses include only safe filenames/statuses and generic
failure messages, not SQL, stack traces, tokens, or connection strings.

To inspect without applying:

```bash
curl -sS https://<vercel-deployment>/api/cloud/admin/migrations \
  -H "Authorization: Bearer <admin token>"
```

To apply all pending allowlisted migrations from the deployed runtime:

```bash
curl -sS -X POST https://<vercel-deployment>/api/cloud/admin/migrations \
  -H "Authorization: Bearer <admin token>" \
  -H "Content-Type: application/json" \
  --data '{}'
```

## Cloud Management

Open `/cloud`, enter `CLOUD_ADMIN_TOKEN`, and optionally set an organization ID filter. The dashboard can:

- verify Vercel/Supabase setup readiness before operators touch workflows
- manage the farm autopilot policy for smart material queueing, auto-eject cooldown, bed-clear verification, and failure-detection hooks
- store filament spool inventory with material, color, remaining grams, dry status, storage location, assigned printer, AMS unit, and tray
- configure alert, ecommerce, vision, shipping, and remote-access integration hooks
- show an automation plan with 3DQue-style feature coverage: central dashboard, smart queue, auto ejection, AMS/filament mapping, failure hooks, ecommerce hooks, remote access hooks, alerting hooks, and material batching
- surface low-spool, printer-offline, dry-filament, and manual bed-clear alerts before the queue stalls
- toggle full-auto merchant signup while keeping approve-only as the default mode
- list merchants by status, approve/activate/reject/suspend merchants, and issue one-time setup tokens
- issue, list, and revoke merchant `pkx_live_...` API keys from the admin console
- inspect merchant print jobs and usage events for tracked API consumption
- show recent nodes, printers, jobs, commands, and events
- create a bootstrap organization and copy its `org_id`
- create a farm node row and return the raw `LOCAL_NODE_TOKEN` once
- download a Windows-node ZIP with the local runtime and prefilled `.env`
- enqueue local-node commands such as `printer.status`, `printer.pause`, `printer.resume`, `printer.stop`, `printer.gcode`, `job.start`, and `cloud.print.ready`
- inspect full row details for nodes, printers, jobs, commands, events, merchants, keys, and usage without exposing Supabase service-role credentials

Provisioned node rows store only:

```text
sha256("${NODE_TOKEN_PEPPER}:${LOCAL_NODE_TOKEN}")
```

in `farm_nodes.token_hash`. Copy the returned `CLOUD_API_URL` and `LOCAL_NODE_TOKEN` values into the Windows NUC `.env`, or click `Download Windows ZIP` after provisioning to get a prefilled package.

If you are provisioning manually from the Supabase SQL editor instead, create an organization and node row from a trusted server-side context. Do not paste `SUPABASE_SERVICE_ROLE_KEY` into the NUC or browser.

The local node should store:

```bash
CLOUD_API_URL=https://<vercel-deployment>
LOCAL_NODE_TOKEN=<opaque node token>
CLOUD_COMMAND_POLL_INTERVAL_MS=2000
CLOUD_HEARTBEAT_INTERVAL_MS=30000
CLOUD_REQUEST_TIMEOUT_MS=15000
CLOUD_RETRY_MAX_ATTEMPTS=4
CLOUD_RESULT_OUTBOX_PATH=./data/cloud-result-outbox.json
```

It should never store `SUPABASE_SERVICE_ROLE_KEY`.

The local node retries transient Vercel/Supabase failures with bounded backoff, avoids overlapping command polls, and persists final command results to `CLOUD_RESULT_OUTBOX_PATH` until the cloud accepts them. Heartbeats include a non-secret IPv4 interface inventory and pending result count for operational visibility.

## End-to-end Smoke Test

After the Supabase migration is applied and Vercel has `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NODE_TOKEN_PEPPER`, `CLOUD_ADMIN_TOKEN`, and the
direct Postgres env needed for any admin migration run, run:

```bash
CLOUD_API_URL=https://<vercel-deployment> \
CLOUD_ADMIN_TOKEN=<bootstrap admin token> \
npm run cloud:smoke
```

The smoke test creates a temporary organization and node through the cloud admin
API, sends a local-node heartbeat with the returned node token, queues a
`printer.status` command, runs one local agent poll, and confirms the command is
reported as succeeded with simulated local execution. It intentionally does not
print the one-time node token or touch printer hardware.

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
- `cloud.print.ready` with `payload.local_printer_id`, `payload.download_url`, and `payload.original_name`

`cloud.print.ready` is the merchant API fulfillment command. The local Windows node downloads the signed private artifact from Vercel/Supabase storage, wraps raw `.gcode` into `.gcode.3mf` when needed, uploads the file to the selected Bambu printer over LAN FTPS, starts the print over MQTT, and reports the command result back to Vercel.

For the operator-facing setup path, see `docs/windows-local-node.md` or `/windows-node-guide.html`.

For the farm-manager automation target list, including the 3DQue/AutoFarm3D feature review, see `docs/farm-automation-feature-review.md`.
For the broader Bambu/Vercel/Supabase/Windows edge roadmap, see `docs/print-farm-platform-roadmap.md`.
