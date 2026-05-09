const DB_NAME = "kampot_riders";
const DB_VERSION = 3;
const AUTOSAVE_KEY = "kr_autosave_v2";
const SELECTED_LAYER_KEY = "kr_selected_layer";

let db = null;

export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function safeParseJSON(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function normalizePoint(point) {
  if (!point || !isFiniteNumber(point.lat) || !isFiniteNumber(point.lng)) return null;
  return {
    lat: Number(point.lat),
    lng: Number(point.lng),
    alt: isFiniteNumber(point.alt) ? Number(point.alt) : null,
    time: isFiniteNumber(point.time) ? Number(point.time) : Date.now(),
    accuracy: isFiniteNumber(point.accuracy) ? Number(point.accuracy) : null,
    speed: isFiniteNumber(point.speed) ? Number(point.speed) : 0
  };
}

export function normalizeTrackSegments(trackSegments, legacyPoints = []) {
  const sourceSegments = Array.isArray(trackSegments) && trackSegments.length > 0
    ? trackSegments
    : [Array.isArray(legacyPoints) ? legacyPoints : []];

  return sourceSegments
    .map(segment => Array.isArray(segment) ? segment.map(normalizePoint).filter(Boolean) : [])
    .filter(segment => segment.length > 0);
}

export function flattenTrackSegments(trackSegments) {
  return normalizeTrackSegments(trackSegments).flat();
}

export function computeRideMetrics(trackSegments) {
  const segments = normalizeTrackSegments(trackSegments);
  let totalDistance = 0;
  let elevGain = 0;
  let movingTime = 0;
  let firstTime = null;
  let lastTime = null;

  for (const segment of segments) {
    for (let index = 0; index < segment.length; index += 1) {
      const point = segment[index];
      if (firstTime == null || point.time < firstTime) firstTime = point.time;
      if (lastTime == null || point.time > lastTime) lastTime = point.time;
      if (index === 0) continue;
      const previous = segment[index - 1];
      const distance = haversine(previous.lat, previous.lng, point.lat, point.lng);
      if (distance < 500) totalDistance += distance;
      if (point.alt != null && previous.alt != null) {
        const deltaAlt = point.alt - previous.alt;
        if (deltaAlt > 2) elevGain += deltaAlt;
      }
      if (point.time >= previous.time) movingTime += point.time - previous.time;
    }
  }

  return {
    totalDistance,
    elevGain,
    movingTime,
    totalTime: firstTime != null && lastTime != null ? Math.max(0, lastTime - firstTime) : 0
  };
}

export function normalizeRideRecord(record) {
  if (!record || typeof record !== "object") return null;
  const trackSegments = normalizeTrackSegments(record.trackSegments, record.points);
  if (trackSegments.length === 0) return null;

  const metrics = computeRideMetrics(trackSegments);
  const firstPoint = trackSegments[0][0];
  return {
    ...record,
    date: typeof record.date === "string" ? record.date : new Date(firstPoint.time).toISOString(),
    name: typeof record.name === "string" ? record.name : "",
    trackSegments,
    points: flattenTrackSegments(trackSegments),
    distance: isFiniteNumber(record.distance) ? Number(record.distance) : metrics.totalDistance,
    elevGain: isFiniteNumber(record.elevGain) ? Number(record.elevGain) : metrics.elevGain,
    movingTime: isFiniteNumber(record.movingTime) ? Number(record.movingTime) : metrics.movingTime,
    totalTime: isFiniteNumber(record.totalTime) ? Number(record.totalTime) : metrics.totalTime,
    interruptionCount: isFiniteNumber(record.interruptionCount)
      ? Number(record.interruptionCount)
      : Math.max(0, trackSegments.length - 1)
  };
}

export async function openDB() {
  if (db) return db;
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains("tracks")) {
        database.createObjectStore("tracks", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = event => resolve(event.target.result);
    request.onerror = event => reject(event.target.error || event);
  });
  return db;
}

export async function saveRideRecord(record) {
  const database = await openDB();
  const normalized = normalizeRideRecord(record);
  if (!normalized) return;
  await new Promise((resolve, reject) => {
    const tx = database.transaction("tracks", "readwrite");
    tx.objectStore("tracks").add({
      date: normalized.date,
      name: normalized.name,
      distance: normalized.distance,
      elevGain: normalized.elevGain,
      movingTime: normalized.movingTime,
      totalTime: normalized.totalTime,
      interruptionCount: normalized.interruptionCount,
      points: normalized.points,
      trackSegments: normalized.trackSegments
    });
    tx.oncomplete = () => resolve();
    tx.onerror = event => reject(event.target.error || event);
  });
}

export async function loadTracks() {
  const database = await openDB();
  const records = await new Promise(resolve => {
    const request = database.transaction("tracks", "readonly").objectStore("tracks").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
  return records.map(normalizeRideRecord).filter(Boolean);
}

export async function updateTrackName(id, name) {
  const database = await openDB();
  await new Promise(resolve => {
    const tx = database.transaction("tracks", "readwrite");
    const store = tx.objectStore("tracks");
    const request = store.get(id);
    request.onsuccess = () => {
      const record = normalizeRideRecord(request.result);
      if (record) {
        record.name = name;
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function deleteTrack(id) {
  const database = await openDB();
  await new Promise(resolve => {
    const tx = database.transaction("tracks", "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function saveAutosave(snapshot) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    return true;
  } catch (error) {
    try {
      const compactSnapshot = {
        ...snapshot,
        trackSegments: normalizeTrackSegments(snapshot.trackSegments).map(segment => segment.slice(-400))
      };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(compactSnapshot));
      return true;
    } catch {
      console.warn("[KR] Autosave failed:", error);
      return false;
    }
  }
}

export function loadAutosave() {
  const parsed = safeParseJSON(localStorage.getItem(AUTOSAVE_KEY));
  if (!parsed || typeof parsed !== "object") return null;
  const trackSegments = normalizeTrackSegments(parsed.trackSegments, parsed.track);
  if (trackSegments.length === 0) return null;
  return {
    startTime: isFiniteNumber(parsed.startTime) ? Number(parsed.startTime) : null,
    recording: Boolean(parsed.recording),
    autoPaused: Boolean(parsed.autoPaused),
    totalDistance: isFiniteNumber(parsed.totalDistance) ? Number(parsed.totalDistance) : 0,
    elevationGain: isFiniteNumber(parsed.elevationGain) ? Number(parsed.elevationGain) : 0,
    movingTimeMs: isFiniteNumber(parsed.movingTimeMs) ? Number(parsed.movingTimeMs) : 0,
    interruptionCount: isFiniteNumber(parsed.interruptionCount) ? Number(parsed.interruptionCount) : Math.max(0, trackSegments.length - 1),
    currentLayer: typeof parsed.currentLayer === "string" ? parsed.currentLayer : null,
    trackSegments,
    savedAt: isFiniteNumber(parsed.savedAt) ? Number(parsed.savedAt) : Date.now()
  };
}

export function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}

export function saveSelectedLayer(layerId) {
  try {
    localStorage.setItem(SELECTED_LAYER_KEY, layerId);
  } catch {
    console.warn("[KR] Failed to persist selected layer");
  }
}

export function loadSelectedLayer() {
  const value = localStorage.getItem(SELECTED_LAYER_KEY);
  return typeof value === "string" ? value : null;
}
