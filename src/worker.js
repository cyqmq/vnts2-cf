import { Vnts2Room } from "./room.js";

export { Vnts2Room };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const options = env.LOCATION_HINT ? { locationHint: env.LOCATION_HINT } : undefined;
      const stub = env.VNTS2_ROOM.get(env.VNTS2_ROOM.idFromName("global"), options);

      if (url.pathname === "/peer" && env.SERVER_TOKEN) {
        return await stub.fetch(request);
      }

      if (url.pathname.startsWith("/peer/")) {
        return await stub.fetch(request);
      }

      if (url.pathname === "/" && request.headers.get("Upgrade") === "websocket") {
        return await stub.fetch(request);
      }

      // 根路径：跳转到仪表盘（未登录时前端再跳转到 /login）
      if (url.pathname === "/") {
        return Response.redirect(new URL("/dashboard", url.origin).toString(), 302);
      }

      if (url.pathname === "/health" || url.pathname === "/me" || url.pathname === "/login" || url.pathname === "/register" || url.pathname === "/test" || url.pathname === "/room" || url.pathname === "/settings" || url.pathname === "/config" || url.pathname === "/dashboard" || url.pathname === "/about") {
        return await stub.fetch(request);
      }

      // 服务端账户与房间加入 API（跨浏览器共享登录态）
      if (url.pathname.startsWith("/api/")) {
        return await stub.fetch(request);
      }

      // 未配置 LOG_PASSWORD 时 /log 和 /log/clear 不路由到 Durable Object，直接跳转项目地址
      if (env.LOG_PASSWORD && (url.pathname === "/log" || url.pathname === "/log/clear")) {
        return await stub.fetch(request);
      }

      // 未配置 ADMIN_PASSWORD 时 /admin 相关不路由到 Durable Object，直接跳转项目地址
      if (env.ADMIN_PASSWORD && url.pathname.startsWith("/admin")) {
        return await stub.fetch(request);
      }

      // 302 跳转到项目地址
      return Response.redirect("https://github.com/lmq8267/vnts2-cf", 302);
    } catch (error) {
      console.error("[vnts2-cf] Worker 请求处理失败", error);
      return Response.json({ ok: false, error: "服务暂时不可用" }, { status: 503 });
    }
  }
};
