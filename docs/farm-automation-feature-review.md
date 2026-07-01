# Farm Automation Feature Review

This review captures the competitor feature set we want PrintKinetix to cover while keeping the implementation native to the Vercel/Supabase cloud control plane and the Windows local-node agent.

For the broader platform architecture, model-aware Bambu adapter strategy, and Windows edge-agent roadmap, see `docs/print-farm-platform-roadmap.md`.

## 3DQue Feature Targets

3DQue's AutoFarm3D page positions the product around a centralized queue, smart dispatch, farm-wide stats, and self-managing print-farm workflow:

- Source: https://www.3dque.com/autofarm3d

Their feature navigation and pages also call out the farm-manager capabilities operators expect from a serious print-farm system:

- Central Control: https://www.3dque.com/features/central-control
- Smart Queue: https://www.3dque.com/features/smart-queue
- Auto Ejection: https://www.3dque.com/features/auto-ejection
- AMS Mapping: https://www.3dque.com/features/ams-mapping
- Filament Library: https://www.3dque.com/features/filament-library
- Secure Remote Access: https://www.3dque.com/features/remote-access
- QuinlyVision failure detection: https://www.3dque.com/features/quinlyvision

## PrintKinetix Implementation Map

Implemented in this slice:

- Central farm dashboard in `/cloud` with nodes, printers, jobs, commands, events, merchants, usage, and automation health.
- Smart material queue planning through `GET /api/cloud/farm-automation`.
- Merchant job routing that considers job dimensions, material, color, printer capacity, live printer status, and operator-entered spool assignments.
- Filament/AMS inventory metadata for material, color, grams remaining, dry status, storage location, printer, AMS unit, and tray.
- Auto-eject policy controls for bed-clear verification, cooldown release temperature, max eject attempts, and manual-clear fallbacks.
- Failure-detection integration metadata for camera AI/webhook providers.
- Alert integration metadata for Slack, email, SMS, or webhook destinations.
- Ecommerce and shipping integration metadata so merchant/order systems can be connected without schema churn.
- Remote-access integration metadata for secure operator tunnels.
- Admin-visible feature map, ejection queue, material routing recommendations, low-spool alerts, dry-filament alerts, offline-printer alerts, and manual-bed-clear alerts.
- Model-aware platform strategy output for Fleet Hub, Bambu Connect, LAN Developer Mode, and community LAN adapter risk planning.

Next implementation candidates:

- Convert `auto_eject` planner items into durable `node_commands` with a local confirmation loop.
- Add camera snapshot ingestion and failure-detection event callbacks.
- Add spool reservation and decrementing based on merchant job estimated grams and completed print results.
- Add per-printer material change workflows when the fastest route needs a non-loaded spool.
- Add operator-safe remote-access launch links once a specific tunnel provider is selected.
- Add ecommerce order import/export connectors for Shopify, Etsy, WooCommerce, and ShipStation.
- Add farm utilization, printer MTBF, retry rate, failure reason, and filament burn-down analytics.
