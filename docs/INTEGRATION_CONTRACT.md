# Masjid Sentral — App Integration Contract (v1.1)

> **For coding agents.** This file is self-contained. You need no other context
> to build an integration. Read §0 first, build in the order of §9, and pass
> every check in §10. Where this file and older docs disagree, **this file wins**
> until `GET /openapi.json` publishes v1.1.

| | |
|---|---|
| Status | **v1.1, live 2026-11-17** at `https://api.masjidsentral.com`. Endpoints marked **NEW** are new in v1.1 and are deployed. Keys are handed out privately by the maintainers. |
| Maintainers | Jejak Masjid (JM) × Qiyam |
| Base URL | `https://api.masjidsentral.com` (prod). A staging URL is handed out with your key. |
| Audience | Any app that reads or writes Masjid Sentral data (first: JM, Qiyam) |

---

## 0. Agent brief

**Goal.** Masjid Sentral is the **master copy** of masjids, their details and
their programmes. When a user of app A edits a masjid detail or adds a
programme, users of app B must see it, and the reverse.

**What you build in your app:**

1. A **link** from every local masjid to its Sentral masjid (`sentral_id`).
2. An **outbound path**: every local edit to a masjid detail or programme is
   sent to Sentral (through a retrying outbox).
3. An **inbound path**: a webhook receiver plus a pull of `GET /changes`, so
   Sentral changes are applied to your local copy.

**What you do NOT build:** a Sentral server, a Sentral website, user accounts
in Sentral. Your app keeps its own users, check-ins, points and other
app-specific data. Sentral never sees them.

**Hard rules (MUST / MUST NOT):**

- **R1** MUST send `Authorization: Bearer <api_key>` on every request, reads included. The key is a server secret: MUST NOT ship it inside a mobile app or browser bundle. Call Sentral from your backend only.
- **R2** MUST apply an inbound change only when `change.version > local.sentral_version` for that entity (§6.3). This one rule handles echoes of your own writes, duplicates and out-of-order delivery.
- **R3** MUST send `If-Match: <version>` on every `PATCH`/`DELETE` and handle `409` (§5.4).
- **R4** MUST send an `Idempotency-Key` on every `POST`/`PATCH`/`DELETE`. Use your outbox row id. Retries reuse the same key.
- **R5** MUST verify the webhook signature before trusting the body (§7).
- **R6** MUST treat `GET /changes` as the source of truth. Webhooks are only a "wake up and pull" ping. Run a scheduled pull at least every 15 minutes even if no webhook arrives.
- **R7** MUST moderate your own users' input **before** sending it. Sentral trusts app keys and publishes writes to every other app straight away.
- **R8** MUST NOT send personal data: no user names, emails, phone numbers or device ids. `X-Sentral-Actor` is an opaque, app-local id (§3).
- **R9** MUST NOT round or coarsen coordinates. Send full-precision WGS84 `lat`/`lng`. Prayer-zone lookups downstream fail on rounded points.
- **R10** MUST ignore unknown JSON fields and unknown `change.entity` values. Do not fail on them. New fields are added without a version bump.
- **R11** MUST handle `op: "merge"` (§6.4). Duplicates are merged into one masjid and your links must follow.

---

## 1. Conventions

