const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([48.2082, 16.3738], 12);
const serviceConfig = window.MOPEDROUTE_CONFIG || {
  publicApis: false,
  geocoderBase: 'https://nominatim.openstreetmap.org',
  routerUrl: 'https://valhalla1.openstreetmap.de/route'
};
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>'
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const fields = {
  start: { input: document.querySelector('#start-input'), suggestions: document.querySelector('#start-suggestions'), point: null, marker: null },
  destination: { input: document.querySelector('#destination-input'), suggestions: document.querySelector('#destination-suggestions'), point: null, marker: null }
};
const state = { picking: 'start', routeLayer: null, routeResult: null, requestId: 0 };
const geocodeCache = new Map();
const routeCache = new Map();
let geocodeQueue = Promise.resolve();
let lastGeocodeRequestAt = 0;

const planner = document.querySelector('#planner');
const routeButton = document.querySelector('#route-button');
const routeResult = document.querySelector('#route-result');
const notice = document.querySelector('#notice');
const mapHint = document.querySelector('#map-hint');
const topSpeedInput = document.querySelector('#top-speed');
const avoidHighwaysInput = document.querySelector('#avoid-highways');

function updatePreferenceLabels() {
  const speed = Math.min(80, Math.max(30, Number(topSpeedInput.value) || 45));
  document.querySelector('#speed-chip-value').textContent = `${speed} km/h`;
  document.querySelector('#options-summary-value').textContent = `${speed} km/h · ${avoidHighwaysInput.checked ? 'Autobahnen meiden' : 'freie Streckenwahl'}`;
}

topSpeedInput.addEventListener('input', updatePreferenceLabels);
avoidHighwaysInput.addEventListener('change', updatePreferenceLabels);
updatePreferenceLabels();

function iconFor(kind) {
  const label = kind === 'start' ? 'A' : 'B';
  const className = kind === 'start' ? 'pin-start' : 'pin-end';
  return L.divIcon({
    className: 'custom-pin-wrap',
    html: `<div class="custom-pin ${className}"><span>${label}</span></div>`,
    iconSize: [34, 40],
    iconAnchor: [17, 39]
  });
}

function setNotice(message, type = '') {
  notice.textContent = message;
  notice.className = `notice ${type}`.trim();
  notice.hidden = !message;
}

