import { createGPSController } from "./gps.js";
import { downloadGPX, parseGPX } from "./gpx.js";
import {
  clearAutosave,
  deleteTrack,
  flattenTrackSegments,
  haversine,
  loadAutosave,
  loadSelectedLayer,
  loadTracks,
  openDB,
  saveAutosave,
  saveRideRecord,
  saveSelectedLayer,
  updateTrackName
} from "./storage.js";
import { createMapController } from "./map.js";

const AUTO_PAUSE_RADIUS = 15;
const MIN_ACCURACY = 30;
const ALTITUDE_SMOOTH = 3;
const SPEED_THRESHOLD = 1.5;
const GPS_GAP_THRESHOLD_MS = 45000;
const MAX_SEGMENT_DISTANCE = 500;
const AUTOSAVE_INTERVAL = 10000;

const runtimeConfig = globalThis.KAMPOT_RIDERS_CONFIG || {};

const GOOGLE_SATELLITE_CONFIG = Object.freeze({
  enabled: runtimeConfig.googleSatellite?.enabled ?? false,
  apiKey: runtimeConfig.googleSatellite?.apiKey ?? "",
  language: runtimeConfig.googleSatellite?.language ?? "en-US",
  region: runtimeConfig.googleSatellite?.region ?? "KH"
});

// Static client-side apps cannot keep Google keys secret. If you enable Satellite,
// use a restricted Google Maps Platform key limited to the published GitHub Pages
// origin and Map Tiles API only. Runtime override is supported via:
// window.KAMPOT_RIDERS_CONFIG = { googleSatellite: { enabled: true, apiKey: "..." } };

const state = {
  recording: false,
  autoPaused: false,
  trackSegments: [],
  anchorPoint: null,
  totalDistance: 0,
  elevationGain: 0,
  movingTimeMs: 0,
  lastMovingTick: null,
  startTime: null,
  altitudeBuffer: [],
  currentSpeed: 0,
  currentAlt: 0,
  currentPos: null,
  timerInterval: null,
  autosaveInterval: null,
  wakeLock: null,
  interruptionCount: 0,
  referenceRide: null,
  selectedLayer: loadSelectedLayer() || "cycle"
};

const $ = id => document.getElementById(id);
const dom = {
  btnRecord: $("btnRecord"),
  btnExport: $("btnExport"),
  btnTracks: $("btnTracks"),
  btnRecenter: $("btnRecenter"),
  btnCloseOverlay: $("btnCloseOverlay"),
  btnImportGpx: $("btnImportGpx"),
  clearReferenceButton: $("clearReferenceButton"),
  gpxFileInput: $("gpxFileInput"),
  tracksOverlay: $("tracksOverlay"),
  tracksList: $("tracksList"),
  statusBadge: $("statusBadge"),
  pauseBadge: $("pauseBadge"),
  gpsDot: $("gpsDot"),
  gpsText: $("gpsText"),
  wakeIcon: $("wakeIcon"),
  toast: $("toast"),
  mapNotice: $("mapNotice"),
  mapNoticeText: $("mapNoticeText"),
  mapNoticeAction: $("mapNoticeAction"),
  recoveryDialog: $("recoveryDialog"),
  recoveryStats: $("recoveryStats"),
  discardRecoveryButton: $("discardRecoveryButton"),
  resumeRecoveryButton: $("resumeRecoveryButton"),
  refBadge: $("refBadge"),
  refBadgeLabel: $("refBadgeLabel"),
  segmentCount: $("segmentCount"),
  interruptionCount: $("interruptionCount"),
  activeLayerLabel: $("activeLayerLabel")
};

let mapController = null;
let gpsController = null;
let recoverySnapshot = null;
let toastTimer = null;

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function currentMovingTime() {
  if (state.recording && !state.autoPaused && state.lastMovingTick) {
    return state.movingTimeMs + (Date.now() - state.lastMovingTick);
  }
  return state.movingTimeMs;
}

function currentTotalTime() {
  return state.startTime ? Date.now() - state.startTime : 0;
}

