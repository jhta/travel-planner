'use strict';

const STORAGE_KEY = 'travel-planner';
const THEME_KEY = 'travel-planner-theme';

const state = {
  trips: [],
  activeTripId: null,
};

let map = null;
let markersLayer = null;
let polylineLayer = null;
let arrowsLayer = null;
let placeMarkers = {};
let geocodeAbort = null;
let tripEditing = false;
let editingPlaceId = null;
let selectedPlaceId = null;
let expandedPlaceId = null;
let gapAction = null; // { index, mode: 'menu' | 'place' | 'transport' }
let foodSectionOpen = true;
let lodgingEditPlaceId = null;
let viewMode = 'stops'; // 'stops' | 'days'
let focusAfterRender = null;

// ---------- Persistence ----------

async function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      state.trips = Array.isArray(parsed.trips) ? parsed.trips : [];
      state.trips.forEach(ensureTripFields);
      state.activeTripId = parsed.activeTripId || state.trips[0]?.id || null;
      return;
    } catch (e) {
      console.warn('Bad localStorage data, falling back to file', e);
    }
  }
  await loadFromFile();
}

async function loadFromFile() {
  try {
    const res = await fetch('trips.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('trips.json not found');
    const data = await res.json();
    state.trips = Array.isArray(data.trips) ? data.trips : [];
    state.trips.forEach(ensureTripFields);
    state.activeTripId = data.activeTripId || state.trips[0]?.id || null;
  } catch (e) {
    console.warn('Could not load trips.json — starting empty', e);
    state.trips = [];
    state.activeTripId = null;
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ trips: state.trips, activeTripId: state.activeTripId })
  );
}

function exportState() {
  const blob = new Blob(
    [JSON.stringify({ trips: state.trips, activeTripId: state.activeTripId }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'trips.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed?.trips)
        ? parsed.trips
        : parsed && parsed.id && Array.isArray(parsed.places)
        ? [parsed]
        : null;
      if (!incoming || incoming.length === 0) {
        alert('No trips found in this file.');
        return;
      }

      const tripIds = new Set(state.trips.map((t) => t.id));
      const placeIds = new Set(
        state.trips.flatMap((t) => t.places.map((p) => p.id))
      );

      const added = [];
      for (const raw of incoming) {
        if (!raw || !Array.isArray(raw.places)) continue;
        const trip = { ...raw };
        if (!trip.id || tripIds.has(trip.id)) trip.id = newId('t');
        tripIds.add(trip.id);
        trip.places = trip.places.map((p) => {
          const copy = { ...p };
          if (!copy.id || placeIds.has(copy.id)) copy.id = newId('p');
          placeIds.add(copy.id);
          return copy;
        });
        ensureTripFields(trip);
        state.trips.push(trip);
        added.push(trip);
      }

      if (added.length === 0) {
        alert('No valid trips found in this file.');
        return;
      }

      state.activeTripId = added[0].id;
      selectedPlaceId = null;
      expandedPlaceId = null;
      gapAction = null;
      lodgingEditPlaceId = null;
      saveState();
      if (!map) initMap();
      render();
    } catch (err) {
      console.error(err);
      alert('Could not import: ' + err.message);
    }
  });
  input.click();
}

async function reloadFromFile() {
  if (!confirm('Discard local changes and reload from trips.json?')) return;
  localStorage.removeItem(STORAGE_KEY);
  selectedPlaceId = null;
  expandedPlaceId = null;
  gapAction = null;
  lodgingEditPlaceId = null;
  await loadFromFile();
  if (state.trips.length === 0) {
    startOnboarding({ initial: true });
  } else {
    render();
  }
}

// ---------- State helpers ----------

function getActiveTrip() {
  return state.trips.find((t) => t.id === state.activeTripId) || null;
}

function newId(prefix = 'p') {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

function placeStillExists(placeId) {
  return state.trips.some((t) => t.places.some((p) => p.id === placeId));
}

function migratePhotosOnce() {
  const KEY = 'travel-planner-photo-migrated-v2';
  if (localStorage.getItem(KEY)) return;
  let changed = false;
  state.trips.forEach((t) => {
    if (!Array.isArray(t.places)) return;
    t.places.forEach((p) => {
      if (p.photoUrl != null) {
        p.photoUrl = null;
        changed = true;
      }
    });
  });
  localStorage.setItem(KEY, '1');
  if (changed) saveState();
}

function ensureTripFields(trip) {
  if (!trip.flights) trip.flights = {};
  if (!trip.flights.outbound) trip.flights.outbound = { number: '', booking: '' };
  if (!trip.flights.inbound) trip.flights.inbound = { number: '', booking: '' };
  if (!Array.isArray(trip.documents)) trip.documents = [];
  if (!Array.isArray(trip.packing)) trip.packing = [];
  if (!Array.isArray(trip.foods)) trip.foods = [];
  if (Array.isArray(trip.places)) {
    trip.places.forEach((p) => {
      if (!Array.isArray(p.activities)) p.activities = [];
    });
  }
}

// ---------- State mutations ----------

function deleteTrip(id) {
  if (!confirm('Delete this trip and all its places?')) return;
  state.trips = state.trips.filter((t) => t.id !== id);
  if (state.activeTripId === id) {
    state.activeTripId = state.trips[0]?.id ?? null;
  }
  saveState();
  render();
}

function setActiveTrip(id) {
  state.activeTripId = id;
  selectedPlaceId = null;
  expandedPlaceId = null;
  gapAction = null;
  lodgingEditPlaceId = null;
  saveState();
  render();
}

function updateTrip(updates) {
  const trip = getActiveTrip();
  if (!trip) return;
  Object.assign(trip, updates);
  saveState();
}

function addPlace(place) {
  const trip = getActiveTrip();
  if (!trip) return;
  trip.places.push(place);
  saveState();
  render();
}

function insertPlaceAt(index, place) {
  const trip = getActiveTrip();
  if (!trip) return;
  const i = Math.max(0, Math.min(index, trip.places.length));
  trip.places.splice(i, 0, place);
  gapAction = null;
  saveState();
  render();
}

function setTransport(placeId, transport) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  place.transportTo = transport;
  gapAction = null;
  saveState();
  render();
}

function clearTransport(placeId) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  delete place.transportTo;
  gapAction = null;
  saveState();
  render();
}

function updatePlace(placeId, updates) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  Object.assign(place, updates);
  saveState();
  render();
}

function deletePlace(placeId) {
  const trip = getActiveTrip();
  if (!trip) return;
  trip.places = trip.places.filter((p) => p.id !== placeId);
  if (selectedPlaceId === placeId) selectedPlaceId = null;
  if (expandedPlaceId === placeId) expandedPlaceId = null;
  if (lodgingEditPlaceId === placeId) lodgingEditPlaceId = null;
  saveState();
  render();
}

function setLodging(placeId, { url, name }) {
  if (!url || !url.trim()) return;
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  const trimmed = url.trim();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const trimmedName = (name || '').trim();
  place.lodging = trimmedName ? { url: normalized, name: trimmedName } : { url: normalized };
  lodgingEditPlaceId = null;
  saveState();
  render();
}

function clearLodging(placeId) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  delete place.lodging;
  if (lodgingEditPlaceId === placeId) lodgingEditPlaceId = null;
  saveState();
  render();
}

function addActivity(placeId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place) return;
  if (!Array.isArray(place.activities)) place.activities = [];
  place.activities.push({ id: newId('a'), text: trimmed, done: false });
  focusAfterRender = `[data-add-activity="${placeId}"]`;
  saveState();
  render();
}

function toggleActivity(placeId, activityId) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place || !Array.isArray(place.activities)) return;
  const a = place.activities.find((x) => x.id === activityId);
  if (!a) return;
  a.done = !a.done;
  saveState();
  render();
}

function removeActivity(placeId, activityId) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place || !Array.isArray(place.activities)) return;
  place.activities = place.activities.filter((x) => x.id !== activityId);
  saveState();
  render();
}

function setActivityLink(placeId, activityId, rawUrl) {
  const trip = getActiveTrip();
  if (!trip) return;
  const place = trip.places.find((p) => p.id === placeId);
  if (!place || !Array.isArray(place.activities)) return;
  const a = place.activities.find((x) => x.id === activityId);
  if (!a) return;
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    delete a.link;
  } else {
    a.link = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  saveState();
  render();
}

function addFood(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const trip = getActiveTrip();
  if (!trip) return;
  if (!Array.isArray(trip.foods)) trip.foods = [];
  trip.foods.push({ id: newId('f'), name: trimmed, imageUrl: null });
  foodSectionOpen = true;
  focusAfterRender = '[data-add-food]';
  saveState();
  render();
}

function removeFood(foodId) {
  const trip = getActiveTrip();
  if (!trip || !Array.isArray(trip.foods)) return;
  trip.foods = trip.foods.filter((f) => f.id !== foodId);
  saveState();
  render();
}