- JSON, UTF-8. Field names are `snake_case`.
- Timestamps: output is always ISO 8601 UTC with `Z` at second precision (`2026-11-14T10:30:00Z`). Input may be UTC `Z` or an RFC 3339 offset (`2026-11-14T18:30:00+08:00`); it is normalised to `Z`. Programmes also carry an IANA `timezone` (default `Asia/Kuala_Lumpur`) used to expand `rrule`.
- IDs: Sentral ids are integers. Reference ids are slugs: countries `my`/`sg`/`bn`/`id`, states `my-jhr`, `my-kul`… (get them from `GET /states`), types `masjid`/`surau`/`mini-surau` (map your own types onto these, e.g. `musolla` → `surau`, `mini surau` → `mini-surau`; anything else waits for §11).
- `version`: an integer on every masjid and programme. It starts at 1 and goes up by 1 on every accepted write.
- Errors: `{ "error": "<human message>", "code": "<machine_code>", "details"?: {...} }`. Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `version_conflict` 409, `idempotency_mismatch` 409, `validation_failed` 422, `rate_limited` 429, `internal` 500, plus `possible_duplicate` 409 (`details.candidates`, same shape as `/masjids/match`) and `already_linked` 409 (`details.masjid_id` or `details.event_id`, `app_id`, `external_id`). Admin-only: `already_exists` 409. Repeating the same contact `type` or facility `code` in one request → 422.
- Rate limit: 600 requests/min per key. On `429`, honour `Retry-After` (seconds).
- Query strings: URL-encode `+` in offsets as `%2B` (an unencoded `+` arrives as a space and is read as `+`).
- Lists: list endpoints take `limit` (max 100; default 20, programmes 50) and `cursor`, and return `{ "data": [ <full entity> … ], "next_cursor": <string|null> }` (null at the end). Treat the cursor as opaque.
- A PATCH that changes nothing still counts as a write: the version goes up by 1 and a change is emitted.

## 2. Authentication and keys

- One key per app, issued by the maintainers. Each key has an `app_id` (`jejak_masjid`, `qiyam`, …) and scopes: `read`, `write`, `webhook`.
- Header: `Authorization: Bearer <api_key>`. Missing or invalid → `401`. Missing scope → `403`.
- Rotation: a new key is issued alongside the old one, and both work for 7 days.

## 3. Write headers

| Header | Required on | Value |
|---|---|---|
| `Idempotency-Key` | POST, PATCH, DELETE | Unique per logical write (e.g. `qiyam-outbox-81723`). Same key + same body within 24 h → the original response is returned. Same key + different body → `409 idempotency_mismatch`. |
| `If-Match` | PATCH, DELETE | The `version` you based the edit on. |
| `X-Sentral-Actor` | POST, PATCH, DELETE | Opaque app-local user id, or `system` for jobs. Stored in the audit log so maintainers can trace and revert. Never PII (R8). |

---

## 4. Data model

### 4.1 Masjid

```json
{
  "id": 10234,
  "version": 7,
  "name": "Masjid Al-Hidayah",
  "type_id": "masjid",
  "lat": 3.139003,
  "lng": 101.686855,
  "geohash": "w283kq9",
  "country_id": "my",
  "state_id": "my-kul",
  "city_id": "my-kul-kuala-lumpur",
  "address": "Jalan ...",
  "description": null,
  "jumaat_available": true,
  "telephone": "+60312345678",
  "email": null,
  "google_url": "https://maps.google.com/?cid=...",
  "contacts": [{ "type": "facebook", "value": "https://facebook.com/..." }],
  "facilities": [{ "code": "TOILET_FEMALE", "available": true }],
  "images": [{ "url": "https://...", "is_thumbnail": true, "sort_order": 0 }],
  "external_ids": [{ "app_id": "qiyam", "external_id": "q_5521" }],
  "status": "active",
  "merged_into": null,
  "updated_by_app": "qiyam",
  "created_at": "2026-06-11T02:00:00Z",
  "updated_at": "2026-11-14T10:30:00Z"
}
```

- `geohash` is computed by the server. Do not send it.
- `contacts[].type`: `facebook`, `instagram`, `twitter`, `youtube`, `whatsapp`, `tiktok`, `threads`, `website`.
- `facilities[].code` comes from `GET /facilities` (**NEW**). Unknown codes → `422`. A code that is absent means "unknown". `available: false` means "confirmed not available".
- `images[].url`: a full HTTPS URL hosted by the sending app (each app keeps its own image storage; Sentral stores the URL). Send only images your own moderation has approved, and remove them from Sentral when you hide them locally.
- `status`: `active` | `deleted` | `merged`. Deleted and merged masjids still appear in `/changes`. They are hidden from list and search.

### 4.2 Programme (masjid event) — **NEW fields**

