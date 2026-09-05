# App Template

Minimal starting point for a Chickadee Bandit app. Copy this folder, rename the `id` in `manifest.json` (and the `app_{appId}__` table prefix to match), then build from here. Ships one governed `items` table, a demo-mode fallback, and the standard build/dev tooling.

Four documents, in the order you need them:

| File | What it is |
|---|---|
| **README.md** (this file) | Getting started, tooling, and a complete index of every manifest key |
| **[CLAUDE.md](CLAUDE.md)** | The full pattern reference — runtime globals, row policies, protocols, encryption, every key in depth |
| **[SECURITY.md](SECURITY.md)** | The threat model and the security checklist. Read before you ship anything that holds private data |
| **[PUBLISHING.md](PUBLISHING.md)** | Why a bundle gets rejected at publish time, and how to fix it |

---

## Quick start

```bash
make setup     # once, after cloning: enables the pre-push hook (build + tests)
npm install

npm run dev    # preview locally at http://localhost:3001
npm test       # run the manifest + logic tests
npm run build  # produce dist/bundle.json
```

Then install it: paste the `dist/bundle.json` URL into **Hub → Apps → Install from URL**.

---

## File structure

```
manifest.json        App metadata, data access, storage, governance — see the key index below
src/
  index.html         Your app's entry point (required)
  logic.js           Extracted pure logic, so it can be unit-tested (see CLAUDE.md)
  style.css          Optional additional files
migrations/
  001_init.sql       Schema for `storage: "db"` apps. Runs once, in order, per household
__tests__/           vitest specs — manifest validation and your extracted logic
scenarios.json       Optional behavioral scenarios the hub can exercise
build.mjs            Bundles src/ + migrations/ → dist/bundle.json, and validates the manifest
dev.mjs              Local preview server with a stubbed hub runtime
preflight.sh         Build + test gate; run by the pre-push hook
dist/
  bundle.json        Output — this is what you install
.github/workflows/
  release.yml        Auto-publishes a release on every push to main
```

### Tooling notes

- **`make setup` is not optional.** It points `core.hooksPath` at `.githooks`, which runs `preflight.sh` (build + tests) before every push. Without it a broken bundle can reach a release.
- **`make help`** lists every target.
- **Migrations run outside the encryption codec.** A literal string written by a migration lands in the database as plaintext. Only column-to-column backfills are safe there. See CLAUDE.md → "Migration SQL".
- **`hub-sdk.js` is vendored, not bundled.** The hub serves it at `/hub-sdk.js`; import from that path. `.hub-sdk.js` is gitignored — see CLAUDE.md → "Updating hub-sdk.js" for the refresh command.
- **Never edit `version` in `manifest.json` by hand.** The release workflow owns it.

---

## manifest.json

Point your editor at the published schema for autocomplete and inline validation of every key:

```jsonc
{
  "$schema": "https://chickadeebandit.com/manifest-schema.json",
  "id": "my-app",
  …
}
```

That URL serves the generated structural JSON Schema for every key below. It is
regenerated from the hub's own manifest definitions, so it is always current for
the hub you are installing into.

### Required keys

| Field | Description |
|---|---|
| `id` | Unique slug, e.g. `chore-tracker`. Lowercase; becomes your `app_{id}__` table prefix |
| `name` | Display name shown in the hub |
| `version` | Semver string — **owned by CI, do not hand-edit** |
| `description` | One-line description |
| `entrypoint` | Entry file, almost always `index.html` |
| `runtime` | `static` for HTML/JS apps (use this) |
| `data_access` | `{ reads: [], writes: [] }` — family data keys (see below). Declare `[]` explicitly if none |
| `permissions` | `{ default_audience, requires_approval }` — audience is `everyone` \| `adults` \| `children`; approval requires a hub admin to activate the app |

### Key index — all 78 keys

Everything below is optional. **"See"** points at the section of `CLAUDE.md` with
the full treatment; keys marked *stub* are covered by the stub-reference table at
the end of CLAUDE.md.

