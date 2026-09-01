const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });

const memoryCache = new Map();
const serviceSchedulers = new Map();
const MAX_CACHE_ENTRIES = 500;
const AMAP_MIN_INTERVAL = 420;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const cachedValue = (key) => {
  const cached = memoryCache.get(key);
  if (!cached) return null;
  if (cached.expires <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return cached.value;
};

const remember = (key, value, ttl) => {
  if (memoryCache.size >= MAX_CACHE_ENTRIES)
    memoryCache.delete(memoryCache.keys().next().value);
  memoryCache.set(key, { value, expires: Date.now() + ttl });
};

// 同一热实例内，每种高德服务保留 420ms 间隔，单实例约 2.38 QPS。
// 用户搜索与路线拥有更高优先级，不会再被卡片图片后台预热堵在队尾。
const drainAmapQueue = async (state) => {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      state.queue.sort(
        (a, b) => b.priority - a.priority || a.sequence - b.sequence,
      );
      const job = state.queue.shift();
      const elapsed = Date.now() - state.lastStarted;
      if (elapsed < AMAP_MIN_INTERVAL) await sleep(AMAP_MIN_INTERVAL - elapsed);
      state.lastStarted = Date.now();
      try {
        job.resolve(await job.task());
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    state.running = false;
    // 有任务恰好在 while 判空与 running 复位之间入队时，重新启动排空，
    // 避免该请求永远停在队列里，导致整次多点规划持续“规划中”。
    if (state.queue.length) void drainAmapQueue(state);
  }
};

let amapJobSequence = 0;
const scheduleAmap = (service, task, priority = 0) => {
  let state = serviceSchedulers.get(service);
  if (!state) {
    state = { queue: [], running: false, lastStarted: 0 };
    serviceSchedulers.set(service, state);
  }
  return new Promise((resolve, reject) => {
    state.queue.push({
      task,
      priority,
      sequence: amapJobSequence++,
      resolve,
      reject,
    });
    void drainAmapQueue(state);
  });
};

const bodyJson = async (request) => {
  const text = await request.text();
  if (text.length > 50000) throw new Error("请求内容过长");
  return text ? JSON.parse(text) : {};
};

// 高德 JS API 官方推荐生产环境通过同源 /_AMapService 代理安全校验。
// 安全密钥只留在 Worker 环境变量中，不再交给浏览器。
export async function proxyAmapJsService(request, env) {
  if (!env.AMAP_SECURITY_CODE)
    return json({ error: "尚未配置高德 JS API 安全密钥" }, 503);
  const incoming = new URL(request.url);
  const prefix = "/_AMapService";
  if (!incoming.pathname.startsWith(`${prefix}/`))
    return json({ error: "高德代理路径无效" }, 404);
  const upstreamPath = incoming.pathname.slice(prefix.length);
  const upstreamOrigin = upstreamPath.startsWith("/v4/map/styles")
    ? "https://webapi.amap.com"
    : "https://restapi.amap.com";
  const target = new URL(`${upstreamPath}${incoming.search}`, upstreamOrigin);
  target.searchParams.set("jscode", env.AMAP_SECURITY_CODE);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("accept-encoding");
  headers.set("accept-encoding", "identity");
  headers.set("referer", incoming.origin);
  const response = await fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "follow",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  responseHeaders.set("access-control-allow-origin", incoming.origin);
  responseHeaders.set("vary", "origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

const collectPolyline = (value) => {
  if (!value) return [];
  if (typeof value === "object" && value.polyline)
    return collectPolyline(value.polyline);
  if (typeof value !== "string") return [];
  return value
    .split(";")
    .filter((point) => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(point));
};

const isAmapPhotoHost = (hostname) =>
  /(^|\.)(amap\.com|autonavi\.com)$/i.test(String(hostname || ""));

function preferredAmapPhoto(photos) {
  return (Array.isArray(photos) ? photos : [])
    .map((photo) => normalizeAmapPhoto(photo?.url))
    .filter(Boolean)
    .sort((a, b) => {
      const score = (source) => {
        const hostname = new URL(source).hostname.toLowerCase();
        if (hostname === "store.is.autonavi.com") return 3;
        if (hostname === "aos-cdn-image.amap.com") return 2;
        return 1;
      };
      return score(b) - score(a);
    })[0];
}

function normalizeAmapPhoto(source) {
  let parsed;
  try {
    parsed = new URL(String(source || ""));
  } catch {
    return "";
  }
  if (!/^https?:$/.test(parsed.protocol) || !isAmapPhotoHost(parsed.hostname))
    return "";
  parsed.protocol = "https:";
  return parsed.href;
}

function redirectAmapPhoto(source) {
  const location = normalizeAmapPhoto(source);
  if (!location) return null;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control":
        "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400",
    },
  });
}

