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

async function soda(path, params, attempt = 0) {
  const url = `${SOCRATA}/${path}?${new URLSearchParams(params)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`SODA ${path} HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
    return res.json();
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); // back off on transient resets
    return soda(path, params, attempt + 1);
  }
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

// normPark() strips "park"/"playground"/"recreation center", so genuinely
// different parks can share a normalized name -- "Asser Levy Playground"
// (Manhattan, E 23rd St) and "Asser Levy Park" (Brooklyn, Coney Island) both
// reduce to "asser levy". Matching on name alone silently picked whichever
// row Socrata returned first and placed Manhattan fields in Brooklyn, so the
// park join is keyed by borough too.
//
// Handles both shapes the two datasets use: permits (tvpp-9vvx) give a full
// name ("MANHATTAN"), parks properties (enfh-gkve) a single-letter code.
const BORO_CODES = { manhattan:'M', brooklyn:'B', bronx:'X', queens:'Q', 'staten island':'R' };
function normBoro(s) {
  const v = String(s || '').toLowerCase().replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  if (BORO_CODES[v]) return BORO_CODES[v];
  const c = v.toUpperCase();
  return 'MBXQR'.includes(c) && c.length === 1 ? c : null;
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
    $select: 'event_location, event_borough, event_name',
    $where: `start_date_time>='${WINDOW_START}' AND start_date_time<='${WINDOW_END}' AND event_agency='Parks Department'`,
  });
  // split comma-joined names exactly like the app's groupByField(); also record
  // which sports have permits at each location (from event_name) so we can resolve
  // real fields whose event_location text doesn't itself contain the sport word.
  const fieldNames = new Set();
  const nameToSports = new Map();
  const nameToBoros = new Map();
  const sportFromText = (t) => { const l = String(t||'').toLowerCase(); for (const s of Object.keys(SPORT_COLS)) if (l.includes(s)) return s; return null; };
  for (const r of permitRows) {
    const evSport = sportFromText(r.event_name);
    const evBoro = normBoro(r.event_borough);
    for (const nm of String(r.event_location || '').split(',').map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean)) {
      fieldNames.add(nm);
      if (evSport) { if (!nameToSports.has(nm)) nameToSports.set(nm, new Set()); nameToSports.get(nm).add(evSport); }
      if (evBoro) { if (!nameToBoros.has(nm)) nameToBoros.set(nm, new Set()); nameToBoros.get(nm).add(evBoro); }
    }
  }
  console.error(`  ${permitRows.length} permit rows -> ${fieldNames.size} distinct field names`);

  console.error('Fetching Parks Properties (enfh-gkve)…');
  // No geometry here: the park polygon payload is huge and prone to connection
  // resets, and it's only needed for a park centroid — which we derive from the
  // park's athletic-facility centroids below instead.
  const parks = await sodaAll('enfh-gkve.json', { $select: 'gispropnum, signname, borough' });
  const parkByBoroNorm = new Map();  // "M|norm(signname)" -> gispropnum
  const gisByNorm = new Map();       // norm(signname) -> Set of gispropnum (ambiguity check)
  for (const p of parks) {
    if (!p.gispropnum) continue;
    const key = normPark(p.signname);
    if (!key) continue;
    const boro = normBoro(p.borough);
    if (boro) {
      const bk = `${boro}|${key}`;
      if (!parkByBoroNorm.has(bk)) parkByBoroNorm.set(bk, p.gispropnum);
    }
    if (!gisByNorm.has(key)) gisByNorm.set(key, new Set());
    gisByNorm.get(key).add(p.gispropnum);
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
  const stat = { exact: 0, exactByNumber: 0, sportPark: 0, park: 0, none: 0, ambiguous: 0 };
  const unresolved = [];
  const ambiguous = [];
  const parkDiag = [];
  const deferred = [];
  for (const name of fieldNames) {
    const { park, sport, fieldNo } = parseFieldName(name);
    // Candidate sports: the one in the name, plus every sport that actually has a
    // permit at this location (from event_name) -- catches real fields whose text
    // name omits the sport (e.g. "Randall's Island Park: Field 5").
    const candSports = new Set(nameToSports.get(name) || []);
    if (sport) candSports.add(sport);
    // try the whole park name, then each "/"-separated alias (e.g. "A Park / B Park"),
    // each scoped to the borough the permit says this field is in.
    const candBoros = nameToBoros.get(name) || new Set();
    const nameVariants = [park, ...park.split('/')].map(normPark).filter(Boolean);
    let gis = null;
    for (const v of nameVariants) {
      for (const b of candBoros) { gis = parkByBoroNorm.get(`${b}|${v}`); if (gis) break; }
      if (gis) break;
    }
    // No borough-scoped hit (permit borough missing, or the park row carries a
    // borough we couldn't normalize): fall back to the name alone, but ONLY when
    // that name maps to exactly one park citywide. An ambiguous name with no
    // borough to settle it gets no pin, rather than a coin-flip wrong one.
    if (!gis) {
      for (const v of nameVariants) {
        const set = gisByNorm.get(v);
        if (set?.size === 1) { gis = [...set][0]; break; }
        if (set?.size > 1) { stat.ambiguous++; ambiguous.push({ name, variant: v, parks: set.size }); }
      }
    }
    if (!gis) { stat.none++; unresolved.push(park); continue; }
    const facs = facByPark.get(gis) || [];
    let hit = null, tier = null;
    // 1. exact: a facility of one of the candidate sports with this field_number
    if (fieldNo && candSports.size) hit = facs.find(f => f.fieldNo === fieldNo && [...candSports].some(s => f.sportsTrue.has(s)));
    if (hit) tier = 'exact';
    // 2. field_number is unique in the park -> that's the field, even if the sport
    //    flags disagree (qnem sport tagging is sometimes incomplete)
    if (!hit && fieldNo) {
      const byNo = facs.filter(f => f.fieldNo === fieldNo);
      if (byNo.length === 1) { hit = byNo[0]; tier = 'exactByNumber'; }
    }
    // 3. any facility of a candidate sport (right sport, right park, unknown field #)
    if (!hit && candSports.size) { hit = facs.find(f => [...candSports].some(s => f.sportsTrue.has(s))); if (hit) tier = 'sportPark'; }
    if (!hit && facs.length) {
      if (process.env.DEBUG) parkDiag.push({ name, sport, fieldNo, candSports: [...candSports],
        parkSports: [...new Set(facs.flatMap(f => [...f.sportsTrue]))],
        parkFieldNos: facs.map(f => f.fieldNo).filter(Boolean) });
      // park centroid = average of its facility centroids
      const avg = facs.reduce((a, f) => [a[0]+f.centroid[0], a[1]+f.centroid[1]], [0,0]);
      hit = { centroid: [ +(avg[0]/facs.length).toFixed(6), +(avg[1]/facs.length).toFixed(6) ] }; tier = 'park';
    }
    // gis matched but the park has no athletic facilities in qnem -> defer:
    // we'll fetch just this park's polygon centroid in a small batched query.
    if (!hit) { deferred.push({ name, gis }); continue; }
    coords[name] = hit.centroid;
    stat[tier]++;
  }

  // Second pass: park-polygon centroid for matched-but-facility-less parks.
  // Fetching geometry only for these (vs. all ~2000 parks up front) keeps the
  // payload small and avoids the connection resets the full geometry pull hits.
  const needGis = [...new Set(deferred.map(d => d.gis))];
  const centroidByGis = new Map();
  console.error(`Fetching park polygons for ${needGis.length} facility-less parks…`);
  for (let i = 0; i < needGis.length; i += 40) {
    const chunk = needGis.slice(i, i + 40);
    const rows = await soda('enfh-gkve.json', {
      $select: 'gispropnum, multipolygon',
      $where: `gispropnum in (${chunk.map(g => `'${g}'`).join(',')})`,
      $limit: 200,
    });
    for (const r of rows) { const c = centroidOf(r.multipolygon); if (c) centroidByGis.set(r.gispropnum, c); }
  }
  for (const d of deferred) {
    const c = centroidByGis.get(d.gis);
    if (c) { coords[d.name] = c; stat.park++; } else { stat.none++; }
  }

  writeFileSync(new URL('../public/field-coords.json', import.meta.url), JSON.stringify(coords));
  const total = fieldNames.size;
  const fieldLevel = stat.exact + stat.exactByNumber;
  const placed = fieldLevel + stat.sportPark + stat.park;
  console.error(`\nDONE -> public/field-coords.json`);
  console.error(`  exact field (sport+#):  ${stat.exact}`);
  console.error(`  exact field (# unique): ${stat.exactByNumber}`);
  console.error(`  sport-in-park:          ${stat.sportPark}`);
  console.error(`  park centroid:          ${stat.park}`);
  console.error(`  unresolved:             ${stat.none}`);
  console.error(`  ambiguous name, no boro:${stat.ambiguous} (left unplaced on purpose)`);
  console.error(`  field-level total:      ${fieldLevel} (${(100*fieldLevel/total).toFixed(1)}%)`);
  console.error(`  coverage:               ${placed}/${total} (${(100*placed/total).toFixed(1)}%) — unresolved get NO pin`);
  if (process.env.DEBUG) {
    const uniq = [...new Set(unresolved)].sort();
    console.error(`\nUNRESOLVED parks (${uniq.length}):`); uniq.slice(0,60).forEach(p => console.error('  · '+p));
    if (ambiguous.length) {
      console.error(`\nAMBIGUOUS (${ambiguous.length}) — same normalized name in multiple parks, no usable borough:`);
      ambiguous.slice(0,30).forEach(a => console.error(`  · "${a.name}" -> "${a.variant}" matches ${a.parks} parks`));
    }
    // Why did park-tier fields not reach field level?
    const noSport = parkDiag.filter(d => !d.sport).length;
    const sportMissingInPark = parkDiag.filter(d => d.sport && !d.parkSports.includes(d.sport)).length;
    const fieldNoMissing = parkDiag.filter(d => d.sport && d.parkSports.includes(d.sport) && d.fieldNo && !d.parkFieldNos.includes(d.fieldNo)).length;
    console.error(`\nPARK-TIER breakdown (${parkDiag.length}):`);
    console.error(`  sport not parsed from name: ${noSport}`);
    console.error(`  sport not present in park's facilities: ${sportMissingInPark}`);
    console.error(`  sport present but field_number mismatch: ${fieldNoMissing}`);
    console.error('  samples:'); parkDiag.slice(0,12).forEach(d => console.error(`    "${d.name}" sport=${d.sport} no=${d.fieldNo} | parkSports=[${d.parkSports}] fieldNos=[${d.parkFieldNos.slice(0,8)}]`));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