function setFoodLink(foodId, rawUrl) {
  const trip = getActiveTrip();
  if (!trip || !Array.isArray(trip.foods)) return;
  const food = trip.foods.find((f) => f.id === foodId);
  if (!food) return;
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    delete food.link;
  } else {
    food.link = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  saveState();
  render();
}

function addChecklistItem(key, name) {
  const trip = getActiveTrip();
  if (!trip) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  trip[key].push({ id: newId('c'), name: trimmed, checked: false });
  focusAfterRender = `[data-add-input="${key}"]`;
  saveState();
  render();
}

function toggleChecklistItem(key, id) {
  const trip = getActiveTrip();
  if (!trip) return;
  const item = trip[key].find((x) => x.id === id);
  if (!item) return;
  item.checked = !item.checked;
  saveState();
  render();
}

function removeChecklistItem(key, id) {
  const trip = getActiveTrip();
  if (!trip) return;
  trip[key] = trip[key].filter((x) => x.id !== id);
  saveState();
  render();
}

// ---------- External APIs ----------

async function geocode(query) {
  if (geocodeAbort) geocodeAbort.abort();
  geocodeAbort = new AbortController();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    query
  )}&format=json&limit=5&addressdetails=1`;
  const res = await fetch(url, {
    signal: geocodeAbort.signal,
    headers: { 'Accept-Language': navigator.language || 'en' },
  });
  if (!res.ok) throw new Error('geocode failed');
  return await res.json();
}

async function fetchPhoto(place) {
  if (typeof place.lat === 'number' && typeof place.lng === 'number') {
    const wd = await fetchWikidataImage(place.lat, place.lng);
    if (wd) return wd;
  }
  const title = place.name.split(',')[0].trim();
  return await fetchWikipediaImage(title);
}

async function fetchWikidataImage(lat, lng) {
  const sparql = `SELECT ?item ?image (COUNT(DISTINCT ?sitelink) AS ?fame) WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral.
    bd:serviceParam wikibase:radius "25".
  }
  ?item wdt:P18 ?image.
  ?sitelink schema:about ?item.
  ?sitelink schema:isPartOf [ wikibase:wikiGroup "wikipedia" ].
  FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q486972. }
  FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q56061. }
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q5. }
} GROUP BY ?item ?image ORDER BY DESC(?fame) LIMIT 1`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.results?.bindings?.[0]?.image?.value;
    if (!raw) return null;
    return raw.replace(/^http:/, 'https:') + '?width=400';
  } catch {
    return null;
  }
}

async function fetchWikipediaImage(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.thumbnail?.source || data.originalimage?.source || null;
  } catch {
    return null;
  }
}

// ---------- Rendering ----------

function render() {
  renderHeader();
  renderSidebar();
  updateMap();
  if (focusAfterRender) {
    const el = document.querySelector(focusAfterRender);
    if (el) el.focus();
    focusAfterRender = null;
  }
}

function renderHeader() {
  const sel = document.getElementById('trip-selector');
  sel.innerHTML = '';
  if (state.trips.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No trips yet';
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    for (const trip of state.trips) {
      const opt = document.createElement('option');
      opt.value = trip.id;
      opt.textContent = trip.name;
      if (trip.id === state.activeTripId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

function renderSidebar() {
  const root = document.getElementById('trip-detail');
  root.innerHTML = '';
  const trip = getActiveTrip();
  if (!trip) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No trip selected. Create one to start planning.';
    root.appendChild(empty);
    return;
  }

  root.appendChild(tripEditing ? renderTripEdit(trip) : renderTripDisplay(trip));

  root.appendChild(renderFlights(trip));

  // Add-place input
  const addRow = document.createElement('div');
  addRow.className = 'add-place-row';
  const placeInput = document.createElement('input');
  placeInput.type = 'text';
  placeInput.id = 'place-input';
  placeInput.placeholder = 'Add a place (city, landmark…)';
  placeInput.autocomplete = 'off';
  const dropdown = document.createElement('div');
  dropdown.className = 'suggestions';
  dropdown.hidden = true;
  addRow.append(placeInput, dropdown);
  root.appendChild(addRow);
  setupAddPlaceInput(addRow, placeInput, dropdown);

  // View toggle
  if (trip.places.length > 0) {
    root.appendChild(renderViewToggle());
  }

  // Places list / Days view
  const list = document.createElement('div');
  list.className = viewMode === 'days' ? 'days-list' : 'places-list';
  if (trip.places.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No places yet. Search above to add one.';
    list.appendChild(empty);
  } else if (viewMode === 'days') {
    trip.places.forEach((place, i) => {
      list.appendChild(renderDaySegment(trip, place, i));
    });
  } else {
    trip.places.forEach((place, i) => {
      list.appendChild(renderPlaceCard(place, i));
      if (i < trip.places.length - 1) {
        list.appendChild(renderPlaceGap(trip, i + 1));
      }
    });
  }
  root.appendChild(list);

  root.appendChild(
    renderChecklist(trip, 'documents', 'Documents & visa', 'e.g. Passport, ESTA, travel insurance…')
  );
  root.appendChild(
    renderChecklist(trip, 'packing', 'Packing list', 'e.g. Charger, sunscreen, adapter…')
  );
  root.appendChild(renderFoods(trip));

  const modal = renderLodgingModal();
  if (modal) root.appendChild(modal);
}

function renderFlights(trip) {
  const hasOutbound = !!trip.flights.outbound.number;
  const hasInbound = !!trip.flights.inbound.number;

  if (!hasOutbound && !hasInbound) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flights-empty';
    btn.innerHTML = `
      <span class="flights-empty-icon" aria-hidden="true">✈</span>
      <span class="flights-empty-text">
        <strong>Add your flights</strong>
        <small>Outbound and inbound flight numbers</small>
      </span>
      <span class="flights-empty-arrow" aria-hidden="true">→</span>
    `;
    btn.addEventListener('click', startFlightWizard);
    return btn;
  }

  const wrap = document.createElement('section');
  wrap.className = 'trip-section flights-section';

  const header = document.createElement('header');
  header.className = 'section-header';
  const title = document.createElement('h3');
  title.className = 'section-title';
  title.textContent = 'Flights';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'trip-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', startFlightWizard);
  header.append(title, editBtn);
  wrap.appendChild(header);

  wrap.appendChild(renderFlightDisplay('Outbound', trip.flights.outbound));
  wrap.appendChild(renderFlightDisplay('Inbound', trip.flights.inbound));

  return wrap;
}

function renderFlightDisplay(label, flight) {
  const row = document.createElement('div');
  row.className = 'flight-display' + (flight.number ? '' : ' empty');

  const dir = document.createElement('span');
  dir.className = 'flight-dir';
  dir.textContent = label;
  row.appendChild(dir);

  if (flight.number) {
    const num = document.createElement('span');
    num.className = 'flight-num';
    num.textContent = flight.number;
    row.appendChild(num);

    const ref = document.createElement('span');
    ref.className = 'flight-ref';
    ref.textContent = flight.booking ? `Ref ${flight.booking}` : '';
    row.appendChild(ref);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'flight-placeholder';
    placeholder.textContent = 'Not added';
    row.appendChild(placeholder);
  }

  return row;
}

function renderChecklist(trip, key, title, addPlaceholder) {
  const wrap = document.createElement('section');
  wrap.className = 'trip-section checklist-section';

  const heading = document.createElement('h3');
  heading.className = 'section-title';
  heading.textContent = title;
  wrap.appendChild(heading);

  const items = trip[key];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'checklist-empty';
    empty.textContent = 'Nothing yet.';
    wrap.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'checklist';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'checklist-item' + (item.checked ? ' checked' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.checked;
      cb.addEventListener('change', () => toggleChecklistItem(key, item.id));

      const name = document.createElement('span');
      name.className = 'checklist-name';
      name.textContent = item.name;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'checklist-remove';
      del.setAttribute('aria-label', `Remove ${item.name}`);
      del.textContent = '×';
      del.addEventListener('click', () => removeChecklistItem(key, item.id));

      li.append(cb, name, del);
      list.appendChild(li);
    });
    wrap.appendChild(list);
  }

  const form = document.createElement('form');
  form.className = 'checklist-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = addPlaceholder;
  input.dataset.addInput = key;
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'ghost';
  btn.textContent = '+ Add';
  form.append(input, btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addChecklistItem(key, input.value);
  });
  wrap.appendChild(form);

  return wrap;
}

function renderFoods(trip) {
  const foods = Array.isArray(trip.foods) ? trip.foods : [];
  const wrap = document.createElement('section');
  wrap.className = 'trip-section food-section';
  if (foodSectionOpen) wrap.classList.add('open');

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'food-header';
  header.setAttribute('aria-expanded', String(foodSectionOpen));

  const headLeft = document.createElement('span');
  headLeft.className = 'food-header-left';
  const titleEl = document.createElement('h3');
  titleEl.className = 'section-title';
  titleEl.textContent = 'Food & drinks';
  const count = document.createElement('span');
  count.className = 'food-count';
  count.textContent = foods.length ? String(foods.length) : '';
  headLeft.append(titleEl, count);

  const chev = svgIcon('M3 4.5l3 3 3-3', { className: 'food-chev', size: 14 });

  header.append(headLeft, chev);
  header.addEventListener('click', () => {
    foodSectionOpen = !foodSectionOpen;
    render();
  });
  wrap.appendChild(header);

  if (!foodSectionOpen) return wrap;

  const body = document.createElement('div');
  body.className = 'food-body';

  if (foods.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'food-empty';
    empty.textContent = 'No food picks yet — what should you taste on this trip?';
    body.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'food-list';
    foods.forEach((food) => list.appendChild(renderFoodItem(food)));
    body.appendChild(list);
  }

  const form = document.createElement('form');
  form.className = 'food-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add a dish, drink, or restaurant…';
  input.dataset.addFood = '1';
  input.autocomplete = 'off';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'food-add-btn';
  submit.textContent = 'Add';
  form.append(input, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    addFood(input.value);
    input.value = '';
  });
  body.appendChild(form);

  wrap.appendChild(body);
  return wrap;
}

function renderFoodItem(food) {
  const li = document.createElement('li');
  li.className = 'food-item';
  if (food.link) li.classList.add('has-link');
  li.dataset.foodId = food.id;

  const thumb = document.createElement('div');
  thumb.className = 'food-thumb';
  applyFoodImage(thumb, food);

  const info = document.createElement('div');
  info.className = 'food-info';
  const name = document.createElement('span');
  name.className = 'food-name';
  name.textContent = food.name;
  info.appendChild(name);
  if (food.link) {
    try {
      const u = new URL(food.link);
      const host = document.createElement('span');
      host.className = 'food-host';
      host.textContent = u.hostname.replace(/^www\./, '');
      info.appendChild(host);
    } catch {}
  }

  const actions = document.createElement('span');
  actions.className = 'food-actions';

  const linkEdit = document.createElement('button');
  linkEdit.type = 'button';
  linkEdit.className = 'food-link-edit';
  linkEdit.setAttribute('aria-label', food.link ? 'Edit link' : 'Add link');
  linkEdit.title = food.link ? 'Edit link' : 'Add link';
  linkEdit.appendChild(
    food.link
      ? svgIcon('M2 9l5-5 1 1-5 5H2zM6 4l1-1 1 1', { size: 12 })
      : svgIcon('M5.5 2v7M2 5.5h7', { size: 12, strokeWidth: 1.6 })
  );
  linkEdit.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = window.prompt(
      food.link ? 'Edit link (leave empty to remove):' : 'Add link (URL):',
      food.link || ''
    );
    if (next === null) return;
    setFoodLink(food.id, next);
  });
  actions.appendChild(linkEdit);

  if (food.link) {
    const open = document.createElement('a');
    open.href = food.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.className = 'food-link';
    open.title = food.link;
    open.setAttribute('aria-label', 'Open link in new tab');
    open.appendChild(svgIcon('M4 3h5v5M9 3L4 8M3 6v3h3', { size: 12 }));
    open.addEventListener('click', (e) => e.stopPropagation());
    actions.appendChild(open);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'food-del';
  del.setAttribute('aria-label', 'Remove food');
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Remove "${food.name}"?`)) removeFood(food.id);
  });
  actions.appendChild(del);

  li.append(thumb, info, actions);
  return li;
}

