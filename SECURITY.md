# Security model and review checklist

Read this before shipping any app that holds something a household member should
not see. It is the same checklist the platform team uses when reviewing an app.

Work through it against your own code the way a reviewer would: for every table
in `migrations/`, every write in your JS, and every hub endpoint you call. When
you find a gap, the fix is almost always *moving a rule out of the client and
into `row_policies` or a hub-mediated endpoint* — not adding another check in JS.

---

## 1. The platform model — this is the whole lens

Your app is **static client-side HTML/JS**. There is **no app backend**. It talks
to a shared platform runtime that every app on the hub shares.

Apps run SQL by POSTing to `/run/<appId>/api/db`. Each household has its own
SQLite database, shared by all of that household's apps. The backend enforces —
**and only enforces** — these four things:

1. **Table scoping.** An app may only touch its own `app_<sanitized_id>__*` tables. One statement per call.
2. **Encryption at rest.** Text columns are encrypted on write and decrypted on read, except columns ending in `_id` / `_at` / `_date` / `_by` and a skip-list (`status`, `type`, `category`, `key`, `visibility`, `audience`, and similar). **Never filter or sort in SQL on a column that gets encrypted** — the comparison is against ciphertext and silently matches nothing.
3. **Quotas.** Database bytes, row counts, store, files.
4. **`row_policies`.** *Opt-in, per-table* row-level access, declared in `manifest.json` and rewritten into your SQL server-side.

That is the entire list. Anything else you want enforced, you must declare.

### The golden rule

> **Client-side JS is not a security boundary.** `window.__IS_ADMIN`,
> `window.__CURRENT_MEMBER`, `isAdult()`, and any `if (canManage)` check in your
> app can be trivially bypassed: any household member can open dev-tools and POST
> arbitrary SQL to `/api/db` against your app's own tables.
>
> **A table with no `row_policy` is fully readable AND writable by every member of
> the household**, no matter what the UI shows. Any access rule that matters —
> owner-only, adults-only, admin/board-only, approval gates, private visibility —
> must be enforced by a `row_policy` or a dedicated hub endpoint, never by the
> client alone.

The server independently resolves the caller's identity (member id, member role,
admin flag) and `row_policies` are evaluated against *that*. The injected
`window.__*` values are convenience hints for rendering, nothing more.

The full policy toolkit — every policy kind, its modifiers, and how to choose —
is in [CLAUDE.md](CLAUDE.md) → "Row-level access control".

---

## 2. Security & access-control checklist

### For every table in your migrations

- [ ] Does it hold anything not meant to be household-wide-public (private, adults-only, owner-only, group/committee-only, admin-only)?
- [ ] If yes, is there a matching `row_policy`? If not → **confidentiality bug.**
- [ ] Does the UI imply a restriction the backend doesn't enforce? Look for `audience`, `visibility`, `private`, role badges, hidden tabs. **A control that implies protection it can't deliver is a bug even if no data is secret.**
- [ ] **Partial-row confidentiality.** Is the row public but one *column* meant to be hidden (a secret answer, a valuation, an opt-in contact field)? A row-level policy alone still returns that column to everyone — it needs `column_read_acls` on that column, or a separate `endpoint_only` table. A column the UI hides but `SELECT *` returns is a bug.
- [ ] **Per-column encryption audit, especially times.** Encryption at rest is the default for text columns and is real defense in depth — keep it on for names, notes, messages, locations. A column should be plaintext only when (a) the hub or a hot query must *operate* on it — a `row_policy` key, a `WHERE`/`ORDER BY`, a `glance`/`agenda`/export filter — or (b) it is non-sensitive metadata. Decide **per column**, not per app.
  - Well-named `_date`, `_at` and `_time` columns are already plaintext, so clock and calendar values sort and filter correctly with no declaration. Columns that carry an operational value under some other name — `capacity`, `interval_hours`, `slot`, `days_mask` — still need `db_plaintext_columns`.
  - If the app stores nothing sensitive at all (a shared presence board, a public roster), app-wide `db_encryption: "off"` is a legitimate choice — `status-board` is the reference. It gates the **whole** app, not one column.
  - **This is a decide-it-up-front choice.** Values written while a column was encrypted stay encrypted at rest and never compare or sort correctly afterwards. Changing your mind later requires a backfill, not a manifest edit.