function setPickMode(kind) {
  state.picking = kind;
  document.querySelectorAll('[data-pick]').forEach((button) => {
    const active = button.dataset.pick === kind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  mapHint.textContent = kind === 'start' ? 'Tippe auf die Karte, um den Start zu setzen' : 'Tippe auf die Karte, um das Ziel zu setzen';
  mapHint.classList.remove('is-hidden');
}

function mapPadding() {
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  return {
    paddingTopLeft: [mobile ? 28 : 430, 48],
    paddingBottomRight: [36, mobile ? planner.clientHeight + 22 : 48],
    maxZoom: mobile ? 14 : 15
  };
}

function setPlace(kind, place) {
  const field = fields[kind];
  field.point = { lat: Number(place.lat), lon: Number(place.lon), label: place.name || place.label || 'Kartenpunkt' };
  field.input.value = place.name || place.label || 'Kartenpunkt';
  field.suggestions.hidden = true;
  field.suggestions.replaceChildren();
  if (field.marker) map.removeLayer(field.marker);
  field.marker = L.marker([field.point.lat, field.point.lon], { icon: iconFor(kind), keyboard: true, title: kind === 'start' ? 'Start' : 'Ziel' }).addTo(map);
  field.marker.bindTooltip(kind === 'start' ? 'Start' : 'Ziel', { direction: 'top', offset: [0, -30] });
  state.routeResult = null;
  routeResult.hidden = true;
  planner.classList.remove('panel-route-ready');
  if (state.routeLayer) {
    map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  setNotice('');
  setPickMode(kind === 'start' ? 'destination' : 'start');
  if (fields.start.point && fields.destination.point) {
    map.fitBounds(L.latLngBounds([[fields.start.point.lat, fields.start.point.lon], [fields.destination.point.lat, fields.destination.point.lon]]), mapPadding());
  } else {
    map.setView([field.point.lat, field.point.lon], Math.max(map.getZoom(), 14));
  }
}

map.on('click', (event) => {
  if (state.picking === 'parking') {
    saveParkingLocation(event.latlng.lat, event.latlng.lng);
    state.picking = 'start';
    mapHint.classList.add('is-hidden');
    return;
  }
  if (document.querySelector('.screen.active')?.dataset.screen !== 'route') return;
  setPlace(state.picking, { lat: event.latlng.lat, lon: event.latlng.lng, name: 'Punkt auf der Karte' });
});

async function searchPlace(kind) {
  const field = fields[kind];
  const query = field.input.value.trim();
  if (query.length < 2) {
    setNotice('Bitte gib einen Ort oder eine Adresse ein.');
    field.input.focus();
    return;
  }
  setNotice(`${kind === 'start' ? 'Start' : 'Ziel'} wird gesucht …`);
  field.suggestions.hidden = true;
  try {
    const results = await findPlaces(query);
    if (!results.length) {
      setNotice('Dazu wurde kein Ort gefunden. Prüfe die Schreibweise oder wähle einen Punkt auf der Karte.', 'error');
      return;
    }
    field.suggestions.replaceChildren();
    results.forEach((place) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'suggestion';
      const title = document.createElement('strong');
      title.textContent = place.name;
      const subtitle = document.createElement('small');
      subtitle.textContent = place.label;
      button.append(title, subtitle);
      button.addEventListener('click', () => setPlace(kind, place));
      field.suggestions.append(button);
    });
    field.suggestions.hidden = false;
    setNotice(results.length > 1 ? 'Wähle den passenden Treffer aus.' : 'Treffer gefunden — bitte auswählen.');
  } catch (error) {
    setNotice(error.message || 'Die Adresssuche ist fehlgeschlagen.', 'error');
  }
}

function findPlaces(query) {
  const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
  if (geocodeCache.has(normalized)) return Promise.resolve(geocodeCache.get(normalized));

  const request = geocodeQueue.then(async () => {
    if (geocodeCache.has(normalized)) return geocodeCache.get(normalized);
    const elapsed = Date.now() - lastGeocodeRequestAt;
    if (elapsed < 1100) await new Promise((resolve) => window.setTimeout(resolve, 1100 - elapsed));
    lastGeocodeRequestAt = Date.now();

    let endpoint;
    if (serviceConfig.publicApis) {
      endpoint = new URL('search', `${serviceConfig.geocoderBase.replace(/\/+$/, '')}/`);
      endpoint.searchParams.set('format', 'jsonv2');
      endpoint.searchParams.set('addressdetails', '1');
      endpoint.searchParams.set('limit', '5');
    } else {
      endpoint = new URL('/api/geocode', window.location.origin);
    }
    endpoint.searchParams.set('q', query.trim());
    const response = await fetch(endpoint, { headers: { 'Accept-Language': 'de,en;q=0.8' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Die Adresssuche ist gerade nicht verfügbar.');

    const results = (Array.isArray(data) ? data : data.results || []).map((place) => ({
      lat: Number(place.lat),
      lon: Number(place.lon),
      name: place.name || place.display_name?.split(',')[0] || 'Kartenpunkt',
      label: place.label || place.display_name || place.name || 'Kartenpunkt',
      type: place.type
    }));
    geocodeCache.set(normalized, results);
    if (geocodeCache.size > 100) geocodeCache.delete(geocodeCache.keys().next().value);
    return results;
  });
  geocodeQueue = request.catch(() => {});
  return request;
}

document.querySelectorAll('[data-search]').forEach((button) => {
  button.addEventListener('click', () => searchPlace(button.dataset.search));
});
Object.entries(fields).forEach(([kind, field]) => {
  field.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchPlace(kind);
    }
    if (event.key === 'Escape') field.suggestions.hidden = true;
  });
});
document.querySelectorAll('[data-pick]').forEach((button) => button.addEventListener('click', () => setPickMode(button.dataset.pick)));

function formatDistance(km) {
  if (!Number.isFinite(km)) return '—';
  return km < 10 ? `${km.toLocaleString('de-AT', { maximumFractionDigits: 1 })} km` : `${Math.round(km).toLocaleString('de-AT')} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `ca. ${minutes} Min.`;
  return rest ? `ca. ${hours} Std. ${rest} Min.` : `ca. ${hours} Std.`;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function sampleRouteWaypoints(coordinates, limit = 3) {
  if (coordinates.length < 3) return [];
  const points = coordinates.map(([lat, lon]) => L.latLng(lat, lon));
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + points[index - 1].distanceTo(points[index]));
  }
  const total = distances[distances.length - 1];
  if (!total) return [];
  const samples = [];
  for (let sample = 1; sample <= limit; sample += 1) {
    const target = total * sample / (limit + 1);
    let index = distances.findIndex((distance) => distance >= target);
    if (index < 1) index = 1;
    if (index >= points.length - 1) index = points.length - 2;
    const coordinate = coordinates[index];
    const key = `${coordinate[0].toFixed(5)},${coordinate[1].toFixed(5)}`;
    if (!samples.some((point) => point.key === key)) samples.push({ key, coordinate });
  }
  return samples.map((point) => point.coordinate);
}

function makeExternalMapLinks(coordinates) {
  const origin = `${fields.start.point.lat.toFixed(6)},${fields.start.point.lon.toFixed(6)}`;
  const destination = `${fields.destination.point.lat.toFixed(6)},${fields.destination.point.lon.toFixed(6)}`;
  const waypoints = sampleRouteWaypoints(coordinates).map(([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`);
  const avoidHighways = document.querySelector('#avoid-highways').checked;

  const googleParams = new URLSearchParams({ api: '1', origin, destination, travelmode: 'driving' });
  if (waypoints.length) googleParams.set('waypoints', waypoints.join('|'));
  if (avoidHighways) googleParams.set('avoid', 'highways');

  const appleParams = new URLSearchParams({ source: origin, destination, mode: 'driving' });
  waypoints.forEach((waypoint) => appleParams.append('waypoint', waypoint));
  if (avoidHighways) appleParams.set('avoid', 'highways');

  return {
    google: `https://www.google.com/maps/dir/?${googleParams.toString()}`,
    apple: `https://maps.apple.com/directions?${appleParams.toString()}`
  };
}

async function copyLink(value, label) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const temporary = document.createElement('textarea');
      temporary.value = value;
      temporary.setAttribute('readonly', '');
      temporary.style.position = 'fixed';
      temporary.style.opacity = '0';
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand('copy');
      temporary.remove();
      if (!copied) throw new Error('Kopieren wurde vom Browser nicht erlaubt.');
    }
    setNotice(`${label} in die Zwischenablage kopiert.`, 'success');
  } catch {
    setNotice('Der Link konnte nicht kopiert werden. Öffne die Karten-App über die Schaltfläche.', 'error');
  }
}