```json
{
  "id": 88121,
  "version": 2,
  "masjid_id": 10234,
  "title": "Kuliah Maghrib: Tafsir Al-Quran",
  "description": "Kuliah mingguan ...",
  "category": "kuliah",
  "speaker": "Ustaz Ahmad",
  "start_at": "2026-11-20T11:15:00Z",
  "end_at": "2026-11-20T12:15:00Z",
  "timezone": "Asia/Kuala_Lumpur",
  "rrule": "FREQ=WEEKLY;BYDAY=TH",
  "status": "active",
  "poster_url": "https://cdn.qiyam.example/posters/abc.jpg",
  "registration_url": null,
  "external_ids": [{ "app_id": "qiyam", "external_id": "prog_993" }],
  "source_app": "qiyam",
  "updated_by_app": "qiyam",
  "created_at": "2026-11-14T10:30:00Z",
  "updated_at": "2026-11-14T10:31:00Z"
}
```

- `category` (draft list, §11): `kuliah`, `ceramah`, `tazkirah`, `kelas`, `qiamullail`, `gotong_royong`, `sukan`, `majlis`, `program_belia`, `korban`, `iftar`, `jualan`, `lain` (other). Unknown → `422`. Map anything you don't have to `lain`.
- `rrule`: RFC 5545 RRULE without the `RRULE:` prefix, or `null` for a one-off. `start_at`/`end_at` describe the first occurrence. An app that stores a series as separate dated rows MAY send each row as its own one-off programme (one `external_id` per row) instead of an `rrule`.
- **Only public programmes sync.** Never send drafts. When a programme is unpublished, taken down by your moderation or deleted, send `DELETE`. When it is called off but should still show as cancelled, `PATCH status: cancelled` (optionally with `description` noting why).
- `status`: `active` | `cancelled` | `completed` | `deleted`.
- `poster_url`: an HTTPS image hosted by the sending app. Sentral stores the URL and does not proxy it. Keep the URL alive for as long as the programme is active.
- Registration and attendance stay in each app. Sentral holds only the public programme listing.

---

## 5. Endpoints

All require `read`. Writes also require `write`.

### 5.1 Masjids

| Method | Path | Notes |
|---|---|---|
| GET | `/masjids` | List and filter (`state`, `city`, `type`, `name`, `jumaat`, `updated_since`) |
| GET | `/masjids/nearby?lat&lng&radius` | `radius` in metres, max 20,000. Rows add `distance_m`, nearest first. |
| GET | `/masjids/{id}` | Full record (§4.1). A merged id returns `301` with `Location` set to the survivor. A deleted id returns `200` with the tombstone (`status: deleted`). Lists, search and nearby return `active` only. |
| GET | `/masjids/by-external/{app_id}/{external_id}` | **NEW.** Find a masjid by your own id, whatever its status. |
| GET | `/masjids/match?lat&lng&name[&type_id]` | **NEW.** Returns `{ "candidates": [ { id, name, type_id, same_type, lat, lng, address, external_ids, score, distance_m } ] }`: the top 5 active masjids within 1 km by `score` 0–1 (§9 step 2). `same_type` compares with your `type_id` (`null` if you sent none). Names differing only by a number or a single letter (Blok A / Blok B, Fasa 1 / Fasa 2) score below 0.9. |
| POST | `/masjids` | Create. Body = §4.1 writable fields + `external_id`. Returns `201` + full record. Possible duplicate (a same-type candidate with `score ≥ 0.9` within 50 m) → `409 code: possible_duplicate` with `details.candidates`; resend with `?force=true` only after a person confirms it is a different place (the change records `"forced": true`). An `external_id` already held by an active masjid → `409 already_linked`; one held by a deleted masjid moves to the new masjid. |
| PATCH | `/masjids/{id}` | Send only the fields you changed. `contacts`/`facilities` in a PATCH change only the listed `type`/`code` entries. Send `{ "code": "X", "available": null }` to clear one, or `{ "type": "facebook", "value": null }` for a contact. Retired facility codes can be cleared but not set. `images`, when sent, replace the whole list. Use DELETE, not `status`, to delete. PATCH/DELETE on a merged masjid → `404` with `details.merged_into`. |
| PUT | `/masjids/{id}/external-ids/{app_id}` | **NEW.** Body `{ "external_id": "q_5521" }`. Links your id; returns `200` + the full masjid with a bumped version and emits an `update` with `changed_fields: ["external_ids"]`. `Idempotency-Key` optional, no `If-Match`. Only your own `app_id` (else `403`). Same id again → `200`, no change. The masjid already has a different id from your app → `409 already_linked`. Your id held by another active masjid → `409 already_linked`; held by a deleted masjid → the link moves. A merged masjid → `404` with `details.merged_into`. |
| DELETE | `/masjids/{id}` | **NEW.** Soft delete. Use it for "this place does not exist / closed for good". Its programmes are deleted in the same write (each emits an `event` `delete`). A masjid with more than 200 live programmes → 422 `details.reason: too_many_events`. If a programme is added while the delete runs → `409 version_conflict`; retry. |