#### Identity and presentation

| Key | Purpose |
|---|---|
| `category` | e.g. `health`, `finance`, `games`, `tools` |
| `tags` | Array of strings for marketplace filtering |
| `icon` | Emoji (`"🛒"`) or a bundled filename (`"icon.svg"`) |
| `nav` | `{ label }` — adds the app to the hub nav. Effectively required; apps without it are invisible until an admin enables them |
| `companion_app` | `{ name, tagline, ios_url, android_url }` — native companion callout |
| `contexts` | Tenant kinds: `household` (default), `shared_space`, `shared_space.roster` — *stub* |
| `min_age` | Minimum member age the hub enforces — *stub* |
| `kiosk` | `"allow"` (default) or `"never"` — *stub* |

#### Storage and data

| Key | Purpose |
|---|---|
| `storage` | `"db"` (SQL) \| `"kv"` (key/value blob) \| `"none"` |
| `resource_limits` | Storage and rate caps. Declare it even when accepting defaults (see below) |
| `db_encryption` | App-owned D1 encryption mode; `"default"` unless you have a reason — *stub* |
| `db_plaintext_columns` | Columns exempted from encryption, so SQL can filter/sort/join on them. See "Column encryption" |
| `preload` | First-render queries the hub answers with **zero** app round-trips. See "Zero requests for the first-render reads" |
| `migrations` | *(not a manifest key — schema lives in `migrations/*.sql`)* |

#### Access control

| Key | Purpose |
|---|---|
| `row_policies` | Per-table row-level access, rewritten into your SQL server-side. **The** governance key. See "Row-level access control" |
| `retention` | Hub-managed expiry for a table with no row policy. See "Hub-managed expiry" |
| `member_references` | What happens to a row when the member it names leaves. See "Member references" |
| `store_acls` | Per-key authorization on `/api/store`. See "Endpoint ACL keys" |
| `notification_acls` | Who may send app notifications. See "Endpoint ACL keys" |
| `publish_acls` | Per-event-type publish authorization — gates the automation path. See "Endpoint ACL keys" |
| `export_acls` | Per-key authorization on cross-app writes. See "Endpoint ACL keys" |
| `file_acls` | Who may upload raw files, and who may read the bytes. See "File and document access control" |
| `document_acls` | Who may mutate hub document records. See "File and document access control" |

#### Files

| Key | Purpose |
|---|---|
| `delete_file_columns` | Scalar file-id columns reclaimed when the row is deleted. See "File lifecycle" |
| `delete_file_list_columns` | The same, for JSON-array file-id columns |
| `update_file_columns` | Scalar file-id columns reclaimed when an UPDATE unlinks them |
| `update_file_list_columns` | The same, for JSON-array columns |
| `file_purge` | Countersigned early destruction of a versioned record's bytes |
| `delete_cascades` | Children (and their files) deleted with a parent row. See "Cascading deletes" |

#### Dashboard and hub surfaces

| Key | Purpose |
|---|---|
| `glance` | Hub-rendered dashboard tile from one SQL query — no iframe (see below) |
| `widget` | `{ label, size }` — an iframe summary tile; needs a `widget.html`. Prefer `glance` |
| `agenda` | Contribution to the Today view. See "Today view" |
| `digest` | Contribution to the weekly digest email. See "Weekly digest contribution" |
| `reports` | Named governed views the hub renders as HTML/CSV/JSON |
| `kiosk_quick_add` | Shared-device quick-add lane. See "Kiosk quick-add" |
| `kiosk_checklist` | Shared-device checklist lane. See "Kiosk checklist" |

#### Events, automation and AI

