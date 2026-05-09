const DEFAULT_CENTER = [10.594, 104.162];
const DEFAULT_ZOOM = 14;

function layerLabel(layerId) {
  if (layerId === "osm") return "OSM map";
  if (layerId === "satellite") return "Satellite";
  return "Cycle map";
}

function fallbackSuggestion(layerId) {
  if (layerId === "cycle") {
    return { label: "Switch to OSM map", layerId: "osm", extra: "Satellite may also work if configured." };
  }
  if (layerId === "osm") {
    return { label: "Switch to Cycle map", layerId: "cycle", extra: "Satellite may also work if configured." };
  }
  return { label: "Switch to OSM map", layerId: "osm", extra: "Cycle map is also available." };
}

export function createMapController({ selectedLayerId, onLayerSelected, onNotice, onLayerLabelChange }) {
  const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  const trackLine = L.polyline([], { color: "#e83040", weight: 4, opacity: 0.85, smoothFactor: 1 }).addTo(map);
  const refLine = L.polyline([], { color: "#00e5ff", weight: 3, opacity: 0.75, dashArray: "8 6", smoothFactor: 1 });
  const posMarker = L.circleMarker(DEFAULT_CENTER, {
    radius: 7,
    fillColor: "#4a90d4",
    fillOpacity: 1,
    stroke: true,
    color: "#fff",
    weight: 2
  });
  const accCircle = L.circle(DEFAULT_CENTER, {
    radius: 10,
    fillColor: "#4a90d4",
    fillOpacity: 0.08,
    stroke: true,
    color: "#4a90d4",
    weight: 1,
    opacity: 0.2
  });

  const cycleLayer = L.tileLayer("https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors & CyclOSM"
  });
  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  const satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri"
  });

  const layers = { cycle: cycleLayer, osm: osmLayer, satellite: satelliteLayer };
  const layerButtons = [...document.querySelectorAll(".layer-option")];
  const layerToggle = document.getElementById("layerToggle");
  const layerToggleLabel = document.getElementById("layerToggleLabel");
  const layerMenu = document.getElementById("layerMenu");
  const offlineBadge = document.getElementById("offlineBadge");
  let activeLayerId = "cycle";
  let autoFollow = true;
  let initialZoomDone = false;
  const tileFailureCounts = { cycle: 0, osm: 0, satellite: 0 };

  function setLayerButtonState(layerId) {
    layerButtons.forEach(button => {
      button.classList.toggle("active", button.dataset.layer === layerId);
    });
    const label = layerLabel(layerId);
    layerToggleLabel.textContent = label;
    onLayerLabelChange(label);
  }

  function closeLayerMenu() {
    layerMenu.classList.add("hidden");
    layerToggle.setAttribute("aria-expanded", "false");
  }

  function toggleLayerMenu() {
    const opening = layerMenu.classList.contains("hidden");
    layerMenu.classList.toggle("hidden");
    layerToggle.setAttribute("aria-expanded", opening ? "true" : "false");
  }

  function updateOfflineBadge() {
    if (navigator.onLine) {
      offlineBadge.classList.add("hidden");
      return;
    }
    offlineBadge.textContent = activeLayerId === "satellite"
      ? "Offline: satellite needs network"
      : "Offline: cached map when available";
    offlineBadge.classList.remove("hidden");
  }

  function bindTileResilience(layerId, layer) {
    layer.on("tileerror", () => {
      tileFailureCounts[layerId] += 1;
      if (layerId !== activeLayerId || tileFailureCounts[layerId] < 2) return;
      const fallback = fallbackSuggestion(layerId);
      onNotice({
        text: `${layerLabel(layerId)} appears unavailable. Recording continues. ${fallback.extra}`,
        actionLabel: fallback.label,
        actionLayerId: fallback.layerId
      });
    });
    layer.on("tileload", () => {
      tileFailureCounts[layerId] = 0;
    });
  }

  bindTileResilience("cycle", cycleLayer);
  bindTileResilience("osm", osmLayer);
  bindTileResilience("satellite", satelliteLayer);

  function setActiveLayer(layerId, { silent = false } = {}) {
    const requested = layers[layerId] ? layerId : "cycle";
    if (layers[activeLayerId] && map.hasLayer(layers[activeLayerId])) {
      map.removeLayer(layers[activeLayerId]);
    }
    activeLayerId = requested;
    layers[activeLayerId].addTo(map);
    closeLayerMenu();
    setLayerButtonState(activeLayerId);
    updateOfflineBadge();
    if (!silent) onLayerSelected(activeLayerId);
  }

  layerButtons.forEach(button => {
    button.addEventListener("click", () => setActiveLayer(button.dataset.layer));
  });
  layerToggle.addEventListener("click", toggleLayerMenu);
  document.addEventListener("click", event => {
    if (!event.target.closest("#layerSelector")) {
      closeLayerMenu();
    }
  });

  map.on("dragstart", () => {
    autoFollow = false;
    document.getElementById("btnRecenter").classList.remove("following");
    closeLayerMenu();
  });

  window.addEventListener("online", updateOfflineBadge);
  window.addEventListener("offline", updateOfflineBadge);
  setActiveLayer(selectedLayerId || "cycle", { silent: true });

  return {
    map,
    setActiveLayer,
    getActiveLayer: () => activeLayerId,
    setAutoFollow(value) {
      autoFollow = value;
    },
    setCurrentPosition(lat, lng, accuracy) {
      posMarker.setLatLng([lat, lng]).addTo(map);
      accCircle.setLatLng([lat, lng]).setRadius(accuracy).addTo(map);
      if (!initialZoomDone) {
        initialZoomDone = true;
        map.setView([lat, lng], 15, { animate: true });
      }
      if (autoFollow) {
        map.panTo([lat, lng], { animate: true, duration: 0.4 });
      }
    },
    recenter() {
      const latLng = posMarker.getLatLng();
      if (latLng) map.panTo(latLng, { animate: true, duration: 0.3 });
      autoFollow = true;
      document.getElementById("btnRecenter").classList.add("following");
    },
    setTrackSegments(trackSegments) {
      trackLine.setLatLngs(trackSegments.map(segment => segment.map(point => [point.lat, point.lng])));
    },
    setReferenceSegments(trackSegments) {
      refLine.setLatLngs(trackSegments.map(segment => segment.map(point => [point.lat, point.lng])));
      if (!map.hasLayer(refLine)) refLine.addTo(map);
    },
    clearReference() {
      refLine.setLatLngs([]);
      if (map.hasLayer(refLine)) refLine.remove();
    },
    fitTrack(trackSegments) {
      const latLngs = trackSegments.flat().map(point => [point.lat, point.lng]);
      if (latLngs.length > 0) {
        map.fitBounds(latLngs, { padding: [40, 40] });
      }
    },
    dismissSplash() {
      document.getElementById("splash").classList.add("hidden");
    },
    showSplashStatus(message) {
      document.getElementById("splashStatus").textContent = message;
    }
  };
}
