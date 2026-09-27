// Quota counts user submissions, not the model's internal verification/retry calls.
export const AI_DAILY_LIMIT = 30;
const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;

export function dailyWindow(now) {
  const day = Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS);
  return { day, resetAt: (day + 1) * DAY_MS - BEIJING_OFFSET_MS };
}

export function consumeDailyQuota(previous, now) {
  const { day, resetAt } = dailyWindow(now);
  const used = previous?.day === day ? previous.used : 0;
  const allowed = used < AI_DAILY_LIMIT;
  const state = { day, used: used + (allowed ? 1 : 0), resetAt };
  return { state, allowed, remaining: AI_DAILY_LIMIT - state.used, resetAt };
}

// One persistent object per hashed visitor: updates remain atomic across tabs,
// simultaneous requests, Worker isolates and redeployments.
export class AiDailyQuota {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const result = await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get("quota");
      const result = consumeDailyQuota(previous, Date.now());
      if (result.allowed) {
        await txn.put("quota", result.state);
        if (previous?.day !== result.state.day)
          await txn.setAlarm(result.resetAt);
      }
      return result;
    });
    return Response.json({
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt,
    });
  }

  async alarm() {
    await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get("quota");
      if (!state) return;
      if (state.resetAt <= Date.now()) await txn.delete("quota");
      else await txn.setAlarm(state.resetAt);
    });
  }
}

const quotaError = (error, status, headers = {}) =>
  Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

export async function withAiDailyQuota(request, env, next) {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" ||
      !["/api/ai", "/api/recognize-image"].includes(path)) return next();
  // No upstream key means no billable operation; preserve the original error.
  if (!env.DEEPSEEK_API_KEY) return next();

  let quota;
  try {
    // Never trust a caller-supplied visitor ID or X-Forwarded-For.
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || !env.AI_DAILY_QUOTA) throw new Error("Quota unavailable");
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(env.DEEPSEEK_API_KEY),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC", key, encoder.encode(`tuji-ai-visitor-v1:${ip.trim().toLowerCase()}`),
    );
    const visitor = Array.from(new Uint8Array(signature),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const object = env.AI_DAILY_QUOTA.get(env.AI_DAILY_QUOTA.idFromName(visitor));
    const response = await object.fetch("https://ai-quota/consume", { method: "POST" });
    if (!response.ok) throw new Error("Quota unavailable");
    quota = await response.json();
    if (typeof quota.allowed !== "boolean" ||
        !Number.isInteger(quota.remaining) || quota.remaining < 0 ||
        quota.remaining > AI_DAILY_LIMIT || !Number.isFinite(quota.resetAt))
      throw new Error("Invalid quota response");
  } catch {
    // Fail closed: an unavailable counter must not turn into unlimited AI calls.
    return quotaError("AI 调用额度暂时无法核验，请稍后重试", 503);
  }

  const headers = {
    "x-ai-daily-limit": String(AI_DAILY_LIMIT),
    "x-ai-daily-remaining": String(quota.remaining),
    "x-ai-daily-reset": String(Math.floor(quota.resetAt / 1000)),
  };
  if (!quota.allowed) return quotaError(
    "今日 AI 调用已达到 30 次上限，文字调整与图片识别共用额度，请在北京时间明日零点后再试",
    429,
    { ...headers, "retry-after": String(Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000))) },
  );
  // Failed/invalid submissions still consume a slot to bound repeated attempts.
  const original = await next();
  const response = new Response(original.body, original);
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  response.headers.set("cache-control", "no-store");
  return response;
}
