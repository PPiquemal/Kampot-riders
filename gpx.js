import { computeRideMetrics, normalizeTrackSegments } from "./storage.js";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function generateGPX(trackSegments, name) {
  const segments = normalizeTrackSegments(trackSegments);
  const safeName = escapeXml(name || "Kampot Riders");
  const segmentXml = segments.map(segment => {
    const pointsXml = segment.map(point => {
      const ele = point.alt != null ? `<ele>${point.alt.toFixed(1)}</ele>` : "";
      const time = point.time ? `<time>${new Date(point.time).toISOString()}</time>` : "";
      return `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}">${ele}${time}</trkpt>`;
    }).join("\n");
    return `    <trkseg>\n${pointsXml}\n    </trkseg>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Kampot Riders PWA" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${safeName}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${safeName}</name>
${segmentXml}
  </trk>
</gpx>`;
}

export function downloadGPX(trackSegments, name, toast) {
  const gpx = generateGPX(trackSegments, name);
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.gpx`;
  link.click();
  URL.revokeObjectURL(url);
  if (toast) toast("GPX exported");
}

export function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) return null;

  const rawSegments = [...doc.querySelectorAll("trkseg")];
  const fallbackPoints = rawSegments.length === 0 ? [...doc.querySelectorAll("trkpt")] : null;
  const segmentNodes = rawSegments.length > 0 ? rawSegments : [null];

  const trackSegments = segmentNodes.map(segmentNode => {
    const points = [...(segmentNode ? segmentNode.querySelectorAll("trkpt") : fallbackPoints || [])]
      .map((pointNode, index) => {
        const lat = Number.parseFloat(pointNode.getAttribute("lat"));
        const lng = Number.parseFloat(pointNode.getAttribute("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const ele = pointNode.querySelector("ele");
        const timeNode = pointNode.querySelector("time");
        const parsedTime = timeNode ? Date.parse(timeNode.textContent) : NaN;
        return {
          lat,
          lng,
          alt: ele ? Number.parseFloat(ele.textContent) : null,
          time: Number.isFinite(parsedTime) ? parsedTime : Date.now() + index,
          accuracy: 5,
          speed: 0
        };
      })
      .filter(Boolean);
    return points;
  }).filter(segment => segment.length > 0);

  if (trackSegments.length === 0) return null;
  const metrics = computeRideMetrics(trackSegments);
  const nameNode = doc.querySelector("trk > name") || doc.querySelector("metadata > name");
  return {
    trackSegments,
    totalDistance: metrics.totalDistance,
    elevGain: metrics.elevGain,
    movingTime: metrics.movingTime,
    totalTime: metrics.totalTime,
    name: nameNode ? nameNode.textContent.trim() : ""
  };
}