function smoothAltitude(altitude) {
  state.altitudeBuffer.push(altitude);
  if (state.altitudeBuffer.length > ALTITUDE_SMOOTH) {
    state.altitudeBuffer.shift();
  }
  return state.altitudeBuffer.reduce((sum, value) => sum + value, 0) / state.altitudeBuffer.length;
}

function toast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 2600);
}

function showMapNotice({ text, actionLabel, actionLayerId }) {
  dom.mapNoticeText.textContent = text;
  if (actionLabel && actionLayerId) {
    dom.mapNoticeAction.textContent = actionLabel;
    dom.mapNoticeAction.classList.remove("hidden");
    dom.mapNoticeAction.onclick = () => mapController.setActiveLayer(actionLayerId);
  } else {
    dom.mapNoticeAction.textContent = "";
    dom.mapNoticeAction.classList.add("hidden");
    dom.mapNoticeAction.onclick = null;
  }
  dom.mapNotice.classList.remove("hidden");
}

function hideMapNotice() {
  dom.mapNotice.classList.add("hidden");
  dom.mapNoticeAction.onclick = null;
}

function updateStats() {
  $("speed").textContent = state.currentSpeed.toFixed(1);
  $("distance").textContent = (state.totalDistance / 1000).toFixed(2);
  $("elevation").textContent = Math.round(state.currentAlt || 0);
  $("elevGain").textContent = `↑ ${Math.round(state.elevationGain)}`;
  $("movingTime").textContent = formatTime(currentMovingTime());
  $("totalTime").textContent = formatTime(currentTotalTime());
  const avgSpeed = state.movingTimeMs > 0
    ? (state.totalDistance / 1000) / (state.movingTimeMs / 3600000)
    : 0;
  $("avgSpeed").textContent = avgSpeed.toFixed(1);
  dom.segmentCount.textContent = String(state.trackSegments.length);
  dom.interruptionCount.textContent = String(state.interruptionCount);
}

function updateTimers() {
  if (!state.recording) return;
  $("movingTime").textContent = formatTime(currentMovingTime());
  $("totalTime").textContent = formatTime(currentTotalTime());
}

function setStatus(mode) {
  if (mode === "recording") {
    dom.statusBadge.textContent = "● REC";
    dom.statusBadge.className = "header-status recording";
    return;
  }
  if (mode === "paused") {
    dom.statusBadge.textContent = "PAUSED";
    dom.statusBadge.className = "header-status paused";
    return;
  }
  dom.statusBadge.textContent = "READY";
  dom.statusBadge.className = "header-status idle";
}

function setPauseUi(isPaused) {
  dom.pauseBadge.classList.toggle("visible", isPaused);
  setStatus(isPaused ? "paused" : "recording");
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      dom.wakeIcon.classList.add("active");
      state.wakeLock.addEventListener("release", () => dom.wakeIcon.classList.remove("active"));
    }
  } catch (error) {
    console.warn("[KR] Wake Lock failed:", error);
  }
}

async function releaseWakeLock() {
  if (!state.wakeLock) return;
  try {
    await state.wakeLock.release();
  } catch {
    // Ignore.
  }
  state.wakeLock = null;
  dom.wakeIcon.classList.remove("active");
}

function getLastPoint() {
  const points = flattenTrackSegments(state.trackSegments);
  return points.length > 0 ? points[points.length - 1] : null;
}

function ensureActiveSegment() {
  if (state.trackSegments.length === 0) {
    state.trackSegments.push([]);
  }
  return state.trackSegments[state.trackSegments.length - 1];
}

function startNewSegment() {
  if (state.trackSegments.length === 0 || ensureActiveSegment().length > 0) {
    state.trackSegments.push([]);
  }
}

function autosaveRecordingState() {
  if (!state.recording || flattenTrackSegments(state.trackSegments).length === 0) return;
  saveAutosave({
    recording: state.recording,
    autoPaused: state.autoPaused,
    startTime: state.startTime,
    totalDistance: state.totalDistance,
    elevationGain: state.elevationGain,
    movingTimeMs: state.movingTimeMs,
    interruptionCount: state.interruptionCount,
    currentLayer: mapController.getActiveLayer(),
    trackSegments: state.trackSegments,
    savedAt: Date.now()
  });
}