function renderTripDisplay(trip) {
  const wrap = document.createElement('div');
  wrap.className = 'trip-display';

  const text = document.createElement('div');
  text.className = 'trip-text';
  const title = document.createElement('h1');
  title.className = 'trip-title';
  title.textContent = trip.name;
  const dates = document.createElement('p');
  dates.className = 'trip-dates';
  dates.textContent = formatTripDates(trip.startDate, trip.endDate);
  text.append(title, dates);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'trip-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    tripEditing = true;
    render();
  });

  wrap.append(text, editBtn);
  return wrap;
}

function renderTripEdit(trip) {
  const form = document.createElement('div');
  form.className = 'trip-edit';

  const nameLbl = document.createElement('label');
  nameLbl.textContent = 'Trip name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.value = trip.name;
  nameLbl.appendChild(nameInput);

  const datesRow = document.createElement('div');
  datesRow.className = 'dates-row';
  const startLbl = document.createElement('label');
  startLbl.textContent = 'Start date';
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.value = trip.startDate || '';
  startLbl.appendChild(startInput);
  const endLbl = document.createElement('label');
  endLbl.textContent = 'End date';
  const endInput = document.createElement('input');
  endInput.type = 'date';
  endInput.value = trip.endDate || '';
  endLbl.appendChild(endInput);
  datesRow.append(startLbl, endLbl);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const left = document.createElement('div');
  left.className = 'left';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = 'Delete trip';
  left.appendChild(delBtn);
  const right = document.createElement('div');
  right.className = 'right';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';
  right.append(cancelBtn, saveBtn);
  actions.append(left, right);

  form.append(nameLbl, datesRow, actions);

  const save = () => {
    updateTrip({
      name: nameInput.value.trim() || 'Untitled',
      startDate: startInput.value,
      endDate: endInput.value,
    });
    tripEditing = false;
    render();
  };
  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', () => {
    tripEditing = false;
    render();
  });
  delBtn.addEventListener('click', () => {
    tripEditing = false;
    deleteTrip(trip.id);
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });

  return form;
}

function renderPlaceCard(place, idx) {
  const trip = getActiveTrip();
  const card = document.createElement('article');
  card.className = 'place-card';
  if (selectedPlaceId === place.id) card.classList.add('selected');
  if (expandedPlaceId === place.id && editingPlaceId !== place.id) {
    card.classList.add('expanded');
  }
  card.dataset.placeId = place.id;

  const row = document.createElement('div');
  row.className = 'place-row';
  row.addEventListener('click', (e) => {
    if (e.target.closest('.edit-btn')) return;
    if (e.target.closest('.activity-pill')) return;
    selectPlace(place.id);
  });

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  applyPhoto(thumb, place);

  const info = document.createElement('div');
  info.className = 'info';
  const nameRow = document.createElement('div');
  nameRow.className = 'name-row';
  const order = document.createElement('span');
  order.className = 'order';
  order.textContent = String(idx + 1);
  const name = document.createElement('h3');
  name.className = 'place-name';
  name.textContent = place.name;
  nameRow.append(order, name);
  const dates = document.createElement('p');
  dates.className = 'place-dates';
  dates.textContent = placeDisplayDates(place, trip, idx);
  info.append(nameRow, dates, renderActivityPill(place));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    editingPlaceId = place.id;
    render();
  });

  row.append(thumb, info, editBtn);
  card.appendChild(row);

  card.appendChild(renderLodgingSlot(place));

  if (editingPlaceId === place.id) {
    card.appendChild(renderPlaceEdit(place));
  } else if (expandedPlaceId === place.id) {
    card.appendChild(renderActivities(place));
  }

  return card;
}

function renderLodgingSlot(place) {
  if (place.lodging && place.lodging.url) {
    return renderLodgingFilled(place);
  }
  return renderLodgingEmpty(place);
}

function renderLodgingEmpty(place) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'place-lodging empty';
  btn.setAttribute('aria-label', `Add hotel for ${place.name}`);
  btn.innerHTML = `
    <span class="lodging-icon" aria-hidden="true">🏨</span>
    <span class="lodging-empty-text">Add hotel</span>
    <span class="lodging-empty-plus" aria-hidden="true">+</span>
  `;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openLodgingModal(place.id);
  });
  return btn;
}