### For every write and state transition

- [ ] Is it gated only by a client check (`admin`, `isAdult`, `canManage`, `ME.id === …`)? → bypassable → **privilege-escalation bug.**
- [ ] **Approval / moderation gates** (pending→approved, confirm/deny, decide): enforced server-side? Can a member self-approve, or approve their own item?
- [ ] **Who can delete or edit someone else's row?** Owner-scoped via policy, or open?
- [ ] **Privilege revocation.** If a group member created a row, can they keep editing it after being removed from the group, because the policy also grants owner access?
- [ ] **Lifecycle invariants.** Can raw SQL edit a closed/locked/finalized parent, or insert into its children? Authorization alone does not enforce state — that is what `frozen_when` is for.
- [ ] **Turn rotation.** If the UI says only the current player may act, is the child action table `inherit_visibility` + `insert_only_by_parent_column_member` pointing at the parent's `current_turn_member_id`? A client-side turn check is a bug.
- [ ] **Sealed responses / reveal rounds.** If the UI says answers, guesses, or bids are hidden until a round closes, is the response table protected with `sealed_until` pointing at the parent's status column? `inherit_visibility` alone leaks responses the moment the parent is visible. Also check `max_per_member` (one response per member per round) and `frozen_when` (closed responses can't be edited).
- [ ] **Clock-based reveals.** If entries stay sealed until a *date* (a time capsule), is that enforced by `sealed_until` with `visible_after_parent_column` pointing at a **plaintext** ISO date column — not a client date check or a manual "Reveal" button? A reveal date the hub never compares means any member can read sealed rows early with raw SQL, and nothing ever opens if no one clicks Reveal. Confirm the client gate mirrors the hub, so the UI doesn't still say "Sealed" for rows the hub already returns.
- [ ] **One-per-member flows.** If the UI promises one RSVP/rating/guess per member per event, is it enforced server-side? Use `max_per_member` for attributed rows, or `anonymous_ballot` / `anonymous_responses` with a receipt table for secret ones. A client-side "disable after submitted" is a bug.
- [ ] **Capacity claims.** If the UI promises "only N seats can be claimed" **against discrete fixed slots**, use `slot_claims` — not direct inserts. Verify the claims table is `endpoint_only`, the capacity/status columns are plaintext, and the app handles `409` (`slot_full`, `slot_closed`, `already_claimed`) instead of pretending the claim succeeded. **If instead you book free-range intervals (arbitrary start/end with overlap) or enforce a per-scope cap (N per household per month), `slot_claims` does not apply** — a client-only conflict check followed by a plain `INSERT` is an integrity bug, and the fix is a bespoke `endpoint_only` reservation lane.
- [ ] **Server-derived audit data.** Are actor ids, timestamps, source app ids and reconciliation values derived by the hub rather than accepted from JS?
- [ ] **Privilege roots.** Board/committee/admin group pointers, role and settings rows — who can write them? **The bootstrap of the first admin is the classic hole.** Use `admin_config` or an `app_config` policy.
- [ ] **Broadcast side effects** (`alert_on`, publishing an event, `/api/notifications/send`): can an unprivileged member trigger a household-wide push by self-approving, or by calling the endpoint directly? Use `notification_acls` for configured-group sends and `publish_acls` for the event bus.
- [ ] **Notification audience leaks.** The default `audience` on `/api/notifications/send` is `"all"` — the whole household. Pushing a *preview* of restricted content (a board-only message, an adults-only item) is a confidentiality leak even though no table was read. For "notify a topic's followers," the follower list is `owner_only` and unreadable client-side — use `subscription_notify`, which resolves followers server-side and re-checks eligibility per recipient.
- [ ] **Value-bearing events.** Does your app *emit* an event another app turns into money, points or state (`reward.earned`)? Any member can POST it to your events endpoint — gate it with `publish_acls`. Does your app *consume* such an event and trust the payload? Restrict to a trusted `source_app_id`. Remember publishing also runs household automations, whose steps execute as trusted SQL that bypasses row policies.