function renderRoute(data) {
  const route = data.trip || data.routes?.[0];
  if (!route) throw new Error('Der Routingdienst hat keine Route zurückgegeben.');
  let coordinates;
  let distanceMeters;
  let durationSeconds;
  let steps;
  if (data.trip) {
    coordinates = (route.legs || []).flatMap((leg, index) => {
      const decoded = decodePolyline(leg.shape || '');
      return index ? decoded.slice(1) : decoded;
    });
    distanceMeters = Number(route.summary?.length) * 1000;
    durationSeconds = Number(route.summary?.time);
    steps = route.legs?.flatMap((leg) => leg.maneuvers || []) || [];
  } else {
    coordinates = (route.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
    distanceMeters = Number(route.distance);
    durationSeconds = Number(route.duration);
    steps = route.legs?.flatMap((leg) => leg.steps || []) || [];
  }
  if (!coordinates?.length) throw new Error('Die Route enthält keine darstellbare Streckenlinie.');
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  state.routeLayer = L.polyline(coordinates, { color: '#3478f6', weight: 6, opacity: .96, lineCap: 'round', lineJoin: 'round', className: 'route-line' }).addTo(map);
  const bounds = state.routeLayer.getBounds();
  map.fitBounds(bounds, mapPadding());

  routeResult.replaceChildren();
  routeResult.hidden = false;
  planner.classList.add('panel-route-ready');
  const heading = document.createElement('div');
  heading.className = 'result-heading';
  const titleBox = document.createElement('div');
  titleBox.append(textElement('p', '', 'Deine Route'), textElement('h2', '', `${fields.start.point.label} → ${fields.destination.point.label}`));
  const time = textElement('div', 'result-time', formatDuration(durationSeconds));
  time.append(textElement('small', '', 'geschätzte Fahrzeit'));
  heading.append(titleBox, time);
  routeResult.append(heading);

  const pills = document.createElement('div');
  pills.className = 'result-pills';
  pills.append(textElement('span', 'result-pill', formatDistance(distanceMeters / 1000)));
  pills.append(textElement('span', 'result-pill', `Höchsttempo ${data.routeSettings?.topSpeed || 45} km/h`));
  routeResult.append(pills);
  routeResult.append(textElement('div', 'route-warning', 'Diese Route ist für dein Mopedauto geplant. Google Maps und Apple Karten erhalten Start, Ziel und Zwischenpunkte, berechnen die Strecke aber selbst neu. Die Geschwindigkeitseinstellung wird dort nicht übernommen. Bitte prüfe die Route vor der Fahrt.'));

  const mapLinks = makeExternalMapLinks(coordinates);
  const mapActions = document.createElement('div');
  mapActions.className = 'external-map-actions';
  [
    { label: 'Google Maps öffnen', url: mapLinks.google, copyLabel: 'Google-Maps-Link kopieren' },
    { label: 'Apple Karten öffnen', url: mapLinks.apple, copyLabel: 'Apple-Karten-Link kopieren' }
  ].forEach((mapOption) => {
    const row = document.createElement('div');
    row.className = 'external-map-row';
    const link = textElement('a', 'external-map-link', mapOption.label);
    link.href = mapOption.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const copyButton = textElement('button', 'copy-map-link', 'Link kopieren');
    copyButton.type = 'button';
    copyButton.setAttribute('aria-label', mapOption.copyLabel);
    copyButton.addEventListener('click', () => copyLink(mapOption.url, mapOption.copyLabel));
    row.append(link, copyButton);
    mapActions.append(row);
  });
  routeResult.append(mapActions);

  if (steps.length) {
    const list = document.createElement('ol');
    list.className = 'directions';
    steps.slice(0, 14).forEach((step, index) => {
      const item = document.createElement('li');
      item.append(textElement('span', 'direction-dot', String(index + 1)));
      item.append(textElement('span', '', step.instruction || step.maneuver?.instruction || step.name || 'Weiterfahren'));
      const stepDistance = Number(step.length ?? step.distance);
      if (Number.isFinite(stepDistance) && stepDistance > 0) item.append(textElement('span', 'direction-distance', formatDistance(data.trip ? stepDistance : stepDistance / 1000)));
      list.append(item);
    });
    routeResult.append(list);
  }
  mapHint.classList.add('is-hidden');
  setNotice('Route berechnet. Daten und Abbiegehinweise stammen aus OpenStreetMap/Valhalla.', 'success');
}

function decodePolyline(encoded, precision = 1e6) {
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    latitude += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    longitude += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([latitude / precision, longitude / precision]);
  }
  return coordinates;
}

