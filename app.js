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

  // Places list
  const list = document.createElement('div');
  list.className = 'places-list';
  if (trip.places.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No places yet. Search above to add one.';
    list.appendChild(empty);
  } else {
    trip.places.forEach((place, i) => {
      list.appendChild(renderPlaceCard(place, i));
    });
  }
  root.appendChild(list);

  root.appendChild(
    renderChecklist(trip, 'documents', 'Documents & visa', 'e.g. Passport, ESTA, travel insurance…')
  );
  root.appendChild(
    renderChecklist(trip, 'packing', 'Packing list', 'e.g. Charger, sunscreen, adapter…')
  );
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
  card.dataset.placeId = place.id;

  const row = document.createElement('div');
  row.className = 'place-row';
  row.addEventListener('click', (e) => {
    if (e.target.closest('.edit-btn')) return;
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
  info.append(nameRow, dates);

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

  if (editingPlaceId === place.id) {
    card.appendChild(renderPlaceEdit(place));
  }

  return card;
}

function renderPlaceEdit(place) {
  const form = document.createElement('div');
  form.className = 'place-edit';

  const datesRow = document.createElement('div');
  datesRow.className = 'dates-row';
  const arrLbl = document.createElement('label');
  arrLbl.textContent = 'Arrival';
  const arrInput = document.createElement('input');
  arrInput.type = 'date';
  arrInput.value = place.arrival || '';
  arrLbl.appendChild(arrInput);
  const depLbl = document.createElement('label');
  depLbl.textContent = 'Departure';
  const depInput = document.createElement('input');
  depInput.type = 'date';
  depInput.value = place.departure || '';
  depLbl.appendChild(depInput);
  datesRow.append(arrLbl, depLbl);

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

  form.append(datesRow, notesLbl, actions);

  saveBtn.addEventListener('click', () => {
    updatePlace(place.id, {
      arrival: arrInput.value,
      departure: depInput.value,
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

function setupAddPlaceInput(container, input, dropdown) {
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
    addPlace(place);
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
}

document.addEventListener('DOMContentLoaded', init);