### Other surfaces

- [ ] **`data_access.reads`** — does it request more family context than the app actually uses? Request the narrowest key.
- [ ] **XSS.** Is user or DB content put into the DOM via `innerHTML` without `esc()`?
  - **Row ids count as user content.** `id="row-${item.id}"` is a stored-XSS vector even when your app generates UUIDs, because any member can INSERT a row with an attacker-chosen id via raw `/api/db`. Every DB value interpolated into markup — including into `id` / `class` / `data-*` attributes — needs `esc()`.
  - **Type affinity does not protect you.** A column declared `INTEGER` or `REAL` can still hold attacker-controlled text: SQLite affinity is not type enforcement, and the encryption codec round-trips whatever is written. Escape numeric-typed values too — `${esc(r.guest_count)}`, not `${r.guest_count}`.
- [ ] **Inline-handler injection.** Is untrusted data interpolated into `onclick="fn('${value}')"` or another JavaScript context? HTML escaping is *not* sufficient after attribute entity decoding. Use `data-*` attributes plus `addEventListener`.
- [ ] **`cdn_whitelist` / external `connect-src`** — any unexpected external calls?
- [ ] **Store keys** (`/api/store`) — does a sensitive or authoritative key need a `store_acls` read and/or write rule?
- [ ] **Store projections of governed rows must re-filter to the key's audience.** An export query runs with the *caller's* visibility — when an adult triggers a sync, restricted rows (`audience='adults'`, owner-only, group-only) flow into the projection, and the store key is readable household-wide. **Correct row policies on the D1 table do not protect the projection.** Filter the export query to everyone-visible rows, or redact the restricted fields. This is a real shipped leak, not a hypothetical: check every `exports` key this way.
- [ ] If a key has `export_acls`, is that same key *also* directly writable through your own `/api/store`? Add `store_acls`, or move authoritative data into D1.
- [ ] **Raw file uploads.** If document management is restricted in the UI, is the backing file channel protected with the matching `file_acls` rule? And is every file-id column declared in the file-lifecycle keys, so deleting or replacing an attachment doesn't strand its bytes? See CLAUDE.md → "File lifecycle".
- [ ] **`agenda` (Today view).** The query runs per requester through *that member's* `row_policies`, so — unlike a store export — it does **not** need manual audience filtering; a restricted row simply won't come back. What to verify is query shape: a single own-table SELECT, `LIMIT` 1–20, `title` + `when_at` aliases, and the day token (`:today` / `:day_start` / `:day_end`) used as a **filter in `WHERE`** against a **plaintext** column — never merely selected, and never an encrypted column, which never matches.
- [ ] **`kiosk_quick_add`.** Writes run through the governed path under the ambient (or PIN-escalated) member's policies, so a row-policied target fails **closed** for an unattended device rather than accepting an anonymous write. Verify the target table is genuinely meant to be writable by a walk-up shared device — a household-wide list, not an owner-scoped or adults-only table. If it must stay restricted, `authorization: "member"` gates the card behind PIN escalation. Confirm the SQL-computed columns (`normalized_column`, `done_column`, `done_by_name_column`, `created_at_column`) are plaintext, and that the hub derives actor id and timestamps. On a **toggle** lane with a `normalized_column`, re-adding a completed item **revives** it rather than duplicating — so prune completed rows with a "clear done" action in the full app (the kiosk has no delete), and mirror the revive in any in-app add path so it doesn't throw on the UNIQUE constraint.
- [ ] **Tables paired with hub endpoint mechanisms** (`append_only_records`, `slot_claims`, `anonymous_responses`, `anonymous_ballot`, …): is the endpoint-written table protected with the matching row policy? A table written by a hub mechanism but left without one can still be INSERTed, UPDATEd and DELETEd directly via `/api/db`, bypassing the capacity, duplicate-check, identity or append-only logic that was the entire point.
  - `append_only_records` → target must be `endpoint_only`, or have `endpoint_writes_only: true` on its read policy. If appends are privileged, the record config needs a `write_acl`.
  - `slot_claims` → claims table `endpoint_only`; no raw app SQL touching claims.
  - `anonymous_responses` / `anonymous_ballot` → response/ballot table `endpoint_only`, receipt table `owner_only` + `endpoint_writes_only: true`.
