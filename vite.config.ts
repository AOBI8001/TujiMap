import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import {
  handleApiRequest,
  proxyAmapJsService,
} from "./cloud-functions/api/worker-impl.js";

type Env = Record<string, string>;

async function nodeRequestToWeb(
  req: import("node:http").IncomingMessage,
): Promise<Request> {
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value != null) headers.set(name, value);
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > 50_000) throw new Error("请求内容过长");
      chunks.push(buffer);
    }
    init.body = Buffer.concat(chunks);
  }
  return new Request(new URL(req.url || "/", "http://localhost"), init);
}

function localApi(env: Env): Plugin {
  return {
    name: "tuji-local-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const isApi = req.url?.startsWith("/api/");
        const isAmapProxy = req.url?.startsWith("/_AMapService/");
        if (!isApi && !isAmapProxy) return next();
        try {
          const request = await nodeRequestToWeb(req);
          const response = isAmapProxy
            ? await proxyAmapJsService(request, env)
            : await handleApiRequest(request, env);
          res.statusCode = response.status;
          response.headers.forEach((value: string, name: string) =>
            res.setHeader(name, value),
          );
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "服务异常",
            }),
          );
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), localApi(env)],
    server: {
      host: true,
      port: 3000,
      strictPort: true,
    },
    preview: {
      host: true,
      port: 3000,
    },
  };
});