function renderLodgingFilled(place) {
  const wrap = document.createElement('div');
  wrap.className = 'place-lodging filled';

  const link = document.createElement('a');
  link.href = place.lodging.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'lodging-link';
  link.title = place.lodging.url;

  const icon = document.createElement('span');
  icon.className = 'lodging-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🏨';

  const text = document.createElement('span');
  text.className = 'lodging-text';
  const nameEl = document.createElement('span');
  nameEl.className = 'lodging-name';
  let host = '';
  try { host = new URL(place.lodging.url).hostname.replace(/^www\./, ''); } catch {}
  nameEl.textContent = place.lodging.name || host || 'Hotel';
  text.appendChild(nameEl);
  if (place.lodging.name && host) {
    const hostEl = document.createElement('span');
    hostEl.className = 'lodging-host';
    hostEl.textContent = host;
    text.appendChild(hostEl);
  }

  const arrow = svgIcon('M4 3h5v5M9 3L4 8M3 6v3h3', { size: 12, className: 'lodging-arrow' });

  link.append(icon, text, arrow);
  link.addEventListener('click', (e) => e.stopPropagation());
  wrap.appendChild(link);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'lodging-edit';
  edit.setAttribute('aria-label', 'Edit hotel');
  edit.title = 'Edit hotel';
  edit.appendChild(svgIcon('M2 9l5-5 1 1-5 5H2zM6 4l1-1 1 1', { size: 12 }));
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openLodgingModal(place.id);
  });
  wrap.appendChild(edit);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'lodging-del';
  del.setAttribute('aria-label', 'Remove hotel');
  del.title = 'Remove hotel';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Remove hotel for ${place.name}?`)) clearLodging(place.id);
  });
  wrap.appendChild(del);

  return wrap;
}

function openLodgingModal(placeId) {
  lodgingEditPlaceId = placeId;
  focusAfterRender = '[data-lodging-url]';
  render();
}

function closeLodgingModal() {
  lodgingEditPlaceId = null;
  render();
}

function renderLodgingModal() {
  const trip = getActiveTrip();
  if (!trip) return null;
  const place = trip.places.find((p) => p.id === lodgingEditPlaceId);
  if (!place) return null;

  const backdrop = document.createElement('div');
  backdrop.className = 'lodging-modal-backdrop';
  backdrop.addEventListener('click', () => closeLodgingModal());

  const form = document.createElement('form');
  form.className = 'lodging-modal';
  form.addEventListener('click', (e) => e.stopPropagation());

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lodging-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => closeLodgingModal());

  const iconWrap = document.createElement('div');
  iconWrap.className = 'lodging-modal-icon';
  iconWrap.textContent = '🏨';

  const title = document.createElement('h2');
  title.className = 'lodging-modal-title';
  title.textContent = `Where are you staying in ${place.name}?`;

  const urlField = document.createElement('label');
  urlField.className = 'lodging-modal-field primary';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'https://…';
  urlInput.required = true;
  urlInput.dataset.lodgingUrl = '1';
  urlInput.autocomplete = 'off';
  urlInput.value = (place.lodging && place.lodging.url) || '';
  const urlHint = document.createElement('small');
  urlHint.textContent = 'Booking link, hotel site, or Google Maps';
  urlField.append(urlInput, urlHint);

  const nameField = document.createElement('label');
  nameField.className = 'lodging-modal-field';
  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'Name (optional)';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Hotel Artemide';
  nameInput.autocomplete = 'off';
  nameInput.value = (place.lodging && place.lodging.name) || '';
  nameField.append(nameLabel, nameInput);

  const actions = document.createElement('div');
  actions.className = 'lodging-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => closeLodgingModal());
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = 'Save';
  save.disabled = !urlInput.value.trim();
  actions.append(cancel, save);

  urlInput.addEventListener('input', () => {
    save.disabled = !urlInput.value.trim();
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (urlInput.value.trim()) nameInput.focus();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!urlInput.value.trim()) return;
    setLodging(place.id, { url: urlInput.value, name: nameInput.value });
  });

  form.append(closeBtn, iconWrap, title, urlField, nameField, actions);
  backdrop.appendChild(form);
  return backdrop;
}

function renderViewToggle() {
  const wrap = document.createElement('div');
  wrap.className = 'view-toggle';
  wrap.setAttribute('role', 'tablist');
  [
    { id: 'stops', label: 'Stops' },
    { id: 'days', label: 'Days' },
  ].forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-toggle-btn' + (viewMode === opt.id ? ' active' : '');
    btn.textContent = opt.label;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(viewMode === opt.id));
    btn.addEventListener('click', () => {
      if (viewMode === opt.id) return;
      viewMode = opt.id;
      render();
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function dayNumberOf(trip, isoDate) {
  if (!trip.startDate || !isoDate) return null;
  const start = new Date(trip.startDate);
  const target = new Date(isoDate);
  if (isNaN(start.getTime()) || isNaN(target.getTime())) return null;
  const days = Math.round((target - start) / 86400000);
  return days >= 0 ? days + 1 : null;
}

function computeDayRange(trip, place) {
  const startDay = dayNumberOf(trip, place.arrival);
  const endDay = dayNumberOf(trip, place.departure);
  if (startDay && endDay && endDay > startDay) return `Day ${startDay}–${endDay}`;
  if (startDay) return `Day ${startDay}`;
  return null;
}

function formatDayDateRange(start, end) {
  const fmt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const a = fmt(start);
  const b = fmt(end);
  if (a && b && a !== b) return `${a} → ${b}`;
  return a || b || '';
}

function renderDaySegment(trip, place, idx) {
  const card = document.createElement('article');
  card.className = 'day-segment';
  if (selectedPlaceId === place.id) card.classList.add('selected');
  card.dataset.placeId = place.id;
  card.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, textarea')) return;
    selectPlace(place.id);
  });

  // Header
  const header = document.createElement('header');
  header.className = 'day-segment-header';

  const dayRange = computeDayRange(trip, place);
  const dateLabel = formatDayDateRange(place.arrival, place.departure);

  const meta = document.createElement('div');
  meta.className = 'day-segment-meta';
  if (dayRange) {
    const pill = document.createElement('span');
    pill.className = 'day-pill';
    pill.textContent = dayRange;
    meta.appendChild(pill);
  }
  if (dateLabel) {
    const dateEl = document.createElement('span');
    dateEl.className = 'day-date';
    dateEl.textContent = dateLabel;
    meta.appendChild(dateEl);
  }
  if (!dayRange && !dateLabel) {
    const placeholder = document.createElement('span');
    placeholder.className = 'day-date';
    placeholder.textContent = 'Stop ' + (idx + 1);
    meta.appendChild(placeholder);
  }
  header.appendChild(meta);

  const placeRow = document.createElement('div');
  placeRow.className = 'day-place-row';
  const thumb = document.createElement('div');
  thumb.className = 'thumb day-thumb';
  applyPhoto(thumb, place);
  const name = document.createElement('h3');
  name.className = 'day-place-name';
  name.textContent = place.name;
  placeRow.append(thumb, name);
  header.appendChild(placeRow);

  card.appendChild(header);

  // Inbound transport
  if (idx > 0 && place.transportTo) {
    card.appendChild(renderDayTransport(place.transportTo));
  }

  // Lodging
  card.appendChild(renderLodgingSlot(place));

  // Activities (always expanded in day view; renderActivities handles empty state)
  card.appendChild(renderActivities(place));

  return card;
}

function renderDayTransport(transport) {
  const meta = transportModeMeta(transport.mode);
  const wrap = document.createElement('div');
  wrap.className = 'day-transport';

  const icon = document.createElement('span');
  icon.className = 'day-transport-icon';
  icon.textContent = meta.icon;

  const text = document.createElement('span');
  text.className = 'day-transport-text';
  const lead = document.createElement('span');
  lead.className = 'day-transport-lead';
  lead.textContent = 'Got here via';
  const detail = document.createElement('strong');
  detail.textContent = meta.label + (transport.duration ? ` · ${transport.duration}` : '');
  text.append(lead, detail);

  wrap.append(icon, text);

  if (transport.link) {
    const link = document.createElement('a');
    link.href = transport.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'day-transport-link';
    link.title = transport.link;
    link.appendChild(svgIcon('M4 3h5v5M9 3L4 8M3 6v3h3', { size: 12 }));
    link.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(link);
  }

  return wrap;
}

function renderActivityPill(place) {
  const activities = Array.isArray(place.activities) ? place.activities : [];
  const total = activities.length;
  const done = activities.filter((a) => a.done).length;
  const isExpanded = expandedPlaceId === place.id && editingPlaceId !== place.id;

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'activity-pill';
  if (total === 0) pill.classList.add('empty');
  else if (done === total) pill.classList.add('done');
  else if (done > 0) pill.classList.add('partial');
  if (isExpanded) pill.classList.add('open');
  pill.setAttribute('aria-expanded', String(isExpanded));

  const icon = document.createElement('span');
  icon.className = 'pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = total === 0 ? '+' : done === total ? '✓' : '◔';

  const label = document.createElement('span');
  label.className = 'pill-label';
  if (total === 0) {
    label.textContent = 'Add activities';
  } else {
    label.textContent = `${done}/${total} ${total === 1 ? 'activity' : 'activities'}`;
  }

  const chevron = svgIcon(
    'M3 4.5l3 3 3-3',
    { className: 'pill-chev', size: 12 }
  );

  pill.append(icon, label, chevron);

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (editingPlaceId === place.id) return;
    expandedPlaceId = expandedPlaceId === place.id ? null : place.id;
    if (expandedPlaceId === place.id && total === 0) {
      focusAfterRender = `[data-add-activity="${place.id}"]`;
    }
    render();
  });

  return pill;
}

function renderActivities(place) {
  const activities = Array.isArray(place.activities) ? place.activities : [];
  const wrap = document.createElement('div');
  wrap.className = 'activities';

  const header = document.createElement('div');
  header.className = 'activities-header';
  const title = document.createElement('span');
  title.className = 'activities-title';
  title.textContent = 'Activities';
  const count = document.createElement('span');
  count.className = 'activities-count';
  const done = activities.filter((a) => a.done).length;
  count.textContent = activities.length ? `${done}/${activities.length}` : '';
  header.append(title, count);
  wrap.appendChild(header);

  if (activities.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'activities-empty';
    empty.textContent = 'Nothing planned yet — add your first one below.';
    wrap.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'activity-list';
    activities.forEach((a) => list.appendChild(renderActivityItem(place, a)));
    wrap.appendChild(list);
  }

  const addRow = document.createElement('form');
  addRow.className = 'activity-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add an activity…';
  input.dataset.addActivity = place.id;
  input.autocomplete = 'off';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'activity-add-btn';
  submit.textContent = 'Add';
  addRow.append(input, submit);
  addRow.addEventListener('submit', (e) => {
    e.preventDefault();
    addActivity(place.id, input.value);
  });
  wrap.appendChild(addRow);

  return wrap;
}

function renderActivityItem(place, activity) {
  const li = document.createElement('li');
  li.className = 'activity-item';
  if (activity.done) li.classList.add('done');
  if (activity.link) li.classList.add('has-link');

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'activity-check';
  check.setAttribute('aria-label', activity.done ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', String(!!activity.done));
  check.textContent = activity.done ? '✓' : '';
  check.addEventListener('click', () => toggleActivity(place.id, activity.id));

  const text = document.createElement('span');
  text.className = 'activity-text';
  text.textContent = activity.text;
  text.addEventListener('click', () => toggleActivity(place.id, activity.id));

  const actions = document.createElement('span');
  actions.className = 'activity-actions';

  const linkEdit = document.createElement('button');
  linkEdit.type = 'button';
  linkEdit.className = 'activity-link-edit';
  linkEdit.setAttribute('aria-label', activity.link ? 'Edit link' : 'Add link');
  linkEdit.title = activity.link ? 'Edit link' : 'Add link';
  linkEdit.appendChild(
    activity.link
      ? svgIcon('M2 9l5-5 1 1-5 5H2zM6 4l1-1 1 1', { size: 12 })
      : svgIcon('M5.5 2v7M2 5.5h7', { size: 12, strokeWidth: 1.6 })
  );
  linkEdit.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = window.prompt(
      activity.link ? 'Edit link (leave empty to remove):' : 'Add link (URL):',
      activity.link || ''
    );
    if (next === null) return;
    setActivityLink(place.id, activity.id, next);
  });
  actions.appendChild(linkEdit);

  if (activity.link) {
    const open = document.createElement('a');
    open.href = activity.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.className = 'activity-link';
    open.title = activity.link;
    open.setAttribute('aria-label', 'Open link in new tab');
    open.appendChild(svgIcon('M4 3h5v5M9 3L4 8M3 6v3h3', { size: 12 }));
    open.addEventListener('click', (e) => e.stopPropagation());
    actions.appendChild(open);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'activity-del';
  del.setAttribute('aria-label', 'Remove activity');
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    removeActivity(place.id, activity.id);
  });
  actions.appendChild(del);

  li.append(check, text, actions);
  return li;
}

function svgIcon(path, { size = 12, strokeWidth = 1.5, className = '' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', String(strokeWidth));
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

const TRANSPORT_MODES = [
  { id: 'flight', label: 'Flight', icon: '✈' },
  { id: 'train', label: 'Train', icon: '🚆' },
  { id: 'bus', label: 'Bus', icon: '🚌' },
  { id: 'car', label: 'Car', icon: '🚗' },
  { id: 'ferry', label: 'Ferry', icon: '⛴' },
  { id: 'walk', label: 'Walk', icon: '🚶' },
  { id: 'bike', label: 'Bike', icon: '🚲' },
];

function transportModeMeta(modeId) {
  return TRANSPORT_MODES.find((m) => m.id === modeId) || TRANSPORT_MODES[0];
}

function renderPlaceGap(trip, index) {
  const nextPlace = trip.places[index];
  const transport = nextPlace && nextPlace.transportTo ? nextPlace.transportTo : null;
  const isActive = gapAction && gapAction.index === index;

  const gap = document.createElement('div');
  gap.className = 'place-gap';
  if (isActive) gap.classList.add('active');
  if (transport) gap.classList.add('has-transport');
  gap.dataset.gapIndex = String(index);

  if (isActive && gapAction.mode === 'place') {
    gap.appendChild(renderInlineAddPlace(index));
    return gap;
  }
  if (isActive && gapAction.mode === 'transport') {
    gap.appendChild(renderTransportForm(nextPlace, transport));
    return gap;
  }

  const left = document.createElement('span');
  left.className = 'gap-line';
  const right = document.createElement('span');
  right.className = 'gap-line';

  const center = document.createElement('div');
  center.className = 'gap-center';

  if (transport) {
    center.appendChild(renderTransportSummary(nextPlace, transport));
  }

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'gap-add';
  plus.setAttribute('aria-label', 'Add place or transport here');
  plus.title = 'Add place or transport';
  plus.appendChild(svgIcon('M6 2v8M2 6h8', { size: 12, strokeWidth: 1.8 }));
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    gapAction = isActive && gapAction.mode === 'menu' ? null : { index, mode: 'menu' };
    render();
  });
  center.appendChild(plus);

  if (isActive && gapAction.mode === 'menu') {
    center.appendChild(renderGapMenu(index, !!transport));
  }

  gap.append(left, center, right);
  return gap;
}

function renderGapMenu(index, hasTransport) {
  const menu = document.createElement('div');
  menu.className = 'gap-menu';
  menu.setAttribute('role', 'menu');

  const placeBtn = document.createElement('button');
  placeBtn.type = 'button';
  placeBtn.className = 'gap-menu-item';
  placeBtn.innerHTML =
    '<span class="gap-menu-icon" aria-hidden="true">📍</span>' +
    '<span class="gap-menu-text">' +
    '<strong>Add place here</strong>' +
    '<small>Insert a new stop at this position</small>' +
    '</span>';
  placeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gapAction = { index, mode: 'place' };
    focusAfterRender = `[data-gap-place-input="${index}"]`;
    render();
  });

  const transportBtn = document.createElement('button');
  transportBtn.type = 'button';
  transportBtn.className = 'gap-menu-item';
  transportBtn.innerHTML =
    '<span class="gap-menu-icon" aria-hidden="true">✈</span>' +
    '<span class="gap-menu-text">' +
    `<strong>${hasTransport ? 'Edit transport' : 'Add transport'}</strong>` +
    '<small>How you travel between these places</small>' +
    '</span>';
  transportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gapAction = { index, mode: 'transport' };
    render();
  });

  menu.append(placeBtn, transportBtn);
  return menu;
}

function renderTransportSummary(nextPlace, transport) {
  const meta = transportModeMeta(transport.mode);
  const wrap = document.createElement('div');
  wrap.className = 'transport-chip';

  const icon = document.createElement('span');
  icon.className = 'transport-icon';
  icon.textContent = meta.icon;

  const label = document.createElement('span');
  label.className = 'transport-label';
  const parts = [meta.label];
  if (transport.duration) parts.push(transport.duration);
  label.textContent = parts.join(' · ');

  wrap.append(icon, label);

  if (transport.link) {
    const open = document.createElement('a');
    open.href = transport.link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.className = 'transport-link';
    open.title = transport.link;
    open.setAttribute('aria-label', 'Open transport link');
    open.appendChild(svgIcon('M4 3h5v5M9 3L4 8M3 6v3h3', { size: 11 }));
    open.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(open);
  }

  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.transport-link')) return;
    gapAction = { index: getActiveTrip().places.indexOf(nextPlace), mode: 'transport' };
    render();
  });

  return wrap;
}

function renderTransportForm(nextPlace, current) {
  const form = document.createElement('form');
  form.className = 'transport-form';

  const draft = {
    mode: (current && current.mode) || 'flight',
    duration: (current && current.duration) || '',
    notes: (current && current.notes) || '',
    link: (current && current.link) || '',
  };

  const heading = document.createElement('div');
  heading.className = 'transport-form-heading';
  heading.textContent = current ? 'Edit transport' : 'Add transport';
  form.appendChild(heading);

  const modeRow = document.createElement('div');
  modeRow.className = 'transport-modes';
  TRANSPORT_MODES.forEach((m) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'transport-mode';
    if (draft.mode === m.id) chip.classList.add('active');
    chip.dataset.mode = m.id;
    chip.innerHTML = `<span class="transport-mode-icon">${m.icon}</span><span class="transport-mode-label">${m.label}</span>`;
    chip.addEventListener('click', () => {
      draft.mode = m.id;
      modeRow.querySelectorAll('.transport-mode').forEach((c) => {
        c.classList.toggle('active', c.dataset.mode === m.id);
      });
    });
    modeRow.appendChild(chip);
  });
  form.appendChild(modeRow);

  const fields = document.createElement('div');
  fields.className = 'transport-fields';

  const durLbl = document.createElement('label');
  durLbl.className = 'transport-field';
  durLbl.innerHTML = '<span>Duration</span>';
  const durInput = document.createElement('input');
  durInput.type = 'text';
  durInput.placeholder = 'e.g. 2h 30m';
  durInput.value = draft.duration;
  durLbl.appendChild(durInput);

  const linkLbl = document.createElement('label');
  linkLbl.className = 'transport-field';
  linkLbl.innerHTML = '<span>Link (booking, map…)</span>';
  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.placeholder = 'https://…';
  linkInput.value = draft.link;
  linkLbl.appendChild(linkInput);

  fields.append(durLbl, linkLbl);
  form.appendChild(fields);

  const notesLbl = document.createElement('label');
  notesLbl.className = 'transport-field full';
  notesLbl.innerHTML = '<span>Notes</span>';
  const notesInput = document.createElement('textarea');
  notesInput.rows = 2;
  notesInput.placeholder = 'Booking ref, departure terminal, anything useful…';
  notesInput.value = draft.notes;
  notesLbl.appendChild(notesInput);
  form.appendChild(notesLbl);

  const actions = document.createElement('div');
  actions.className = 'transport-actions';

  const left = document.createElement('div');
  left.className = 'transport-actions-left';
  if (current) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', () => clearTransport(nextPlace.id));
    left.appendChild(del);
  }

  const right = document.createElement('div');
  right.className = 'transport-actions-right';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    gapAction = null;
    render();
  });
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = 'Save';

  right.append(cancel, save);
  actions.append(left, right);
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const trimmedLink = linkInput.value.trim();
    const transport = {
      mode: draft.mode,
      duration: durInput.value.trim(),
      notes: notesInput.value.trim(),
      link: trimmedLink
        ? /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedLink)
          ? trimmedLink
          : `https://${trimmedLink}`
        : '',
    };
    setTransport(nextPlace.id, transport);
  });

  return form;
}