function clearIntervals() {
  if (state.timerInterval) {
    window.clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.autosaveInterval) {
    window.clearInterval(state.autosaveInterval);
    state.autosaveInterval = null;
  }
}

function resetRideState() {
  state.recording = false;
  state.autoPaused = false;
  state.trackSegments = [];
  state.anchorPoint = null;
  state.totalDistance = 0;
  state.elevationGain = 0;
  state.movingTimeMs = 0;
  state.lastMovingTick = null;
  state.startTime = null;
  state.altitudeBuffer = [];
  state.currentSpeed = 0;
  state.currentAlt = 0;
  state.interruptionCount = 0;
  if (mapController) {
    mapController.setTrackSegments([]);
  }
}

function saveLayerSelection(layerId) {
  state.selectedLayer = layerId;
  saveSelectedLayer(layerId);
  dom.activeLayerLabel.textContent = layerId === "satellite" ? "Satellite" : layerId === "osm" ? "OSM map" : "Cycle map";
  hideMapNotice();
  if (state.recording) autosaveRecordingState();
}

function updateGpsIndicator(accuracy) {
  if (accuracy <= 10) {
    dom.gpsDot.className = "gps-dot good";
    dom.gpsText.textContent = `±${Math.round(accuracy)}m`;
  } else if (accuracy <= MIN_ACCURACY) {
    dom.gpsDot.className = "gps-dot fair";
    dom.gpsText.textContent = `±${Math.round(accuracy)}m`;
  } else {
    dom.gpsDot.className = "gps-dot poor";
    dom.gpsText.textContent = `±${Math.round(accuracy)}m (weak)`;
  }
}

function onPosition(position) {
  const { latitude: lat, longitude: lng, altitude: rawAlt, accuracy, speed: rawSpeed } = position.coords;
  const time = position.timestamp;

  updateGpsIndicator(accuracy);
  if (accuracy > MIN_ACCURACY) return;

  state.currentPos = { lat, lng };
  mapController.dismissSplash();
  mapController.setCurrentPosition(lat, lng, accuracy);

  const altitude = rawAlt != null ? smoothAltitude(rawAlt) : state.currentAlt;
  state.currentAlt = altitude;

  const lastPoint = getLastPoint();
  let speedKmh = 0;
  if (rawSpeed != null && rawSpeed >= 0) {
    speedKmh = rawSpeed * 3.6;
  } else if (lastPoint) {
    const deltaTime = (time - lastPoint.time) / 1000;
    if (deltaTime > 0) {
      speedKmh = (haversine(lastPoint.lat, lastPoint.lng, lat, lng) / deltaTime) * 3.6;
    }
  }
  state.currentSpeed = speedKmh;
  updateStats();

  if (!state.recording) return;

  if (!state.anchorPoint) {
    state.anchorPoint = { lat, lng, time };
  }

  const distanceFromAnchor = haversine(state.anchorPoint.lat, state.anchorPoint.lng, lat, lng);
  if (distanceFromAnchor <= AUTO_PAUSE_RADIUS && speedKmh < SPEED_THRESHOLD) {
    if (!state.autoPaused) {
      state.autoPaused = true;
      state.lastMovingTick = null;
      setPauseUi(true);
      autosaveRecordingState();
    }
    return;
  }

  if (state.autoPaused) {
    state.autoPaused = false;
    state.lastMovingTick = Date.now();
    setPauseUi(false);
  }

  state.anchorPoint = { lat, lng, time };

  let segmentInterrupted = false;
  if (lastPoint && time - lastPoint.time > GPS_GAP_THRESHOLD_MS) {
    segmentInterrupted = true;
    state.interruptionCount += 1;
    startNewSegment();
    toast("GPS resumed after interruption");
  }

  const activeSegment = ensureActiveSegment();
  const previousInSegment = activeSegment.length > 0 ? activeSegment[activeSegment.length - 1] : null;
  if (!segmentInterrupted && previousInSegment) {
    const distance = haversine(previousInSegment.lat, previousInSegment.lng, lat, lng);
    if (distance > MAX_SEGMENT_DISTANCE) return;
    state.totalDistance += distance;
    if (altitude != null && previousInSegment.alt != null) {
      const deltaAlt = altitude - previousInSegment.alt;
      if (deltaAlt > 2) state.elevationGain += deltaAlt;
    }
  }

  if (state.lastMovingTick) {
    state.movingTimeMs += Date.now() - state.lastMovingTick;
  }
  state.lastMovingTick = Date.now();

  activeSegment.push({
    lat,
    lng,
    alt: altitude,
    time,
    accuracy,
    speed: speedKmh
  });

  mapController.setTrackSegments(state.trackSegments);
  updateStats();
  if (flattenTrackSegments(state.trackSegments).length % 20 === 0) {
    autosaveRecordingState();
  }
}

