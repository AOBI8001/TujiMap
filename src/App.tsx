import { useEffect, useMemo, useRef, useState } from "react";
import {
  CITIES,
  DAY_COLORS,
  cityById,
  type CityConfig,
  type CityId,
  type Preference,
  type Spot,
} from "./data";

type Place = {
  id?: string;
  name: string;
  location: string;
  address?: string;
  area?: string;
};
type TravelMode = "driving" | "transit" | "walking";
type RouteDetail = {
  kind: "walk" | "transit" | "drive";
  title: string;
  instruction?: string;
  duration: number;
  distance: number;
  line?: string;
  direction?: string;
  from?: string;
  to?: string;
  via?: number;
};
type RouteSegment = {
  mode: TravelMode;
  duration: number;
  distance: number;
  line: string;
  details: RouteDetail[];
  polyline: string[];
  source: string;
  fromName: string;
  toName: string;
};
type Endpoint = { origin: Place; destination: Place };
type DayRoute = {
  day: number;
  color: string;
  spots: Spot[];
  segments: RouteSegment[];
  distance: number;
  duration: number;
  origin: Place;
  destination: Place;
};
type Stay = { id: string; place: Place | null; days: number; color: string };
type AiResult = {
  spots?: {
    name: string;
    preference: "like" | "avoid";
    day: number | null;
    after?: string | null;
  }[];
  notes?: string[];
  source?: string;
};

const STAY_COLORS = [
  "#168766",
  "#ff704d",
  "#4d71d9",
  "#a863d7",
  "#d99a35",
  "#2f9aa0",
  "#dd5d83",
];
const TRAVEL_MODES: TravelMode[] = ["driving", "transit", "walking"];
const modeLabel: Record<TravelMode, string> = {
  driving: "驾车",
  transit: "公共交通",
  walking: "纯步行",
};
const CITY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const CITY_GROUPS = Object.entries(
  CITIES.reduce<Record<string, CityConfig[]>>((groups, city) => {
    const letter = city.pinyin[0].toUpperCase();
    (groups[letter] ||= []).push(city);
    return groups;
  }, {}),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([letter, cities]) =>
      [
        letter,
        cities.sort((a, b) => a.pinyin.localeCompare(b.pinyin)),
      ] as const,
  );
let amapLoader: Promise<any> | null = null;
const placeQueryCache = new Map<
  string,
  { expires: number; pois: any[] }
>();
const placeQueryInflight = new Map<string, Promise<any[]>>();
const attractionImagePreloads = new Map<string, Promise<boolean>>();
const preparedCityPromises = new Map<CityId, Promise<CityConfig>>();

function preloadAttractionImage(source?: string) {
  if (!source) return Promise.resolve(false);
  const cached = attractionImagePreloads.get(source);
  if (cached) return cached;

  const request = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "high";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (!ok) attractionImagePreloads.delete(source);
      resolve(ok);
    };
    const timeout = window.setTimeout(() => finish(false), 7000);
    image.onload = async () => {
      try {
        await image.decode?.();
      } catch {
        // The decoded bitmap is an optimisation only; the HTTP cache is ready.
      }
      finish(true);
    };
    image.onerror = () => finish(false);
    image.src = source;
  });

  attractionImagePreloads.set(source, request);
  return request;
}

async function preloadAttractionImages(spots: Spot[]) {
  const sources = Array.from(
    new Set(spots.map((spot) => spot.photo).filter(Boolean) as string[]),
  );
  const direct = sources.filter((source) => source.includes("?url="));
  const fallback = sources.filter((source) => !source.includes("?url="));
  let cursor = 0;
  const warmDirect = async () => {
    while (cursor < direct.length) {
      const source = direct[cursor++];
      await preloadAttractionImage(source);
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(6, direct.length) }, () => warmDirect()),
  );
  // 需要按名称查询的图片会消耗高德关键字搜索配额，保持低并发后台补齐。
  let fallbackCursor = 0;
  const warmFallback = async () => {
    while (fallbackCursor < fallback.length) {
      const source = fallback[fallbackCursor++];
      await preloadAttractionImage(source);
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(2, fallback.length) }, () => warmFallback()),
  );
}

function sameOriginUrl(path: string) {
  return new URL(path, window.location.origin).href;
}

async function searchServerPlaces(
  cityName: string,
  keyword: string,
  page = 1,
): Promise<any[]> {
  const cacheKey = `${cityName}:${keyword.trim()}:${page}`;
  const cached = placeQueryCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.pois;
  const inflight = placeQueryInflight.get(cacheKey);
  if (inflight) return inflight;
  const request = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4800);
    try {
      const response = await fetch(
        sameOriginUrl(
          `/api/places?city=${encodeURIComponent(cityName)}&keywords=${encodeURIComponent(keyword)}&page=${page}`,
        ),
        { signal: controller.signal },
      );
      const raw = await response.text();
      let data: any = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("地点服务响应异常");
      }
      if (!response.ok || !Array.isArray(data.pois))
        throw new Error(data.error || "地点服务不可用");
      placeQueryCache.set(cacheKey, {
        pois: data.pois,
        expires: Date.now() + 30 * 60 * 1000,
      });
      return data.pois;
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  placeQueryInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (placeQueryInflight.get(cacheKey) === request)
      placeQueryInflight.delete(cacheKey);
  }
}

async function searchPlaces(
  cityName: string,
  keyword: string,
  pageSize = 10,
) {
  try {
    return (await searchServerPlaces(cityName, keyword, 1)).slice(0, pageSize);
  } catch (error) {
    if ((window as any).AMap)
      return searchAmapPlaces(cityName, keyword, pageSize);
    throw error;
  }
}

