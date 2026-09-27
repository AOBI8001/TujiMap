import {
  handleApiRequest,
  proxyAmapJsService,
} from "./cloud-functions/api/worker-impl.js";
export { AmapGateway } from "./cloud-functions/api/amap-gateway.js";
export { AiDailyQuota } from "./cloud-functions/api/ai-quota.js";
import { withAiDailyQuota } from "./cloud-functions/api/ai-quota.js";

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
      return withAiDailyQuota(request, env, () =>
        handleApiRequest(request, env, context),
      );
    }
    return env.ASSETS.fetch(request);
  },
};