### 5.2 Programmes — **NEW**

| Method | Path | Notes |
|---|---|---|
| GET | `/masjids/{id}/events?from&to` | A merged masjid → `301` to the survivor's list. Programmes with `status` `active` or `cancelled` whose first occurrence starts before `to` and that either repeat or have not ended before `from`. Defaults: `from` = now, `to` = now + 90 days. Ordered by `start_at, id`. Repeating programmes are returned once (expand them client-side). |
| GET | `/events?masjid_ids=1,2,3&from&to` | Up to 100 masjids per call |
| GET | `/events/{id}` | |
| GET | `/events/by-external/{app_id}/{external_id}` | Whatever its status |
| PUT | `/events/{id}/external-ids/{app_id}` | Link your programme id. Same rules as the masjid PUT. |
| POST | `/masjids/{id}/events` | Create. Include `external_id`. Returns `201`. The masjid must be active: deleted → `404`, merged → `404` with `details.merged_into` (post to the survivor). |
| PATCH | `/events/{id}` | Changed fields only. PATCH, DELETE and link of a programme whose masjid is not active → `404` (`details.merged_into` when merged). |
| DELETE | `/events/{id}` | Sets `status: deleted` |

### 5.3 Reference

`GET /states?country=`, `GET /cities?state=`, `GET /facilities` (**NEW**, the facility code catalogue: `{ "data": [ { code, label_en, label_ms, sort_order } ] }`).

From migration 006, states and cities cover all four countries (MY 16 states / 442 cities, SG 1 / 55, BN 4 / 40, ID 38 / 514). Ids are lowercase ASCII slugs: state `<country>-<slug>` (Malaysia keeps `my-jhr`…), city `<state_id>-<slug>`. Singapore has one state `sg-singapore` whose cities are the 55 URA planning areas. Brunei states are the 4 districts and cities are mukims. Indonesia cities are kabupaten and kota, always prefixed `kab-` or `kota-` (`id-jawa-barat-kab-bogor`, `id-jawa-barat-kota-bogor`). Malaysian cities are Pos Malaysia post towns (`my-sgr-shah-alam`), one per state and town.

### 5.4 Write responses and conflicts

- `200`/`201` return the full entity with its new `version`. **Store that `version` as `local.sentral_version` straight away.** That is what makes R2 skip the echo of your own write.
- `409 version_conflict` returns `details.current` (the latest entity). Resolve it:
  1. Work out which fields your user changed (your outbox stores `base_version` and the changed fields).
  2. For each changed field, if `details.current` still holds the value from your base, re-send it in a new PATCH with `If-Match: current.version` and the **same** idempotency key suffixed `-r1`, `-r2`…
  3. If the remote value changed too, **the remote value wins**. Drop your field, apply `current` locally and log the conflict. Do not loop more than 3 times.
- `422` means a bad payload. Do not retry. Park the outbox row for a person to look at.
- `5xx`, `429` or a network error: retry with exponential backoff (1 s → max 10 min) and keep the outbox row.

---

## 6. Change feed — **NEW**

### 6.1 `GET /changes?after=<seq>&limit=<n>`

`limit` defaults to 200, max 500. Changes come back in `seq` order, which only ever increases.

```json
{
  "changes": [
    {
      "seq": 501233,
      "entity": "masjid",
      "entity_id": 10234,
      "masjid_id": 10234,
      "op": "update",
      "version": 8,
      "origin_app": "jejak_masjid",
      "changed_fields": ["facilities", "telephone"],
      "occurred_at": "2026-11-14T10:35:02Z",
      "data": { "...": "full entity after the change, same shape as GET" }
    }
  ],
  "next_after": 501233,
  "has_more": false
}
```