function loadAmap() {
  if ((window as any).AMap) return Promise.resolve((window as any).AMap);
  if (amapLoader) return amapLoader;
  amapLoader = (async () => {
    const controller = new AbortController();
    const configTimeout = window.setTimeout(() => controller.abort(), 10000);
    let response: Response | null = null;
    let config: any;
    try {
      response = await fetch(sameOriginUrl("/api/amap-config"), {
        signal: controller.signal,
      });
      config = await response.json();
    } finally {
      window.clearTimeout(configTimeout);
    }
    if (
      !response?.ok ||
      !config?.key ||
      (!config?.serviceHost && !config?.securityCode)
    )
      throw new Error("地图配置不可用");
    (window as any)._AMapSecurityConfig = config.serviceHost
      ? {
          serviceHost: new URL(
            String(config.serviceHost).replace(/\/$/, ""),
            window.location.origin,
          ).href.replace(/\/$/, ""),
        }
      : { securityJsCode: config.securityCode };
    await new Promise<void>((resolve, reject) => {
      const old = document.getElementById(
        "amap-sdk",
      ) as HTMLScriptElement | null;
      if (old && !(window as any).AMap) old.remove();
      const script = document.createElement("script");
      script.id = "amap-sdk";
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${config.key}`;
      const timer = window.setTimeout(() => {
        script.remove();
        reject(new Error("高德地图加载超时"));
      }, 15000);
      script.onload = () => {
        window.clearTimeout(timer);
        (window as any).AMap
          ? resolve()
          : reject(new Error("高德地图鉴权失败"));
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("高德地图脚本加载失败"));
      };
      document.head.appendChild(script);
    });
    return (window as any).AMap;
  })().catch((error) => {
    amapLoader = null;
    throw error;
  });
  return amapLoader;
}

async function searchAmapPlaces(
  cityName: string,
  keyword: string,
  pageSize = 10,
) {
  const AMap = await loadAmap();
  return new Promise<any[]>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("地点搜索超时")),
      4500,
    );
    AMap.plugin("AMap.PlaceSearch", () => {
      const service = new AMap.PlaceSearch({
        city: cityName,
        citylimit: true,
        pageSize,
        pageIndex: 1,
        extensions: "all",
      });
      service.search(keyword, (status: string, result: any) => {
        window.clearTimeout(timer);
        if (status !== "complete") {
          reject(new Error("地点搜索失败"));
          return;
        }
        const expected = cityName.replace(/市$/, "");
        const pois = (result?.poiList?.pois || []).filter((poi: any) => {
          const returnedCity = String(poi.cityname || poi.city || "").replace(
            /市$/,
            "",
          );
          return !returnedCity || returnedCity === expected;
        });
        resolve(pois);
      });
    });
  });
}

async function resolveCityDistrict(cityName: string) {
  const AMap = await loadAmap();
  return new Promise<{ center: string; citycode: string } | null>((resolve) =>
    AMap.plugin("AMap.DistrictSearch", () => {
      const service = new AMap.DistrictSearch({
        level: "city",
        subdistrict: 0,
        extensions: "base",
      });
      service.search(cityName, (status: string, result: any) => {
        const district =
          status === "complete" ? result?.districtList?.[0] : null;
        const center =
          district?.center?.lng != null
            ? `${district.center.lng},${district.center.lat}`
            : district?.center?.toString?.() || "";
        const rawCitycode = Array.isArray(district?.citycode)
          ? district.citycode[0]
          : district?.citycode;
        resolve(
          center ? { center, citycode: String(rawCitycode || cityName) } : null,
        );
      });
    }),
  );
}

function spotFromPoi(
  city: CityConfig,
  poi: any,
  index: number,
  popular: boolean,
): Spot | null {
  const location = poiLocation(poi);
  if (!location) return null;
  return {
    id: `amap-${city.id}-${poi.id || index}`,
    name: String(poi.name || "城市景点"),
    area: poi.adname || poi.district || city.name,
    category: String(poi.type || "景点").split(";")[0],
    description:
      typeof poi.address === "string" && poi.address
        ? poi.address
        : `${city.name}城市景点`,
    duration: 1.5,
    hot: popular
      ? index < 14
        ? 100 - index
        : 89
      : Math.max(55, 79 - Math.floor(index / 2)),
    location,
    icon: popular ? "热" : "景",
    rating: poi.biz_ext?.rating || "",
    address: typeof poi.address === "string" ? poi.address : "",
    photo:
      poiPhoto(poi) ||
      namedSpotPhoto(city.name, String(poi.name || "城市景点")),
    source: "amap",
  };
}

async function prepareCity(city: CityConfig): Promise<CityConfig> {
  // 进入地图前先通过同源服务端接口取景点，避免 JS SDK 域名鉴权异常时
  // 初始页面一直卡在“正在载入城市景点”。地图本身随后独立加载并给出错误。
  const [popularPois, broadPois] = await Promise.all([
    searchServerPlaces(city.name, "旅游景点", 1).catch(() => []),
    searchServerPlaces(city.name, "景点", 2).catch(() => []),
  ]);
  const firstLocation = poiLocation(popularPois[0] || broadPois[0] || {});
  const center = city.spots.length ? city.center : firstLocation || city.center;
  const radius = city.tier <= 1.5 ? 24 : city.tier === 2 ? 21 : 18;
  const popularSpots = popularPois
    .map((poi, index) => spotFromPoi(city, poi, index, true))
    .filter((spot): spot is Spot => Boolean(spot));
  const broadSpots = broadPois
    .map((poi, index) => spotFromPoi(city, poi, index, false))
    .filter((spot): spot is Spot => Boolean(spot));
  const normalizedName = (name: string) => name.replace(/[·\s()（）-]/g, "");
  const merged: Spot[] = [];
  const names = new Set<string>();
  const add = (candidate: Spot | null) => {
    if (!candidate || distanceKm(center, candidate.location) > radius) return;
    const name = normalizedName(candidate.name);
    if (!name || names.has(name)) return;
    names.add(name);
    merged.push(candidate);
  };
  city.spots.forEach((seed) => {
    const seedName = normalizedName(seed.name);
    const match = [...popularSpots, ...broadSpots].find((spot) => {
      const candidate = normalizedName(spot.name);
      return (
        candidate === seedName ||
        (Math.min(candidate.length, seedName.length) >= 3 &&
          (candidate.includes(seedName) || seedName.includes(candidate)))
      );
    });
    add({
      ...seed,
      photo: match?.photo || seed.photo || namedSpotPhoto(city.name, seed.name),
      rating: match?.rating || seed.rating,
      address: match?.address || seed.address,
    });
  });
  popularSpots.forEach(add);
  broadSpots.forEach(add);
  const centerSpot: Spot = {
    id: `${city.id}-center`,
    name: `${city.name}市中心`,
    area: "中心城区",
    category: "城市中心",
    description: `${city.name}中心城区`,
    duration: 1,
    hot: 50,
    location: center,
    icon: "城",
    source: "amap",
  };
  return {
    ...city,
    center,
    routeCity: String(
      popularPois[0]?.citycode || broadPois[0]?.citycode || city.routeCity,
    ),
    defaultStart: city.spots.length ? city.defaultStart : centerSpot,
    mapTarget: Math.max(city.mapTarget, Math.min(48, merged.length)),
    spots: merged.slice(0, 48),
  };
}

function prepareCityCached(city: CityConfig) {
  const cached = preparedCityPromises.get(city.id);
  if (cached) return cached;
  const request = prepareCity(city).catch(() => city);
  preparedCityPromises.set(city.id, request);
  return request;
}

function poiLocation(poi: any) {
  if (typeof poi.location === "string") return poi.location;
  if (poi.location?.lng != null && poi.location?.lat != null)
    return `${poi.location.lng},${poi.location.lat}`;
  return poi.location?.toString?.() || "";
}

function poiPhoto(poi: any) {
  const source = String(poi?.photo || poi?.photos?.[0]?.url || "").trim();
  if (!source) return "";
  if (source.startsWith("/api/amap-photo?")) return source;
  // 经同源服务转发，统一处理高德旧 HTTP 图片、防盗链与跨域失败。
  return `/api/amap-photo?url=${encodeURIComponent(source)}`;
}

function namedSpotPhoto(cityName: string, spotName: string) {
  return `/api/amap-photo?city=${encodeURIComponent(cityName)}&name=${encodeURIComponent(spotName)}`;
}

function coords(location: string) {
  const [lng, lat] = location.split(",").map(Number);
  return { lng, lat };
}
function distanceKm(a: string, b: string) {
  const p1 = coords(a);
  const p2 = coords(b);
  const rad = Math.PI / 180;
  const x = (p2.lng - p1.lng) * rad * Math.cos(((p1.lat + p2.lat) / 2) * rad);
  const y = (p2.lat - p1.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371;
}

function attractionStem(name: string) {
  return name
    .replace(/[\s·—_()（）【】\[\]，,。.-]/g, "")
    .replace(/(景区|风景区|旅游区|文化旅游区|遗址公园|森林公园|湿地公园|公园|博物馆|纪念馆|艺术馆|展览馆|度假区|游览区)$/g, "")
    .replace(/(东门|西门|南门|北门|正门|侧门|入口|出口|游客中心|停车场|码头)$/g, "");
}

function sameAttraction(a: Spot, b: Spot) {
  const distance = distanceKm(a.location, b.location);
  if (distance > 3) return false;
  const first = attractionStem(a.name);
  const second = attractionStem(b.name);
  if (!first || !second) return distance < 0.12;
  if (
    Math.min(first.length, second.length) >= 3 &&
    (first.includes(second) || second.includes(first))
  )
    return true;
  const pairs = (value: string) =>
    new Set(
      Array.from({ length: Math.max(0, value.length - 1) }, (_, index) =>
        value.slice(index, index + 2),
      ),
    );
  const firstPairs = pairs(first);
  const genericPairs = new Set([
    "北京",
    "南京",
    "上海",
    "广州",
    "中国",
    "景区",
    "公园",
    "文化",
    "旅游",
    "城市",
  ]);
  const sharedPairs = [...pairs(second)].filter(
    (pair) => firstPairs.has(pair) && !genericPairs.has(pair),
  );
  if (distance < 0.38 && sharedPairs.length >= 1) return true;
  const gateOrBranch = /(门|入口|出口|游客中心|码头|分馆|园区)/;
  return distance < 3 && gateOrBranch.test(a.name + b.name) && sharedPairs.length >= 1;
}

function selectCardSpots(items: Spot[]) {
  const ranked = [...items].sort(
    (a, b) =>
      b.hot - a.hot || Number(b.rating || 0) - Number(a.rating || 0),
  );
  const unique: Spot[] = [];
  for (const spot of ranked) {
    if (unique.some((kept) => sameAttraction(kept, spot))) continue;
    unique.push(spot);
  }
  const clearlyPopular = unique.filter(
    (spot) => spot.hot >= 88 || Number(spot.rating || 0) >= 4.6,
  );
  const target = Math.min(20, Math.max(8, clearlyPopular.length));
  return unique.slice(0, Math.min(target, unique.length));
}
function samePlace(a: Place, b: Place) {
  return a.location === b.location;
}
function offsetRoutePath(polyline: string[], meters: number) {
  const points = polyline.map((point) => point.split(",").map(Number));
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const latitude = (point[1] * Math.PI) / 180;
    const metersPerLng = 111320 * Math.cos(latitude);
    const east = (next[0] - previous[0]) * metersPerLng;
    const north = (next[1] - previous[1]) * 111320;
    const length = Math.hypot(east, north);
    if (!length) return point;
    const offsetLng = ((north / length) * meters) / metersPerLng;
    const offsetLat = ((-east / length) * meters) / 111320;
    return [point[0] + offsetLng, point[1] + offsetLat];
  });
}
function minutes(seconds: number) {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60));
}
function distanceLabel(meters: number) {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
}
function setMobileMapView(map: any, locations: string[], fallback: string) {
  const valid = locations
    .map((location) => coords(location))
    .filter(
      (point) => Number.isFinite(point.lng) && Number.isFinite(point.lat),
    );
  if (!valid.length) valid.push(coords(fallback));
  const minLng = Math.min(...valid.map((point) => point.lng));
  const maxLng = Math.max(...valid.map((point) => point.lng));
  const minLat = Math.min(...valid.map((point) => point.lat));
  const maxLat = Math.max(...valid.map((point) => point.lat));
  const span = distanceKm(`${minLng},${minLat}`, `${maxLng},${maxLat}`);
  const zoom =
    span < 1.2
      ? 15
      : span < 3
        ? 14.2
        : span < 6
          ? 13.5
          : span < 12
            ? 12.8
            : span < 22
              ? 12.2
              : 12;
  map.setZoomAndCenter?.(
    zoom,
    [(minLng + maxLng) / 2, (minLat + maxLat) / 2],
    false,
    520,
  );
}

function orderStops(items: Spot[], start: Place, end: Place) {
  const left = [...items];
  const ordered: Spot[] = [];
  let cursor = start.location;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (
        distanceKm(cursor, left[i].location) <
        distanceKm(cursor, left[best].location)
      )
        best = i;
    const [next] = left.splice(best, 1);
    ordered.push(next);
    cursor = next.location;
  }
  for (let pass = 0; pass < 8 && ordered.length > 2; pass++) {
    let improved = false;
    for (let i = 0; i < ordered.length - 1; i++)
      for (let j = i + 1; j < ordered.length; j++) {
        const a = i === 0 ? start.location : ordered[i - 1].location;
        const b = ordered[i].location;
        const c = ordered[j].location;
        const d =
          j === ordered.length - 1 ? end.location : ordered[j + 1].location;
        if (
          distanceKm(a, b) + distanceKm(c, d) >
          distanceKm(a, c) + distanceKm(b, d) + 0.03
        ) {
          ordered.splice(i, j - i + 1, ...ordered.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    if (!improved) break;
  }
  return ordered;
}

function openPathDistance(items: Spot[]) {
  let total = 0;
  for (let index = 0; index < items.length - 1; index++)
    total += distanceKm(items[index].location, items[index + 1].location);
  return total;
}

// 没有住处时不强行制造“回到暂定住处”的闭环：尝试每个景点作为
// 起点，用最近邻和开放路径 2-opt 找到更短的单向游览顺序。
function orderOpenStops(items: Spot[]) {
  if (items.length < 3) return [...items];
  let bestOrder = [...items];
  let bestDistance = Infinity;
  for (let startIndex = 0; startIndex < items.length; startIndex++) {
    const left = items.filter((_, index) => index !== startIndex);
    const ordered = [items[startIndex]];
    while (left.length) {
      const cursor = ordered.at(-1)!;
      let nearest = 0;
      for (let index = 1; index < left.length; index++)
        if (
          distanceKm(cursor.location, left[index].location) <
          distanceKm(cursor.location, left[nearest].location)
        )
          nearest = index;
      ordered.push(left.splice(nearest, 1)[0]);
    }
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (let i = 1; i < ordered.length - 1; i++)
        for (let j = i + 1; j < ordered.length; j++) {
          const before = ordered[i - 1];
          const first = ordered[i];
          const last = ordered[j];
          const after = ordered[j + 1];
          const current =
            distanceKm(before.location, first.location) +
            (after ? distanceKm(last.location, after.location) : 0);
          const reversed =
            distanceKm(before.location, last.location) +
            (after ? distanceKm(first.location, after.location) : 0);
          if (reversed + 0.03 < current) {
            ordered.splice(i, j - i + 1, ...ordered.slice(i, j + 1).reverse());
            improved = true;
          }
        }
      if (!improved) break;
    }
    const total = openPathDistance(ordered);
    if (total < bestDistance) {
      bestDistance = total;
      bestOrder = ordered;
    }
  }
  return bestOrder;
}

function groupByDay(
  items: Spot[],
  days: number,
  endpoints: Endpoint[],
  locks: Record<string, number>,
) {
  const count = Math.max(1, days);
  const groups: Spot[][] = Array.from({ length: count }, () => []);
  const unlocked = items.filter(
    (item) => !locks[item.id] || locks[item.id] > count,
  );
  for (const item of items) {
    const locked = locks[item.id];
    if (locked && locked <= count) groups[locked - 1].push(item);
  }
  if (unlocked.length) {
    const target = Math.max(1, Math.ceil(items.length / count));
    const remaining = [...unlocked];
    const centroid = (day: number) => {
      const points = groups[day].map((item) => coords(item.location));
      if (!points.length)
        return coords(
          endpoints[day]?.origin?.location || remaining[0].location,
        );
      return {
        lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
        lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
      };
    };
    const seedDay = (day: number) => {
      if (groups[day].length || !remaining.length) return;
      let best = 0;
      if (day === 0) {
        for (let index = 1; index < remaining.length; index++) {
          if (
            coords(remaining[index].location).lng <
            coords(remaining[best].location).lng
          )
            best = index;
        }
      } else if (groups.some((group) => group.length)) {
        let bestDistance = -1;
        for (let index = 0; index < remaining.length; index++) {
          const nearest = Math.min(
            ...groups.map((group, groupDay) =>
              group.length
                ? distanceKm(
                    remaining[index].location,
                    `${centroid(groupDay).lng},${centroid(groupDay).lat}`,
                  )
                : Infinity,
            ),
          );
          if (nearest > bestDistance) {
            best = index;
            bestDistance = nearest;
          }
        }
      }
      groups[day].push(remaining.splice(best, 1)[0]);
    };
    for (let day = 0; day < count; day++) seedDay(day);
    while (remaining.length) {
      let bestPoint = 0;
      let bestDay = 0;
      let bestScore = Infinity;
      for (let pointIndex = 0; pointIndex < remaining.length; pointIndex++)
        for (let day = 0; day < count; day++) {
          const center = centroid(day);
          const loadPenalty =
            1 +
            Math.max(0, groups[day].length - target + 1) * 1.8 +
            (groups[day].length / target) * 0.2;
          const score =
            distanceKm(
              remaining[pointIndex].location,
              `${center.lng},${center.lat}`,
            ) * loadPenalty;
          if (score < bestScore) {
            bestScore = score;
            bestPoint = pointIndex;
            bestDay = day;
          }
        }
      groups[bestDay].push(remaining.splice(bestPoint, 1)[0]);
    }
  }
  return groups.map((group, day) =>
    orderStops(group, endpoints[day].origin, endpoints[day].destination),
  );
}

function tentativePlace(city: CityConfig): Place {
  return {
    ...city.defaultStart,
    name: `暂定住处（${city.defaultStart.name}）`,
  };
}
function endpointsFromStays(days: number, stays: Stay[], city: CityConfig) {
  const result: Endpoint[] = [];
  let day = 0;
  for (const stay of stays)
    for (let i = 0; i < stay.days && day < days; i++, day++) {
      const place = stay.place || tentativePlace(city);
      result.push({ origin: place, destination: place });
    }
  while (result.length < days)
    result.push({
      origin: tentativePlace(city),
      destination: tentativePlace(city),
    });
  return result;
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <img src={sameOriginUrl("/tuji-logo.png")} alt="" />
    </span>
  );
}
function Brand() {
  return (
    <div className="brand">
      <LogoMark />
      <b>途迹</b>
    </div>
  );
}

function PlaceField({
  value,
  onSelect,
  cityName,
  placeholder = "搜索地点",
  compact = false,
}: {
  value?: Place;
  onSelect: (place: Place) => void;
  cityName: string;
  placeholder?: string;
  compact?: boolean;
}) {
  const [text, setText] = useState(value?.name || "");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => setText(value?.name || ""), [value?.location, value?.name]);
  useEffect(() => {
    if (!open || text.trim().length < 2 || text === value?.name) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const pois = await searchPlaces(cityName, text, 7);
        if (!cancelled) setResults(
          pois
            .map((poi) => ({
              id: poi.id,
              name: poi.name,
              location: poiLocation(poi),
              address: typeof poi.address === "string" ? poi.address : "",
              area: poi.adname || poi.district || cityName,
            }))
            .filter((place) => place.location),
        );
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, open, value?.name, cityName]);
  const choose = (place: Place) => {
    onSelect(place);
    setText(place.name);
    setResults([]);
    setOpen(false);
  };
  return (
    <div className={`place-field ${compact ? "compact" : ""}`}>
      <div className="field-icon">⌖</div>
      <input
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        placeholder={placeholder}
      />
      {open && results.length > 0 && (
        <div className="place-results">
          {results.map((item, index) => (
            <button
              key={`${item.location}-${index}`}
              onClick={() => choose(item)}
            >
              <b>{item.name}</b>
              <span>{item.address || item.area || `${cityName}市`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StayTimeline({
  days,
  stays,
  onChange,
}: {
  days: number;
  stays: Stay[];
  onChange: (stays: Stay[]) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragBoundary = (index: number, event: React.PointerEvent) => {
    event.preventDefault();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const before = stays
      .slice(0, index)
      .reduce((sum, stay) => sum + stay.days, 0);
    const pairTotal = stays[index].days + stays[index + 1].days;
    const move = (pointer: PointerEvent) => {
      const absolute = Math.max(
        before + 1,
        Math.min(
          before + pairTotal - 1,
          Math.round(((pointer.clientX - rect.left) / rect.width) * days),
        ),
      );
      const leftDays = absolute - before;
      onChange(
        stays.map((stay, stayIndex) =>
          stayIndex === index
            ? { ...stay, days: leftDays }
            : stayIndex === index + 1
              ? { ...stay, days: pairTotal - leftDays }
              : stay,
        ),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  let from = 1;
  return (
    <div className="stay-timeline" ref={barRef}>
      {stays.map((stay, index) => {
        const start = from;
        const end = from + stay.days - 1;
        from = end + 1;
        return (
          <div
            className="stay-segment"
            key={stay.id}
            style={{
              width: `${(stay.days / days) * 100}%`,
              background: stay.color,
            }}
          >
            <b>{start === end ? `第${start}天` : `${start}–${end}天`}</b>
            <span>{stay.place?.name || "暂定"}</span>
            {index < stays.length - 1 && (
              <button
                className="stay-boundary"
                onPointerDown={(event) => dragBoundary(index, event)}
                aria-label="拖动调整入住天数"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function LegacySetup({
  cityId,
  setCityId,
  days,
  setDays,
  stays,
  setStays,
  onEnter,
  entering,
}: {
  cityId: CityId | null;
  setCityId: (city: CityId) => void;
  days: number;
  setDays: (days: number) => void;
  stays: Stay[];
  setStays: (stays: Stay[]) => void;
  onEnter: () => void;
  entering: boolean;
}) {
  const [candidate, setCandidate] = useState<Place | undefined>();
  const [cityMenuOpen, setCityMenuOpen] = useState(false);
  const [cityQuery, setCityQuery] = useState("");
  const cityListRef = useRef<HTMLDivElement>(null);
  const city = cityId ? cityById(cityId) : null;
  const query = cityQuery.trim().toLowerCase();
  const visibleGroups = query
    ? Object.entries(
        CITIES.filter(
          (item) =>
            item.name.includes(cityQuery.trim()) ||
            item.pinyin.toLowerCase().includes(query),
        ).reduce<Record<string, CityConfig[]>>((groups, item) => {
          const letter = item.pinyin[0].toUpperCase();
          (groups[letter] ||= []).push(item);
          return groups;
        }, {}),
      )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([letter, items]) =>
            [
              letter,
              items.sort((a, b) => a.pinyin.localeCompare(b.pinyin)),
            ] as const,
        )
    : CITY_GROUPS;
  const changeCity = (next: CityId) => {
    setCityMenuOpen(false);
    setCityQuery("");
    if (next === cityId) return;
    setCityId(next);
    setCandidate(undefined);
    setStays([
      { id: `tentative-${next}`, place: null, days, color: STAY_COLORS[0] },
    ]);
  };
  const changeDays = (nextDays: number) => {
    const delta = nextDays - days;
    const next = stays.map((stay) => ({ ...stay }));
    next[next.length - 1].days += delta;
    while (next.length > 1 && next[next.length - 1].days < 1) {
      const removed = next.pop()!;
      next[next.length - 1].days += removed.days;
    }
    if (next[next.length - 1].days < 1) next[next.length - 1].days = 1;
    setDays(nextDays);
    setStays(next);
  };
  const addStay = () => {
    if (!candidate) return;
    if (stays.every((stay) => !stay.place)) {
      setStays([
        { id: `${Date.now()}`, place: candidate, days, color: STAY_COLORS[0] },
      ]);
      setCandidate(undefined);
      return;
    }
    if (stays.length >= days) return;
    const next = stays.map((stay) => ({ ...stay }));
    const donor = next.findLastIndex((stay) => stay.days > 1);
    if (donor < 0) return;
    next[donor].days -= 1;
    next.push({
      id: `${Date.now()}`,
      place: candidate,
      days: 1,
      color: STAY_COLORS[next.length % STAY_COLORS.length],
    });
    setStays(next);
    setCandidate(undefined);
  };
  const addTentative = () => {
    if (stays.some((stay) => !stay.place) || stays.length >= days) return;
    const next = stays.map((stay) => ({ ...stay }));
    const donor = next.findLastIndex((stay) => stay.days > 1);
    if (donor < 0) return;
    next[donor].days -= 1;
    next.push({
      id: `tentative-${Date.now()}`,
      place: null,
      days: 1,
      color: STAY_COLORS[next.length % STAY_COLORS.length],
    });
    setStays(next);
  };
  const removeStay = (index: number) => {
    if (stays.length === 1) return;
    const next = stays.map((stay) => ({ ...stay }));
    const [removed] = next.splice(index, 1);
    next[Math.max(0, index - 1)].days += removed.days;
    setStays(next);
  };
  const jumpToLetter = (letter: string) =>
    cityListRef.current
      ?.querySelector<HTMLElement>(`[data-letter="${letter}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <main className="setup-screen">
      <header>
        <Brand />
        <span className="api-ready">
          <i /> 实时地图
        </span>
      </header>
      <section className="setup-copy">
        <h1>
          随心成行，
          <br />
          <em>按途索迹。</em>
        </h1>
        <p>选好城市和住处，开始规划你的城市环线。</p>
      </section>
      <section className="setup-card stay-setup">
        <div className="setup-field-head destination-head">
          <span>目的地</span>
          <small>{city ? "点击切换城市" : "先选择想去的城市"}</small>
        </div>
        <div className={`city-control ${cityMenuOpen ? "open" : ""}`}>
          <button
            className={`city-select ${city ? "selected" : "empty"}`}
            aria-expanded={cityMenuOpen}
            onClick={() => setCityMenuOpen((open) => !open)}
          >
            <span>
              <b>{city?.name || "选择城市"}</b>
              <small>{city?.urbanLabel || "100 座一线至三线城市"}</small>
            </span>
            <i>⌄</i>
          </button>
          {cityMenuOpen && (
            <div className="city-menu city-menu-indexed">
              <div className="city-list" ref={cityListRef}>
                {CITY_GROUPS.map(([letter, items]) => (
                  <section
                    className="city-letter-group"
                    data-letter={letter}
                    key={letter}
                  >
                    <strong>{letter}</strong>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        className={item.id === cityId ? "active" : ""}
                        onClick={() => changeCity(item.id)}
                      >
                        <span>
                          <b>{item.name}</b>
                          <small>
                            {item.pinyin} ·{" "}
                            {item.urbanLabel.replace("城市", "")}
                          </small>
                        </span>
                        <i>{item.id === cityId ? "✓" : ""}</i>
                      </button>
                    ))}
                  </section>
                ))}
              </div>
              <nav className="city-index" aria-label="城市首字母索引">
                {CITY_ALPHABET.map((letter) => {
                  const available = CITY_GROUPS.some(
                    ([group]) => group === letter,
                  );
                  return (
                    <button
                      key={letter}
                      type="button"
                      disabled={!available}
                      onClick={() => jumpToLetter(letter)}
                      aria-label={`跳转到${letter}`}
                    >
                      {letter}
                    </button>
                  );
                })}
              </nav>
            </div>
          )}
        </div>
        <div className="setup-section days-section">
          <div className="setup-field-head">
            <span>旅行天数</span>
            <strong>
              {days}
              <small>天</small>
            </strong>
          </div>
          <input
            className="days-slider"
            style={
              {
                "--days-progress": `${((days - 1) / 6) * 100}%`,
              } as React.CSSProperties
            }
            type="range"
            min="1"
            max="7"
            value={days}
            onChange={(event) => changeDays(Number(event.target.value))}
          />
          <div className="range-labels">
            <span>1 天</span>
            <i>左右拖动</i>
            <span>7 天</span>
          </div>
        </div>
        <div className="setup-section stays-section">
          <div className="setup-field-head">
            <span>住处安排</span>
            <small>{stays.length > 1 ? "拖动白色分界调整" : ""}</small>
          </div>
          <StayTimeline days={days} stays={stays} onChange={setStays} />
          <div className="stay-list">
            {stays.map((stay, index) => (
              <span key={stay.id}>
                <i style={{ background: stay.color }} />
                {stay.place?.name || "暂定住处"}
                {stay.place && stays.length > 1 && (
                  <button
                    onClick={() => removeStay(index)}
                    aria-label={`移除${stay.place.name}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!stays.some((stay) => !stay.place) && (
              <button
                className="add-tentative"
                onClick={addTentative}
                disabled={stays.length >= days}
              >
                <span>暂定住处</span>
                <b>＋</b>
              </button>
            )}
          </div>
          <div className="add-stay">
            {city ? (
              <PlaceField
                value={candidate}
                onSelect={setCandidate}
                cityName={city.name}
                placeholder={`输入${city.name}酒店或住处`}
                compact
              />
            ) : (
              <div className="city-required">选择城市后搜索住处</div>
            )}
            <button
              onClick={addStay}
              disabled={
                !city ||
                !candidate ||
                (stays.length >= days && !stays.every((stay) => !stay.place))
              }
            >
              新增
            </button>
          </div>
        </div>
        <button
          className={`enter-button ${entering ? "loading" : ""}`}
          onClick={onEnter}
          disabled={!city || entering}
        >
          <span>
            {entering ? "正在载入城市景点" : city ? "进入地图" : "请先选择城市"}
          </span>
          <i>{entering ? "•••" : "→"}</i>
        </button>
      </section>
      <div className="loop-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>起点</span>
      </div>
      <footer className="setup-signature">
        DESIGNED &amp; BUILT BY AOBI · 2026
      </footer>
    </main>
  );
}

function Setup({
  cityId,
  setCityId,
  days,
  setDays,
  stays,
  setStays,
  onEnter,
  entering,
}: {
  cityId: CityId | null;
  setCityId: (city: CityId) => void;
  days: number;
  setDays: (days: number) => void;
  stays: Stay[];
  setStays: (stays: Stay[]) => void;
  onEnter: () => void;
  entering: boolean;
}) {
  const [candidate, setCandidate] = useState<Place | undefined>();
  const [cityMenuOpen, setCityMenuOpen] = useState(false);
  const [cityQuery, setCityQuery] = useState("");
  const cityListRef = useRef<HTMLDivElement>(null);
  const city = cityId ? cityById(cityId) : null;
  const query = cityQuery.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (!query) return CITY_GROUPS;
    const matches = CITIES.filter(
      (item) =>
        item.name.includes(cityQuery.trim()) ||
        item.pinyin.toLowerCase().includes(query),
    );
    return Object.entries(
      matches.reduce<Record<string, CityConfig[]>>((groups, item) => {
        const letter = item.pinyin[0].toUpperCase();
        (groups[letter] ||= []).push(item);
        return groups;
      }, {}),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([letter, items]) =>
          [
            letter,
            items.sort((a, b) => a.pinyin.localeCompare(b.pinyin)),
          ] as const,
      );
  }, [query, cityQuery]);
  const changeCity = (next: CityId) => {
    setCityMenuOpen(false);
    setCityQuery("");
    if (next === cityId) return;
    setCityId(next);
    setCandidate(undefined);
    setStays([
      { id: `tentative-${next}`, place: null, days, color: STAY_COLORS[0] },
    ]);
  };
  const changeDays = (nextDays: number) => {
    const delta = nextDays - days;
    const next = stays.map((stay) => ({ ...stay }));
    next[next.length - 1].days += delta;
    while (next.length > 1 && next[next.length - 1].days < 1) {
      const removed = next.pop()!;
      next[next.length - 1].days += removed.days;
    }
    if (next[next.length - 1].days < 1) next[next.length - 1].days = 1;
    setDays(nextDays);
    setStays(next);
  };
  const addStay = () => {
    if (!candidate) return;
    if (stays.every((stay) => !stay.place)) {
      setStays([
        { id: `${Date.now()}`, place: candidate, days, color: STAY_COLORS[0] },
      ]);
      setCandidate(undefined);
      return;
    }
    if (stays.length >= days) return;
    const next = stays.map((stay) => ({ ...stay }));
    const donor = next.findLastIndex((stay) => stay.days > 1);
    if (donor < 0) return;
    next[donor].days -= 1;
    next.push({
      id: `${Date.now()}`,
      place: candidate,
      days: 1,
      color: STAY_COLORS[next.length % STAY_COLORS.length],
    });
    setStays(next);
    setCandidate(undefined);
  };
  const addTentative = () => {
    if (stays.some((stay) => !stay.place) || stays.length >= days) return;
    const next = stays.map((stay) => ({ ...stay }));
    const donor = next.findLastIndex((stay) => stay.days > 1);
    if (donor < 0) return;
    next[donor].days -= 1;
    next.push({
      id: `tentative-${Date.now()}`,
      place: null,
      days: 1,
      color: STAY_COLORS[next.length % STAY_COLORS.length],
    });
    setStays(next);
  };
  const removeStay = (index: number) => {
    if (stays.length === 1) return;
    const next = stays.map((stay) => ({ ...stay }));
    const [removed] = next.splice(index, 1);
    next[Math.max(0, index - 1)].days += removed.days;
    setStays(next);
  };
  const jumpToLetter = (letter: string) =>
    cityListRef.current
      ?.querySelector<HTMLElement>(`[data-letter="${letter}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  const firstMatch = visibleGroups[0]?.[1]?.[0];
  return (
    <main className="setup-screen">
      <header>
        <Brand />
        <span className="api-ready">
          <i /> 实时地图
        </span>
      </header>
      <section className="setup-copy">
        <h1>
          随心成行，
          <br />
          <em>按途索迹。</em>
        </h1>
        <p>选好城市和住处，开始规划你的城市环线。</p>
      </section>
      <section className="setup-card stay-setup">
        <div className="setup-field-head destination-head">
          <span>目的地</span>
          <small>{city ? "可输入城市名或拼音切换" : "输入城市名或拼音"}</small>
        </div>
        <div className={`city-control ${cityMenuOpen ? "open" : ""}`}>
          <div
            className={`city-select city-combobox ${city ? "selected" : "empty"}`}
          >
            <span>
              <input
                aria-label="选择城市"
                value={cityMenuOpen ? cityQuery : city?.name || ""}
                placeholder="输入城市名或拼音"
                onFocus={() => {
                  setCityMenuOpen(true);
                  setCityQuery("");
                }}
                onChange={(event) => {
                  setCityQuery(event.target.value);
                  setCityMenuOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && firstMatch)
                    changeCity(firstMatch.id);
                }}
              />
              <small>
                {cityMenuOpen
                  ? query
                    ? `${visibleGroups.reduce((sum, [, items]) => sum + items.length, 0)} 个匹配城市`
                    : "按 A–Z 排列"
                  : city
                    ? city.pinyin
                    : "支持 100 座城市"}
              </small>
            </span>
            <button
              type="button"
              aria-label="展开城市列表"
              aria-expanded={cityMenuOpen}
              onClick={() => {
                setCityMenuOpen((open) => !open);
                setCityQuery("");
              }}
            >
              ⌄
            </button>
          </div>
          {cityMenuOpen && (
            <div className="city-menu city-menu-indexed">
              <div className="city-list" ref={cityListRef}>
                {visibleGroups.length ? (
                  visibleGroups.map(([letter, items]) => (
                    <section
                      className="city-letter-group"
                      data-letter={letter}
                      key={letter}
                    >
                      <strong>{letter}</strong>
                      {items.map((item) => (
                        <button
                          key={item.id}
                          className={item.id === cityId ? "active" : ""}
                          onClick={() => changeCity(item.id)}
                        >
                          <span>
                            <b>{item.name}</b>
                            <small>{item.pinyin}</small>
                          </span>
                          <i>{item.id === cityId ? "✓" : ""}</i>
                        </button>
                      ))}
                    </section>
                  ))
                ) : (
                  <div className="city-empty">没有匹配的城市</div>
                )}
              </div>
              {!query && (
                <nav className="city-index" aria-label="城市首字母索引">
                  {CITY_ALPHABET.map((letter) => {
                    const available = CITY_GROUPS.some(
                      ([group]) => group === letter,
                    );
                    return (
                      <button
                        key={letter}
                        type="button"
                        disabled={!available}
                        onClick={() => jumpToLetter(letter)}
                        aria-label={`跳转到${letter}`}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </nav>
              )}
            </div>
          )}
        </div>
        <div className="setup-section days-section">
          <div className="setup-field-head">
            <span>旅行天数</span>
            <strong>
              {days}
              <small>天</small>
            </strong>
          </div>
          <input
            className="days-slider"
            style={
              {
                "--days-progress": `${((days - 1) / 6) * 100}%`,
              } as React.CSSProperties
            }
            type="range"
            min="1"
            max="7"
            value={days}
            onChange={(event) => changeDays(Number(event.target.value))}
          />
          <div className="range-labels">
            <span>1 天</span>
            <i>左右拖动</i>
            <span>7 天</span>
          </div>
        </div>
        <div className="setup-section stays-section">
          <div className="setup-field-head">
            <span>住处安排</span>
            <small>{stays.length > 1 ? "拖动白色分界调整" : ""}</small>
          </div>
          <StayTimeline days={days} stays={stays} onChange={setStays} />
          <div className="stay-list">
            {stays.map((stay, index) => (
              <span key={stay.id}>
                <i style={{ background: stay.color }} />
                {stay.place?.name || "暂定住处"}
                {stay.place && stays.length > 1 && (
                  <button
                    onClick={() => removeStay(index)}
                    aria-label={`移除${stay.place.name}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!stays.some((stay) => !stay.place) && (
              <button
                className="add-tentative"
                onClick={addTentative}
                disabled={stays.length >= days}
              >
                <span>暂定住处</span>
                <b>＋</b>
              </button>
            )}
          </div>
          <div className="add-stay">
            {city ? (
              <PlaceField
                value={candidate}
                onSelect={setCandidate}
                cityName={city.name}
                placeholder={`输入${city.name}酒店或住处`}
                compact
              />
            ) : (
              <div className="city-required">选择城市后搜索住处</div>
            )}
            <button
              onClick={addStay}
              disabled={
                !city ||
                !candidate ||
                (stays.length >= days && !stays.every((stay) => !stay.place))
              }
            >
              新增
            </button>
          </div>
        </div>
        <button
          className={`enter-button ${entering ? "loading" : ""}`}
          onClick={onEnter}
          disabled={!city || entering}
        >
          <span>
            {entering ? "正在载入城市景点" : city ? "进入地图" : "请先选择城市"}
          </span>
          <i>{entering ? "•••" : "→"}</i>
        </button>
      </section>
      <div className="loop-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>起点</span>
      </div>
      <footer className="setup-signature">Designed by Aobi</footer>
    </main>
  );
}

function SwipeCard({
  spot,
  total,
  index,
  onAct,
  onMinimize,
}: {
  spot?: Spot;
  total: number;
  index: number;
  onAct: (preference: Preference) => void;
  onMinimize: () => void;
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [showGuide, setShowGuide] = useState(true);
  const [photoFailed, setPhotoFailed] = useState(false);
  const startRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const timer = window.setTimeout(() => setShowGuide(false), 6800);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    setDrag({ x: 0, y: 0, active: false });
    setLeaving(null);
    setPhotoFailed(false);
  }, [spot?.id]);
  const down = (event: React.PointerEvent) => {
    startRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ x: 0, y: 0, active: true });
  };
  const move = (event: React.PointerEvent) => {
    if (drag.active)
      setDrag({
        x: event.clientX - startRef.current.x,
        y: event.clientY - startRef.current.y,
        active: true,
      });
  };
  const commit = (preference: Preference, direction: "left" | "right") => {
    setLeaving(direction);
    window.setTimeout(() => onAct(preference), 245);
  };
  const up = () => {
    if (!drag.active) return;
    if (drag.x > 72) commit("like", "right");
    else if (drag.x < -72) commit("avoid", "left");
    else setDrag({ x: 0, y: 0, active: false });
  };
  const transform =
    leaving === "left"
      ? "translate3d(-120vw,15px,0) rotate(-20deg)"
      : leaving === "right"
        ? "translate3d(120vw,15px,0) rotate(20deg)"
        : `translate3d(${drag.x}px,${drag.y}px,0) rotate(${drag.x / 26}deg)`;
  return (
    <div className="deck-overlay">
      {showGuide && (
        <div className="gesture-guide">
          <span>左右划动选择~</span>
        </div>
      )}
      <div className="deck-head">
        <span>
          {Math.min(index + 1, total)} / {total}
        </span>
        <button onClick={onMinimize} aria-label="最小化卡片">
          —
        </button>
      </div>
      {spot ? (
        <div
          className="swipe-card"
          tabIndex={0}
          role="group"
          aria-label={`${spot.name}，左滑不去，右滑想去`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") commit("avoid", "left");
            if (event.key === "ArrowRight") commit("like", "right");
          }}
          style={{
            transform,
            transition:
              drag.active && !leaving
                ? "none"
                : "transform .25s cubic-bezier(.2,.82,.2,1)",
          }}
        >
          <div
            className={`swipe-art ${spot.photo && !photoFailed ? "has-photo" : ""}`}
          >
            {spot.photo && !photoFailed && (
              <img
                className="spot-photo"
                src={spot.photo}
                alt=""
                draggable={false}
                onError={() => setPhotoFailed(true)}
              />
            )}
            {(!spot.photo || photoFailed) && (
              <span className="spot-letter">{spot.name.slice(0, 1)}</span>
            )}
            <div
              className="swipe-hint hint-left"
              style={{
                opacity: drag.active
                  ? Math.min(1, Math.max(0.15, -drag.x / 90))
                  : 0.42,
              }}
            >
              <b>×</b>
              <span>不去</span>
            </div>
            <div
              className="swipe-hint hint-right"
              style={{
                opacity: drag.active
                  ? Math.min(1, Math.max(0.15, drag.x / 90))
                  : 0.42,
              }}
            >
              <span>想去</span>
              <b>✓</b>
            </div>
          </div>
          <div className="swipe-info">
            <div>
              <small>
                {spot.area} · {spot.category}
              </small>
              <h2>{spot.name}</h2>
            </div>
            <p>{spot.description}</p>
          </div>
        </div>
      ) : (
        <div className="deck-complete">
          <span>✓</span>
          <h2>热门景点选完了</h2>
          <p>点击“选好了”后统一生成路线</p>
        </div>
      )}
    </div>
  );
}

type MarkerRecord = {
  marker: any;
  content: HTMLDivElement;
  badge: HTMLElement;
  label: HTMLElement;
};
function MapCanvas({
  city,
  endpoints,
  activeDay,
  overviewOpen,
  routes,
  allSpots,
  preferences,
  activeSpot,
  focusSpot,
  planCommitted,
  onSpotClick,
  onChoose,
  onDiscover,
}: {
  city: CityConfig;
  endpoints: Endpoint[];
  activeDay: number;
  overviewOpen: boolean;
  routes: DayRoute[];
  allSpots: Spot[];
  preferences: Record<string, Preference>;
  activeSpot: Spot | null;
  focusSpot: Spot | null;
  planCommitted: boolean;
  onSpotClick: (spot: Spot) => void;
  onChoose: (spot: Spot, preference: "like" | "avoid") => void;
  onDiscover: (spots: Spot[]) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(undefined);
  const amapRef = useRef<any>(undefined);
  const markerRecords = useRef(new Map<string, MarkerRecord>());
  const routeOverlays = useRef<any[]>([]);
  const endpointOverlays = useRef<any[]>([]);
  const initialViewSet = useRef(false);
  const handlers = useRef({ onSpotClick, onChoose });
  const [mapReady, setMapReady] = useState(0);
  const [state, setState] = useState<
    "loading" | "ready" | "error" | "domain-error"
  >("loading");
  handlers.current = { onSpotClick, onChoose };
  useEffect(() => {
    let cancelled = false;
    const originalConsoleError = console.error;
    const monitoredConsoleError = (...args: unknown[]) => {
      originalConsoleError(...args);
      if (
        !cancelled &&
        args.some((value) => String(value).includes("INVALID_USER_DOMAIN"))
      )
        setState("domain-error");
    };
    console.error = monitoredConsoleError;
    const authMonitorTimer = window.setTimeout(() => {
      if (console.error === monitoredConsoleError)
        console.error = originalConsoleError;
    }, 8000);
    const load = async () => {
      try {
        const AMap = await loadAmap();
        if (cancelled || !host.current) return;
        amapRef.current = AMap;
        initialViewSet.current = false;
        const map = new AMap.Map(host.current, {
          center: city.center.split(",").map(Number),
          zoom: 13.2,
          viewMode: "2D",
          mapStyle: "amap://styles/normal",
          showLabel: true,
          zoomEnable: true,
          dragEnable: true,
          doubleClickZoom: true,
          features: ["bg", "road", "building"],
        });
        mapRef.current = map;
        const scale = () =>
          host.current?.style.setProperty(
            "--poi-scale",
            String(
              Math.max(0.9, Math.min(1.32, 1 + (map.getZoom() - 12) * 0.055)),
            ),
          );
        map.on("zoomchange", scale);
        scale();
        const readyTimer = window.setTimeout(() => {
          if (!cancelled) setState("error");
        }, 15000);
        map.on("complete", () => {
          window.clearTimeout(readyTimer);
          if (cancelled) return;
          setState((current) =>
            current === "domain-error" ? current : "ready",
          );
          setMapReady((value) => value + 1);
        });
      } catch (error) {
        console.error("AMap initialization failed", error);
        setState("error");
      }
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(authMonitorTimer);
      if (console.error === monitoredConsoleError)
        console.error = originalConsoleError;
      mapRef.current?.destroy?.();
      mapRef.current = undefined;
      markerRecords.current.clear();
    };
  }, [city.id]);
  useEffect(() => {
    if (!mapReady || city.spots.length >= city.mapTarget) return;
    let cancelled = false;
    searchAmapPlaces(city.name, "景点", 50)
      .then((pois) => {
        if (cancelled) return;
        const existingNames = new Set(
          city.spots.map((spot) => spot.name.replace(/[·\s]/g, "")),
        );
        const discovered = pois
          .map((poi, index): Spot | null => {
            const location = poiLocation(poi);
            const normalized = String(poi.name || "").replace(/[·\s]/g, "");
            if (
              !location ||
              !normalized ||
              existingNames.has(normalized) ||
              distanceKm(city.center, location) > 22
            )
              return null;
            return {
              id: `discover-${city.id}-${poi.id || index}`,
              name: poi.name,
              area: poi.adname || poi.district || city.name,
              category: String(poi.type || "景点").split(";")[0],
              description:
                typeof poi.address === "string" && poi.address
                  ? poi.address
                  : `${city.name}城市景点`,
              duration: 1.5,
              hot: Math.max(55, 78 - index),
              location,
              icon: "景",
              rating: poi.biz_ext?.rating || "",
              address: typeof poi.address === "string" ? poi.address : "",
              photo: poiPhoto(poi),
              source: "amap",
            };
          })
          .filter(Boolean) as Spot[];
        onDiscover(
          discovered.slice(0, Math.max(0, city.mapTarget - city.spots.length)),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mapReady, city.id, city.mapTarget]);
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;
    const visibleIds = new Set(allSpots.map((spot) => spot.id));
    for (const [id, record] of markerRecords.current)
      if (!visibleIds.has(id)) {
        map.remove(record.marker);
        markerRecords.current.delete(id);
      }
    let added = false;
    for (const spot of allSpots)
      if (!markerRecords.current.has(spot.id)) {
        const content = document.createElement("div");
        const badge = document.createElement("b");
        const label = document.createElement("span");
        label.textContent = spot.name;
        const actions = document.createElement("div");
        actions.className = "poi-actions";
        const no = document.createElement("button");
        no.className = "poi-no";
        no.textContent = "×";
        no.title = "不去";
        no.setAttribute("aria-label", `不去${spot.name}`);
        const yes = document.createElement("button");
        yes.className = "poi-yes";
        yes.textContent = "✓";
        yes.title = "加入";
        yes.setAttribute("aria-label", `加入${spot.name}`);
        let lastTouch = 0;
        const choose = (preference: "like" | "avoid", event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          lastTouch = Date.now();
          handlers.current.onChoose(spot, preference);
        };
        no.addEventListener("pointerdown", (event) => event.stopPropagation());
        yes.addEventListener("pointerdown", (event) => event.stopPropagation());
        no.addEventListener("pointerup", (event) => choose("avoid", event));
        yes.addEventListener("pointerup", (event) => choose("like", event));
        no.addEventListener("click", (event) => {
          if (Date.now() - lastTouch < 500) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          choose("avoid", event);
        });
        yes.addEventListener("click", (event) => {
          if (Date.now() - lastTouch < 500) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          choose("like", event);
        });
        actions.append(no, yes);
        content.append(badge, label, actions);
        let lastMarkerTouch = 0;
        content.addEventListener("pointerup", (event) => {
          if ((event.target as Element).closest("button")) return;
          event.stopPropagation();
          lastMarkerTouch = Date.now();
          handlers.current.onSpotClick(spot);
        });
        content.addEventListener("click", (event) => {
          if (
            (event.target as Element).closest("button") ||
            Date.now() - lastMarkerTouch < 500
          )
            return;
          event.stopPropagation();
          handlers.current.onSpotClick(spot);
        });
        const marker = new AMap.Marker({
          position: spot.location.split(",").map(Number),
          zIndex: 110,
          content,
          offset: new AMap.Pixel(-15, -15),
          title: spot.name,
        });
        map.add(marker);
        markerRecords.current.set(spot.id, { marker, content, badge, label });
        added = true;
      }
    if (!initialViewSet.current && markerRecords.current.size) {
      if (window.matchMedia("(max-width:760px)").matches)
        map.setZoomAndCenter?.(
          13.2,
          city.center.split(",").map(Number),
          false,
          420,
        );
      else
        map.setFitView(
          [...markerRecords.current.values()].map((record) => record.marker),
          false,
          [90, 80, 260, 390],
          13,
        );
      initialViewSet.current = true;
    }
  }, [mapReady, allSpots, city.center]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusSpot) return;
    const timer = window.setTimeout(() => {
      const target = focusSpot.location.split(",").map(Number);
      const zoom = Math.max(15, Number(map.getZoom?.() || 12));
      map.setZoomAndCenter?.(zoom, target, false, 650);
      markerRecords.current.get(focusSpot.id)?.marker?.setzIndex?.(260);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [mapReady, focusSpot?.id, focusSpot?.location]);
  const routeKey = routes
    .map(
      (route) =>
        `${route.day}:${route.segments.map((segment) => `${segment.polyline.length}.${segment.distance}`).join("-")}`,
    )
    .join("|");
  const prefKey = allSpots
    .map((spot) => `${spot.id}:${preferences[spot.id] || "none"}`)
    .join("|");
  useEffect(() => {
    const routeMeta = new Map<
      string,
      { index: number; color: string; day: number }
    >();
    routes.forEach((route) =>
      route.spots.forEach((spot, index) =>
        routeMeta.set(spot.id, {
          index: index + 1,
          color: route.color,
          day: route.day,
        }),
      ),
    );
    allSpots.forEach((spot, rank) => {
      const record = markerRecords.current.get(spot.id);
      if (!record) return;
      const pref = preferences[spot.id] || "none";
      const meta = routeMeta.get(spot.id);
      const active = activeSpot?.id === spot.id;
      const muted = planCommitted && !meta;
      record.content.className = `poi-marker ${rank < 12 ? "hot" : ""} ${meta ? "routed" : ""} ${muted ? "muted" : ""} pref-${pref} ${active ? "active" : ""}`;
      if (meta) record.content.style.setProperty("--poi", meta.color);
      record.badge.textContent = meta
        ? String(meta.index)
        : pref === "like" || pref === "must"
          ? "✓"
          : pref === "avoid"
            ? "×"
            : "";
      record.marker.setzIndex?.(
        active
          ? 260
          : meta?.day === activeDay + 1
            ? 225
            : meta
              ? 190
              : rank < 12
                ? 160
                : 110,
      );
    });
  }, [
    mapReady,
    prefKey,
    activeSpot?.id,
    routeKey,
    allSpots,
    planCommitted,
    activeDay,
  ]);
  const endpointKey = endpoints
    .map(
      (endpoint) =>
        `${endpoint.origin.location}>${endpoint.destination.location}`,
    )
    .join("|");
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;
    map.remove([...routeOverlays.current, ...endpointOverlays.current]);
    routeOverlays.current = [];
    endpointOverlays.current = [];
    const orderedRoutes = [...routes].sort(
      (a, b) =>
        Number(a.day - 1 === activeDay) - Number(b.day - 1 === activeDay),
    );
    for (const route of orderedRoutes)
      for (const segment of route.segments) {
        if (segment.polyline.length < 2) continue;
        const isActive = route.day - 1 === activeDay;
        const muted = !overviewOpen && !isActive;
        const laneOffset = 7 + ((route.day - 1) % 4) * 2;
        const line = new AMap.Polyline({
          path: offsetRoutePath(segment.polyline, laneOffset),
          strokeColor: muted ? "#9ea8a3" : route.color,
          strokeWeight: isActive ? 8 : muted ? 5 : 6,
          strokeOpacity: isActive ? 1 : muted ? 0.18 : 0.86,
          isOutline: true,
          outlineColor: "rgba(255,255,255,.9)",
          borderWeight: isActive ? 3 : 2,
          showDir: !muted,
          lineJoin: "round",
          zIndex: isActive ? 180 : 70 + route.day,
        });
        map.add(line);
        routeOverlays.current.push(line);
      }
    const endpoint = endpoints[activeDay] || endpoints[0];
    if (endpoint) {
      const origin = new AMap.Marker({
        position: endpoint.origin.location.split(",").map(Number),
        zIndex: 210,
        content: `<div class="origin-pin"><b>起</b><span>${endpoint.origin.name}</span></div>`,
        offset: new AMap.Pixel(-16, -16),
      });
      map.add(origin);
      endpointOverlays.current.push(origin);
      if (!samePlace(endpoint.origin, endpoint.destination)) {
        const destination = new AMap.Marker({
          position: endpoint.destination.location.split(",").map(Number),
          zIndex: 210,
          content: `<div class="origin-pin end"><b>终</b><span>${endpoint.destination.name}</span></div>`,
          offset: new AMap.Pixel(-16, -16),
        });
        map.add(destination);
        endpointOverlays.current.push(destination);
      }
    }
    const routed = [...routeOverlays.current, ...endpointOverlays.current];
    if (routed.length > endpointOverlays.current.length) {
      if (window.matchMedia("(max-width:760px)").matches) {
        const activeRoute = routes[activeDay];
        setMobileMapView(
          map,
          [
            endpoint?.origin.location,
            ...(activeRoute?.spots || []).map((spot) => spot.location),
            endpoint?.destination.location,
          ].filter(Boolean) as string[],
          city.center,
        );
      } else map.setFitView(routed, false, [90, 75, 235, 390], 16);
    }
  }, [
    mapReady,
    routeKey,
    endpointKey,
    activeDay,
    overviewOpen,
    city.center,
  ]);
  return (
    <div className="map-wrap">
      <div ref={host} className="real-map" />
      {state === "loading" && (
        <div className="map-state">正在连接高德地图…</div>
      )}
      {state === "error" && (
        <div className="map-state error">地图连接失败，请检查高德配置</div>
      )}
      {state === "domain-error" && (
        <div className="map-state error domain-error">
          <b>高德底图未授权当前地址</b>
          <span>
            {/^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
              window.location.hostname,
            )
              ? "本地调试请暂时取消高德 Web JS Key 的域名白名单"
              : `请在高德 Web JS Key 白名单加入 ${window.location.hostname}`}
          </span>
        </div>
      )}
    </div>
  );
}

function EndpointEditor({
  label,
  place,
  cityName,
  onChange,
}: {
  label: string;
  place: Place;
  cityName: string;
  onChange: (place: Place) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(place);
  useEffect(() => {
    if (!editing) setDraft(place);
  }, [place.location, place.name, editing]);
  const open = () => {
    setDraft(place);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(place);
    setEditing(false);
  };
  const confirm = () => {
    onChange(draft);
    setEditing(false);
  };
  return (
    <div className="endpoint-row">
      <i className={label === "起点" ? "origin" : "end"} />
      <div>
        {editing ? (
          <PlaceField
            value={draft}
            onSelect={setDraft}
            cityName={cityName}
            compact
          />
        ) : (
          <button onClick={open}>
            <small>{label} · 点击编辑</small>
            <b>{place.name}</b>
          </button>
        )}
      </div>
      {editing && (
        <div className="endpoint-actions">
          <button
            className="endpoint-confirm"
            onClick={confirm}
            aria-label={`确认${label}`}
          >
            ✓
          </button>
          <button
            className="endpoint-close"
            onClick={cancel}
            aria-label={`取消编辑${label}`}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function InsertStopEditor({
  cityName,
  onSelect,
  onCancel,
}: {
  cityName: string;
  onSelect: (place: Place) => void;
  onCancel: () => void;
}) {
  return (
    <div className="insert-stop-editor">
      <PlaceField
        cityName={cityName}
        onSelect={onSelect}
        placeholder="输入要新增的地点"
        compact
      />
      <button onClick={onCancel} aria-label="取消新增地点">
        ×
      </button>
    </div>
  );
}

function RouteDock({
  cityName,
  days,
  routes,
  activeDay,
  setActiveDay,
  endpoint,
  onEndpoint,
  planning,
  mode,
  onMode,
  onRemove,
  onInsert,
  pendingRemovalIds,
  onOpenAi,
  editDirty,
  onCompleteEdit,
  overviewOpen,
  onToggleOverview,
  selectedCount,
  mobileOpen,
  onMinimize,
}: {
  cityName: string;
  days: number;
  routes: DayRoute[];
  activeDay: number;
  setActiveDay: (day: number) => void;
  endpoint: Endpoint;
  onEndpoint: (endpoint: Endpoint) => void;
  planning: boolean;
  mode: TravelMode;
  onMode: (mode: TravelMode) => void;
  onRemove: (spot: Spot) => void;
  onInsert: (day: number, after: Spot, place: Place) => void;
  pendingRemovalIds: Set<string>;
  onOpenAi: () => void;
  editDirty: boolean;
  onCompleteEdit: () => void;
  overviewOpen: boolean;
  onToggleOverview: () => void;
  selectedCount: number;
  mobileOpen: boolean;
  onMinimize: () => void;
}) {
  const [insertAfter, setInsertAfter] = useState<number | null>(null);
  const [pendingInsertions, setPendingInsertions] = useState<
    Record<string, string[]>
  >({});
  useEffect(() => setInsertAfter(null), [activeDay]);
  useEffect(() => {
    if (!editDirty) setPendingInsertions({});
  }, [editDirty]);
  const route = routes[activeDay] || {
    day: activeDay + 1,
    spots: [],
    segments: [],
    distance: 0,
    duration: 0,
    color: DAY_COLORS[activeDay],
    origin: endpoint.origin,
    destination: endpoint.destination,
  };
  return (
    <aside className={`route-dock ${mobileOpen ? "nav-open" : ""}`}>
      <div className="dock-top">
        <div>
          <small>第 {activeDay + 1} 天</small>
          <h2>
            {route.duration
              ? `约 ${minutes(route.duration)} 分钟`
              : selectedCount
                ? `${selectedCount} 个已选地点`
                : "等待选择地点"}
          </h2>
        </div>
        <div className="dock-status">
          {planning && <span className="planning-dot">正在计算三种路线</span>}
          <button
            className="dock-minimize"
            onClick={onMinimize}
            aria-label="最小化导航"
          >
            —
          </button>
        </div>
      </div>
      <div className="day-switch-block">
        <div className="day-switch-heading">
          <span>第几天</span>
          <small>{overviewOpen ? "全部路线" : `仅第 ${activeDay + 1} 天`}</small>
        </div>
        <div className="day-switch">
          <div className="day-buttons">
            {Array.from({ length: days }, (_, index) => (
              <button
                key={index}
                className={index === activeDay ? "active" : ""}
                style={{ "--day": DAY_COLORS[index] } as React.CSSProperties}
                onClick={() => setActiveDay(index)}
              >
                {index + 1}
              </button>
            ))}
          </div>
          <button
            className={`overview-toggle ${overviewOpen ? "active" : ""}`}
            aria-pressed={overviewOpen}
            aria-label={`总览${overviewOpen ? "已开启" : "已关闭"}`}
            onClick={onToggleOverview}
          >
            <span>总览</span>
            <i className="overview-switch" aria-hidden="true">
              <b />
            </i>
          </button>
        </div>
      </div>
      <div className="endpoint-editor">
        <EndpointEditor
          label="起点"
          place={endpoint.origin}
          cityName={cityName}
          onChange={(origin) => onEndpoint({ ...endpoint, origin })}
        />
        <EndpointEditor
          label="终点"
          place={endpoint.destination}
          cityName={cityName}
          onChange={(destination) => onEndpoint({ ...endpoint, destination })}
        />
      </div>
      <div className="mode-switch">
        {TRAVEL_MODES.map((item) => (
          <button
            key={item}
            className={mode === item ? "active" : ""}
            onClick={() => onMode(item)}
          >
            {modeLabel[item]}
          </button>
        ))}
      </div>
      <div className="route-list detailed">
        {route.segments.length ? (
          route.segments.map((segment, index) => (
            <section
              className="segment-card"
              key={`${segment.fromName}-${segment.toName}-${index}`}
            >
              <header>
                <div>
                  <b>{segment.fromName}</b>
                  <span>→</span>
                  <b>{segment.toName}</b>
                </div>
                <strong>
                  {minutes(segment.duration)} 分钟 ·{" "}
                  {distanceLabel(segment.distance)}
                </strong>
              </header>
              <div className="nav-details">
                {segment.details.map((detail, detailIndex) => (
                  <div
                    className={`nav-step ${detail.kind}`}
                    key={`${detail.title}-${detailIndex}`}
                  >
                    <i>
                      {detail.kind === "drive" ? (
                        <img src={sameOriginUrl("/drive-icon.png")} alt="" />
                      ) : (
                        <img
                          src={sameOriginUrl(
                            detail.kind === "walk"
                              ? "/walk-icon.png"
                              : "/transit-icon.png",
                          )}
                          alt=""
                        />
                      )}
                    </i>
                    <div>
                      <b>{detail.title}</b>
                      {detail.kind === "transit" ? (
                        <span>
                          {detail.from} 上车 · {detail.to} 下车
                          {detail.via ? ` · 途经 ${detail.via} 站` : ""}
                        </span>
                      ) : (
                        detail.instruction && <span>{detail.instruction}</span>
                      )}
                    </div>
                    <small>
                      {minutes(detail.duration)} 分钟
                      <br />
                      {distanceLabel(detail.distance)}
                    </small>
                  </div>
                ))}
              </div>
              {route.spots[index] && (
                <>
                  {(() => {
                    const insertionKey = `${activeDay}-${route.spots[index].id}`;
                    return (
                      <>
                  <div className="stop-edit-actions">
                    <button
                      aria-pressed={pendingRemovalIds.has(route.spots[index].id)}
                      className={`remove-stop ${pendingRemovalIds.has(route.spots[index].id) ? "pending" : ""}`}
                      onClick={() => onRemove(route.spots[index])}
                    >
                      {pendingRemovalIds.has(route.spots[index].id) ? (
                        <>
                          <b>✓ 已标记移除</b>
                          <span>点击“完成编辑”生效</span>
                        </>
                      ) : (
                        <>移除该地</>
                      )}
                    </button>
                    <button
                      className="insert-stop"
                      onClick={() =>
                        setInsertAfter((current) =>
                          current === index ? null : index,
                        )
                      }
                    >
                      新增地点
                    </button>
                  </div>
                  {insertAfter === index && (
                    <InsertStopEditor
                      cityName={cityName}
                      onCancel={() => setInsertAfter(null)}
                      onSelect={(place) => {
                        onInsert(activeDay, route.spots[index], place);
                        setPendingInsertions((current) => ({
                          ...current,
                          [insertionKey]: [
                            ...(current[insertionKey] || []),
                            place.name,
                          ],
                        }));
                        setInsertAfter(null);
                      }}
                    />
                  )}
                  {pendingInsertions[insertionKey]?.length > 0 && (
                    <div className="pending-insert-label">
                      <b>✓ 已加入 {pendingInsertions[insertionKey].join("、")}</b>
                      <span>点击“完成编辑”生效</span>
                    </div>
                  )}
                      </>
                    );
                  })()}
                </>
              )}
            </section>
          ))
        ) : (
          <div className="empty-route">
            选择地点或编辑起终点后，点击“选好了”
          </div>
        )}
      </div>
      <div className="dock-foot">
        <div>
          <b>{route.distance ? distanceLabel(route.distance) : "—"}</b>
          <span>
            {route.duration
              ? `总交通约 ${minutes(route.duration)} 分钟`
              : "尚未生成路线"}
          </span>
        </div>
        <div className="dock-actions">
          <button onClick={onOpenAi}>✦ AI 调整</button>
          <button
            className="complete-edit-button"
            onClick={onCompleteEdit}
            disabled={!editDirty || planning}
          >
            完成编辑
          </button>
        </div>
      </div>
    </aside>
  );
}

function MapSearch({
  cityName,
  example,
  onAdd,
}: {
  cityName: string;
  example: string;
  onAdd: (spot: Spot) => void;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [focused, setFocused] = useState(false);
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (!focused || !typed || text.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const pois = (await searchPlaces(cityName, text, 6)).filter((poi) =>
            poiLocation(poi),
          );
        if (!cancelled) setResults(pois);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, focused, typed, cityName]);
  const choose = (poi: any) => {
    const location = poiLocation(poi);
    onAdd({
      id: `amap-${poi.id || location}`,
      name: poi.name,
      area: poi.adname || poi.district || cityName,
      category: String(poi.type || "地点").split(";")[0],
      description:
        typeof poi.address === "string" && poi.address
          ? poi.address
          : "高德地图地点",
      duration: 1.5,
      hot: 50,
      location,
      icon: "新",
      rating: poi.biz_ext?.rating || "",
      address: typeof poi.address === "string" ? poi.address : "",
      photo: poiPhoto(poi),
      source: "amap",
    });
    setText("");
    setResults([]);
    setTyped(false);
  };
  return (
    <div
      className="map-search"
      onFocus={() => setFocused(true)}
      onBlur={() => window.setTimeout(() => setFocused(false), 120)}
    >
      <span>⌕</span>
      <input
        value={text}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setTyped(true);
        }}
        placeholder={`添加更多景点，例如：${example}`}
      />
      {focused && typed && results.length > 0 && (
        <div className="map-search-results">
          {results.map((poi, index) => (
            <button
              key={`${poiLocation(poi)}-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(poi)}
            >
              <b>{poi.name}</b>
              <small>
                {typeof poi.address === "string"
                  ? poi.address
                  : poi.adname || cityName}
              </small>
              <span>＋</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionSheet({
  spots,
  preferences,
  onClose,
  onContinue,
}: {
  spots: Spot[];
  preferences: Record<string, Preference>;
  onClose: () => void;
  onContinue: () => void;
}) {
  const sections = [
    { preference: "like", title: "想去", mark: "✓" },
    { preference: "avoid", title: "不去", mark: "×" },
  ] as const;
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="selection-sheet">
        <div className="selection-head">
          <div>
            <small>热门景点卡片</small>
            <h2>我的选择</h2>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="selection-table">
          {sections.map((section) => {
            const items = spots.filter(
              (spot) => preferences[spot.id] === section.preference,
            );
            return (
              <div
                className={`selection-group ${section.preference}`}
                key={section.preference}
              >
                <div className="selection-group-title">
                  <span>{section.mark}</span>
                  <b>{section.title}</b>
                  <small>{items.length}</small>
                </div>
                <div className="selection-items">
                  {items.length ? (
                    items.map((spot) => (
                      <div key={spot.id}>
                        <b>{spot.name}</b>
                        <span>{spot.area}</span>
                      </div>
                    ))
                  ) : (
                    <p>暂无</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <button className="continue-cards" onClick={onContinue}>
          继续选择
        </button>
      </section>
    </div>
  );
}

function AiSheet({
  spots,
  days,
  cityName,
  currentPlan,
  onClose,
  onApply,
}: {
  spots: Spot[];
  days: number;
  cityName: string;
  currentPlan: Spot[][];
  onClose: () => void;
  onApply: (result: AiResult) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setLoading(true);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(sameOriginUrl("/api/ai"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          days,
          cityName,
          availableSpots: spots.map((spot) => spot.name),
          currentPlan: currentPlan.map((group) =>
            group.map((spot) => spot.name),
          ),
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data: Record<string, any> = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          response.status === 524
            ? "AI 服务响应超时，请稍后重试"
            : "AI 服务暂时返回了异常内容，请稍后重试",
        );
      }
      if (!response.ok)
        throw new Error(
          data.error ||
            (response.status === 429 || response.status === 503
              ? "免费模型当前访问量较大，请稍后重试"
              : "AI 调整失败"),
        );
      const result = data as AiResult;
      if (!Array.isArray(result.spots)) result.spots = [];
      if (!result.spots.length)
        throw new Error("AI 没有找到可执行的路线修改，请换一种说法");
      onApply(result);
    } catch (reason) {
      setError(
        reason instanceof DOMException && reason.name === "AbortError"
          ? "AI 等待超时，请稍后重试；免费模型高峰期可能较慢"
          : reason instanceof Error
            ? reason.message
            : "AI 调整失败",
      );
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  };
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="ai-sheet">
        <button className="sheet-close" onClick={onClose}>
          ×
        </button>
        <span>✦ DeepSeek-V4-Flash</span>
        <h2>一句话调整路线</h2>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="例如：第二天轻松一点，把玄武湖放到鸡鸣寺之后"
        />
        {error && <p className="ai-error">{error}</p>}
        <button
          className={`ai-submit ${loading ? "loading" : ""}`}
          onClick={submit}
          disabled={!text.trim() || loading}
        >
          {loading ? "AI 正在调整路线…" : "确定并重新规划"}
        </button>
      </section>
    </div>
  );
}

function emptyRoutes(days: number, endpoints: Endpoint[]): DayRoute[] {
  return Array.from({ length: days }, (_, index) => ({
    day: index + 1,
    color: DAY_COLORS[index],
    spots: [],
    segments: [],
    distance: 0,
    duration: 0,
    origin: endpoints[index].origin,
    destination: endpoints[index].destination,
  }));
}

function Planner({
  city,
  days,
  stays,
  onBack,
}: {
  city: CityConfig;
  days: number;
  stays: Stay[];
  onBack: () => void;
}) {
  const [customSpots, setCustomSpots] = useState<Spot[]>([]);
  const [discoveredSpots, setDiscoveredSpots] = useState<Spot[]>([]);
  const spots = useMemo(
    () => [...city.spots, ...discoveredSpots, ...customSpots],
    [city.spots, discoveredSpots, customSpots],
  );
  const cardSpots = useMemo(
    () => selectCardSpots(city.spots),
    [city.spots],
  );
  const initialEndpoints = useMemo(
    () => endpointsFromStays(days, stays, city),
    [days, stays, city],
  );
  const [preferences, setPreferences] = useState<Record<string, Preference>>(
    {},
  );
  const [cardOpen, setCardOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<TravelMode>("driving");
  const [draftEndpoints, setDraftEndpoints] =
    useState<Endpoint[]>(initialEndpoints);
  const [plannedEndpoints, setPlannedEndpoints] =
    useState<Endpoint[]>(initialEndpoints);
  const [plannedIds, setPlannedIds] = useState<string[]>([]);
  const [plannedGroups, setPlannedGroups] = useState<Spot[][]>(() =>
    Array.from({ length: days }, () => []),
  );
  const [draftGroups, setDraftGroups] = useState<Spot[][]>(() =>
    Array.from({ length: days }, () => []),
  );
  const [hasCommittedPlan, setHasCommittedPlan] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);
  const [routeEditDirty, setRouteEditDirty] = useState(false);
  const [endpointsCustomized, setEndpointsCustomized] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [navAttention, setNavAttention] = useState(false);
  const [routesByMode, setRoutesByMode] = useState<
    Record<TravelMode, DayRoute[]>
  >({
    driving: emptyRoutes(days, initialEndpoints),
    transit: emptyRoutes(days, initialEndpoints),
    walking: emptyRoutes(days, initialEndpoints),
  });
  const [planning, setPlanning] = useState(false);
  const [cardImagesReady, setCardImagesReady] = useState(false);
  const [activeDay, setActiveDay] = useState(0);
  const [activeSpot, setActiveSpot] = useState<Spot | null>(null);
  const [focusSpot, setFocusSpot] = useState<Spot | null>(null);
  const [pendingRemovalIds, setPendingRemovalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [aiOpen, setAiOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dayLocks, setDayLocks] = useState<Record<string, number>>({});
  const [routeError, setRouteError] = useState("");
  const [textScale, setTextScale] = useState(1);
  const routeCache = useRef(new Map<string, RouteSegment>());

  // 城市选择后 App 已开始预取；地图页继续等待全部热门卡片图片完成解码，
  // 用户打开卡片后连续滑动不会再逐张等待网络。
  useEffect(() => {
    let cancelled = false;
    setCardImagesReady(false);
    let deadline = 0;
    const timeLimit = new Promise<void>((resolve) => {
      deadline = window.setTimeout(resolve, 15000);
    });
    void Promise.race([preloadAttractionImages(cardSpots), timeLimit]).then(() => {
      if (!cancelled) setCardImagesReady(true);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
    };
  }, [city.id, cardSpots]);

  // 未录入住处时，Planner 会先用内置城市数据立即打开地图，再由高德在
  // 后台补齐该城市的真实中心点。同步替换仍处于“暂定住处”的端点，避免
  // 未预置城市继续拿全国中心坐标去请求跨省公交/步行路线。用户手动编辑
  // 过的起点或终点不满足这个标记条件，因此不会被覆盖。
  useEffect(() => {
    const isTentative = (place: Place) =>
      place.id === `${city.id}-center` || place.name.startsWith("暂定住处（");
    const syncTentative = (current: Endpoint[]) =>
      current.map((endpoint, index) => {
        const fallback = initialEndpoints[index] || initialEndpoints.at(-1);
        if (!fallback) return endpoint;
        return {
          origin: isTentative(endpoint.origin) ? fallback.origin : endpoint.origin,
          destination: isTentative(endpoint.destination)
            ? fallback.destination
            : endpoint.destination,
        };
      });
    setDraftEndpoints(syncTentative);
    setPlannedEndpoints(syncTentative);
  }, [city.id, city.center, city.defaultStart.location, initialEndpoints]);

  const current = cardSpots.find(
    (spot) => !preferences[spot.id] || preferences[spot.id] === "none",
  );
  const selected = useMemo(
    () =>
      spots.filter(
        (spot) =>
          preferences[spot.id] === "must" || preferences[spot.id] === "like",
      ),
    [spots, preferences],
  );
  const groups = plannedGroups;
  const decided = cardSpots.filter(
    (spot) => preferences[spot.id] && preferences[spot.id] !== "none",
  ).length;
  const cardsDone = !current;
  const commitPlanWith = (
    nextPreferences: Record<string, Preference>,
    nextLocks: Record<string, number>,
    aiResult?: AiResult,
  ) => {
    const nextSelected = spots.filter(
      (spot) =>
        nextPreferences[spot.id] === "must" ||
        nextPreferences[spot.id] === "like",
    );
    const requestedEndpoints = draftEndpoints.map((endpoint) => ({ ...endpoint }));
    const hasConfirmedStay = stays.some((stay) => Boolean(stay.place));
    const automaticOpenRoute = !hasConfirmedStay && !endpointsCustomized;
    let nextGroups = groupByDay(
      nextSelected,
      days,
      requestedEndpoints,
      nextLocks,
    );
    if (automaticOpenRoute)
      nextGroups = nextGroups.map((group) => orderOpenStops(group));
    for (const instruction of aiResult?.spots || []) {
      if (
        instruction.preference !== "like" ||
        !instruction.day ||
        instruction.day < 1 ||
        instruction.day > days ||
        !instruction.after
      )
        continue;
      const group = nextGroups[instruction.day - 1];
      const targetIndex = group.findIndex(
        (spot) =>
          spot.name === instruction.name ||
          spot.name.includes(instruction.name) ||
          instruction.name.includes(spot.name),
      );
      const anchorIndex = group.findIndex(
        (spot) =>
          spot.name === instruction.after ||
          spot.name.includes(instruction.after || "") ||
          instruction.after?.includes(spot.name),
      );
      if (targetIndex < 0 || anchorIndex < 0 || targetIndex === anchorIndex)
        continue;
      const anchorId = group[anchorIndex].id;
      const [target] = group.splice(targetIndex, 1);
      const nextAnchorIndex = group.findIndex(
        (spot) => spot.id === anchorId,
      );
      const insertIndex =
        nextAnchorIndex >= 0
          ? nextAnchorIndex + 1
          : Math.min(anchorIndex + 1, group.length);
      group.splice(insertIndex, 0, target);
    }
    const nextEndpoints = automaticOpenRoute
      ? nextGroups.map((group, index) => {
          const fallback =
            requestedEndpoints[index] || requestedEndpoints.at(-1)!;
          if (!group.length) return fallback;
          return {
            origin: group[0],
            destination: group[group.length - 1],
          };
        })
      : requestedEndpoints;
    setPreferences(nextPreferences);
    setDayLocks(nextLocks);
    setPlanning(true);
    setPlannedIds(nextSelected.map((spot) => spot.id));
    setPlannedEndpoints(nextEndpoints);
    setDraftEndpoints(nextEndpoints.map((endpoint) => ({ ...endpoint })));
    setPlannedGroups(nextGroups);
    setDraftGroups(nextGroups.map((group) => [...group]));
    setHasCommittedPlan(true);
    setPlanDirty(false);
    setRouteEditDirty(false);
    setPendingRemovalIds(new Set());
    setOverviewOpen(true);
    setActiveDay(0);
    setNavAttention(true);
    setCardOpen(false);
    setActiveSpot(null);
  };
  const commitPlan = () => commitPlanWith(preferences, dayLocks);
  const clearSelection = () => {
    const resetEndpoints = initialEndpoints.map((endpoint) => ({ ...endpoint }));
    setPreferences({});
    setCustomSpots([]);
    setPlannedIds([]);
    setPlannedGroups(Array.from({ length: days }, () => []));
    setDraftGroups(Array.from({ length: days }, () => []));
    setHasCommittedPlan(false);
    setPlanDirty(false);
    setRouteEditDirty(false);
    setEndpointsCustomized(false);
    setPlannedEndpoints(resetEndpoints);
    setDraftEndpoints(resetEndpoints.map((endpoint) => ({ ...endpoint })));
    setOverviewOpen(true);
    setNavAttention(false);
    setCardOpen(false);
    setSummaryOpen(false);
    setActiveSpot(null);
    setFocusSpot(null);
    setPendingRemovalIds(new Set());
    setDayLocks({});
    setRouteError("");
    setRoutesByMode({
      driving: emptyRoutes(days, resetEndpoints),
      transit: emptyRoutes(days, resetEndpoints),
      walking: emptyRoutes(days, resetEndpoints),
    });
    routeCache.current.clear();
  };
  useEffect(() => {
    if (cardOpen && cardsDone) {
      const timer = window.setTimeout(() => setCardOpen(false), 700);
      return () => window.clearTimeout(timer);
    }
  }, [cardOpen, cardsDone]);
  const groupKey = groups
    .map((group) => group.map((spot) => spot.id).join(","))
    .join("|");
  const endpointKey = plannedEndpoints
    .map(
      (endpoint) =>
        `${endpoint.origin.location}>${endpoint.destination.location}`,
    )
    .join("|");
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!hasCommittedPlan) {
        setRoutesByMode({
          driving: emptyRoutes(days, plannedEndpoints),
          transit: emptyRoutes(days, plannedEndpoints),
          walking: emptyRoutes(days, plannedEndpoints),
        });
        setPlanning(false);
        return;
      }
      const hasJourney = groups.some(
        (group, index) =>
          group.length > 0 ||
          !samePlace(
            plannedEndpoints[index].origin,
            plannedEndpoints[index].destination,
          ),
      );
      if (!hasJourney) {
        const empty = emptyRoutes(days, plannedEndpoints);
        setRoutesByMode({
          driving: empty,
          transit: empty,
          walking: emptyRoutes(days, plannedEndpoints),
        });
        setPlanning(false);
        return;
      }
      setPlanning(true);
      setRouteError("");
      const fetchSegment = async (
        mode: TravelMode,
        point: Place | Spot,
        destination: Place | Spot,
      ): Promise<{ segment: RouteSegment; fetched: boolean }> => {
        const key = `${mode}:${point.location}>${destination.location}`;
        const cached = routeCache.current.get(key);
        if (cached)
          return {
            segment: {
              ...cached,
              fromName: point.name,
              toName: destination.name,
            },
            fetched: false,
          };
        let response: Response;
        let data: any = {};
        const segmentController = new AbortController();
        const abortSegment = () => segmentController.abort();
        controller.signal.addEventListener("abort", abortSegment, { once: true });
        const segmentTimeout = window.setTimeout(abortSegment, 10000);
        try {
          response = await fetch(
            sameOriginUrl(
              `/api/route?origin=${point.location}&destination=${destination.location}&mode=${mode}&city=${encodeURIComponent(city.routeCity)}`,
            ),
            { signal: segmentController.signal },
          );
          const raw = await response.text();
          data = raw ? JSON.parse(raw) : {};
        } catch (reason) {
          if (controller.signal.aborted) throw reason;
          throw new Error(
            segmentController.signal.aborted
              ? "路线请求超时"
              : "路线服务网络波动",
          );
        } finally {
          window.clearTimeout(segmentTimeout);
          controller.signal.removeEventListener("abort", abortSegment);
        }
        if (
          response.ok &&
          (data.stationary ||
            (Array.isArray(data.polyline) && data.polyline.length >= 2))
        ) {
          const segment = {
            ...data,
            fromName: point.name,
            toName: destination.name,
          } as RouteSegment;
          routeCache.current.set(key, segment);
          return { segment, fetched: true };
        }
        throw new Error(String(data.error || "高德未返回真实路线"));
      };
      const buildMode = async (mode: TravelMode) => {
        const next: DayRoute[] = [];
        const failures: string[] = [];
        for (let dayIndex = 0; dayIndex < groups.length; dayIndex++) {
          const group = groups[dayIndex];
          const endpoint = plannedEndpoints[dayIndex];
          const points: (Place | Spot)[] = [
            endpoint.origin,
            ...group,
            endpoint.destination,
          ].filter(
            (point, index, all) =>
              index === 0 || !samePlace(point, all[index - 1]),
          );
          const segments: RouteSegment[] = [];
          if (
            !(
              points.length === 2 &&
              samePlace(endpoint.origin, endpoint.destination)
            )
          ) {
            const segmentResults: Array<RouteSegment | null> = Array.from(
              { length: points.length - 1 },
              () => null,
            );
            let cursor = 0;
            const buildNext = async () => {
              while (!controller.signal.aborted && cursor < points.length - 1) {
                const index = cursor++;
                try {
                  const result = await fetchSegment(
                    mode,
                    points[index],
                    points[index + 1],
                  );
                  segmentResults[index] = result.segment;
                } catch (reason) {
                  if (controller.signal.aborted) throw reason;
                  failures.push(
                    `第${dayIndex + 1}天 ${points[index].name}→${points[index + 1].name}：${reason instanceof Error ? reason.message : "生成失败"}`,
                  );
                }
              }
            };
            await Promise.all(
              Array.from(
                { length: Math.min(2, points.length - 1) },
                () => buildNext(),
              ),
            );
            segments.push(
              ...segmentResults.filter(
                (segment): segment is RouteSegment => Boolean(segment),
              ),
            );
          }
          next.push({
            day: dayIndex + 1,
            color: DAY_COLORS[dayIndex],
            spots: group,
            segments,
            distance: segments.reduce(
              (sum, segment) => sum + segment.distance,
              0,
            ),
            duration: segments.reduce(
              (sum, segment) => sum + segment.duration,
              0,
            ),
            origin: endpoint.origin,
            destination: endpoint.destination,
          });
          if (!controller.signal.aborted)
            setRoutesByMode((current) => ({
              ...current,
              [mode]: [
                ...next,
                ...emptyRoutes(days, plannedEndpoints).slice(next.length),
              ],
            }));
        }
        return { routes: next, failures };
      };
      const nextRoutes: Record<TravelMode, DayRoute[]> = {
        driving: emptyRoutes(days, plannedEndpoints),
        transit: emptyRoutes(days, plannedEndpoints),
        walking: emptyRoutes(days, plannedEndpoints),
      };
      setRoutesByMode(nextRoutes);
      const results = await Promise.all(
        TRAVEL_MODES.map(async (mode) => {
          const result = await buildMode(mode);
          return { mode, ...result };
        }),
      ).catch((reason) => {
        if (controller.signal.aborted) return null;
        throw reason;
      });
      if (!results || controller.signal.aborted) return;
      const failures: string[] = [];
      for (const result of results) {
        nextRoutes[result.mode] = result.routes;
        if (result.failures.length)
          failures.push(
            `${modeLabel[result.mode]}有 ${result.failures.length} 段暂未生成`,
          );
      }
      if (!controller.signal.aborted) {
        setRoutesByMode(nextRoutes);
        const available = TRAVEL_MODES.filter((mode) =>
          nextRoutes[mode].some((route) => route.segments.length),
        );
        if (!available.includes(displayMode) && available[0])
          setDisplayMode(available[0]);
        if (failures.length)
          setRouteError(
            available.length
              ? `${failures.join("；")}，其他路线仍可查看`
              : failures.join("；"),
          );
        setPlanning(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [groupKey, endpointKey, hasCommittedPlan, city.routeCity]);
  useEffect(() => {
    if (!routeError) return;
    const timer = window.setTimeout(() => setRouteError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [routeError]);
  const markDirty = () => setPlanDirty(true);
  const act = (preference: Preference) => {
    if (!current) return;
    setPreferences((old) => ({ ...old, [current.id]: preference }));
    if (preference === "like" || preference === "must")
      setPendingRemovalIds((old) => {
        const next = new Set(old);
        next.delete(current.id);
        return next;
      });
    markDirty();
  };
  const chooseSpot = (spot: Spot, preference: "like" | "avoid") => {
    setPreferences((old) => ({ ...old, [spot.id]: preference }));
    if (preference === "like")
      setPendingRemovalIds((old) => {
        const next = new Set(old);
        next.delete(spot.id);
        return next;
      });
    setActiveSpot(null);
    markDirty();
  };
  const remove = (spot: Spot) => {
    if (pendingRemovalIds.has(spot.id)) return;
    setPendingRemovalIds((old) => new Set(old).add(spot.id));
    setDraftGroups((old) =>
      old.map((group) => group.filter((item) => item.id !== spot.id)),
    );
    setRouteEditDirty(true);
  };
  const editEndpoint = (endpoint: Endpoint) => {
    setEndpointsCustomized(true);
    setDraftEndpoints((old) =>
      old.map((item, index) => (index === activeDay ? endpoint : item)),
    );
    hasCommittedPlan ? setRouteEditDirty(true) : markDirty();
  };
  const insertRouteStop = (day: number, after: Spot, place: Place) => {
    const existing = spots.find(
      (spot) =>
        spot.location === place.location ||
        attractionStem(spot.name) === attractionStem(place.name),
    );
    const spot: Spot =
      existing ||
      ({
        id: `route-${city.id}-${place.id || place.location.replace(/[^\d]/g, "")}`,
        name: place.name,
        location: place.location,
        area: place.area || city.name,
        address: place.address || "",
        category: "自定义地点",
        description: place.address || `${city.name}自定义地点`,
        duration: 1.5,
        hot: 70,
        icon: "新",
        source: "amap",
      } as Spot);
    if (!existing)
      setCustomSpots((old) =>
        old.some((item) => item.id === spot.id || item.location === spot.location)
          ? old
          : [...old, spot],
      );
    setPreferences((old) => ({ ...old, [spot.id]: "like" }));
    setDraftGroups((old) =>
      old.map((group, groupDay) => {
        if (groupDay !== day || group.some((item) => item.id === spot.id))
          return group;
        const next = [...group];
        const draftAnchor = next.findIndex((item) => item.id === after.id);
        const plannedAnchor = plannedGroups[day]?.findIndex(
          (item) => item.id === after.id,
        );
        const index =
          draftAnchor >= 0
            ? draftAnchor + 1
            : Math.max(0, Math.min(plannedAnchor ?? next.length, next.length));
        next.splice(index, 0, spot);
        return next;
      }),
    );
    setFocusSpot(spot);
    setRouteEditDirty(true);
  };
  const completeRouteEdits = () => {
    if (!routeEditDirty || planning) return;
    const nextGroups = draftGroups.map((group) => [...group]);
    setPreferences((old) => {
      const next = { ...old };
      pendingRemovalIds.forEach((id) => (next[id] = "avoid"));
      nextGroups.flat().forEach((spot) => (next[spot.id] = "like"));
      return next;
    });
    setDayLocks((old) => {
      const next = { ...old };
      pendingRemovalIds.forEach((id) => delete next[id]);
      return next;
    });
    const hasConfirmedStay = stays.some((stay) => Boolean(stay.place));
    const nextEndpoints = !hasConfirmedStay && !endpointsCustomized
      ? nextGroups.map((group, index) => {
          const fallback = draftEndpoints[index] || draftEndpoints.at(-1)!;
          if (!group.length) return fallback;
          return {
            origin: group[0],
            destination: group[group.length - 1],
          };
        })
      : draftEndpoints.map((endpoint) => ({ ...endpoint }));
    setPlannedEndpoints(nextEndpoints);
    setDraftEndpoints(nextEndpoints.map((endpoint) => ({ ...endpoint })));
    setPlannedGroups(nextGroups);
    setPlannedIds(nextGroups.flat().map((spot) => spot.id));
    setPendingRemovalIds(new Set());
    setRouteEditDirty(false);
    setPlanning(true);
  };
  const addSearchSpot = (spot: Spot) => {
    setCustomSpots((old) =>
      old.some((item) => item.id === spot.id || item.location === spot.location)
        ? old
        : [...old, spot],
    );
    setPreferences((old) => ({ ...old, [spot.id]: "like" }));
    setActiveSpot(spot);
    setFocusSpot(spot);
    markDirty();
  };
  const discoverSpots = (incoming: Spot[]) =>
    setDiscoveredSpots((old) => {
      const names = new Set(
        [...city.spots, ...old].map((spot) => spot.name.replace(/[·\s]/g, "")),
      );
      return [
        ...old,
        ...incoming.filter(
          (spot) => !names.has(spot.name.replace(/[·\s]/g, "")),
        ),
      ].slice(0, Math.max(0, city.mapTarget - city.spots.length));
    });
  const applyAi = (result: AiResult) => {
    const nextPrefs = { ...preferences };
    const nextLocks = { ...dayLocks };
    for (const instruction of (result.spots || []).slice(0, 12)) {
      if (
        instruction.preference !== "like" &&
        instruction.preference !== "avoid"
      )
        continue;
      const name = String(instruction.name || "").trim();
      if (!name) continue;
      const found =
        spots.find((spot) => spot.name === name) ||
        spots.find(
          (spot) => spot.name.includes(name) || name.includes(spot.name),
        );
      if (!found) continue;
      nextPrefs[found.id] = instruction.preference;
      if (instruction.preference === "avoid") {
        delete nextLocks[found.id];
      } else if (
        instruction.day &&
        instruction.day >= 1 &&
        instruction.day <= days
      ) {
        nextLocks[found.id] = instruction.day;
      }
    }
    setAiOpen(false);
    commitPlanWith(nextPrefs, nextLocks, result);
  };
  const routes = routesByMode[displayMode];
  const hasNavigation = routes.some((route) => route.segments.length > 0);
  const openCards = () => {
    setNavOpen(false);
    cardsDone ? setSummaryOpen(true) : setCardOpen(true);
  };
  return (
    <main
      className={`planner-screen ${navOpen ? "nav-is-open" : ""}`}
      style={
        { "--text-scale": textScale * 1.15 } as React.CSSProperties
      }
    >
      <header className="map-header">
        <button className="brand-button" onClick={onBack}>
          <Brand />
        </button>
        <div className="trip-title">
          <b>
            {city.name} · {days} 天路线
          </b>
          <span>
            {stays.map((stay) => stay.place?.name || "暂定住处").join(" · ")}
          </span>
        </div>
        <div className="text-size-controls" aria-label="调整界面文字大小">
          <button
            onClick={() =>
              setTextScale((value) =>
                Math.max(0.7, Number((value - 0.1).toFixed(1))),
              )
            }
            disabled={textScale <= 0.7}
            aria-label="缩小文字"
          >
            −
          </button>
          <span>{Math.round(textScale * 100)}%</span>
          <button
            onClick={() =>
              setTextScale((value) =>
                Math.min(1.3, Number((value + 0.1).toFixed(1))),
              )
            }
            disabled={textScale >= 1.3}
            aria-label="放大文字"
          >
            ＋
          </button>
        </div>
        <button className="reset-button" onClick={onBack}>
          修改天数
        </button>
      </header>
      <MapCanvas
        city={city}
        endpoints={plannedEndpoints}
        activeDay={activeDay}
        overviewOpen={overviewOpen}
        routes={routes}
        allSpots={spots}
        preferences={preferences}
        activeSpot={activeSpot}
        focusSpot={focusSpot}
        planCommitted={hasCommittedPlan && plannedIds.length > 0}
        onSpotClick={(spot) =>
          setActiveSpot((previous) => (previous?.id === spot.id ? null : spot))
        }
        onChoose={chooseSpot}
        onDiscover={discoverSpots}
      />
      <RouteDock
        cityName={city.name}
        days={days}
        routes={routes}
        activeDay={activeDay}
        setActiveDay={setActiveDay}
        endpoint={draftEndpoints[activeDay]}
        onEndpoint={editEndpoint}
        planning={planning}
        mode={displayMode}
        onMode={setDisplayMode}
        onRemove={remove}
        onInsert={insertRouteStop}
        pendingRemovalIds={pendingRemovalIds}
        onOpenAi={() => {
          setNavOpen(false);
          setAiOpen(true);
        }}
        editDirty={routeEditDirty}
        onCompleteEdit={completeRouteEdits}
        overviewOpen={overviewOpen}
        onToggleOverview={() => setOverviewOpen((open) => !open)}
        selectedCount={selected.length}
        mobileOpen={navOpen}
        onMinimize={() => setNavOpen(false)}
      />
      <button
        className={`mobile-nav-launcher ${hasNavigation ? "ready" : ""} ${navAttention ? "attention" : ""}`}
        onClick={() => {
          setNavAttention(false);
          setNavOpen(true);
        }}
      >
        <span>路线</span>
        <div>
          <b>{hasNavigation ? "查看导航" : "路线导航"}</b>
          <small>{hasNavigation ? "路线已生成" : "选好后查看"}</small>
        </div>
        <i aria-hidden="true">→</i>
      </button>
      <div className="map-day-legend">
        {routes
          .filter((route) => route.segments.length)
          .map((route) => (
            <span
              className={route.day - 1 === activeDay ? "active" : ""}
              key={route.day}
            >
              <i style={{ background: route.color }} />第 {route.day} 天
            </span>
          ))}
      </div>
      <MapSearch
        cityName={city.name}
        example={city.defaultStart.name}
        onAdd={addSearchSpot}
      />
      <div className="plan-actions">
        <button className="clear-selection-button" onClick={clearSelection}>
          清空所选景点
        </button>
        <button
          className={`done-button ${planDirty ? "dirty" : ""} ${planning ? "planning" : ""}`}
          onClick={commitPlan}
          disabled={planning}
        >
          <span>{planning ? "规划中" : "选好了"}</span>
          <i>{planning ? "•••" : "→"}</i>
        </button>
      </div>
      {!cardOpen && (
        <button
          className="deck-launcher"
          onClick={openCards}
          disabled={!cardImagesReady}
        >
          <span className="deck-icon">
            <i />
            <i />
          </span>
          <div>
            <b>热门景点卡片</b>
            <small>
              {!cardImagesReady
                ? "图片准备中"
                : cardsDone
                ? `${selected.length} 个想去`
                : `还剩 ${Math.max(0, cardSpots.length - decided)} 个`}
            </small>
          </div>
          <em aria-hidden="true">→</em>
        </button>
      )}
      {cardOpen && <div className="card-scrim" />}
      {cardOpen && (
        <SwipeCard
          spot={current}
          total={cardSpots.length}
          index={decided}
          onAct={act}
          onMinimize={() => setCardOpen(false)}
        />
      )}
      {routeError && <div className="route-error">{routeError}</div>}
      {summaryOpen && (
        <SelectionSheet
          spots={cardSpots}
          preferences={preferences}
          onClose={() => setSummaryOpen(false)}
          onContinue={() => {
            setSummaryOpen(false);
            if (current) setCardOpen(true);
          }}
        />
      )}
      {aiOpen && (
        <AiSheet
          spots={spots}
          days={days}
          cityName={city.name}
          currentPlan={groups}
          onClose={() => setAiOpen(false)}
          onApply={applyAi}
        />
      )}
    </main>
  );
}

export default function App() {
  const [screen, setScreen] = useState<"setup" | "planner">("setup");
  const [cityId, setCityId] = useState<CityId | null>(null);
  const [days, setDays] = useState(3);
  const [stays, setStays] = useState<Stay[]>([
    { id: "tentative", place: null, days: 3, color: STAY_COLORS[0] },
  ]);
  const [preparedCity, setPreparedCity] = useState<CityConfig | null>(null);
  const [entering, setEntering] = useState(false);
  const cityCache = useRef(new Map<CityId, CityConfig>());
  const city = cityId ? cityById(cityId) : null;
  useEffect(() => {
    if (!city) return;
    let active = true;
    void prepareCityCached(city).then((prepared) => {
      cityCache.current.set(city.id, prepared);
      if (active)
        void preloadAttractionImages(selectCardSpots(prepared.spots));
    });
    return () => {
      active = false;
    };
  }, [city?.id]);
  const enter = async () => {
    if (!city || entering) return;
    const cached = cityCache.current.get(city.id);
    if (cached) {
      setPreparedCity(cached);
      setScreen("planner");
      return;
    }
    setEntering(true);
    try {
      // 城市选择后已在后台预取；这里确保拿到真实中心与 citycode 再进入，
      // 避免公交 INVALID_PARAMS 与跨城步行 OVER_DIRECTION_RANGE。
      const prepared = await prepareCityCached(city);
      cityCache.current.set(city.id, prepared);
      setPreparedCity(prepared);
      setScreen("planner");
      void preloadAttractionImages(selectCardSpots(prepared.spots));
    } finally {
      setEntering(false);
    }
  };
  const chooseCity = (id: CityId) => {
    setCityId(id);
    if (preparedCity?.id !== id) setPreparedCity(null);
  };
  return screen === "setup" || !city || !preparedCity ? (
    <Setup
      cityId={cityId}
      setCityId={chooseCity}
      days={days}
      setDays={setDays}
      stays={stays}
      setStays={setStays}
      onEnter={enter}
      entering={entering}
    />
  ) : (
    <Planner
      key={preparedCity.id}
      city={preparedCity}
      days={days}
      stays={stays}
      onBack={() => setScreen("setup")}
    />
  );
}
