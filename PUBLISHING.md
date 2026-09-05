# Publishing: why a bundle gets rejected, and how to fix it

There are **two gates** between your code and a running app:

1. **`node build.mjs`** (local, and in the release workflow) — bundles `src/` and `migrations/` and validates what it can see locally.
2. **Hub admission** — when the bundle is installed or updated, the hub re-validates the manifest against the real schema and the real database conventions. This gate is stricter, and it is where most surprises happen.

`preflight.sh` (wired up by `make setup`) runs the first gate before every push.
Nothing runs the second gate for you, so this page is the map.

---

## The single biggest rejection class: a manifest column must be plaintext

Most manifest keys name columns the **hub itself** reads — in raw SQL, outside
the encryption codec. Text columns are encrypted at rest by default, so a column
named by one of those keys must be plaintext or the hub can never read it.

You will see a message shaped like:

```
manifest.<key>.<field> "<column>" must be plaintext
(built-in or listed in db_plaintext_columns)
```

**A column is plaintext when** it ends in `_id`, `_at`, `_date` or `_by`, or its
name is on the skip-list (`status`, `type`, `category`, `key`, `visibility`,
`audience`, and similar), **or** you list it in `manifest.db_plaintext_columns`.

Two ways to fix it, in order of preference:

1. **Rename the column** so a built-in suffix applies — `renewal` → `renewal_date`, `owner` → `owner_id`. Best done before the app ships.
2. **Add it to `db_plaintext_columns`.** Necessary for names that can't take a suffix — `capacity`, `interval_hours`, `slot`, `days_mask`.

The three clock/calendar suffixes — `_at`, `_date` and `_time` — are all
plaintext, so `start_time` and `due_date` sort and filter correctly with no
declaration. What still needs one is an operational value under a name the
suffixes don't reach: `capacity`, `interval_hours`, `slot`, `days_mask`.

Keys that impose this on at least one field include `row_policies` (owner,
status, visibility, `retain_days.timestamp_column`, `file_id_column`,
`exempt_when.column`, `visible_after_parent_column`), `slot_claims`,
`secret_draw`, `inactivity_alerts`, `date_reminders`, `schedule_reminders`,
`subscription_notify`, `shareable`, `geofence_zones`, `kiosk_quick_add`,
`kiosk_checklist`, `delete_file_columns`, `update_file_columns`,
`delete_cascades[].file_id_column`, and every column a `write_effects`
statement computes.

**Decide this before you ship.** Values written while a column was encrypted stay
encrypted at rest. Flipping the column to plaintext later does not decrypt them —
old rows keep comparing and sorting wrong until you backfill.

---

## Local build rejections (`node build.mjs`)

### Migrations — `storage: "db"` apps

| Rejection | Rule |
|---|---|
| `storage:"db" apps must have a migrations/ directory` | ...containing at least one `.sql` file |
| `migration file must start with a number` | `001_init.sql`, `002_add_notes.sql` |
| `migration versions must be unique` | one file per version number |
| `CREATE TABLE must use IF NOT EXISTS` | migrations must be re-runnable |
| `DROP TABLE / DROP COLUMN / RENAME COLUMN / RENAME TABLE / TRUNCATE is not allowed` | destructive DDL is refused outright — migrate forward with a new column |

Also true, and not caught locally: **a migration runs outside the encryption
codec.** A string literal a migration writes lands in the database as *plaintext*
in a column the codec will later read as ciphertext. Only column-to-column
backfills are safe in a migration. The hub's admission lint catches the common
cases and tells you to add the column to `db_plaintext_columns` or use a
different `DEFAULT`. Migration SQL is also capped at 8000 characters per file.

### Inline scripts

| Rejection | Rule |
|---|---|
| `inline script does not parse` | every inline `<script>` is syntax-checked |
| `top-level "<name>" is declared more than once` | duplicate `const` / `function` at top level of one script block |
| inline handlers must resolve to globals | `onclick="foo()"` **dies silently** under `<script type="module">` unless you assign `window.foo = foo`. The build checks that every inline handler resolves |

### Glance and agenda queries

Checked locally *and* at admission: a single `SELECT`, no semicolon, read-only,
explicit named columns (no `SELECT *`), and a `LIMIT` in range (glance 1–10,
5 for a `list` template; agenda 1–20). Every column a `display` template names
must appear in the `SELECT` list — alias with `AS` where needed.

---

## Hub admission rejections

### SQL shape — `preload`, `glance`, `agenda`, `reports`

All four are validated as SQL, not as strings. Common rejections:

- must be a **single statement**, a **SELECT**, and **read-only**
- must not contain **SQL comments**, and must not end with a semicolon
- must **select explicit, named columns** — no `SELECT *`, no unaliased expressions
- may only read **your own** `app_<id>__` tables
- no set operations (`UNION`, …)
- max 2000 characters