- `entity`: `masjid` | `event` (more may be added — R10).
- `op`: `create` | `update` | `delete` | `merge`.
- `data` is the full entity after the change. On `delete` it holds the tombstone (`status: deleted`).
- Your own writes appear in the feed too. R2 skips them.
- v1.1 keeps the whole feed (nothing is pruned). `410 code: cursor_expired` is reserved for a future retention limit: if you ever get it, run a full resync (§9 step 2), then continue from `latest_seq`.
- `data` may carry extra keys beyond the GET shape (`via_merge`, `moved_external_ids`, `forced`); ignore what you don't use (R10).
- `GET /changes/latest` returns `{ "latest_seq": n }`. Use it to start the cursor after your first full sync.

### 6.2 Cursor

Persist `next_after` **only after** you have committed the whole page locally, in the same transaction if you can. Then a crash just replays the page, and R2 makes the replay harmless.

### 6.3 Applying a change (pseudo-code)

```
for change in page.changes:
  local = find_local_by_sentral_id(change.entity, change.entity_id)
  if local and change.version <= local.sentral_version: continue   # R2
  if change.op == "merge": handle_merge(change); continue          # §6.4
  if not local and change.entity == "masjid":
      local = find_by_external_id(change.data.external_ids, my_app_id)
             or create_local_masjid(change.data)                    # new from other app
  upsert_local(change.data); local.sentral_version = change.version
save_cursor(page.next_after)
```

- A programme whose masjid you have not linked yet: fetch `GET /masjids/{masjid_id}`, create or link it, then apply the programme.
- Inbound changes MUST NOT be re-queued to your outbox. Apply them on a code path that skips your outbound hook. Otherwise you echo every change back to Sentral.

### 6.4 Merge

A merge emits, in this order: the `merge` change on the **removed** masjid (`entity_id`, `data.merged_into` = survivor id, `data.moved_external_ids`, `data.external_ids` = `[]`), then one `event` `update` per moved programme (new `masjid_id`), then an `update` on the survivor (`changed_fields: ["external_ids"]`). On the `merge`: point your local link at the survivor, fetch it with `GET /masjids/{survivor}`, and set `sentral_version` from that fetched record. A survivor may then hold two ids from your app; `by-external` returns the survivor for either. If you held both locally, merge them with your own app rules (for example, move check-ins). Programmes of the removed masjid arrive as separate `event` `update` changes with the new `masjid_id`.

---

## 7. Webhooks — **NEW**

- Register once with the maintainers: an HTTPS URL plus your key's `webhook` scope. You receive a shared secret `whsec_…`.
- Sentral POSTs a thin ping within seconds of each committed write by **another** app:

```
POST <your url>
Content-Type: application/json
X-Sentral-Signature: t=1763116502,v1=5f2c…
X-Sentral-Delivery: dlv_01JD…

{ "type": "changes.available", "latest_seq": 501233 }
```

- Verify: `v1 == hex(HMAC_SHA256(secret, t + "." + raw_body))` with a constant-time compare, and `|now - t| <= 300` s. Fail → `401`, do nothing.
- Respond `2xx` within 5 s. Do the pull asynchronously (queue or background job). Do not pull inside the request.
- Retries: 1 m, 5 m, 30 m, 2 h, 6 h, then the delivery is dropped. Dropped pings are harmless because the scheduled pull catches up (R6). Pings may arrive twice or out of order. The ping carries no data on purpose.

---

## 8. Ownership and moderation

- Any app key with `write` may edit any masjid or programme. Writes go live straight away for every app.
- Each app moderates its **own users** before sending (R7): reports, review queues, trust levels, photo rules. Sentral does not re-moderate.
- Every write is audited (`app_id`, `X-Sentral-Actor`, before/after, time). Maintainers can revert a change. A revert is field-level (only the fields that change touched) and arrives in your feed as a normal change with a higher `version`: reverting an edit is an `update`, reverting a create is a `delete`, reverting a delete is an `update` back to `active`. Merges cannot be reverted in v1.1.
- Programmes: you MAY edit a programme created by another app (for example, to cancel it). Prefer leaving another app's programme alone unless your user is that masjid's committee.
- Abuse from one app's users is that app's responsibility. Its key can be suspended.