function renderInlineAddPlace(index) {
  const wrap = document.createElement('div');
  wrap.className = 'gap-place-add';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'add-place-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search a place to insert here…';
  input.autocomplete = 'off';
  input.dataset.gapPlaceInput = String(index);
  const dropdown = document.createElement('div');
  dropdown.className = 'suggestions';
  dropdown.hidden = true;
  inputWrap.append(input, dropdown);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'gap-cancel';
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.textContent = '×';
  cancel.addEventListener('click', () => {
    gapAction = null;
    render();
  });

  wrap.append(inputWrap, cancel);

  setupAddPlaceInput(inputWrap, input, dropdown, (place) => {
    insertPlaceAt(index, place);
  });

  return wrap;
}

function renderPlaceEdit(place) {
  const trip = getActiveTrip();
  const tripStart = trip && trip.startDate ? trip.startDate : '';
  const tripEnd = trip && trip.endDate ? trip.endDate : '';

  const form = document.createElement('div');
  form.className = 'place-edit';

  const hint = document.createElement('p');
  hint.className = 'place-edit-hint';
  if (tripStart && tripEnd) {
    hint.textContent = `Trip runs ${formatShort(tripStart)} – ${formatShort(tripEnd)}. Arrival and departure must fall within this range.`;
  } else {
    hint.classList.add('warn');
    hint.textContent = 'This trip has no start/end dates set. Add them first via Edit trip — otherwise place dates can drift out of range.';
  }
  form.appendChild(hint);

  const datesRow = document.createElement('div');
  datesRow.className = 'dates-row';
  const arrLbl = document.createElement('label');
  arrLbl.textContent = 'Arrival';
  const arrInput = document.createElement('input');
  arrInput.type = 'date';
  arrInput.value = place.arrival || '';
  if (tripStart) arrInput.min = tripStart;
  if (tripEnd) arrInput.max = tripEnd;
  arrLbl.appendChild(arrInput);
  const depLbl = document.createElement('label');
  depLbl.textContent = 'Departure';
  const depInput = document.createElement('input');
  depInput.type = 'date';
  depInput.value = place.departure || '';
  if (tripStart) depInput.min = tripStart;
  if (tripEnd) depInput.max = tripEnd;
  depLbl.appendChild(depInput);
  datesRow.append(arrLbl, depLbl);

  const errorEl = document.createElement('p');
  errorEl.className = 'place-edit-error';
  errorEl.hidden = true;
  errorEl.setAttribute('role', 'alert');

  const notesLbl = document.createElement('label');
  notesLbl.textContent = 'Notes';
  const notesInput = document.createElement('textarea');
  notesInput.rows = 3;
  notesInput.value = place.notes || '';
  notesLbl.appendChild(notesInput);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = 'Delete';
  const right = document.createElement('div');
  right.className = 'right';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save';
  right.append(cancelBtn, saveBtn);
  actions.append(delBtn, right);

  form.append(datesRow, errorEl, notesLbl, actions);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    arrInput.classList.toggle('invalid', /arrival/i.test(msg) || /both/i.test(msg) || /trip range/i.test(msg));
    depInput.classList.toggle('invalid', /departure/i.test(msg) || /both/i.test(msg) || /trip range/i.test(msg));
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
    arrInput.classList.remove('invalid');
    depInput.classList.remove('invalid');
  }
  arrInput.addEventListener('input', clearError);
  depInput.addEventListener('input', clearError);

  saveBtn.addEventListener('click', () => {
    const arr = arrInput.value;
    const dep = depInput.value;
    const err = validatePlaceDates(arr, dep, tripStart, tripEnd);
    if (err) {
      showError(err);
      return;
    }
    updatePlace(place.id, {
      arrival: arr,
      departure: dep,
      notes: notesInput.value,
    });
    editingPlaceId = null;
    render();
  });
  cancelBtn.addEventListener('click', () => {
    editingPlaceId = null;
    render();
  });
  delBtn.addEventListener('click', () => {
    if (confirm(`Delete ${place.name}?`)) {
      editingPlaceId = null;
      deletePlace(place.id);
    }
  });

  return form;
}

