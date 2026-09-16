#!/usr/bin/env node
// Builds public/field-coords.json — a static map of NYC Parks field name -> [lat, lng].
//
// Why static: field locations don't move, and the source datasets change rarely,
// so resolving them once (here) is cheaper and more reliable than re-doing the
// fuzzy name join on every permit sync. Re-run this when NYC updates its data:
//   node scripts/build-field-coords.mjs
//
// Sources (NYC Open Data):
//   tvpp-9vvx  Park Event Permits         -> the field NAMES the app actually shows
//   qnem-b8re  Athletic Facilities        -> per-field geometry (multipolygon) + sport flags + field_number
//   enfh-gkve  Parks Properties           -> gispropnum -> park name (signname) + park geometry
//
// Strategy per field name "Park: [SubArea-]Sport-NN":
//   1. park name  -> gispropnum   (normalized signname match)
//   2. gispropnum + sport + field_number -> exact facility centroid   (best)
//   3. gispropnum + sport (any field)    -> that sport's facility centroid
//   4. gispropnum (any facility / park polygon) -> park centroid       (still correct park)
// Anything with no park match at all is left out (frontend will not random-place it).

import { writeFileSync } from 'node:fs';

const SOCRATA = 'https://data.cityofnewyork.us/resource';
const TODAY = new Date();
const WINDOW_END = new Date(TODAY.getTime() + 120 * 864e5).toISOString().replace('Z', '');
const WINDOW_START = new Date(TODAY.getTime() - 30 * 864e5).toISOString().replace('Z', '');

async function soda(path, params) {
  const url = `${SOCRATA}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`SODA ${path} HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

// paginated fetch
async function sodaAll(path, params, pageSize = 5000) {
  let out = [], offset = 0;
  for (;;) {
    const page = await soda(path, { ...params, $limit: pageSize, $offset: offset });
    out = out.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset > 60000) break; // safety
  }
  return out;
}

// ---- geometry: rough centroid of a GeoJSON MultiPolygon/Polygon ----
function centroidOf(geom) {
  if (!geom || !geom.coordinates) return null;
  let sx = 0, sy = 0, n = 0;
  const visit = (a) => {
    if (typeof a[0] === 'number') { sx += a[0]; sy += a[1]; n++; return; }
    for (const c of a) visit(c);
  };
  visit(geom.coordinates);
  if (!n) return null;
  return [ +(sy / n).toFixed(6), +(sx / n).toFixed(6) ]; // [lat, lng]  (GeoJSON is [lng,lat])
}