| Key | Purpose |
|---|---|
| `publishes` / `alert_on` / `subscribes_to` | The event bus. `alert_on` is a subset of `publishes`. See "The event bus" |
| `automation_actions` | Actions household automations may invoke, executed as trusted scoped SQL |
| `suggested_automations` | Starter-rule hints in the automations settings UI |
| `write_effects` | Hub-appended same-transaction side-effect SQL. Constrains the trigger table's client SQL — read the constraints first |
| `capture_consumer` | Accept AI-parsed capture suggestions (`event` \| `task` \| `grocery_item`) |
| `ai_access` | MCP exposure: named queries, inserts, mutations. See "AI access (MCP)" |

#### Cross-app and sharing

| Key | Purpose |
|---|---|
| `exports` | KV keys other apps may read/write as `app.{this-id}.{key}` |
| `shareable` | External share links, including a governed `submit` lane |
| `external_contacts` | Double-opt-in confirmed external email addresses |
| `cdn_whitelist` | Trusted external origins added to the app's CSP |

#### Purchase gates

| Key | Purpose |
|---|---|
| `required_capabilities` | Household-wide paid capabilities consumed: `cron`, `email`, `sharing`, `ai_capture`, `geofence` |
| `requires_entitlement` | Per-app purchase key required to install or run |

#### Scheduled protocols (all consume `cron`)

| Key | Purpose |
|---|---|
| `inactivity_alerts` | Dead-man's switch: check-in endpoint + cron evaluator |
| `date_reminders` | "X is in N days" — recurring-annual or one-shot dates |
| `schedule_reminders` | Time-of-day nudges with a completion signal and escalation |

#### Endpoint-mediated mechanisms

Each of these moves a correctness or privacy guarantee into the hub, because the
client cannot be trusted to hold it. All are covered in CLAUDE.md.

| Key | Purpose |
|---|---|
| `slot_claims` | Atomic capacity claims — N seats, no oversubscription |
| `anonymous_responses` | Anonymous survey/poll responses with an unlinkable receipt |
| `anonymous_ballot` | Ranked or majority voting; receipt and ballot unlinkable — *stub* |
| `agreements` | Multi-party agreement/countersign state |
| `append_only_records` | An audit log app SQL cannot rewrite |
| `versioned_records` | Replacement keeps the prior version; delete is a soft retire — *stub* |
| `subscription_notify` | Notify a topic's followers without leaking previews |
| `admin_config` | A settings table only an admin may write |
| `secret_draw` | Server-side assignment draw with exclusions — *stub* |
| `cycle_projection` | Materialize a recurring rotation into dated rows — *stub* |
| `geofence_zones` | Zone definitions and arrival/departure events — *stub* |
| `managed_finance` | Hub-managed billing periods and payments — *stub* |
| `financial_ledger_imports` | Governed import of external transactions — *stub* |
| `partner_link` | Resolves a member to their current reciprocal partner — *stub* |
| `mutual_reveal` | Answers unlock only once both partners submit — *stub* |
| `mutual_signals` | Time-boxed reciprocal signals; one-sided reveals nothing — *stub* |
| `paired_messages` | Endpoint-mediated partner DMs — *stub* |
| `couple_item_state` | Per-member state on a shared item, revealed reciprocally — *stub* |

### resource_limits

Declare `resource_limits` even when accepting defaults, so limits are explicit:

```json
"resource_limits": {
  "max_store_bytes": 524288,         // kv apps: max KV storage (default 5 MB)
  "max_store_reads_per_day": 500,    // kv apps: read requests per day (default 1000)
  "max_store_writes_per_day": 200,   // kv apps: write requests per day (default 500)
  "max_db_bytes": 52428800,          // db apps: database size cap (default 200 MB)
  "max_db_rows": 100000,             // db apps: total row cap
  "max_file_bytes": 10485760,        // file-uploading apps: max size per file (default 10 MB)
  "max_files_bytes": 524288000,      // file-uploading apps: total file storage (default 500 MB)
  "max_docs_bytes": 104857600        // hub-document storage (default 100 MB)
}
```

Apps with `"storage": "none"` do not need `resource_limits`.