function onPositionError() {
  dom.gpsDot.className = "gps-dot poor";
  dom.gpsText.textContent = "GPS unavailable";
  if (mapController) mapController.showSplashStatus("GPS unavailable — check permissions");
}

function buildRecoveryStats(snapshot) {
  dom.recoveryStats.textContent = "";
  const stats = [
    { value: (snapshot.totalDistance / 1000).toFixed(2), label: "km" },
    { value: String(flattenTrackSegments(snapshot.trackSegments).length), label: "points" },
    { value: String(snapshot.trackSegments.length), label: "segments" },
    { value: `${Math.round((Date.now() - snapshot.savedAt) / 60000)}m`, label: "ago" }
  ];
  stats.forEach(stat => {
    const box = document.createElement("div");
    box.className = "recovery-stat";
    const value = document.createElement("div");
    value.className = "recovery-stat-val";
    value.textContent = stat.value;
    const label = document.createElement("div");
    label.className = "recovery-stat-lbl";
    label.textContent = stat.label;
    box.append(value, label);
    dom.recoveryStats.append(box);
  });
}

function checkRecovery() {
  const snapshot = loadAutosave();
  if (!snapshot || !snapshot.recording) {
    clearAutosave();
    return;
  }
  recoverySnapshot = snapshot;
  buildRecoveryStats(snapshot);
  dom.recoveryDialog.classList.add("visible");
}

function discardRecovery() {
  recoverySnapshot = null;
  clearAutosave();
  dom.recoveryDialog.classList.remove("visible");
}

async function resumeRecovery() {
  if (!recoverySnapshot) return;
  const snapshot = recoverySnapshot;
  recoverySnapshot = null;
  dom.recoveryDialog.classList.remove("visible");

  state.recording = true;
  state.autoPaused = snapshot.autoPaused;
  state.startTime = snapshot.startTime;
  state.totalDistance = snapshot.totalDistance;
  state.elevationGain = snapshot.elevationGain;
  state.movingTimeMs = snapshot.movingTimeMs;
  state.trackSegments = snapshot.trackSegments;
  state.interruptionCount = snapshot.interruptionCount;
  state.lastMovingTick = snapshot.autoPaused ? null : Date.now();

  dom.btnRecord.classList.add("recording");
  dom.btnExport.classList.add("hidden");
  dom.btnRecenter.classList.add("following");
  mapController.setAutoFollow(true);
  mapController.setTrackSegments(state.trackSegments);
  mapController.fitTrack(state.trackSegments);
  if (snapshot.currentLayer) mapController.setActiveLayer(snapshot.currentLayer);
  setPauseUi(snapshot.autoPaused);
  updateStats();

  await requestWakeLock();
  gpsController.ensureWatch();
  gpsController.forcePositionRefresh();
  state.timerInterval = window.setInterval(updateTimers, 1000);
  state.autosaveInterval = window.setInterval(autosaveRecordingState, AUTOSAVE_INTERVAL);
  toast("Ride recovered");
}

function clearReferenceRide() {
  state.referenceRide = null;
  mapController.clearReference();
  dom.refBadge.classList.remove("visible");
  dom.refBadgeLabel.textContent = "";
  toast("Reference cleared");
}