const needsPhotoProxy = (source) => {
  try {
    return new URL(source).hostname.toLowerCase() === "aos-comment.amap.com";
  } catch {
    return false;
  }
};

async function proxyAmapPhoto(source) {
  const location = normalizeAmapPhoto(source);
  if (!location) return json({ error: "图片地址无效" }, 400);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(location, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: "https://www.amap.com/",
          "user-agent": "Mozilla/5.0 TujiMap/1.1",
        },
        signal: controller.signal,
        cf: { cacheEverything: true, cacheTtl: 2592000 },
      });
      if (!response.ok) throw new Error(`图片源返回 ${response.status}`);
      return new Response(response.body, {
        status: 200,
        headers: {
          "content-type": response.headers.get("content-type") || "image/jpeg",
          "cache-control":
            "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(350);
    } finally {
      clearTimeout(timeout);
    }
  }
  return json(
    { error: lastError instanceof Error ? lastError.message : "景点图片加载失败" },
    502,
  );
}

const straightDistanceKm = (from, to) => {
  const [fromLng, fromLat] = String(from).split(",").map(Number);
  const [toLng, toLat] = String(to).split(",").map(Number);
  const latitude = ((fromLat + toLat) / 2) * (Math.PI / 180);
  return (
    Math.hypot(
      (toLng - fromLng) * Math.cos(latitude),
      toLat - fromLat,
    ) * 111.32
  );
};