Per-surface:

| Surface | Extra rules |
|---|---|
| `preload` | `{ sql, params? }` per named statement. `?` placeholders only — the preload must match the statement your app posts at runtime, byte for byte. **Do not embed `:me` / `:today` in the SQL** — pass them as params. `endpoint_only` and `steward_reads_only` tables are not preloadable. **Inline the integers in `LIMIT` / `OFFSET`** rather than binding them; binding is fine at runtime, but the admission check refuses it. A `WHERE` or `JOIN … ON` that compares an **encrypted column against a string** is refused — it can never match, so the preload would return no rows and your app would silently render an empty first paint |
| `agenda` | must reference a day token (`:today` / `:day_start` / `:day_end`) **and compare it in a `WHERE` or `JOIN … ON`** — merely selecting or sorting on it is not filtering. Must select a `title` and `when_at` alias. The compared column, and any `:me` comparison, must be **plaintext** — encrypted columns never match |
| `glance` | `LIMIT` 1–10 (max 5 for `list`). A `recurring_due` glance requires a matching `digest` |
| `reports` | must **not** declare a `LIMIT` — reports are complete by definition. `:range_start` and `:range_end` come as a pair or not at all. Ordering on an encrypted column is refused (the document would come out in ciphertext order). `change_history` requires `audit_writes: true` on at least one governed table |

### Table scoping

```
<table> is not accessible — apps may only access their own tables (prefixed app_<id>__)
Could not parse SQL — only standard single statements against your app's tables
```

One statement per `/api/db` call. **A top-level `JOIN` across two of your own
governed tables is legal** — the rewriter applies both policies. What fails
closed is a governed table inside a **subquery**: scope a query to a parent with
a JOIN, not a nested `SELECT`.

### Structural constraints

| Rejection | Rule |
|---|---|
| PRIMARY KEY over an encrypted column | refused — the key can never be compared. This also covers `ON CONFLICT`, which needs the same comparison |
| `CHECK` / `UNIQUE` on an encrypted column | refused — the constraint would compare ciphertext and is dead |
| `<mechanism> requires a UNIQUE or PRIMARY KEY constraint on …` | `ON CONFLICT`-based mechanisms (receipts, folds, rollups) need the matching constraint declared in a migration, because SQLite rejects the conflict target without one |
| `Encrypted INSERTs must name columns and use VALUES placeholders` | no `INSERT … SELECT` or bare `INSERT INTO t VALUES (…)` into an encrypted table |
| `SQL may not mix $N and ? placeholders` | pick one |
| `must be sent as a single statement — it declares <key>, which the batch form does not run` | some manifest keys (write effects, cascades) only fire on the single-statement path |
| `write_effects` on an existing table | declaring insert effects retroactively forbids `INSERT … SELECT`, multi-row `VALUES`, and `ON CONFLICT` on that table. Audit its existing write paths first |
| row-policy keys | keyed by **unprefixed** table name (`items`, not `app_myapp__items`). A prefixed key is silently dead — it matches no table and governs nothing |
| `src/queries/*.sql` | no semicolons, and each file must start with `SELECT` or `WITH` |

---

## Rejected by the release process, not the validator

- **A push to `main` is a release.** There is no staging step.
- **Never hand-edit `version` in `manifest.json`.** CI owns it, and so does `catalog.json` — never edit that either, and never infer a released version from it.
- **A new `data_access` key makes the app uninstallable** until the catalog release carries it. If a change adds one, expect a window where installs fail.
- **If a change needs a matching hub change, land the hub first** — except for the migration-literal lint class, where the apps must be released *before* the hub tightens the rule. When in doubt, ask which side gates the other.

---

## Not rejected, but silently broken

These pass every gate and then behave wrongly. They are the ones worth grepping
for before you ship:

- **Filtering or sorting on an encrypted column.** The comparison runs against ciphertext, so it matches nothing and sorts arbitrarily. No error is raised.
- **`NULLS LAST` is unsupported.** Use `ORDER BY (col IS NULL), col`.
- **`date('now')` is UTC, not the household's day.** Any date you store or compare must come from the household-local helper (`hubToday()`), never from the device clock. A floating `YYYY-MM-DDTHH:MM` stored in an app table is **household-local**, never UTC.
- **`db_encryption: "off"` gates the whole app**, not one column. Check it before concluding a column is encrypted.
- **A declared integration that nothing calls.** `publishes` / `alert_on` / `subscribes_to` in the manifest do not wire anything up — the app must actually call the endpoint.
- **A field named `event` in an operational log payload** overwrites the event *name*. Pick another key.