function buildTrackItem(track) {
  const item = document.createElement("div");
  item.className = `track-item${state.referenceRide?.id === track.id ? " track-ref-active" : ""}`;

  const date = new Date(track.date);
  const dateStr = date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
  const timeStr = date.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });

  const nameRow = document.createElement("div");
  nameRow.className = "track-name-row";
  const input = document.createElement("input");
  input.className = "track-name-input";
  input.type = "text";
  input.value = track.name || "";
  input.placeholder = `${dateStr} ${timeStr}`;
  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") input.blur();
  });
  input.addEventListener("blur", async () => {
    const nextName = input.value.trim();
    if (nextName === track.name) return;
    await updateTrackName(track.id, nextName);
    if (state.referenceRide?.id === track.id) {
      dom.refBadgeLabel.textContent = nextName || dom.refBadgeLabel.textContent;
    }
    showTracks();
  });
  const hint = document.createElement("span");
  hint.className = "rename-hint";
  hint.textContent = "✎";
  nameRow.append(input, hint);

  const top = document.createElement("div");
  top.className = "track-item-top";
  const meta = document.createElement("div");
  meta.className = "track-item-date";
  meta.textContent = `${dateStr} · ${timeStr}`;

  const actions = document.createElement("div");
  actions.className = "track-item-actions";
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.textContent = state.referenceRide?.id === track.id ? "REF" : "Load";
  if (state.referenceRide?.id === track.id) loadButton.classList.add("active");
  loadButton.addEventListener("click", event => {
    event.stopPropagation();
    state.referenceRide = track;
    mapController.setReferenceSegments(track.trackSegments);
    mapController.fitTrack(track.trackSegments);
    dom.refBadge.classList.add("visible");
    dom.refBadgeLabel.textContent = track.name || dateStr;
    dom.tracksOverlay.classList.remove("visible");
    toast("Reference ride loaded");
  });

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "GPX";
  exportButton.addEventListener("click", event => {
    event.stopPropagation();
    const safeName = (track.name || track.date.slice(0, 10)).replace(/[^a-zA-Z0-9\-_]/g, "_").slice(0, 40);
    downloadGPX(track.trackSegments, `KampotRiders_${safeName}`, toast);
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete";
  deleteButton.textContent = "✕";
  deleteButton.addEventListener("click", async event => {
    event.stopPropagation();
    if (!window.confirm("Delete this ride?")) return;
    await deleteTrack(track.id);
    if (state.referenceRide?.id === track.id) clearReferenceRide();
    toast("Ride deleted");
    showTracks();
  });

  actions.append(loadButton, exportButton, deleteButton);
  top.append(meta, actions);

  const stats = document.createElement("div");
  stats.className = "track-item-stats";
  const distance = document.createElement("div");
  const distanceSpan = document.createElement("span");
  distanceSpan.textContent = (track.distance / 1000).toFixed(2);
  distance.append(distanceSpan, document.createTextNode(" km"));
  const climb = document.createElement("div");
  const climbSpan = document.createElement("span");
  climbSpan.textContent = `↑ ${Math.round(track.elevGain)}`;
  climb.append(climbSpan, document.createTextNode(" m"));
  const moving = document.createElement("div");
  const movingSpan = document.createElement("span");
  movingSpan.textContent = formatTime(track.movingTime);
  moving.append(movingSpan);
  stats.append(distance, climb, moving);

  item.append(nameRow, top, stats);
  return item;
}

async function showTracks() {
  const tracks = await loadTracks();
  dom.tracksList.textContent = "";
  if (tracks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No rides recorded yet. Tap the red button to start riding.";
    dom.tracksList.append(empty);
  } else {
    tracks.slice().reverse().forEach(track => dom.tracksList.append(buildTrackItem(track)));
  }
  dom.tracksOverlay.classList.add("visible");
}

async function importGPXFile(file) {
  const text = await file.text();
  const parsed = parseGPX(text);
  if (!parsed || parsed.trackSegments.length === 0) {
    toast("Invalid GPX file");
    return;
  }
  const firstPoint = parsed.trackSegments[0][0];
  await saveRideRecord({
    date: new Date(firstPoint.time).toISOString(),
    name: parsed.name || file.name.replace(/\.gpx$/i, ""),
    distance: parsed.totalDistance,
    elevGain: parsed.elevGain,
    movingTime: parsed.movingTime,
    totalTime: parsed.totalTime,
    interruptionCount: Math.max(0, parsed.trackSegments.length - 1),
    trackSegments: parsed.trackSegments
  });
  toast(`GPX imported — ${(parsed.totalDistance / 1000).toFixed(2)} km`);
  showTracks();
}

function exportCurrentRide() {
  if (flattenTrackSegments(state.trackSegments).length < 2) return;
  downloadGPX(state.trackSegments, `KampotRiders_${new Date().toISOString().slice(0, 10)}`, toast);
}

async function startRecording() {
  resetRideState();
  state.recording = true;
  state.startTime = Date.now();
  state.lastMovingTick = Date.now();
  state.trackSegments = [[]];
  dom.btnRecord.classList.add("recording");
  dom.btnExport.classList.add("hidden");
  dom.btnRecenter.classList.add("following");
  mapController.setAutoFollow(true);
  setPauseUi(false);
  updateStats();
  await requestWakeLock();
  gpsController.ensureWatch();
  state.timerInterval = window.setInterval(updateTimers, 1000);
  state.autosaveInterval = window.setInterval(autosaveRecordingState, AUTOSAVE_INTERVAL);
  toast("Recording started");
}

async function stopRecording() {
  state.recording = false;
  if (state.lastMovingTick && !state.autoPaused) {
    state.movingTimeMs += Date.now() - state.lastMovingTick;
  }
  state.lastMovingTick = null;
  clearIntervals();
  clearAutosave();
  await releaseWakeLock();

  dom.btnRecord.classList.remove("recording");
  dom.pauseBadge.classList.remove("visible");
  dom.btnExport.classList.toggle("hidden", flattenTrackSegments(state.trackSegments).length < 2);
  setStatus("idle");
  updateStats();

  if (flattenTrackSegments(state.trackSegments).length < 2) {
    toast("Not enough points recorded");
    return;
  }

  await saveRideRecord({
    date: new Date(state.startTime).toISOString(),
    name: "",
    distance: state.totalDistance,
    elevGain: state.elevationGain,
    movingTime: state.movingTimeMs,
    totalTime: currentTotalTime(),
    interruptionCount: state.interruptionCount,
    trackSegments: state.trackSegments
  });
  toast(`Ride saved — ${(state.totalDistance / 1000).toFixed(2)} km`);
}

function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (state.recording) requestWakeLock();
  gpsController.handleVisibilityResume();
}

