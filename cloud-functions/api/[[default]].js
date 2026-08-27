// EdgeOne Makers Node Functions 入口：cloud-functions/api/[[default]].js
// 匹配 /api/* 所有请求，复用同目录 worker-impl.js 中的 API 实现。
import { handleApiRequest } from "./worker-impl.js";

/**
 * @param {{ request: Request, env: Record<string, string | undefined> }} context
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
  return handleApiRequest(context.request, context.env);
}
