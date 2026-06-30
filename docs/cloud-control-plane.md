# Cloud Control Plane

This project is being split into two runtime surfaces:

1. **Vercel cloud control plane**: hosts browser/admin views and server-side API routes. Vercel talks to Supabase with `SUPABASE_SERVICE_ROLE_KEY`; that key must never be shipped to a Windows NUC or browser bundle.
2. **Local Windows/NUC node**: runs the printer-control software on the same LAN as the Bambu printers. It reaches out to Vercel with an opaque `LOCAL_NODE_TOKEN`, sends heartbeats/status, claims queued commands, and executes LAN-only printer work locally.

The first implemented cloud endpoints are:

```text
POST /api/agent/heartbeat
GET  /api/agent/commands?limit=10
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

Command claim responses return the node's queued `node_commands` rows after atomically moving them from `queued` to `claimed` through the `claim_node_commands` Supabase RPC. Event posts accept up to 100 well-formed event rows per request and write them into `node_events` for cloud visibility.

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
```

It should never store `SUPABASE_SERVICE_ROLE_KEY`.