- [ ] **`anonymous_responses` counting.** Every "has responded" or response-count query — list view, widget, AI export — must join the **receipt** table, not the responses table. `member_id` is NULL in `responses` for anonymous submissions, so `COUNT(DISTINCT member_id)` always returns 0. Check `widget.html` and `src/queries/*.sql` separately from `index.html`.
- [ ] **`canManage`-style helpers.** Does the helper grant manage access to the row creator regardless of role? If the table is `adult_writable`, a non-adult creator will see manage controls and get a silent 403 on every action — misleading UX, and a sign the client gate does not mirror the server. `canManage` should require `isAdult`, not `created_by === me.id`.
- [ ] **Declared integrations actually wired.** If the manifest declares `publishes` and `alert_on`, does the code actually call the events endpoint after the relevant action? A missing `publishEvent("survey.closed", …)` after a status UPDATE means the declared integration is dead even though `publish_acls` is perfect. Same for `subscribes_to`.

---

## 3. Performance checklist

- [ ] **Indexes** on the columns used in `WHERE` / `JOIN` / `ORDER BY` of your hot queries. Remember encrypted columns cannot be usefully indexed for filtering — another reason to decide plaintext columns up front.
- [ ] **Schema integrity:** foreign keys (or endpoint validation), unique constraints, enum/range `CHECK`s, orphan behaviour, delete semantics. Note that a `CHECK` or `UNIQUE` constraint on an **encrypted** column is dead on arrival.
- [ ] **Money:** integer minor units, exact allocation totals, deterministic rounding, overflow-safe arithmetic.
- [ ] **Multi-resource writes.** If one action touches D1 plus the store, another app, or events — is it idempotent and retryable? Is partial failure persisted as pending and visible, rather than swallowed?
- [ ] **Optimistic UI.** Does a mutation full-refetch and re-render the whole list via `innerHTML`, or update local state immediately and then persist? Prefer optimistic plus targeted render — `amenity-reservations` is the reference.
- [ ] **N+1 and waterfalls.** Independent loads should be `Promise.all`'d. Better: use `manifest.preload` so first render costs **zero** round-trips.
- [ ] **Over-fetching.** `SELECT *` plus a client filter where a `WHERE` / `LIMIT` would do; large `LIMIT`s pulled on first paint. An unbounded preload is a bug, not a convenience.
- [ ] **Re-fetching context.** `/api/context` is already served `private, max-age=30`, so re-reading it is cheap — don't build a cache around it, and don't avoid it by stuffing member data into your own tables.
- [ ] **Render before data.** Paint a skeleton on first frame, then hydrate.

**Scale note:** most of these are negligible at family size and real at the HOA /
"organization" scale several apps advertise — hundreds of members, thousands of
rows. Judge against the scale your description promises.

---

## 4. Rating your own findings

When you audit your app, give each finding a severity so you fix them in order:

- 🔴 **High** — a confidentiality breach or privilege escalation reachable by any household member.
- 🟠 **Medium** — an integrity or approval bypass, or a restriction the UI implies but nothing enforces.
- 🟡 **Low** — hardening, client-only gates on low-stakes data, performance at scale.

For each one, be able to state: **what**, **where** (`file:line`), **why it is
exploitable** in terms of the golden rule, and **the fix** — and say explicitly
when the fix means moving logic out of the client into a `row_policy` or a hub
endpoint. If you cannot articulate the exploit, you probably have not found the
real bug yet.
