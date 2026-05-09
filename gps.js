export function createGPSController({ onPosition, onError, getRecordingState }) {
  const gpsOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 };
  let watchId = null;
  let pollingId = null;
  let lastFixAt = 0;

  function handleSuccess(position) {
    lastFixAt = Date.now();
    onPosition(position);
  }

  function ensureWatch() {
    if (!("geolocation" in navigator)) return false;
    if (watchId == null) {
      watchId = navigator.geolocation.watchPosition(handleSuccess, onError, gpsOptions);
    }
    if (pollingId == null) {
      pollingId = window.setInterval(() => {
        const stale = !lastFixAt || Date.now() - lastFixAt > 8000;
        if (stale && getRecordingState()) {
          navigator.geolocation.getCurrentPosition(handleSuccess, onError, gpsOptions);
        }
      }, 5000);
    }
    return true;
  }

  function forcePositionRefresh() {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(handleSuccess, onError, gpsOptions);
  }

  function handleVisibilityResume() {
    ensureWatch();
    if (getRecordingState()) {
      forcePositionRefresh();
    }
  }

  function stop() {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (pollingId != null) {
      window.clearInterval(pollingId);
      pollingId = null;
    }
  }

  return {
    ensureWatch,
    forcePositionRefresh,
    handleVisibilityResume,
    stop,
    getLastFixAt: () => lastFixAt
  };
}
