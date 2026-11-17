# PROGRESS: regions (migration 006)

Branch `feat/regions` in `api` (tests, docs) and `masjidsentral-db-schema` (migration, generator, sources). Not merged, not pushed, not applied to any remote DB.

## What was built

- `masjidsentral-db-schema/migrations/006_regions.sql`: generated, deterministic (sorted by id), every statement `INSERT OR IGNORE`.
- `masjidsentral-db-schema/scripts/regions/generate.mjs`: Node, no dependencies, reads only `sources/*` and `my_cities_existing.sql` as data. Run `node scripts/regions/generate.mjs` from `masjidsentral-db-schema/`; re-running gives a byte-identical file.
- `masjidsentral-db-schema/scripts/regions/sources/`: raw downloads (untrusted data, parsed with regexes and `JSON.parse` only).
- `api/tests/regions.test.ts`: 16 tests.

## Sources (downloaded 2026-11-17)

| Country | Source | Version |
|---|---|---|
| ID | `github.com/cahyadsn/wilayah`, `db/wilayah.sql` (`sources/wilayah.sql`) | Kepmendagri No 300.2.2-2138 Tahun 2025, file last edit 2026-02-13, repo commit `d68e8d5516f969d1905d0b2940f20034becb0db7` (`sources/wilayah_commit.json`) |
| SG | data.gov.sg dataset `d_4765db0e87b9c86336792efe8a1f7a66`, "Master Plan 2019 Planning Area Boundary (No Sea)", URA (`sources/sg_planning_areas_2019.geojson`, `sources/sg_metadata.json`) | dataset updated 2025-12-05 |
| BN | Wikipedia "Mukims of Brunei" raw wikitext (`sources/bn_mukims_wikipedia.wikitext`); it cites the Brunei Information Department district lists | fetched 2026-11-17 |
| MY | prod list `scripts/regions/my_cities_existing.sql` (612, unchanged) plus Wikipedia "List of districts in Malaysia" raw wikitext (`sources/my_districts_wikipedia.wikitext`) | fetched 2026-11-17 |

## Counts

| Country | States | Cities | Notes |
|---|---|---|---|
| my | 16 (from 001) | 632 | 612 existing + 20 new districts |
| sg | 1 | 55 | URA planning areas, as expected |
| bn | 4 | 40 | 39 mukims + Bandar Seri Begawan |
| id | 38 | 514 | 416 kabupaten + 98 kota, as expected |

The 006 file inserts 43 states (SG 1, BN 4, ID 38) and 1,241 cities (the 612 existing are re-stated as no-ops). Every spec count matched; there were no count deviations.

## Deviations and notes