function validatePlaceDates(arrival, departure, tripStart, tripEnd) {
  if ((arrival || departure) && (!tripStart || !tripEnd)) {
    return 'Set the trip start and end dates first (Edit trip), then come back here.';
  }
  if (arrival && tripStart && arrival < tripStart) {
    return `Arrival ${formatShort(arrival)} is before the trip starts (${formatShort(tripStart)}).`;
  }
  if (arrival && tripEnd && arrival > tripEnd) {
    return `Arrival ${formatShort(arrival)} is after the trip ends (${formatShort(tripEnd)}).`;
  }
  if (departure && tripStart && departure < tripStart) {
    return `Departure ${formatShort(departure)} is before the trip starts (${formatShort(tripStart)}).`;
  }
  if (departure && tripEnd && departure > tripEnd) {
    return `Departure ${formatShort(departure)} is after the trip ends (${formatShort(tripEnd)}).`;
  }
  if (arrival && departure && departure < arrival) {
    return 'Departure cannot be before arrival.';
  }
  return null;
}

function applyPhoto(thumb, place) {
  thumb.innerHTML = '';
  thumb.classList.remove('loading');
  if (place.photoUrl) {
    const img = document.createElement('img');
    img.src = place.photoUrl;
    img.alt = place.name;
    img.loading = 'lazy';
    thumb.appendChild(img);
    return;
  }
  if (place.photoUrl === '') return;
  thumb.classList.add('loading');
  fetchPhoto(place).then((url) => {
    if (!placeStillExists(place.id)) return;
    place.photoUrl = url || '';
    saveState();
    const stillThumb = document.querySelector(
      `[data-place-id="${place.id}"] .thumb`
    );
    if (stillThumb) applyPhoto(stillThumb, place);
  });
}

function foodStillExists(foodId) {
  return state.trips.some(
    (t) => Array.isArray(t.foods) && t.foods.some((f) => f.id === foodId)
  );
}

function applyFoodImage(thumb, food) {
  thumb.innerHTML = '';
  thumb.classList.remove('loading');
  if (food.imageUrl) {
    const img = document.createElement('img');
    img.src = food.imageUrl;
    img.alt = food.name;
    img.loading = 'lazy';
    thumb.appendChild(img);
    return;
  }
  if (food.imageUrl === '') return;
  thumb.classList.add('loading');
  fetchWikipediaImage(food.name).then((url) => {
    if (!foodStillExists(food.id)) return;
    food.imageUrl = url || '';
    saveState();
    const stillThumb = document.querySelector(
      `[data-food-id="${food.id}"] .food-thumb`
    );
    if (stillThumb) applyFoodImage(stillThumb, food);
  });
}

function formatDateRange(a, b) {
  if (!a && !b) return '';
  if (a && b) return `${formatShort(a)} – ${formatShort(b)}`;
  return formatShort(a || b);
}

function formatTripDates(start, end) {
  if (!start && !end) return 'Dates not set';
  const longFmt = (iso) => {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
  };
  if (start && end) return `${formatShort(start)} – ${longFmt(end)}`;
  if (start) return `From ${longFmt(start)}`;
  return `Until ${longFmt(end)}`;
}

function formatShort(input) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function placeDisplayDates(place, trip, idx) {
  if (place.arrival && place.departure) {
    return `${formatShort(place.arrival)} – ${formatShort(place.departure)}`;
  }
  if (place.arrival || place.departure) {
    return formatShort(place.arrival || place.departure);
  }
  if (trip && trip.startDate && trip.endDate && trip.places.length > 0) {
    const start = new Date(trip.startDate);
    const end = new Date(trip.endDate);
    const totalMs = end - start;
    if (totalMs > 0) {
      const slot = totalMs / trip.places.length;
      const a = new Date(start.getTime() + idx * slot);
      const b = new Date(start.getTime() + (idx + 1) * slot);
      return `${formatShort(a)} – ${formatShort(b)}`;
    }
  }
  return 'Dates TBD';
}