document.querySelector('#route-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!fields.start.point || !fields.destination.point) {
    setNotice('Bitte suche Start und Ziel oder setze beide direkt auf der Karte.', 'error');
    if (!fields.start.point) fields.start.input.focus();
    else fields.destination.input.focus();
    return;
  }
  if (fields.start.point.lat === fields.destination.point.lat && fields.start.point.lon === fields.destination.point.lon) {
    setNotice('Start und Ziel sind identisch. Bitte wähle zwei verschiedene Punkte.', 'error');
    return;
  }
  const requestId = ++state.requestId;
  routeButton.disabled = true;
  routeButton.lastChild.textContent = ' Route wird gesucht …';
  setNotice('Die passende Strecke wird berechnet …');
  try {
    const topSpeed = Math.min(80, Math.max(30, Number(topSpeedInput.value) || 45));
    const avoidHighways = document.querySelector('#avoid-highways').checked;
    const routeInput = {
      start: fields.start.point,
      destination: fields.destination.point,
      topSpeed,
      avoidHighways
    };
    const routeKey = JSON.stringify([
      Number(routeInput.start.lat.toFixed(6)), Number(routeInput.start.lon.toFixed(6)),
      Number(routeInput.destination.lat.toFixed(6)), Number(routeInput.destination.lon.toFixed(6)),
      topSpeed, avoidHighways
    ]);
    const cachedRoute = routeCache.get(routeKey);
    if (cachedRoute) {
      renderRoute(cachedRoute);
      setNotice('Route aus dem Zwischenspeicher geladen.', 'success');
      return;
    }
    const valhallaRequest = {
      locations: [
        { lat: routeInput.start.lat, lon: routeInput.start.lon, type: 'break' },
        { lat: routeInput.destination.lat, lon: routeInput.destination.lon, type: 'break' }
      ],
      costing: 'auto',
      costing_options: {
        auto: {
          top_speed: topSpeed,
          use_highways: avoidHighways ? 0 : 0.5,
          use_tolls: 0,
          use_ferry: 0
        }
      },
      units: 'kilometers',
      language: 'de-DE',
      format: 'json',
      directions_type: 'instructions'
    };
    const response = await fetch(serviceConfig.publicApis ? serviceConfig.routerUrl : '/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serviceConfig.publicApis ? valhallaRequest : routeInput)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Die Route konnte nicht berechnet werden.');
    if (serviceConfig.publicApis) data.routeSettings = { topSpeed, avoidHighways };
    routeCache.set(routeKey, data);
    if (routeCache.size > 12) routeCache.delete(routeCache.keys().next().value);
    if (requestId === state.requestId) renderRoute(data);
  } catch (error) {
    if (requestId === state.requestId) setNotice(`${error.message} Prüfe deine Internetverbindung oder versuche es später erneut.`, 'error');
  } finally {
    if (requestId === state.requestId) {
      routeButton.disabled = false;
      routeButton.replaceChildren();
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<path d="M4 19.5 8.7 5l6.6 14.5 4.7-14"/><circle cx="4" cy="19.5" r="1.4"/><circle cx="20" cy="5.5" r="1.4"/>';
      routeButton.append(icon, document.createTextNode('Route berechnen'));
    }
  }
});