---

## 9. Build order for your agent

0. **Send new masjids now (create-only push) — start this first (maintainers 2026-11-17).** Sentral is live at `https://api.masjidsentral.com`, and new masjids keep being added in both apps before the full link jobs run. Ship this small piece now so every new masjid reaches Sentral from day one; the link jobs (step 2) later skip anything that already has a `sentral_id`.
   - **Never block your user.** Save the masjid locally and answer the user as you do today. Sending to Sentral happens in the background (queue, cron or outbox drain). Never call Sentral inside the user's request.
   - **But never drop it either.** A failed send stays queued and is retried. Keep a durable row per masjid (the `sentral_outbox` of step 1 is enough; `entity='masjid'`, `op='create'`).
   - **Only moderated masjids.** Enqueue when your moderation approves the masjid (R7), not when a user submits it.
   - **Request.** `POST /masjids` with `Idempotency-Key: <app_id>-masjid-create-<local_id>`, `X-Sentral-Actor: system` (or the opaque moderator id) and the body `name, type_id, country_id, state_id, city_id (or null), lat, lng, address, external_id: "<local_id>"`. `name`, `type_id`, `country_id`, `state_id`, `lat`, `lng` and `address` are required. Do not round coordinates (R9). **Build the body once and store it**; every retry sends the exact stored body with the same key (a different body under the same key is `409 idempotency_mismatch`).
   - **Results:**

     | Response | Do |
     |---|---|
     | `201` | Store `sentral_id = body.id`, `sentral_version = body.version`. Done. |
     | `409 already_linked` | Your id is already in Sentral: store `details.masjid_id`, then `GET /masjids/{id}` and store its `version`. Done. |
     | `409 possible_duplicate` | If the top `details.candidates[0]` has `score >= 0.9`, `distance_m <= 50` and `same_type: true`: `PUT /masjids/{id}/external-ids/<app_id>` with `{ "external_id": "<local_id>" }`, store `id` and the returned `version`. Otherwise (or if that PUT returns `409 already_linked`) mark the row `needs_review` for a person. **Never send `?force=true` automatically.** |
     | `429`, `5xx`, network error, timeout | Retry later with the same key and body (exponential backoff, e.g. 1 min doubling to 6 h). |
     | `401`, `403` | Configuration problem (key or scope). Keep the row, retry later, alert the maintainers. |
     | `422` | Your data does not fit (e.g. an unmapped `state_id` or unknown `type_id`). Mark the row `failed` with the error, do not retry, fix the mapping and requeue. |
   - **Reference ids.** Map your state and district/city to `GET /states?country=` and `GET /cities?state=` ids. `city_id` is optional: send `null` rather than a guess.
   - **Edits are not sent yet.** Only creates. Edits, deletes and programmes follow in step 3. Your later inbound sync sees your own creates in `/changes`; R2 skips them because you stored `sentral_version`.