// ---------- Add-place input + autocomplete ----------

function setupAddPlaceInput(container, input, dropdown, onPick) {
  let debounceTimer = null;
  let lastResults = [];

  function hide() {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
  }

  function show(results) {
    lastResults = results;
    dropdown.innerHTML = '';
    if (!results.length) {
      hide();
      return;
    }
    for (const r of results.slice(0, 5)) {
      const div = document.createElement('div');
      div.className = 'suggestion';
      div.textContent = r.display_name;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickResult(r);
      });
      dropdown.appendChild(div);
    }
    dropdown.hidden = false;
  }

  function pickResult(r) {
    const place = {
      id: newId('p'),
      name: r.display_name.split(',')[0].trim(),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      arrival: '',
      departure: '',
      notes: '',
      photoUrl: null,
    };
    if (typeof onPick === 'function') onPick(place);
    else addPlace(place);
    input.value = '';
    hide();
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      hide();
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const results = await geocode(q);
        show(results);
      } catch (e) {
        if (e.name !== 'AbortError') console.warn(e);
      }
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (lastResults[0]) pickResult(lastResults[0]);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) hide();
  });
}

// ---------- Map ----------

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function updateMap() {
  if (!map) return;
  markersLayer.clearLayers();
  if (polylineLayer) {
    map.removeLayer(polylineLayer);
    polylineLayer = null;
  }
  if (arrowsLayer) {
    map.removeLayer(arrowsLayer);
    arrowsLayer = null;
  }
  placeMarkers = {};

  const trip = getActiveTrip();
  if (!trip || trip.places.length === 0) return;

  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim() || '#fb8f67';

  const latlngs = [];
  trip.places.forEach((place, i) => {
    const icon = L.divIcon({
      className: 'map-pin' + (place.id === selectedPlaceId ? ' selected' : ''),
      html: `<div class="pin-inner">${i + 1}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([place.lat, place.lng], { icon }).addTo(markersLayer);
    m.bindPopup(`<strong>${escapeHtml(place.name)}</strong>`);
    m.on('click', () => selectPlace(place.id, { scrollCard: true }));
    placeMarkers[place.id] = m;
    latlngs.push([place.lat, place.lng]);
  });

  if (latlngs.length >= 2) {
    polylineLayer = L.polyline(latlngs, {
      color: accent,
      weight: 3,
      opacity: 0.85,
    }).addTo(map);

    if (typeof L.polylineDecorator === 'function') {
      arrowsLayer = L.layerGroup().addTo(map);
      for (let i = 0; i < latlngs.length - 1; i++) {
        const seg = L.polyline([latlngs[i], latlngs[i + 1]]);
        L.polylineDecorator(seg, {
          patterns: [
            {
              offset: '50%',
              repeat: 0,
              symbol: L.Symbol.arrowHead({
                pixelSize: 14,
                polygon: true,
                pathOptions: {
                  stroke: false,
                  color: accent,
                  fillOpacity: 0.95,
                },
              }),
            },
          ],
        }).addTo(arrowsLayer);
      }
    }
  }

  if (latlngs.length === 1) {
    map.setView(latlngs[0], 10);
  } else {
    map.fitBounds(latlngs, { padding: [50, 50] });
  }
}

function selectPlace(placeId, { scrollCard = false } = {}) {
  selectedPlaceId = selectedPlaceId === placeId ? null : placeId;

  Object.entries(placeMarkers).forEach(([id, marker]) => {
    const el = marker.getElement();
    if (el) el.classList.toggle('selected', id === selectedPlaceId);
  });
  document.querySelectorAll('.place-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.placeId === selectedPlaceId);
  });

  if (selectedPlaceId && map) {
    const trip = getActiveTrip();
    const place = trip && trip.places.find((p) => p.id === selectedPlaceId);
    if (place) {
      map.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 8), {
        duration: 0.6,
      });
    }
    if (scrollCard) {
      const card = document.querySelector(
        `.place-card[data-place-id="${selectedPlaceId}"]`
      );
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Theme ----------

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
  updateThemeButton();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  let next;
  if (current === 'light') next = 'dark';
  else if (current === 'dark') next = 'light';
  else {
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    next = prefersDark ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  updateThemeButton();
  updateMap();
}

function updateThemeButton() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const current = document.documentElement.getAttribute('data-theme');
  const isDark =
    current === 'dark' ||
    (!current && matchMedia('(prefers-color-scheme: dark)').matches);
  btn.textContent = isDark ? '☀️' : '🌙';
}

// ---------- Onboarding (Typeform-style) ----------

let onboardingRoot = null;
let onboardingDraft = null;
let onboardingStep = 0;
let onboardingScreens = [];
let onboardingTotalSteps = 0;
let onComplete = null;
let onCancel = null;

function startOnboarding({ initial = false } = {}) {
  onboardingDraft = {
    id: newId('t'),
    name: '',
    startDate: '',
    endDate: '',
    places: [],
  };
  onboardingStep = 0;
  onboardingScreens = [renderNameScreen, renderDatesScreen, renderPlacesScreen];
  onboardingTotalSteps = onboardingScreens.length;

  onComplete = () => {
    ensureTripFields(onboardingDraft);
    state.trips.push(onboardingDraft);
    state.activeTripId = onboardingDraft.id;
    saveState();
    teardownOnboarding();
    enterApp();
  };
  onCancel = initial ? null : teardownOnboarding;

  buildOnboardingShell();
  document.body.classList.add('onboarding-active');
  goToStep(0, 'forward');
}

function teardownOnboarding() {
  document.body.classList.remove('onboarding-active');
  if (onboardingRoot) {
    onboardingRoot.remove();
    onboardingRoot = null;
  }
  onboardingDraft = null;
}

function buildOnboardingShell() {
  if (onboardingRoot) onboardingRoot.remove();
  onboardingRoot = document.createElement('div');
  onboardingRoot.className = 'onboarding';

  const progress = document.createElement('div');
  progress.className = 'onboarding-progress';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  progress.appendChild(fill);

  const topbar = document.createElement('div');
  topbar.className = 'onboarding-topbar';
  const back = document.createElement('button');
  back.className = 'back';
  back.type = 'button';
  back.textContent = '← Back';
  back.hidden = true;
  back.addEventListener('click', () => {
    if (onboardingStep > 0) goToStep(onboardingStep - 1, 'back');
  });
  topbar.appendChild(back);
  if (onCancel) {
    const cancel = document.createElement('button');
    cancel.className = 'cancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => onCancel());
    topbar.appendChild(cancel);
  } else {
    const spacer = document.createElement('span');
    topbar.appendChild(spacer);
  }

  const body = document.createElement('div');
  body.className = 'onboarding-body';

  onboardingRoot.append(progress, topbar, body);
  document.body.appendChild(onboardingRoot);
}

function goToStep(step, direction) {
  onboardingStep = step;
  const fill = onboardingRoot.querySelector('.progress-fill');
  fill.style.width = `${((step + 1) / onboardingTotalSteps) * 100}%`;
  onboardingRoot.querySelector('.back').hidden = step === 0;

  const body = onboardingRoot.querySelector('.onboarding-body');
  const old = body.firstElementChild;
  if (old) {
    old.classList.add(direction === 'back' ? 'exiting-right' : 'exiting');
    setTimeout(() => old.remove(), 260);
  }

  const screen = onboardingScreens[step]();

  if (direction === 'back') screen.classList.add('entering-back');
  body.appendChild(screen);
  requestAnimationFrame(() => {
    screen.classList.add('active');
  });
  setTimeout(() => {
    const focusable = screen.querySelector('input');
    if (focusable) focusable.focus();
  }, 280);
}

function renderNameScreen() {
  const el = document.createElement('div');
  el.className = 'screen';

  const tag = document.createElement('p');
  tag.className = 'step-tag';
  tag.textContent = 'Step 1 of 3';

  const h2 = document.createElement('h2');
  h2.textContent = "What's your trip called?";

  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = "Give it a name you'll recognize later.";

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g. Italy 2026';
  input.value = onboardingDraft.name;

  const actions = document.createElement('div');
  actions.className = 'screen-actions';
  const cont = document.createElement('button');
  cont.className = 'primary continue';
  cont.type = 'button';
  cont.textContent = 'Continue →';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.innerHTML = 'press <kbd>Enter ↵</kbd>';
  actions.append(cont, hint);

  el.append(tag, h2, sub, input, actions);

  const refresh = () => {
    cont.disabled = !input.value.trim();
  };
  refresh();
  const advance = () => {
    const v = input.value.trim();
    if (!v) return;
    onboardingDraft.name = v;
    goToStep(1, 'forward');
  };
  input.addEventListener('input', refresh);
  cont.addEventListener('click', advance);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      advance();
    }
  });

  return el;
}

function renderDatesScreen() {
  const el = document.createElement('div');
  el.className = 'screen';

  const tag = document.createElement('p');
  tag.className = 'step-tag';
  tag.textContent = 'Step 2 of 3';

  const h2 = document.createElement('h2');
  h2.textContent = 'When are you traveling?';

  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = 'Approximate dates are fine — you can change them later.';

  const grid = document.createElement('div');
  grid.className = 'dates-grid';
  const startLbl = document.createElement('label');
  startLbl.textContent = 'Start date';
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startInput.value = onboardingDraft.startDate || '';
  startLbl.appendChild(startInput);
  const endLbl = document.createElement('label');
  endLbl.textContent = 'End date';
  const endInput = document.createElement('input');
  endInput.type = 'date';
  endInput.value = onboardingDraft.endDate || '';
  endLbl.appendChild(endInput);
  grid.append(startLbl, endLbl);

  const actions = document.createElement('div');
  actions.className = 'screen-actions';
  const cont = document.createElement('button');
  cont.className = 'primary continue';
  cont.type = 'button';
  cont.textContent = 'Continue →';
  const skip = document.createElement('button');
  skip.className = 'ghost';
  skip.type = 'button';
  skip.textContent = 'Skip';
  actions.append(cont, skip);

  el.append(tag, h2, sub, grid, actions);

  const advance = () => {
    onboardingDraft.startDate = startInput.value;
    onboardingDraft.endDate = endInput.value;
    goToStep(2, 'forward');
  };
  cont.addEventListener('click', advance);
  skip.addEventListener('click', () => {
    onboardingDraft.startDate = '';
    onboardingDraft.endDate = '';
    goToStep(2, 'forward');
  });
  [startInput, endInput].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        advance();
      }
    });
  });

  return el;
}

function renderPlacesScreen() {
  const el = document.createElement('div');
  el.className = 'screen';

  const tag = document.createElement('p');
  tag.className = 'step-tag';
  tag.textContent = 'Step 3 of 3';

  const h2 = document.createElement('h2');
  h2.textContent = 'Where do you want to go?';

  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = 'Add cities, towns or landmarks. You can refine later.';

  const addRow = document.createElement('div');
  addRow.className = 'add-place-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a place…';
  input.autocomplete = 'off';
  const dropdown = document.createElement('div');
  dropdown.className = 'suggestions';
  dropdown.hidden = true;
  addRow.append(input, dropdown);

  const list = document.createElement('ul');
  list.className = 'onboarding-places';

  const actions = document.createElement('div');
  actions.className = 'screen-actions';
  const done = document.createElement('button');
  done.className = 'primary done';
  done.type = 'button';
  done.textContent = 'Finish ✓';
  const count = document.createElement('span');
  count.className = 'hint';
  actions.append(done, count);

  el.append(tag, h2, sub, addRow, list, actions);

  const renderList = () => {
    list.innerHTML = '';
    onboardingDraft.places.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'onboarding-place';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${p.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        onboardingDraft.places.splice(i, 1);
        renderList();
      });
      li.append(num, name, remove);
      list.appendChild(li);
    });
    const n = onboardingDraft.places.length;
    count.textContent = n
      ? `${n} place${n > 1 ? 's' : ''} added`
      : 'or finish and add later';
  };
  renderList();

  let debounceTimer = null;
  let lastResults = [];
  const hide = () => {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
  };
  const show = (results) => {
    lastResults = results;
    dropdown.innerHTML = '';
    if (!results.length) {
      hide();
      return;
    }
    for (const r of results.slice(0, 5)) {
      const div = document.createElement('div');
      div.className = 'suggestion';
      div.textContent = r.display_name;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickResult(r);
      });
      dropdown.appendChild(div);
    }
    dropdown.hidden = false;
  };
  const pickResult = (r) => {
    onboardingDraft.places.push({
      id: newId('p'),
      name: r.display_name.split(',')[0].trim(),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      arrival: '',
      departure: '',
      notes: '',
      photoUrl: null,
    });
    input.value = '';
    hide();
    renderList();
    input.focus();
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      hide();
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const results = await geocode(q);
        show(results);
      } catch (e) {
        if (e.name !== 'AbortError') console.warn(e);
      }
    }, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (lastResults[0]) pickResult(lastResults[0]);
      else if (!input.value.trim()) onComplete();
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  done.addEventListener('click', () => onComplete());

  return el;
}

// ---------- Flight wizard ----------

function startFlightWizard() {
  const trip = getActiveTrip();
  if (!trip) return;

  onboardingDraft = {
    outbound: { ...trip.flights.outbound },
    inbound: { ...trip.flights.inbound },
  };
  onboardingStep = 0;
  onboardingScreens = [renderFlightOutScreen, renderFlightInScreen];
  onboardingTotalSteps = onboardingScreens.length;

  onComplete = () => {
    const t = getActiveTrip();
    if (t) {
      t.flights.outbound = { ...onboardingDraft.outbound };
      t.flights.inbound = { ...onboardingDraft.inbound };
      saveState();
    }
    teardownOnboarding();
    render();
  };
  onCancel = teardownOnboarding;

  buildOnboardingShell();
  document.body.classList.add('onboarding-active');
  goToStep(0, 'forward');
}

function renderFlightOutScreen() {
  return renderFlightStep({
    direction: 'outbound',
    title: "What's your outbound flight?",
    subtitle: 'Add the flight number and booking reference.',
    isLast: false,
  });
}

function renderFlightInScreen() {
  return renderFlightStep({
    direction: 'inbound',
    title: 'And the return flight?',
    subtitle: 'Skip if your trip is one-way.',
    isLast: true,
  });
}

function renderFlightStep({ direction, title, subtitle, isLast }) {
  const el = document.createElement('div');
  el.className = 'screen';

  const tag = document.createElement('p');
  tag.className = 'step-tag';
  tag.textContent = `Step ${onboardingStep + 1} of ${onboardingTotalSteps}`;

  const h2 = document.createElement('h2');
  h2.textContent = title;

  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = subtitle;

  const grid = document.createElement('div');
  grid.className = 'dates-grid';

  const numLbl = document.createElement('label');
  numLbl.textContent = 'Flight number';
  const numInput = document.createElement('input');
  numInput.type = 'text';
  numInput.placeholder = 'e.g. AF1234';
  numInput.value = onboardingDraft[direction].number || '';
  numInput.autocomplete = 'off';
  numLbl.appendChild(numInput);

  const refLbl = document.createElement('label');
  refLbl.textContent = 'Booking reference';
  const refInput = document.createElement('input');
  refInput.type = 'text';
  refInput.placeholder = 'e.g. ABC123';
  refInput.value = onboardingDraft[direction].booking || '';
  refInput.autocomplete = 'off';
  refLbl.appendChild(refInput);

  grid.append(numLbl, refLbl);

  const actions = document.createElement('div');
  actions.className = 'screen-actions';
  const cont = document.createElement('button');
  cont.className = 'primary continue';
  cont.type = 'button';
  cont.textContent = isLast ? 'Save ✓' : 'Continue →';
  const skip = document.createElement('button');
  skip.className = 'ghost';
  skip.type = 'button';
  skip.textContent = 'Skip';
  actions.append(cont, skip);

  el.append(tag, h2, sub, grid, actions);

  const advance = () => {
    onboardingDraft[direction].number = numInput.value.trim();
    onboardingDraft[direction].booking = refInput.value.trim();
    if (isLast) onComplete();
    else goToStep(onboardingStep + 1, 'forward');
  };
  const skipFn = () => {
    onboardingDraft[direction].number = '';
    onboardingDraft[direction].booking = '';
    if (isLast) onComplete();
    else goToStep(onboardingStep + 1, 'forward');
  };

  cont.addEventListener('click', advance);
  skip.addEventListener('click', skipFn);
  [numInput, refInput].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        advance();
      }
    });
  });

  return el;
}

// ---------- Boot ----------

async function init() {
  initTheme();
  await loadState();
  migratePhotosOnce();
  bindGlobalEvents();
  if (state.trips.length === 0) {
    startOnboarding({ initial: true });
  } else {
    initMap();
    render();
  }
}

function enterApp() {
  if (!map) initMap();
  render();
  if (map) setTimeout(() => map.invalidateSize(), 60);
}

function bindGlobalEvents() {
  document.getElementById('trip-selector').addEventListener('change', (e) => {
    if (e.target.value) setActiveTrip(e.target.value);
  });
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('import-btn').addEventListener('click', importFromFile);
  document.getElementById('export-btn').addEventListener('click', exportState);
  document.getElementById('reload-btn').addEventListener('click', reloadFromFile);
  document.getElementById('new-trip-btn').addEventListener('click', () => {
    startOnboarding({ initial: false });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lodgingEditPlaceId) closeLodgingModal();
  });
}

document.addEventListener('DOMContentLoaded', init);