function useLocation() {
  if (!navigator.geolocation) {
    setNotice('Dein Browser unterstützt die Standortfreigabe nicht.', 'error');
    return;
  }
  setNotice('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition((position) => {
    setPlace('start', { lat: position.coords.latitude, lon: position.coords.longitude, name: 'Mein Standort' });
    setNotice('Standort als Start gesetzt.', 'success');
  }, (error) => {
    const message = error.code === 1 ? 'Standortzugriff abgelehnt. Du kannst den Start suchen oder auf der Karte setzen.' : 'Standort konnte nicht ermittelt werden. Prüfe die Standortfreigabe und versuche es erneut.';
    setNotice(message, 'error');
  }, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 });
}
document.querySelector('#location-button').addEventListener('click', useLocation);
document.querySelector('#map-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setNotice('Dein Browser unterstützt die Standortfreigabe nicht.', 'error');
  navigator.geolocation.getCurrentPosition((position) => map.setView([position.coords.latitude, position.coords.longitude], 15), () => setNotice('Standort konnte nicht ermittelt werden.', 'error'), { enableHighAccuracy: true, timeout: 12_000 });
});

const storageKeys = { fuel: 'mopedroute.fuel.v1', services: 'mopedroute.services.v1', settings: 'mopedroute.settings.v1', parking: 'mopedroute.parking.v1', daily: 'mopedroute.daily.v1' };
function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { return false; }
  return true;
}
const records = {
  fuel: readStored(storageKeys.fuel, []),
  services: readStored(storageKeys.services, []),
  settings: readStored(storageKeys.settings, { odometer: null }),
  parking: readStored(storageKeys.parking, null),
  daily: readStored(storageKeys.daily, { date: todayKey(), km: 0 })
};
let parkingMarker = null;
let gpsWatchId = null;
let lastGpsFix = null;