1. **Schema in your app.** Add to your masjid table: `sentral_id INTEGER UNIQUE NULL` and `sentral_version INTEGER NOT NULL DEFAULT 0`. Add the same two columns to your programme table. Add a table `sentral_outbox(id, entity, local_id, sentral_id, op, payload_json, base_version, attempts, next_attempt_at, last_error, status)` and a table `sentral_cursor(last_seq)`.
2. **Initial link (one-off job, resumable).** **Rebuild (maintainers 2026-11-14):** the old v1.0 import kept no app ids and over-merged, so Sentral's masjid table is rebuilt empty. **Qiyam's link job runs first** and creates the base set; **JM's link job runs after Qiyam's finishes**, matches against it and handles the duplicate checking and review. Do not start JM's run until the maintainers say Qiyam's is done. The job is the import: there is no CSV step. **Re-run it nightly** until your outbound sync (step 3) is live, so masjids added in your app in the meantime are picked up. It only touches masjids without a `sentral_id`, so re-runs are safe. **Links are one-to-one:** if a Sentral row is already linked to another of your masjids, do not link a second one; send both to the review list. For each local masjid without `sentral_id`:
   - `GET /masjids/by-external/{you}/{local_id}`. Found → link.
   - Else `GET /masjids/match?lat&lng&name`. If the top candidate has `score ≥ 0.9`, `distance_m ≤ 50` **and** `same_type: true` (send your `type_id`) → `PUT /masjids/{id}/external-ids/{you}`, then link.
   - Else if the top candidate has `score ≥ 0.6` → write it to a review list for a person. Do not auto-link.
   - Else `POST /masjids` with `external_id`, then link.
   - After linking, set `sentral_version` from the returned record and decide per field: Sentral's value wins unless the Sentral field is empty and yours is not. In that case, queue a PATCH.
   - Programmes: for each public programme, `GET /events/by-external/{you}/{id}`. Found → link locally. Else compare with `GET /masjids/{sentral_id}/events`: same `start_at` and a near-identical `title` → `PUT /events/{id}/external-ids/{you}`; otherwise `POST`. If unsure, POST: a duplicate programme is cheaper than a wrong link.
   - When done: `GET /changes/latest` → save as the cursor.
3. **Outbound.** At every place your app commits a masjid-detail or programme change (after your own moderation), insert an outbox row in the same transaction. A worker drains the outbox (§5.4).
   - **Add-masjid flow (SHOULD):** before a user submits a new masjid, call `GET /masjids/match` from your backend and show the candidates ("Is it one of these?"). If the user picks one, create your local masjid from that Sentral record and link it. Do not POST a new one. Show the same candidates to your moderator at approval time. On `409 possible_duplicate`, link to a candidate or let a person confirm `?force=true`. Never auto-force.
4. **Inbound pull.** A job that loops `GET /changes?after=cursor` until `has_more: false`, applying §6.3. Schedule it every ≤15 min. Also trigger it from the webhook.
5. **Webhook receiver** (§7).
6. **Reads.** Your app may keep reading its local copy. Use Sentral reads for linking, backfill and checks. Do not proxy end-user traffic through Sentral.

## 10. Acceptance checks (all must pass against staging)

1. A request without a key → `401`. A request with a read-only key on POST → `403`.
2. Link job: a masjid that exists in Sentral is linked, not duplicated. Re-running the job creates nothing new.
3. Edit a facility in your app → it appears in `GET /masjids/{id}` within 1 min. Your own `/changes` entry is skipped (local `sentral_version` already equals it).
4. Another key edits the same masjid → your webhook fires → your local copy updates within 1 min.
5. Webhook with a bad signature, or a `t` older than 5 min → rejected, no pull.
6. Webhooks disabled → the scheduled pull still applies the change within 15 min.
7. Replay the same `/changes` page twice → no duplicate rows and no version going backwards.
8. Two apps PATCH the same field from the same base → one wins, the other gets `409`, resolves it per §5.4, and both apps end on the same value.
9. Same `Idempotency-Key` sent twice → one write, identical responses.
10. Merge of masjid A into B → your links move to B and A's programmes show under B.
11. Create, cancel and delete a programme in one app → the other app shows it, then shows it as cancelled, then hides it.
12. Your logs and payloads contain no user name, email or phone (only the masjid's own public contacts).

## 11. Open items (maintainers, not your agent)

- Final facility code catalogue (both apps' codes to be merged into `GET /facilities`).
- Final programme `category` list (§4.2 is the union of both apps' lists).
- Masjid types: JM also has `institution` (university, hospital, office prayer spaces). Add it or map it to `surau`.
- Facility state: JM tracks confirmed / unconfirmed / disputed per facility; Sentral has only available yes / no / unknown. Agree which states count as `true`.
- Check that production reference data (`countries`, `states`, `cities`, `masjid_types` incl. `mini-surau`) matches the schema repo before the rebuild.
- Sentral server prerequisites before any key is issued: remove the dev test key seeded in migration `002_api_keys.sql`, and confirm what the prod D1 holds.
- Staging URL, key issue and webhook registration.
- Data licence: each app's terms must allow user-contributed masjid and programme data to be shared with the partner app.