const requestJson = async (target, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(options.timeout) || 6500),
  );
  try {
    const response = await fetch(target, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
};

async function api(request, env, url) {
  if (url.pathname === "/api/amap-photo") {
    let source = String(url.searchParams.get("url") || "").slice(0, 1800);
    if (source && url.searchParams.get("proxy") === "1")
      return proxyAmapPhoto(source);
    let fallbackCity = "";
    let fallbackName = "";
    if (!source) {
      if (!env.AMAP_WEB_SERVICE_KEY)
        return json({ error: "尚未配置高德 Web服务 Key" }, 503);
      const city = String(url.searchParams.get("city") || "").slice(0, 20);
      const name = String(url.searchParams.get("name") || "").slice(0, 80);
      if (!city || !name) return json({ error: "缺少景点图片参数" }, 400);
      fallbackCity = city;
      fallbackName = name;
      const params = new URLSearchParams({
        key: env.AMAP_WEB_SERVICE_KEY,
        keywords: name,
        region: `${city.replace(/市$/, "")}市`,
        city_limit: "true",
        page_size: "10",
        page_num: "1",
        show_fields: "photos",
      });
      let data;
      try {
        data = await scheduleAmap(
          "places",
          () =>
            requestJson(`https://restapi.amap.com/v5/place/text?${params}`, {
              timeout: 5500,
            }),
          -10,
        );
      } catch {
        return json({ error: "高德景点图片查询失败" }, 502);
      }
      if (data?.status !== "1")
        return json({ error: data?.info || "高德景点图片查询失败" }, 502);
      const normalize = (value) =>
        String(value || "").replace(/[·\s()（）—_-]/g, "");
      const expected = normalize(name);
      const candidates = (data.pois || []).filter((poi) =>
        preferredAmapPhoto(poi.photos),
      );
      const matched =
        candidates.find((poi) => normalize(poi.name) === expected) ||
        candidates
          .filter((poi) => {
            const candidate = normalize(poi.name);
            return (
              Math.min(candidate.length, expected.length) >= 3 &&
              (candidate.includes(expected) || expected.includes(candidate))
            );
          })
          .sort(
            (a, b) =>
              Math.abs(normalize(a.name).length - expected.length) -
              Math.abs(normalize(b.name).length - expected.length),
          )[0] ||
        candidates[0];
      source = preferredAmapPhoto(matched?.photos) || "";
    }
    let photoUrl = normalizeAmapPhoto(source);
    if (!photoUrl && fallbackName) {
      const shorterName = fallbackName
        .replace(
          /(历史文化|历史|文化|传统|民俗|风貌|旅游)*(街区|名街|步行街|观景平台|景区|风景区)$/,
          "",
        )
        .trim();
      if (shorterName && shorterName !== fallbackName) {
        const fallbackParams = new URLSearchParams({
          key: env.AMAP_WEB_SERVICE_KEY,
          keywords: shorterName,
          region: `${fallbackCity.replace(/市$/, "")}市`,
          city_limit: "true",
          page_size: "10",
          page_num: "1",
          show_fields: "photos",
        });
        try {
          const fallbackData = await scheduleAmap(
            "places",
            () =>
              requestJson(
                `https://restapi.amap.com/v5/place/text?${fallbackParams}`,
                { timeout: 5500 },
              ),
            -10,
          );
          const fallbackSource = preferredAmapPhoto(
            fallbackData?.pois?.find((poi) => preferredAmapPhoto(poi.photos))
              ?.photos,
          );
          photoUrl = normalizeAmapPhoto(fallbackSource);
        } catch {
          // 继续使用无图占位，不影响卡片选择本身。
        }
      }
    }
    if (!photoUrl) return json({ error: "该景点暂无可用图片" }, 404);
    const clientPhotoUrl = needsPhotoProxy(photoUrl)
      ? `/api/amap-photo?url=${encodeURIComponent(photoUrl)}&proxy=1`
      : photoUrl;
    if (url.searchParams.get("format") === "json")
      return json(
        { url: clientPhotoUrl },
        200,
        {
          "cache-control":
            "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400",
        },
      );
    return redirectAmapPhoto(photoUrl);
  }
  if (url.pathname === "/api/status")
    return json({
      deepseek: Boolean(env.DEEPSEEK_API_KEY),
      amapMap: Boolean(env.AMAP_JS_KEY && env.AMAP_SECURITY_CODE),
      amapService: Boolean(env.AMAP_WEB_SERVICE_KEY),
      model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    });
  if (url.pathname === "/api/amap-config") {
    if (!env.AMAP_JS_KEY || !env.AMAP_SECURITY_CODE)
      return json({ error: "尚未配置高德 Web端 Key 与安全密钥" }, 503);
    return json(
      { key: env.AMAP_JS_KEY, serviceHost: "/_AMapService" },
      200,
      { "cache-control": "no-store" },
    );
  }
  if (url.pathname === "/api/places") {
    if (!env.AMAP_WEB_SERVICE_KEY)
      return json({ error: "尚未配置高德 Web服务 Key" }, 503);
    const requestedCity = url.searchParams.get("city") || "重庆";
    const city = /^[\u4e00-\u9fa5]{2,12}$/.test(requestedCity)
      ? requestedCity
      : "重庆";
    const params = new URLSearchParams({
      key: env.AMAP_WEB_SERVICE_KEY,
      keywords: url.searchParams.get("keywords") || "景点",
      region: `${city}市`,
      city_limit: "true",
      page_size: "20",
      page_num: url.searchParams.get("page") || "1",
      show_fields: "business,photos",
    });
    const placeCacheKey = `places:${city}:${params.get("keywords")}:${params.get("page_num")}`;
    const cachedPlaces = cachedValue(placeCacheKey);
    if (cachedPlaces)
      return json(cachedPlaces, 200, {
        "cache-control": "public, max-age=3600, s-maxage=86400",
        "x-tuji-cache": "hit",
      });
    let data;
    let placeError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        data = await scheduleAmap(
          "places",
          () =>
            requestJson(`https://restapi.amap.com/v5/place/text?${params}`, {
              timeout: 5500,
            }),
          20,
        );
        if (data?.status === "1") break;
        if (!/QPS_HAS_EXCEEDED|SERVER_IS_BUSY|GATEWAY_TIMEOUT/i.test(String(data?.info || "")))
          break;
      } catch (error) {
        placeError = error;
      }
      if (attempt === 0) await sleep(950 + Math.random() * 250);
    }
    if (!data) {
      const error = placeError;
      console.error("AMap place request failed", {
        code: error?.code,
        message: error?.message,
      });
      return json({ error: "高德地点服务暂时无法连接，请稍后重试" }, 502);
    }
    if (data.status !== "1")
      return json(
        { error: data.info || "高德地点搜索失败", infocode: data.infocode },
        502,
      );
    const pois = (data.pois || [])
      .filter((poi) => {
        const returnedCity = String(poi.cityname || "").replace(/市$/, "");
        return !returnedCity || returnedCity === city.replace(/市$/, "");
      })
      .map((poi, index) => ({
        id: poi.id,
        name: poi.name,
        address: typeof poi.address === "string" ? poi.address : `${city}市`,
        area: poi.adname || poi.district || city,
        location: poi.location,
        citycode: poi.citycode || city,
        type: poi.type,
        rating: poi.business?.rating || "",
        photo: preferredAmapPhoto(poi.photos) || "",
        hot: Math.max(
          45,
          82 - index - ((Number(url.searchParams.get("page")) || 1) - 1) * 10,
        ),
      }));
    const placeResult = { pois, count: Number(data.count || pois.length) };
    remember(placeCacheKey, placeResult, 60 * 60 * 1000);
    return json(placeResult, 200, {
      "cache-control": "public, max-age=3600, s-maxage=86400",
      "x-tuji-cache": "miss",
    });
  }
  if (url.pathname === "/api/route") {
    if (!env.AMAP_WEB_SERVICE_KEY)
      return json({ error: "尚未配置高德 Web服务 Key" }, 503);
    const origin = url.searchParams.get("origin");
    const destination = url.searchParams.get("destination");
    const requested = url.searchParams.get("mode");
    const mode = ["driving", "transit", "walking"].includes(requested)
      ? requested
      : "driving";
    if (!origin || !destination)
      return json({ error: "缺少路线起点或终点" }, 400);
    if (origin === destination)
      return json({
        mode,
        stationary: true,
        duration: 0,
        distance: 0,
        line: "已在此处",
        details: [
          {
            kind: mode === "driving" ? "drive" : "walk",
            title: "已在目的地",
            instruction: "无需移动",
            duration: 0,
            distance: 0,
          },
        ],
        polyline: [],
        source: "途迹",
      });
    const params = new URLSearchParams({
      key: env.AMAP_WEB_SERVICE_KEY,
      origin,
      destination,
      show_fields: "cost,navi,polyline",
    });
    const requestedRouteCity = String(url.searchParams.get("city") || "");
    let routeCity =
      /^\d{3,6}$/.test(requestedRouteCity) ||
      /^[\u4e00-\u9fa5]{2,12}$/.test(requestedRouteCity)
        ? requestedRouteCity
        : "023";
    if (mode === "transit" && !/^\d{3,6}$/.test(routeCity)) {
      const cityCodeKey = `citycode:${routeCity}`;
      const cachedCityCode = cachedValue(cityCodeKey);
      if (cachedCityCode) routeCity = cachedCityCode;
      else {
        const cityParams = new URLSearchParams({
          key: env.AMAP_WEB_SERVICE_KEY,
          keywords: `${routeCity}市政府`,
          region: `${routeCity.replace(/市$/, "")}市`,
          city_limit: "true",
          page_size: "1",
          page_num: "1",
        });
        try {
          const cityData = await scheduleAmap(
            "places",
            () =>
              requestJson(
                `https://restapi.amap.com/v5/place/text?${cityParams}`,
                { timeout: 4500 },
              ),
            30,
          );
          const code = String(cityData?.pois?.[0]?.citycode || "");
          if (/^\d{3,6}$/.test(code)) {
            routeCity = code;
            remember(cityCodeKey, code, 7 * 24 * 60 * 60 * 1000);
          }
        } catch {
          // 下方会返回明确的城市参数错误，不再把 INVALID_PARAMS 暴露给用户。
        }
      }
    }
    if (mode === "transit" && !/^\d{3,6}$/.test(routeCity))
      return json({ error: "暂时无法确认当前城市的公交代码，请重试" }, 502);
    const routeCacheKey = `route:${mode}:${routeCity}:${origin}>${destination}`;
    const cachedRoute = cachedValue(routeCacheKey);
    const routeCacheHeader =
      mode === "driving"
        ? "public, max-age=60, s-maxage=300"
        : mode === "transit"
          ? "public, max-age=1800, s-maxage=21600"
          : "public, max-age=86400, s-maxage=604800";
    if (cachedRoute)
      return json(cachedRoute, 200, {
        "cache-control": routeCacheHeader,
        "x-tuji-cache": "hit",
      });
    if (mode === "transit") {
      params.set("city1", routeCity);
      params.set("city2", routeCity);
    }
    if (mode === "driving") params.set("strategy", "32");
    const endpoint =
      mode === "walking"
        ? "walking"
        : mode === "driving"
          ? "driving"
          : "transit/integrated";
    const requestDirection = async (targetEndpoint, targetParams) => {
      let result = {};
      for (let attempt = 0; attempt < 1; attempt++) {
        try {
          result = await scheduleAmap(
            `direction:${targetEndpoint}`,
            () =>
              requestJson(
                `https://restapi.amap.com/v5/direction/${targetEndpoint}?${targetParams}`,
                { timeout: 5500 },
              ),
            10,
          );
        } catch (reason) {
          console.error("AMap direction request failed", {
            code: reason?.code,
            message: reason?.message,
          });
          result = {
            status: "0",
            info:
              reason?.name === "AbortError" ||
              reason?.message === "UPSTREAM_TIMEOUT"
                ? "ROUTE_TIMEOUT"
                : "ROUTE_NETWORK_ERROR",
          };
        }
        if (result.status === "1") break;
        break;
      }
      return result;
    };
    let data = await requestDirection(endpoint, params);
    if (data.status !== "1")
      return json(
        {
          error:
            /QPS_HAS_EXCEEDED|SERVER_IS_BUSY|GATEWAY_TIMEOUT|ROUTE_TIMEOUT|ROUTE_NETWORK_ERROR/i.test(
              String(data.info || ""),
            )
              ? "路线服务网络波动，请重试"
              : /OVER_DIRECTION_RANGE/i.test(String(data.info || ""))
                ? "两地点距离超出步行规划范围，请检查地点是否位于当前城市"
                : data.info || "高德路线规划失败",
          infocode: data.infocode,
        },
        502,
      );
    let resolvedMode = mode;
    let walkingFallback = false;
    let plan = mode === "transit" ? data.route?.transits?.[0] : data.route?.paths?.[0];
    if (
      !plan &&
      mode === "transit" &&
      straightDistanceKm(origin, destination) <= 3.5
    ) {
      const walkingParams = new URLSearchParams({
        key: env.AMAP_WEB_SERVICE_KEY,
        origin,
        destination,
        show_fields: "cost,navi,polyline",
      });
      data = await requestDirection("walking", walkingParams);
      if (data.status === "1") {
        plan = data.route?.paths?.[0];
        resolvedMode = "walking";
        walkingFallback = Boolean(plan);
      }
    }
    if (!plan) return json({ error: "高德未返回可用路线" }, 502);
    const polyline = [];
    const lines = [];
    const details = [];
    const cleanText = (value) =>
      String(value || "")
        .replace(/0x[0-9a-f]+/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    if (resolvedMode === "transit") {
      for (const segment of plan?.segments || []) {
        const busline = segment.bus?.buslines?.[0];
        const walkingSteps = segment.walking?.steps || [];
        const walkingDistance = Number(segment.walking?.distance || 0);
        if (walkingSteps.length && walkingDistance > 0) {
          for (const step of walkingSteps)
            polyline.push(...collectPolyline(step.polyline));
          details.push({
            kind: "walk",
            title: busline?.departure_stop?.name
              ? `步行至 ${busline.departure_stop.name}`
              : "步行至目的地",
            instruction: walkingSteps
              .map((step) => cleanText(step.instruction))
              .filter(Boolean)
              .slice(0, 3)
              .join("；"),
            duration: Number(segment.walking?.cost?.duration || 0),
            distance: walkingDistance,
          });
        }
        if (busline) {
          polyline.push(...collectPolyline(busline.polyline));
          const rawName = String(busline.name || "公共交通");
          const name = rawName.split("(")[0];
          const directionMatch = rawName.match(/\((?:.*--)?([^()]*)\)$/);
          const direction = directionMatch?.[1] || "";
          if (name) lines.push(name);
          details.push({
            kind: "transit",
            title: `乘坐 ${name}${direction ? `（${direction}方向）` : ""}`,
            line: name,
            direction,
            from: busline.departure_stop?.name || "上车站",
            to: busline.arrival_stop?.name || "下车站",
            via: Number(busline.via_num || 0),
            duration: Number(busline.cost?.duration || 0),
            distance: Number(busline.distance || 0),
          });
        }
      }
    } else {
      for (const activePlan of [plan]) {
        for (const step of activePlan?.steps || []) {
          const points = collectPolyline(step.polyline);
          polyline.push(...points);
          const isDriving = resolvedMode === "driving";
          details.push({
            kind: isDriving ? "drive" : "walk",
            title:
              cleanText(step.instruction) ||
              (isDriving ? "继续驾车" : "继续步行"),
            instruction: cleanText(step.road_name || step.road),
            duration: Number(step.cost?.duration || 0),
            distance: Number(step.step_distance || step.distance || 0),
          });
        }
      }
    }
    if (polyline.length < 2)
      return json({ error: "高德未返回真实道路折线" }, 502);
    const routeResult = {
      mode: resolvedMode,
      duration: [plan].reduce(
        (sum, item) =>
          sum + Number(item?.cost?.duration || item?.duration || 0),
        0,
      ),
      distance: [plan].reduce(
        (sum, item) => sum + Number(item?.distance || 0),
        0,
      ),
      line: walkingFallback
        ? "步行（附近无合适公交）"
        : [...new Set(lines)].slice(0, 3).join(" → ") ||
          (resolvedMode === "walking"
            ? "步行"
            : resolvedMode === "driving"
              ? "驾车"
              : "公共交通"),
      details,
      polyline,
      source: "高德地图 Web服务",
    };
    const routeTtl =
      mode === "driving"
        ? 5 * 60 * 1000
        : mode === "transit"
          ? 6 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
    remember(routeCacheKey, routeResult, routeTtl);
    return json(routeResult, 200, {
      "cache-control": routeCacheHeader,
      "x-tuji-cache": "miss",
    });
  }
  if (url.pathname === "/api/ai" && request.method === "POST") {
    if (!env.DEEPSEEK_API_KEY)
      return json({ error: "尚未配置 DeepSeek API Key" }, 503);
    const body = await bodyJson(request);
    const content = String(body.text || "").slice(0, 3000);
    const days = Math.max(1, Math.min(7, Number(body.days) || 3));
    const cityName = String(body.cityName || "当前城市").slice(0, 30);
    const available = Array.isArray(body.availableSpots)
      ? body.availableSpots.map(String).slice(0, 180)
      : [];
    const currentPlan = Array.isArray(body.currentPlan)
      ? body.currentPlan.slice(0, days).map((items) =>
          Array.isArray(items) ? items.map(String).slice(0, 20) : [],
        )
      : [];
    if (!content.trim()) return json({ error: "请输入行程要求" }, 400);
    const requestBody = JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: `你是“途迹”的${cityName}路线调整器。只返回JSON对象：{\"spots\":[{\"name\":\"候选地点中的完整原名\",\"preference\":\"like或avoid\",\"day\":1到${days}或null,\"after\":\"同一天中要排在其后的地点完整原名或null\"}],\"notes\":[\"简短中文说明\"]}。用户可以要求增加、移除、跨天移动、调整先后顺序或让某天轻松一点。加入或保留用like，删除用avoid；移动地点时用like并填写新的day；指定“在某地点之后”时填写after。只使用候选地点完整原名，不得虚构。对于“某天轻松一点”，从该天选择1到2个相对次要地点移到较空的一天，若无合适日期则删除一个相对次要地点。当前路线：${currentPlan.map((items, index) => `第${index + 1}天[${items.join("、")}]`).join("；") || "尚未规划"}。候选地点：${available.join("、")}`,
        },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      reasoning_effort: "low",
      max_tokens: 1000,
      temperature: 0.1,
    });
    let response;
    let data = {};
    let timedOut = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        response = await fetch(
          `${String(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
            },
            body: requestBody,
            signal: controller.signal,
          },
        );
        const raw = await response.text();
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = {
            error: {
              message:
                raw.slice(0, 180) || `上游服务返回 HTTP ${response.status}`,
            },
          };
        }
      } catch (error) {
        timedOut = error instanceof DOMException && error.name === "AbortError";
        data = {
          error: {
            message: timedOut ? "模型响应超时" : "无法连接 DeepSeek 模型",
          },
        };
      } finally {
        clearTimeout(timeout);
      }
      if (response?.ok) break;
      const message = String(data.error?.message || "");
      const retryable =
        timedOut ||
        !response ||
        response.status === 429 ||
        response.status >= 500 ||
        /rate|limit|访问量|过载|繁忙|timeout/i.test(message);
      if (!retryable || attempt === 1) break;
      await new Promise((resolve) =>
        setTimeout(resolve, 900 + Math.round(Math.random() * 500)),
      );
    }
    if (!response?.ok) {
      const message = String(data.error?.message || "");
      const busy =
        timedOut ||
        !response ||
        response.status === 429 ||
        response.status >= 500 ||
        /rate|limit|访问量|过载|繁忙|timeout/i.test(message);
      return json(
        {
          error: busy
            ? "DeepSeek-V4-Flash 当前访问量较大或响应超时，请稍后重试"
            : message || "DeepSeek 模型调用失败",
        },
        busy ? 503 : Math.min(599, Math.max(400, response.status)),
      );
    }
    try {
      const parsed = JSON.parse(
        data.choices?.[0]?.message?.content || "{}",
      );
      const seen = new Set();
      const spots = (Array.isArray(parsed.spots) ? parsed.spots : [])
        .map((item) => {
          const name = String(item?.name || "").trim();
          const preference = item?.preference === "avoid" ? "avoid" : "like";
          const numericDay = Number(item?.day);
          const day =
            Number.isInteger(numericDay) && numericDay >= 1 && numericDay <= days
              ? numericDay
              : null;
          const afterName = String(item?.after || "").trim();
          const after = available.includes(afterName) ? afterName : null;
          if (!available.includes(name) || seen.has(name)) return null;
          seen.add(name);
          return { name, preference, day, after };
        })
        .filter(Boolean)
        .slice(0, 16);
      return json({
        spots,
        notes: (Array.isArray(parsed.notes) ? parsed.notes : [])
          .map(String)
          .filter(Boolean)
          .slice(0, 3),
        source: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      });
    } catch {
      return json({ error: "模型返回格式异常，请重新提交一次" }, 502);
    }
  }
  return json({ error: "接口不存在" }, 404);
}

export async function handleApiRequest(request, env, context) {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/"))
      return json({ error: "接口不存在" }, 404);
    const cacheable =
      request.method === "GET" &&
      ["/api/places", "/api/route", "/api/amap-photo"].includes(url.pathname) &&
      typeof caches !== "undefined";
    const edgeCache = cacheable ? caches.default : null;
    if (edgeCache) {
      const cached = await edgeCache.match(request);
      if (cached) return cached;
    }
    const response = await api(request, env, url);
    if (
      edgeCache &&
      (response.ok || [301, 302, 307, 308].includes(response.status)) &&
      /public/i.test(response.headers.get("cache-control") || "")
    ) {
      const write = edgeCache.put(request, response.clone());
      if (context?.waitUntil) context.waitUntil(write);
      else await write;
    }
    return response;
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "服务异常" },
      500,
    );
  }
}