function showScreen(screenName) {
  if (screenName !== 'parking' && state.picking === 'parking') state.picking = 'start';
  document.querySelectorAll('[data-screen]').forEach((section) => {
    const active = section.dataset.screen === screenName;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });
  document.querySelectorAll('[data-screen-target]').forEach((button) => {
    const active = button.dataset.screenTarget === screenName;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (screenName === 'parking' && records.parking) focusParking();
  if (screenName === 'route') window.setTimeout(() => map.invalidateSize(), 60);
  if (screenName !== 'route') mapHint.classList.add('is-hidden');
}
document.querySelectorAll('[data-screen-target]').forEach((button) => {
  button.addEventListener('click', () => showScreen(button.dataset.screenTarget));
});

function localDate(dateString) {
  if (!dateString) return 'Kein Datum';
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? dateString : new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium' }).format(date);
}
function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function euro(value) {
  return `${Number(value || 0).toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function numberInput(form, name) {
  const value = Number(new FormData(form).get(name));
  return Number.isFinite(value) ? value : NaN;
}
function actionButton(label, className, onClick, ariaLabel = label) {
  const button = textElement('button', className, label);
  button.type = 'button';
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function fuelConsumption() {
  const sorted = [...records.fuel].sort((a, b) => Number(a.odometer) - Number(b.odometer));
  const fullIndices = sorted.map((entry, index) => entry.full ? index : -1).filter((index) => index >= 0);
  if (fullIndices.length < 2) return null;
  const currentIndex = fullIndices[fullIndices.length - 1];
  const previousIndex = fullIndices[fullIndices.length - 2];
  const distance = Number(sorted[currentIndex].odometer) - Number(sorted[previousIndex].odometer);
  if (distance <= 0) return null;
  const liters = sorted.slice(previousIndex + 1, currentIndex + 1).reduce((sum, entry) => sum + Number(entry.liters || 0), 0);
  return liters * 100 / distance;
}

function renderFuel() {
  const total = records.fuel.reduce((sum, entry) => sum + Number(entry.total || 0), 0);
  document.querySelector('#fuel-total-cost').textContent = euro(total);
  const consumption = fuelConsumption();
  document.querySelector('#fuel-consumption').textContent = consumption === null ? '—' : `${consumption.toLocaleString('de-AT', { maximumFractionDigits: 1 })} L/100 km`;
  document.querySelector('#fuel-count').textContent = `${records.fuel.length} ${records.fuel.length === 1 ? 'Eintrag' : 'Einträge'}`;
  const list = document.querySelector('#fuel-list');
  list.replaceChildren();
  if (!records.fuel.length) {
    list.append(textElement('p', 'empty-state', 'Noch keine Tankfüllung gespeichert.'));
    return;
  }
  [...records.fuel].sort((a, b) => b.date.localeCompare(a.date) || Number(b.odometer) - Number(a.odometer)).slice(0, 20).forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'record-card';
    const copy = document.createElement('div');
    copy.append(textElement('strong', 'record-title', `${Number(entry.liters).toLocaleString('de-AT')} L · ${euro(entry.total)}`));
    copy.append(textElement('small', 'record-meta', `${localDate(entry.date)} · ${Number(entry.odometer).toLocaleString('de-AT')} km${entry.full ? ' · Vollgetankt' : ''}`));
    card.append(copy, actionButton('Entfernen', 'text-action', () => {
      records.fuel = records.fuel.filter((item) => item.id !== entry.id);
      writeStored(storageKeys.fuel, records.fuel);
      renderFuel();
    }));
    list.append(card);
  });
}

const fuelForm = document.querySelector('#fuel-form');
document.querySelector('#fuel-date').value = todayKey();
fuelForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(fuelForm);
  const entry = {
    id: Date.now(), date: String(formData.get('date')), odometer: numberInput(fuelForm, 'odometer'),
    liters: numberInput(fuelForm, 'liters'), total: numberInput(fuelForm, 'total'), full: formData.has('full')
  };
  if (!entry.date || !Number.isFinite(entry.odometer) || !Number.isFinite(entry.liters) || !Number.isFinite(entry.total)) return;
  records.fuel.push(entry);
  writeStored(storageKeys.fuel, records.fuel);
  records.settings.odometer = Math.max(Number(records.settings.odometer || 0), entry.odometer);
  writeStored(storageKeys.settings, records.settings);
  renderServices();
  renderFuel();
  fuelForm.reset();
  document.querySelector('#fuel-date').value = new Date().toISOString().slice(0, 10);
});

function reminderDue(item) {
    const dateDue = item.date && item.date <= todayKey();
  const kmDue = item.odometer !== null && records.settings.odometer !== null && Number(item.odometer) <= Number(records.settings.odometer);
  return dateDue || kmDue;
}
function renderServices() {
  const list = document.querySelector('#service-list');
  list.replaceChildren();
  document.querySelector('#service-count').textContent = `${records.services.length} ${records.services.length === 1 ? 'Eintrag' : 'Einträge'}`;
  document.querySelector('#current-odometer').value = records.settings.odometer ?? '';
  if (!records.services.length) {
    list.append(textElement('p', 'empty-state', 'Noch keine Wartungserinnerung angelegt.'));
    return;
  }
  [...records.services].sort((a, b) => Number(reminderDue(b)) - Number(reminderDue(a)) || (a.date || '9999').localeCompare(b.date || '9999') || Number(a.odometer || Infinity) - Number(b.odometer || Infinity)).forEach((item) => {
    const card = document.createElement('article');
    card.className = `record-card service-record${item.done ? ' is-done' : ''}${!item.done && reminderDue(item) ? ' is-due' : ''}`;
    const copy = document.createElement('div');
    copy.append(textElement('strong', 'record-title', item.title));
    const due = [item.date ? `bis ${localDate(item.date)}` : '', item.odometer !== null ? `bei ${Number(item.odometer).toLocaleString('de-AT')} km` : ''].filter(Boolean).join(' · ') || 'Ohne Termin';
    copy.append(textElement('small', 'record-meta', item.done ? `Erledigt · ${due}` : `${reminderDue(item) ? 'Jetzt fällig · ' : 'Fällig: '}${due}`));
    const actions = document.createElement('div');
    actions.className = 'record-actions';
    if (!item.done) actions.append(actionButton('Erledigt', 'text-action', () => {
      item.done = true;
      writeStored(storageKeys.services, records.services);
      renderServices();
    }));
    actions.append(actionButton('×', 'remove-action', () => {
      records.services = records.services.filter((entry) => entry.id !== item.id);
      writeStored(storageKeys.services, records.services);
      renderServices();
    }, `Erinnerung ${item.title} löschen`));
    card.append(copy, actions);
    list.append(card);
  });
}
document.querySelector('#odometer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = Number(document.querySelector('#current-odometer').value);
  if (!Number.isFinite(value) || value < 0) return;
  records.settings.odometer = value;
  writeStored(storageKeys.settings, records.settings);
  renderServices();
});
document.querySelector('#service-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const title = String(data.get('title') || '').trim();
  const date = String(data.get('date') || '');
  const odometerRaw = String(data.get('odometer') || '');
  if (!title || (!date && !odometerRaw)) return;
  records.services.push({ id: Date.now(), title, date, odometer: odometerRaw ? Number(odometerRaw) : null, done: false });
  writeStored(storageKeys.services, records.services);
  event.currentTarget.reset();
  renderServices();
});

function renderParking() {
  const card = document.querySelector('#parking-card');
  card.replaceChildren();
  if (!records.parking) {
    card.append(textElement('strong', 'record-title', 'Noch kein Parkplatz gemerkt'), textElement('small', 'record-meta', 'Speichere deinen aktuellen Standort oder wähle einen Punkt auf der Karte.'));
    return;
  }
  const copy = document.createElement('div');
  copy.append(textElement('strong', 'record-title', records.parking.note || 'Dein Parkplatz'));
  copy.append(textElement('small', 'record-meta', `${localDate(records.parking.date)} · ${new Date(records.parking.savedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`));
  copy.append(textElement('small', 'record-meta', `${Number(records.parking.lat).toFixed(5)}, ${Number(records.parking.lon).toFixed(5)}`));
  const actions = document.createElement('div');
  actions.className = 'record-actions parking-actions';
  actions.append(actionButton('Auf Karte', 'text-action', focusParking));
  actions.append(actionButton('Löschen', 'text-action', () => {
    records.parking = null;
    writeStored(storageKeys.parking, null);
    if (parkingMarker) map.removeLayer(parkingMarker);
    parkingMarker = null;
    renderParking();
  }));
  card.append(copy, actions);
}
function saveParkingLocation(lat, lon) {
  const note = document.querySelector('#parking-note').value.trim();
    records.parking = { lat: Number(lat), lon: Number(lon), note, date: todayKey(), savedAt: Date.now() };
  writeStored(storageKeys.parking, records.parking);
  if (parkingMarker) map.removeLayer(parkingMarker);
  parkingMarker = L.marker([lat, lon], { title: 'Gemerkter Parkplatz' }).addTo(map).bindTooltip('Mein Parkplatz', { direction: 'top' });
  map.setView([lat, lon], 16, mapPadding());
  document.querySelector('#parking-help').textContent = 'Parkplatz gespeichert. Du kannst ihn jederzeit auf der Karte anzeigen.';
  renderParking();
}
function focusParking() {
  if (!records.parking) return;
  const point = [Number(records.parking.lat), Number(records.parking.lon)];
  if (!parkingMarker) parkingMarker = L.marker(point, { title: 'Gemerkter Parkplatz' }).addTo(map).bindTooltip('Mein Parkplatz', { direction: 'top' });
  map.setView(point, 16, mapPadding());
}
document.querySelector('#save-parking-location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    document.querySelector('#parking-help').textContent = 'Standort wird nicht unterstützt. Wähle stattdessen einen Punkt auf der Karte.';
    return;
  }
  document.querySelector('#parking-help').textContent = 'Standort wird ermittelt …';
  navigator.geolocation.getCurrentPosition((position) => saveParkingLocation(position.coords.latitude, position.coords.longitude), (error) => {
    document.querySelector('#parking-help').textContent = error.code === 1 ? 'Standortzugriff abgelehnt. Wähle deinen Parkplatz auf der Karte.' : 'Standort konnte nicht ermittelt werden. Wähle einen Punkt auf der Karte.';
  }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 });
});
document.querySelector('#pick-parking-location').addEventListener('click', () => {
  state.picking = 'parking';
  document.querySelector('#parking-help').textContent = 'Tippe jetzt auf die Karte, um deinen Parkplatz zu speichern.';
  mapHint.textContent = 'Tippe auf die Karte, um deinen Parkplatz zu merken';
  mapHint.classList.remove('is-hidden');
});

function updateDailyDistance() {
  const today = todayKey();
  if (records.daily.date !== today) records.daily = { date: today, km: 0 };
  document.querySelector('#daily-distance').innerHTML = `${Number(records.daily.km).toLocaleString('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} <small>km</small>`;
}
function stopTracking(message = 'Aufzeichnung beendet.') {
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  lastGpsFix = null;
  document.querySelector('#gps-status').textContent = 'GPS aus';
  document.querySelector('#speedometer').classList.remove('tracking');
  document.querySelector('#start-tracking').disabled = false;
  document.querySelector('#stop-tracking').disabled = true;
  document.querySelector('#cockpit-help').textContent = message;
}
function acceptGpsPosition(position) {
  const { latitude, longitude, speed, accuracy } = position.coords;
  document.querySelector('#gps-status').textContent = 'GPS aktiv';
  document.querySelector('#gps-accuracy').textContent = `${Math.round(accuracy)} m`;
  document.querySelector('#speedometer').classList.add('tracking');
  if (Number.isFinite(speed)) {
    const kmh = Math.max(0, speed * 3.6);
    document.querySelector('#gps-speed').textContent = String(Math.round(kmh));
    document.querySelector('#speedometer').style.setProperty('--speed-angle', `${Math.min(kmh, 80) / 80 * 270}deg`);
  }
  if (lastGpsFix && accuracy <= 60 && lastGpsFix.accuracy <= 60) {
    const distance = map.distance([lastGpsFix.lat, lastGpsFix.lon], [latitude, longitude]);
    const elapsed = position.timestamp - lastGpsFix.timestamp;
    if (distance > 4 && distance < 1200 && elapsed > 0 && elapsed < 120_000) {
      records.daily.km = Number(records.daily.km || 0) + distance / 1000;
      writeStored(storageKeys.daily, records.daily);
      if (records.settings.odometer !== null) {
        records.settings.odometer = Number(records.settings.odometer) + distance / 1000;
        writeStored(storageKeys.settings, records.settings);
      }
      updateDailyDistance();
    }
  }
  lastGpsFix = { lat: latitude, lon: longitude, accuracy, timestamp: position.timestamp };
}
document.querySelector('#start-tracking').addEventListener('click', () => {
  if (!navigator.geolocation) {
    document.querySelector('#cockpit-help').textContent = 'Dieser Browser unterstützt kein GPS. Verwende ein Smartphone mit Standortfreigabe.';
    return;
  }
  document.querySelector('#start-tracking').disabled = true;
  document.querySelector('#stop-tracking').disabled = false;
  document.querySelector('#gps-status').textContent = 'Suche GPS …';
  document.querySelector('#cockpit-help').textContent = 'Warte auf GPS-Signal …';
  gpsWatchId = navigator.geolocation.watchPosition(acceptGpsPosition, (error) => {
    stopTracking(error.code === 1 ? 'Standortzugriff abgelehnt. Erlaube den Standortzugriff und starte die Fahrt erneut.' : 'GPS-Signal nicht verfügbar. Prüfe den Standortzugriff und versuche es erneut.');
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 });
});
document.querySelector('#stop-tracking').addEventListener('click', () => stopTracking('Fahrt beendet. Tageskilometer wurden auf diesem Gerät gespeichert.'));

renderFuel();
renderServices();
renderParking();
updateDailyDistance();
if (records.parking) focusParking();

document.querySelector('#panel-toggle').addEventListener('click', (event) => {
  const collapsed = planner.classList.toggle('is-collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  event.currentTarget.setAttribute('aria-label', collapsed ? 'Planer ausklappen' : 'Planer einklappen');
  window.setTimeout(() => map.invalidateSize(), 240);
});

document.querySelector('.brand-mark').addEventListener('click', (event) => {
  event.preventDefault();
  Object.values(fields).forEach((field) => {
    field.point = null;
    field.input.value = '';
    field.suggestions.hidden = true;
    field.suggestions.replaceChildren();
    if (field.marker) map.removeLayer(field.marker);
    field.marker = null;
  });
  if (state.routeLayer) map.removeLayer(state.routeLayer);
  state.routeLayer = null;
  state.routeResult = null;
  routeResult.hidden = true;
  planner.classList.remove('panel-route-ready');
  map.setView([48.2082, 16.3738], 12);
  setPickMode('start');
  setNotice('Start- und Zieleingabe zurückgesetzt.');
});

setPickMode('start');
window.addEventListener('resize', () => map.invalidateSize());
