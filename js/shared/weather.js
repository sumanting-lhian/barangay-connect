/* ================================================
   weather.js — BarangayConnect
   Fetches and displays current weather conditions
   for the barangay's municipality using the
   Open-Meteo API. Results are cached per session
   to avoid redundant network requests.

   APIs used:
     Geocoding  → geocoding-api.open-meteo.com  (name → lat/lon)
     Forecast   → api.open-meteo.com            (lat/lon → weather)

   WHAT IS IN HERE:
     · WMO weather code to description mapping
     · Geocoding with municipality + province fallback chain
     · Current temperature and condition fetching
     · sessionStorage caching keyed by location
     · DOM injection into #weatherTemp and #weatherDesc

   WHAT IS NOT IN HERE:
     · Weather widget styles              → main.css / dashboard.css
     · Barangay location data             → Firestore / firebase-config.js
     · Widget layout and markup           → dashboard.html

   REQUIRED IMPORTS:
     · None — no local dependencies

   QUICK REFERENCE:
     Entry point    → loadWeather(municipality, province)
     DOM targets    → #weatherTemp, #weatherDesc
     Cache key      → weather:{municipality}:{province}
     PH fallback    → { lat: 12.8797, lon: 121.7740 }
================================================ */


/* ================================================
   WMO WEATHER CODE MAP
   Maps WMO weather interpretation codes to
   human-readable condition labels.
================================================ */

const WMO = {
  0:  'Clear Sky',
  1:  'Mostly Clear',
  2:  'Partly Cloudy',
  3:  'Overcast',
  45: 'Foggy',
  48: 'Foggy',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  61: 'Light Rain',
  63: 'Rainy',
  65: 'Heavy Rain',
  71: 'Light Snow',
  73: 'Snowy',
  75: 'Heavy Snow',
  80: 'Light Showers',
  81: 'Rain Showers',
  82: 'Heavy Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};


/* ================================================
   CONFIG
================================================ */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/* Used when geocoding fails for both municipality and province */
const PH_FALLBACK = { lat: 12.8797, lon: 121.7740 };


/* ================================================
   GEOCODING
   Resolves a location query string to coordinates.
   Falls back from municipality+province → province
   only → Philippines center point.
================================================ */

async function geocode(query) {
  const res  = await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`);
  const data = await res.json();
  const r    = data.results?.[0];
  return r ? { lat: r.latitude, lon: r.longitude } : null;
}

async function resolveCoords(municipality, province) {
  if (municipality && province) {
    const coords = await geocode(`${municipality}, ${province}, Philippines`);
    if (coords) return coords;
  }

  if (province) {
    const coords = await geocode(`${province}, Philippines`);
    if (coords) return coords;
  }

  return PH_FALLBACK;
}


/* ================================================
   LOAD WEATHER
   Public entry point. Resolves coordinates, fetches
   current conditions, caches the result, and injects
   it into the DOM. Network errors are silently
   ignored to preserve the placeholder state.
================================================ */

export async function loadWeather(municipality, province) {
  const cacheKey = `weather:${municipality}:${province}`;

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) { applyWeather(JSON.parse(cached)); return; }

    const { lat, lon } = await resolveCoords(municipality, province);

    const res  = await fetch(
      `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weathercode` +
      `&temperature_unit=celsius&timezone=Asia%2FManila`,
    );
    const data = await res.json();

    const result = {
      temp: Math.round(data.current.temperature_2m),
      desc: WMO[data.current.weathercode] ?? 'Weather',
    };

    sessionStorage.setItem(cacheKey, JSON.stringify(result));
    applyWeather(result);
  } catch {
    /* Network error — keep the '—°' placeholder */
  }
}


/* ================================================
   APPLY WEATHER
   Writes temperature and description to their
   respective DOM elements.
================================================ */

function applyWeather({ temp, desc }) {
  const tEl = document.getElementById('weatherTemp');
  const dEl = document.getElementById('weatherDesc');
  if (tEl) tEl.textContent = `${temp}°`;
  if (dEl) dEl.textContent = desc;
}