- **Legacy ids break the spec regex.** 33 of the 612 prod MY cities have ids with runs of hyphens, e.g. `my-sbh-taw---tawau`, `my-sbh-pbs---kota-kinabalu`, `my-pls---01000-kangar`, `my-kdh-kdh---padang-serai`, `my-sgr-pet---petaling`. The spec says to copy the 612 unchanged and never rename, so they stay. The test asserts the strict regex `^[a-z]{2}(-[a-z0-9]+)+$` for every other id, and asserts that exactly these 33 legacy ids (all `my-`, all containing `--`) are the exceptions. All new ids pass the strict regex. The legacy list is also messy in other ways (ALL CAPS names, `UNKNOWN`, `Tumphttps:`, an Arabic row, `Kuala Kumpur` and `Makaysia` typos); none of it was touched.
- **MY districts.** Only 20 of the 162 official districts parsed were not already present under the same slug. Added: Bera; Kalabakan, Nabawan, Paitan, Pitas, Sook, Telupid, Tongod (Sabah); Bukit Mabong, Lingga, Lubok Antu, Matu, Pakan, Pantu, Sebuyau, Selangau, Song, Tanjung Manis, Tebedu, Telang Usan (Sarawak). Divisions (bahagian) were not added as cities: every Sarawak and Sabah division has a same-named district, which is covered.
- **Same place, different slug in prod.** Following the spec's same-slug rule, `my-sbh-tongod`, `my-sbh-sook` are new rows although prod already has `my-sbh-san---tongod` and `my-sbh-bpa---sook` (legacy "branch - district" names). Perak's Larut, Matang and Selama already exists as `my-prk-larut-matang-and-selama`, so the generator skips the Malay-spelled `...-dan-...` row (a same-place guard in `generate.mjs`).
- **Malay names for Penang districts** use the official Malay names that prod already uses as ids: Seberang Perai Utara/Tengah/Selatan, Timur Laut, Barat Daya (all already existed; no new rows).
- **Indonesia names** are the Kemendagri names. `Kep.` is expanded to `Kepulauan` (one row, `Kabupaten Kepulauan Siau Tagulandang Biaro`); trailing spaces are trimmed. Jakarta keeps the source name `Kabupaten Administrasi Kepulauan Seribu` / `Kota Administrasi Jakarta Selatan` etc. while the id drops "Administrasi": `id-dki-jakarta-kota-jakarta-selatan`, `id-dki-jakarta-kab-kepulauan-seribu`. Two province ids use the spec's short forms: `id-dki-jakarta` (name Daerah Khusus Ibukota Jakarta) and `id-di-yogyakarta` (name Daerah Istimewa Yogyakarta).
- **Brunei** names are the mukim names from the article titles (`Pengkalan Batu`, the Wikipedia table displays `Pangkalan Batu`). `Berakas 'A'` becomes `bn-brunei-muara-berakas-a` (apostrophes dropped, name keeps them).
- **Singapore** planning-area names are title-cased from the URA upper-case values (`North-Eastern Islands`, `Central Water Catchment`, ...). The list includes non-residential areas (water catchments, islands, Straits View), as the spec asks for all 55.
- Wikipedia is a cross-check-grade source for BN and MY (the spec accepts it for MY; no machine-readable official BN mukim list was found). The 39 mukim and 4 district counts match the article and the spec.

## Old SG/BN/ID state ids from the old D1 to the new ids

| Old id | New id | Note |
|---|---|---|
| `bn-brunei` | `bn-brunei-muara` | was a country-level row |
| `bn-brunei-muara` | `bn-brunei-muara` | unchanged |
| `bn-brunei-muara-district` | `bn-brunei-muara` | duplicate |
| `bn-tutong` | `bn-tutong` | unchanged |
| `id-aceh` | `id-aceh` | unchanged |
| `id-bali` | `id-bali` | unchanged |
| `id-daerah-khusus-ibukota-jakarta` | `id-dki-jakarta` | duplicate |
| `id-dki-jakarta` | `id-dki-jakarta` | unchanged |
| `id-east-java` | `id-jawa-timur` | English duplicate |
| `id-jakarta` | `id-dki-jakarta` | duplicate |
| `id-jakarta-selatan` | `id-dki-jakarta-kota-jakarta-selatan` | was a city, now a city under `id-dki-jakarta` |
| `id-jawa-barat` | `id-jawa-barat` | unchanged |
| `id-jawa-tengah` | `id-jawa-tengah` | unchanged |
| `id-jawa-timur` | `id-jawa-timur` | unchanged |
| `id-kalimantan-selatan` | `id-kalimantan-selatan` | unchanged |
| `id-kalimantan-timur` | `id-kalimantan-timur` | unchanged |
| `id-riau` | `id-riau` | unchanged |
| `id-sulawesi-selatan` | `id-sulawesi-selatan` | unchanged |
| `id-sumatera-selatan` | `id-sumatera-selatan` | unchanged |
| `id-sumatera-utara` | `id-sumatera-utara` | unchanged |
| `id-west-sumatra` | `id-sumatera-barat` | English duplicate |
| `sg-singapore` | `sg-singapore` | unchanged |

Cities that hung off the old states have no stored mapping in this repo; Qiyam should re-resolve them by name under the new state (`GET /cities?state=`).

## Verification

`npx vitest run`: 375 passed (359 existing + 16 new). `npx tsc --noEmit`: clean. No wrangler command was run.
