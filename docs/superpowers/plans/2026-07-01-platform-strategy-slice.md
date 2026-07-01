# Platform Strategy Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the attached print-farm platform report into a live, model-aware Bambu integration strategy and readiness roadmap inside the existing PrintKinetix cloud admin.

**Architecture:** Add a focused planner module that maps Bambu model families to recommended adapter modes, fallback modes, readiness gates, risks, and roadmap phases. Feed that planner into the existing `/api/cloud/farm-automation` response so the admin dashboard can show platform readiness without adding a Supabase migration.

**Tech Stack:** Node.js ESM, Vitest, Vercel Functions, Supabase REST via existing `platform_settings`, static admin HTML/CSS/JS.

---

### Task 1: Platform Strategy Planner

**Files:**
- Create: `src/cloud/platformStrategy.js`
- Test: `tests/cloud/platformStrategy.test.js`
- Modify: `src/cloud/farmAutomation.js`
- Test: `tests/cloud/farmAutomation.test.js`

- [ ] **Step 1: Write failing tests**

```js
import { describe, expect, it } from 'vitest';
import { buildPlatformStrategy } from '../../src/cloud/platformStrategy.js';

describe('platform strategy planner', () => {
  it('recommends model-aware Bambu adapter modes and readiness gates', () => {
    const strategy = buildPlatformStrategy({
      overview: {
        nodes: [{ node_id: 'node-1', status: 'online' }],
        printers: [
          { printer_id: 'p1', model: 'P1S', status: 'online', capabilities: { lan_mode: true, developer_mode: true } },
          { printer_id: 'h2', model: 'H2D Pro', status: 'online', capabilities: { fleet_hub: true, ethernet: true } },
        ],
        commands: [{ command_id: 'cmd-1', status: 'queued' }],
      },
      automationPlan: { summary: { spools_total: 2 }, feature_map: { smart_queue: true, auto_ejection: true } },
    });

    expect(strategy.printer_adapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ printer_id: 'p1', recommended_mode: 'lan_developer_mode', fallback_mode: 'bambu_connect' }),
      expect.objectContaining({ printer_id: 'h2', recommended_mode: 'fleet_hub', fallback_mode: 'bambu_connect' }),
    ]));
    expect(strategy.readiness).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: 'edge_agent_online', status: 'ready' }),
      expect.objectContaining({ gate: 'command_intents', status: 'ready' }),
    ]));
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- tests/cloud/platformStrategy.test.js`

Expected: FAIL because `src/cloud/platformStrategy.js` does not exist.

- [ ] **Step 3: Implement planner**

Create constants for integration modes, model family profiles, roadmap phases, and risk items. Export `buildPlatformStrategy({ overview, automationPlan })`, returning `integration_modes`, `model_profiles`, `printer_adapters`, `readiness`, `roadmap_phases`, and `risks`.

- [ ] **Step 4: Attach planner to farm automation output**

Import `buildPlatformStrategy` in `src/cloud/farmAutomation.js` and add `platform_strategy` to the return object from `buildFarmAutomationPlan()`.

- [ ] **Step 5: Run planner tests**

Run: `npm test -- tests/cloud/platformStrategy.test.js tests/cloud/farmAutomation.test.js`

Expected: PASS.

### Task 2: Admin Dashboard Readiness Tables

**Files:**
- Modify: `public/cloud.html`
- Modify: `public/js/cloud-dashboard.js`
- Modify: `public/css/cloud.css`
- Test: `tests/cloud/dashboardAssets.test.js`

- [ ] **Step 1: Write failing asset assertions**

Assert the dashboard contains `platform-strategy-table`, `readiness-gates-table`, `roadmap-phases-table`, and JS functions `renderPlatformStrategy` and `flattenPlatformStrategyRows`.

- [ ] **Step 2: Run asset test to verify RED**

Run: `npm test -- tests/cloud/dashboardAssets.test.js`

Expected: FAIL on the missing IDs/functions.

- [ ] **Step 3: Add dashboard markup**

Add a table-grid section under Farm Autopilot for adapter strategy, readiness gates, and roadmap phases.

- [ ] **Step 4: Add rendering functions**

Render `plan.platform_strategy.printer_adapters`, `readiness`, and `roadmap_phases` with existing `renderTable()` helpers.

- [ ] **Step 5: Run asset test**

Run: `npm test -- tests/cloud/dashboardAssets.test.js`

Expected: PASS.

### Task 3: Roadmap Documentation

**Files:**
- Create: `docs/print-farm-platform-roadmap.md`
- Modify: `docs/cloud-control-plane.md`
- Modify: `docs/farm-automation-feature-review.md`
- Test: `tests/cloud/merchantDocs.test.js`

- [ ] **Step 1: Write failing docs assertions**

Assert the roadmap doc mentions `Fleet Hub`, `Bambu Connect`, `LAN Developer Mode`, `Windows edge agent`, and `durable command intents`.

- [ ] **Step 2: Run docs test to verify RED**

Run: `npm test -- tests/cloud/merchantDocs.test.js`

Expected: FAIL because the roadmap doc does not exist.

- [ ] **Step 3: Add roadmap doc and cross-links**

Summarize the attached report into the repo with implementation mapping and next slices.

- [ ] **Step 4: Run docs test**

Run: `npm test -- tests/cloud/merchantDocs.test.js`

Expected: PASS.

### Task 4: Verification and Deployment

**Files:**
- No new files beyond Tasks 1-3.

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run syntax and OpenAPI checks**

Run: `for f in $(rg --files src api public/js tests scripts | rg '\.(js|mjs)$'); do node --check "$f" || exit 1; done`

Run: `git diff --check`

Expected: both commands exit 0.

- [ ] **Step 3: Commit and push**

Commit message: `feat: add platform strategy readiness planner`

- [ ] **Step 4: Deploy and smoke**

Deploy with `vercel deploy --prod --yes --scope chain-havens-projects` and smoke `/cloud`, `/api/cloud/farm-automation`, and the rendered JS bundle.
