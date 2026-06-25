---
name: nyc-open-data
description: Reference for querying NYC Open Data (Socrata/SoQL) for SPORDO — the permits dataset tvpp-9vvx, the 311 complaints dataset erm2-nwe9, SoQL query patterns, gotchas (timezone format, app tokens, pagination), and rate limits. Load when ingesting, querying, or debugging NYC permit/complaint data.
---

# NYC Open Data (Socrata) for SPORDO

NYC Open Data runs on **Socrata**. Each dataset has a 4x4 id and a JSON endpoint:
`https://data.cityofnewyork.us/resource/<dataset-id>.json`. Query with **SoQL** via either discrete params (`$where`, `$select`, `$limit`, `$order`) or a single `$query=<full SoQL>` param.

## Datasets SPORDO uses

### Permits — `tvpp-9vvx`  (primary; drives availability)
`https://data.cityofnewyork.us/resource/tvpp-9vvx.json`
NYC Parks permit data. This is the heart of "is this field booked?". Normalize per-field into the `Permit` shape and upsert into `field_permit_cache`. Inspect the live column list before mapping (Socrata exposes the schema at the dataset's "API Docs" / `.json?$limit=1`).

### 311 complaints — `erm2-nwe9`  (maintenance signal)
Used to flag fields with likely maintenance issues. The prototype's `fetchMaintenanceComplaints` builds a SoQL query roughly like:

```sql
select unique_key, created_date, status, complaint_type, descriptor,
       latitude, longitude, park_facility_name
where created_date >= '<ISO-no-Z>'
  and latitude is not null and longitude is not null
  and (agency = 'DPR' or lower(coalesce(complaint_type,'')) like '%park%')
  and upper(borough) = '<BOROUGH>'
  and (<keyword OR-filter: lighting, surface, broken, net, rim, turf, closed, ...>)
order by created_date desc
limit <N>
```
…then matches complaints to fields by proximity (haversine).

## Gotchas (learned from the prototype — respect these)

- **Timestamps:** Socrata **rejects the `Z` suffix**. Build ISO strings and strip it: `new Date(...).toISOString().replace('Z','')`. Socrata times are floating/local.
- **Escaping:** single-quote-escape user/keyword values in SoQL (`k.replace(/'/g, "''")`).
- **`$query` vs params:** when using full SoQL, pass it as `$query=` (URL-encoded) — don't mix with `$where` etc.
- **Pagination:** default page is small. Use `$limit` + `$offset` (or `$order` + cursor) to pull full results; never assume one request returns everything.

## Production hardening

- **Register a Socrata app token** and send it as the `X-App-Token` header (or `$$app_token=`). Without it you share a low anonymous rate limit; with it you get a much higher throttle. Store it as a **secret** (Wrangler secret / `.dev.vars`), never in client code.
- **Sync server-side, serve from cache.** Don't call Socrata from the browser in production — the prototype does, but the production path is: scheduled worker → normalize → `field_permit_cache` → client reads cache. (See the `data-pipeline-engineer` agent.)
- **Be resilient:** back off on 429/5xx, and **never overwrite good cached data with an empty or failed fetch**. Stamp `field_sync_meta` with last-success, source, and row counts; surface staleness to the UI.
- **Spot-check** ingested data against known fields before trusting a sync.

## Quick reference

```
# one row to inspect schema
curl 'https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=1'

# with app token + paging
curl -H "X-App-Token: $SOCRATA_APP_TOKEN" \
  'https://data.cityofnewyork.us/resource/tvpp-9vvx.json?$limit=1000&$offset=0'
```