### Glance widgets

A **glance** is a lightweight dashboard tile the hub renders itself from one read-only SQL query — no iframe, no `widget.html`, no app code. Prefer it over `widget` for a simple "one number / short list / alert count" summary; reach for `widget` only when the tile needs real interactivity. `"storage": "db"` apps only.

```jsonc
"glance": {
  "source": {
    "kind": "sql",
    // A single SELECT over your OWN prefixed tables, with a small LIMIT.
    // Runs through the same path as /api/db — your row_policies and column
    // decryption apply, and the query is shown in the admin approval diff.
    "query": "SELECT COUNT(*) AS n FROM app_myapp__items WHERE checked = 0 LIMIT 1"
  },
  "display": { "template": "badge", "count": "n", "label": "to buy", "severity": "info" }
}
```

Three display templates — every column a template names must appear in the query's `SELECT` list (alias with `AS` as needed):

| Template | Reads | Fields |
|---|---|---|
| `stat` | row 0 | `value` (column), `label` (static text), optional `empty_hides` (hide the tile when the value is 0/empty) |
| `list` | up to 5 rows | `title` (column), optional `subtitle` (column), optional `when` (column holding an ISO date/time, shown as a relative "in 3d") |
| `badge` | row 0 | `count` (column), `label` (static text), optional `severity` (`info` \| `warn` \| `alert`) — a count of 0 hides the tile |

Query rules (enforced by `node build.mjs` manifest validation): exactly one `SELECT`; only your own `app_{appId}__` tables; a `LIMIT` between 1 and 10; explicit named columns (no `SELECT *`). Tapping the tile opens your app. A glance whose query fails is silently dropped, so it never breaks the dashboard. Reference apps: `grocery` (badge), `chores` (stat), `calendar` (list).

### Available data_access keys

These are the only values `data_access.reads` / `.writes` accept for family data:

```
family.members             family.preferences
family.app_members         family.documents
family.groups              family.locations
family.calendar            family.presence
family.tasks               family.geofence_trackers
family.weather             family.health.medications
                           family.health.conditions
```

`family.members` answers *"who lives here"*; `family.app_members` answers *"who can open this app"* — use the latter for participant pickers. `family.presence` is derived home/away with no coordinates.

Two additional namespaces are not family keys but appear in the same arrays:

- `app.{other-app-id}.{key}` — another app's KV export. The **other** app must list `{key}` in its `exports`, and gate writes with `export_acls`.
- `cross.{resource}` — a hub-mediated cross-app resource (e.g. `cross.calendar_events`).

The hub enforces `data_access` — requests for data not declared in your manifest are rejected. Request the narrowest key that answers your question.

---

## Reading family data from your app

The hub injects `window.__FAMILY_HUB_CONTEXT_URL` into your app's page. Use it as the base URL for hub API calls:

```js
const BASE = window.__FAMILY_HUB_CONTEXT_URL ?? "";

const res = await fetch(`${BASE}/api/family`);
const members = await res.json();
```

For a `storage: "db"` app, prefer `manifest.preload` over a first-render fetch — the hub inlines the answer and the app renders with **zero** round-trips. See CLAUDE.md.

---

## Publishing via GitHub releases (optional)

Push to `main` — the included GitHub Actions workflow automatically:
1. Runs `node build.mjs`
2. Creates a release tagged `v{version}` from `manifest.json`
3. Uploads `dist/bundle.json` as the release asset

Anyone can then install your app by pasting the release asset URL into their hub:
```
https://github.com/firebirdsystems/chickadeebandit-your-app/releases/latest/download/bundle.json
```

A push to `main` **is a release.** If a change needs a matching hub change, land the hub first.

---

## Creating apps without GitHub

If you're using Claude or another AI connected to your hub via MCP, you can skip the template entirely. Just describe the app you want — the AI will generate and deploy it directly using the `publish_app` MCP tool. No build step, no repo, no release needed.