async function init() {
  await openDB();
  mapController = createMapController({
    selectedLayerId: state.selectedLayer,
    googleConfig: {
      enabled: GOOGLE_SATELLITE_CONFIG.enabled,
      apiKey: GOOGLE_SATELLITE_CONFIG.enabled ? GOOGLE_SATELLITE_CONFIG.apiKey : "",
      language: GOOGLE_SATELLITE_CONFIG.language,
      region: GOOGLE_SATELLITE_CONFIG.region
    },
    onLayerSelected: saveLayerSelection,
    onNotice: showMapNotice,
    onLayerLabelChange: label => {
      dom.activeLayerLabel.textContent = label;
    }
  });

  gpsController = createGPSController({
    onPosition,
    onError: onPositionError,
    getRecordingState: () => state.recording
  });
  gpsController.ensureWatch();

  setStatus("idle");
  updateStats();
  checkRecovery();
  window.setTimeout(() => mapController.dismissSplash(), 4000);
}

dom.btnRecord.addEventListener("click", () => {
  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
});
dom.btnExport.addEventListener("click", exportCurrentRide);
dom.btnTracks.addEventListener("click", showTracks);
dom.btnCloseOverlay.addEventListener("click", () => dom.tracksOverlay.classList.remove("visible"));
dom.btnImportGpx.addEventListener("click", () => dom.gpxFileInput.click());
dom.gpxFileInput.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) importGPXFile(file);
  event.target.value = "";
});
dom.clearReferenceButton.addEventListener("click", clearReferenceRide);
dom.btnRecenter.addEventListener("click", () => mapController.recenter());
dom.discardRecoveryButton.addEventListener("click", discardRecovery);
dom.resumeRecoveryButton.addEventListener("click", resumeRecovery);
document.addEventListener("visibilitychange", handleVisibilityChange);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .then(registration => registration.update())
    .catch(error => console.warn("[KR] SW registration failed:", error));
}

init().catch(error => {
  console.error("[KR] Init failed:", error);
  toast("App failed to initialize");
});
