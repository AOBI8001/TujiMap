import {
  handleApiRequest,
  proxyAmapJsService,
} from "./cloud-functions/api/worker-impl.js";

/**
 * Cloudflare Workers 入口：
 * - /api/* 交给途迹现有的高德与 DeepSeek 后端处理；
 * - 其他请求交给 Cloudflare Static Assets，SPA 回退由 wrangler.jsonc 负责。
 */
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_AMapService/")) {
      return proxyAmapJsService(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, context);
    }
    return env.ASSETS.fetch(request);
  },
};
