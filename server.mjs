import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL(".", import.meta.url));
const staticDir = resolve(projectDir);
const port = Number(process.env.PORT || 4173);
const hostFlag = process.argv.indexOf("--host");
const host = process.env.HOST || (hostFlag >= 0 ? process.argv[hostFlag + 1] : "127.0.0.1");
const nominatimBase = (process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
const valhallaUrl = process.env.VALHALLA_URL || "https://valhalla1.openstreetmap.de/route";
const nominatimCache = new Map();
let nominatimLastRequest = 0;
let nominatimQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) {
        reject(new Error("Anfrage ist zu groß."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Ungültige JSON-Anfrage."));
      }
    });
    request.on("error", reject);
  });
}

function validPoint(point) {
  return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)) &&
    Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lon)) <= 180;
}

async function waitForGeocoderSlot() {
  const waitMs = Math.max(0, 1_100 - (Date.now() - nominatimLastRequest));
  if (waitMs) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  nominatimLastRequest = Date.now();
}

function queueGeocode(task) {
  const next = nominatimQueue.then(task, task);
  nominatimQueue = next.catch(() => {});
  return next;
}

async function geocode(query) {
  const normalized = query.trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
  if (normalized.length < 2) throw Object.assign(new Error("Bitte mindestens zwei Zeichen eingeben."), { status: 400 });
  if (normalized.length > 180) throw Object.assign(new Error("Die Suche ist zu lang."), { status: 400 });
  if (nominatimCache.has(normalized)) return nominatimCache.get(normalized);

  return queueGeocode(async () => {
    if (nominatimCache.has(normalized)) return nominatimCache.get(normalized);
    await waitForGeocoderSlot();
    const url = new URL(`${nominatimBase}/search`);
    url.searchParams.set("q", query.trim());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    const upstream = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Language": "de,en;q=0.8",
        "User-Agent": "MopedautoRoutePlanner/1.0 (local OpenStreetMap routing demo)"
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!upstream.ok) throw Object.assign(new Error(`Adresssuche antwortet mit Status ${upstream.status}.`), { status: 502 });
    const places = await upstream.json();
    const results = places.map((place) => ({
      lat: Number(place.lat),
      lon: Number(place.lon),
      name: place.name || place.display_name.split(",")[0],
      label: place.display_name,
      type: place.type
    }));
    nominatimCache.set(normalized, results);
    if (nominatimCache.size > 250) nominatimCache.delete(nominatimCache.keys().next().value);
    return results;
  });
}

async function calculateRoute(body) {
  if (!validPoint(body.start) || !validPoint(body.destination)) {
    throw Object.assign(new Error("Start und Ziel benötigen gültige Koordinaten."), { status: 400 });
  }
  const topSpeed = Math.min(80, Math.max(30, Number(body.topSpeed) || 45));
  const request = {
    locations: [
      { lat: Number(body.start.lat), lon: Number(body.start.lon), type: "break" },
      { lat: Number(body.destination.lat), lon: Number(body.destination.lon), type: "break" }
    ],
    costing: "auto",
    costing_options: {
      auto: {
        top_speed: topSpeed,
        use_highways: body.avoidHighways === false ? 0.5 : 0,
        use_tolls: 0,
        use_ferry: 0
      }
    },
    units: "kilometers",
    language: "de-DE",
    format: "json",
    directions_type: "instructions"
  };
  const upstream = await fetch(valhallaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Client-Id": "mopedauto-routeplaner-local-demo"
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(25_000)
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw Object.assign(new Error(data.error || data.message || `Routing antwortet mit Status ${upstream.status}.`), { status: upstream.status });
  }
  return { ...data, routeSettings: { topSpeed, avoidHighways: body.avoidHighways !== false } };
}

async function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Ungültiger Pfad.");
    return;
  }
  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = resolve(staticDir, `.${requested}`);
  if (filePath !== staticDir && !filePath.startsWith(`${staticDir}${sep}`)) {
    response.writeHead(403).end("Zugriff verweigert.");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Keine Datei.");
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Seite nicht gefunden.");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/geocode") {
      const results = await geocode(url.searchParams.get("q") || "");
      sendJson(response, 200, { results });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/route") {
      const body = await readBody(request);
      const result = await calculateRoute(body);
      sendJson(response, 200, result);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API-Endpunkt nicht gefunden." });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    const status = error.status || (error.name === "TimeoutError" ? 504 : 502);
    sendJson(response, status, { error: error.message || "Der Kartendienst ist gerade nicht erreichbar." });
  }
});

server.listen(port, host, () => {
  console.log(`Mopedauto-Routenplaner läuft auf http://${host}:${port}`);
});