// ---- name normalization for park matching ----
function normPark(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')      // drop "(PS 21)", "(JHS 126)", etc.
    .replace(/&/g, ' and ')
    .replace(/[.'’`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(playground|park|fields?|athletic|recreation area|recreation center|rec center|ballfields?|complex|the)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// sport keyword in a field name -> qnem boolean columns that count as that sport
const SPORT_COLS = {
  soccer:     ['regulation_soccer', 'nonregulation_soccer'],
  baseball:   ['adult_baseball', 'll_baseb_12andunder', 'll_baseb_13andolder', 't_ball'],
  softball:   ['adult_softball', 'll_softball'],
  football:   ['adult_football', 'youth_football', 'flagfootball', 'wheelchairfootball'],
  basketball: ['basketball'],
  tennis:     ['tennis'],
  handball:   ['handball'],
  cricket:    ['cricket'],
  rugby:      ['rugby'],
  lacrosse:   ['lacrosse'],
};

function parseFieldName(name) {
  const park = name.split(':')[0].trim();
  const rest = name.slice(park.length + 1).toLowerCase();
  let sport = null;
  for (const s of Object.keys(SPORT_COLS)) if (rest.includes(s) || name.toLowerCase().includes(s)) { sport = s; break; }
  const numMatch = rest.match(/(\d{1,3})\s*$/);
  const fieldNo = numMatch ? String(parseInt(numMatch[1], 10)) : null; // "05" -> "5"
  return { park, sport, fieldNo };
}
const normNum = (x) => (x == null ? null : String(parseInt(String(x), 10)));

async function main() {
  console.error('Fetching distinct permit field names…');
  const permitRows = await sodaAll('tvpp-9vvx.json', {
    $select: 'event_location, event_borough',
    $where: `start_date_time>='${WINDOW_START}' AND start_date_time<='${WINDOW_END}' AND event_agency='Parks Department'`,
  });
  // split comma-joined names exactly like the app's groupByField()
  const fieldNames = new Set();
  for (const r of permitRows) {
    for (const nm of String(r.event_location || '').split(',').map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean)) {
      fieldNames.add(nm);
    }
  }
  console.error(`  ${permitRows.length} permit rows -> ${fieldNames.size} distinct field names`);

  console.error('Fetching Parks Properties (enfh-gkve)…');
  const parks = await sodaAll('enfh-gkve.json', { $select: 'gispropnum, signname, borough, multipolygon' });
  // build normalized signname -> {gispropnum, centroid}
  const parkByNorm = new Map();
  const parkCentroid = new Map();
  for (const p of parks) {
    if (!p.gispropnum) continue;
    const c = centroidOf(p.multipolygon);
    if (c) parkCentroid.set(p.gispropnum, c);
    const key = normPark(p.signname);
    if (key && !parkByNorm.has(key)) parkByNorm.set(key, p.gispropnum);
  }
  console.error(`  ${parks.length} parks`);

  console.error('Fetching Athletic Facilities (qnem-b8re)…');
  const facs = await sodaAll('qnem-b8re.json', {
    $select: 'gispropnum, field_number, primary_sport, multipolygon, ' + Object.values(SPORT_COLS).flat().join(', '),
  });
  // index facilities by gispropnum -> [{sportsTrue:Set, fieldNo, centroid}]
  const facByPark = new Map();
  for (const f of facs) {
    const c = centroidOf(f.multipolygon);
    if (!c || !f.gispropnum) continue;
    const sportsTrue = new Set();
    for (const [sport, cols] of Object.entries(SPORT_COLS)) if (cols.some(col => f[col] === true)) sportsTrue.add(sport);
    if (!facByPark.has(f.gispropnum)) facByPark.set(f.gispropnum, []);
    facByPark.get(f.gispropnum).push({ sportsTrue, fieldNo: normNum(f.field_number), centroid: c });
  }
  console.error(`  ${facs.length} facilities across ${facByPark.size} parks`);

  const coords = {};
  const stat = { exact: 0, sportPark: 0, park: 0, none: 0 };
  const unresolved = [];
  for (const name of fieldNames) {
    const { park, sport, fieldNo } = parseFieldName(name);
    // try the whole park name, then each "/"-separated alias (e.g. "A Park / B Park")
    let gis = parkByNorm.get(normPark(park));
    if (!gis) for (const seg of park.split('/')) { gis = parkByNorm.get(normPark(seg)); if (gis) break; }
    if (!gis) { stat.none++; unresolved.push(park); continue; }
    const facs = facByPark.get(gis) || [];
    let hit = null, tier = null;
    if (sport && fieldNo) hit = facs.find(f => f.sportsTrue.has(sport) && f.fieldNo === fieldNo);
    if (hit) tier = 'exact';
    if (!hit && sport) { hit = facs.find(f => f.sportsTrue.has(sport)); if (hit) tier = 'sportPark'; }
    if (!hit && facs.length) {
      // park centroid = average of its facility centroids
      const avg = facs.reduce((a, f) => [a[0]+f.centroid[0], a[1]+f.centroid[1]], [0,0]);
      hit = { centroid: [ +(avg[0]/facs.length).toFixed(6), +(avg[1]/facs.length).toFixed(6) ] }; tier = 'park';
    }
    if (!hit && parkCentroid.has(gis)) { hit = { centroid: parkCentroid.get(gis) }; tier = 'park'; }
    if (!hit) { stat.none++; continue; }
    coords[name] = hit.centroid;
    stat[tier]++;
  }

  writeFileSync(new URL('../public/field-coords.json', import.meta.url), JSON.stringify(coords));
  const total = fieldNames.size;
  const placed = stat.exact + stat.sportPark + stat.park;
  console.error(`\nDONE -> public/field-coords.json`);
  console.error(`  exact field:   ${stat.exact}`);
  console.error(`  sport-in-park: ${stat.sportPark}`);
  console.error(`  park centroid: ${stat.park}`);
  console.error(`  unresolved:    ${stat.none}`);
  console.error(`  coverage:      ${placed}/${total} (${(100*placed/total).toFixed(1)}%) — unresolved get NO pin (not random)`);
  if (process.env.DEBUG) {
    const uniq = [...new Set(unresolved)].sort();
    console.error(`\nUNRESOLVED parks (${uniq.length}):`); uniq.slice(0,60).forEach(p => console.error('  · '+p));
    console.error('\nEXACT samples:'); Object.entries(coords).slice(0,6).forEach(([n,c]) => console.error(`  ${n} -> ${c}`));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
