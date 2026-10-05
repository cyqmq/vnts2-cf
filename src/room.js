import {
  MSG,
  decrementTtl,
  encodeClientSimpleInfoList,
  encodeConfirmRegResponse,
  encodeErrorResponse,
  encodeRegResponse,
  encodeRpcClientListResponse,
  encodeServerMessage,
  makePacket,
  parseServerMessage,
  parseRequestMessage,
  parseRpcRequest,
  parseSelectiveBroadcast,
  readPacket
} from "./protocol.js";
import { contains, defaultNetworkConfig, intToIp, networkConfigFromClientIp, networkConfigFromGateway, parseNetworks } from "./ip.js";
import { SERVER_VERSION as GEN_VERSION } from "./version.js";
import { setUiVersion } from "./ui.js";
import { renderHealthHtml, renderLoginPage, renderRegisterPage, renderLoginHtml, renderRoomHtml, renderRoomListHtml, renderPeerLoginHtml, renderPeerHtml, renderLogLoginHtml, renderLogHtml, renderSettingsHtml, renderAdminLoginHtml, renderAdminHtml, renderConfigHtml, renderDashboardHtml, renderAboutPage } from "./ui-pages.js";

const REG_NORMAL = 0;
const REG_PRE_REGISTER = 1;
const STORAGE_KEY = "vnts2-state";
const ACCOUNTS_KEY = "vnts2-accounts";
const SESSIONS_KEY = "vnts2-sessions";
const INVITES_KEY = "vnts2-invites";
const REG_MODE_KEY = "vnts2-registration-mode";
const REG_MODE_OPEN = "open";
const REG_MODE_INVITE = "invite";
const REG_MODE_CLOSED = "closed";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 1024;
const MAX_NETWORKS = 1024;
const MAX_STORED_DEVICES = 4096;
const SESSION_IDLE_TIMEOUT_MS = 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOINED_ROOMS = 32;

export class Vnts2Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.configErrors = [];
    try {
      this.allowedNetworks = parseNetworks(env);
    } catch (error) {
      this.allowedNetworks = new Set(["__invalid_network_configuration__"]);
      this.configErrors.push(`NETWORKS 配置无效：${errorMessage(error)}`);
    }
    // NETWORKS 为空表示允许任意网络编号；管理员添加的房间只用于展示/预置，
    // 不应改变"允许任意"的语义（否则添加一个房间后所有未列出的网络都会被拒绝）。
    this.allowAllNetworks = this.allowedNetworks.size === 0;
    this.networks = new Map();
    this.sessions = new Map();
    this.accountSessions = new Map();
    this.invites = new Map();
    this.registrationMode = normalizeRegistrationMode(env.REGISTER_MODE);
    this.nextSessionId = 1;
    this.accounts = new Map();
    this.initialized = false;
    this.serverVersion = env.SERVER_VERSION || GEN_VERSION;
    this.defaultGatewayIp = env.GATEWAY || "10.46.0.1";
    this.leaseDurationMs = positiveSeconds(env.LEASE_DURATION, 86400, 10) * 1000;
    this.peerServers = String(env.PEER_SERVERS || "")
      .split(",")
      .map((v) => v.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    this.peerToken = env.SERVER_TOKEN || "";
    this.peerTokenHash = "";
    this.peerClientCache = new Map();
    this.peerClientCacheTime = 0;
    this.peerClientCacheSignature = "";
    this.peerServerStatus = new Map();
    this.logLevel = String(env.LOG_LEVEL || "info").toLowerCase();
    this.maintenanceIntervalMs = positiveSeconds(env.MAINTENANCE_INTERVAL, 15, 5) * 1000;
    this.logs = [];
    this.logPassword = String(env.LOG_PASSWORD || "");
    this.adminPassword = String(env.ADMIN_PASSWORD || "");
    // 安全：密码/令牌的哈希值，用于会话 Cookie 认证（避免明文存于 Cookie）
    this.logPasswordHash = "";
    this.adminPasswordHash = "";
    this.disableRelay = parseBool(env.DISABLE_RELAY || "");
    this.lastError = "";
    this.startTime = Date.now();
    this._dataDirty = false;
    this._logPersistScheduled = false;
    // 管理员为每个房间设置的组网密码（networkCode -> password），用于客户端配置文件
    this.networkPasswords = new Map();
  }

  async fetch(request) {
    try {
      await this.init();
      const url = new URL(request.url);
      if (url.pathname.startsWith("/peer/")) return await this.handlePeerRequest(request, url);
      if (url.pathname === "/peer") return await this.handlePeerPage(request, url);
      if (request.headers.get("Upgrade") === "websocket") return this.acceptWebSocket(request);
      if (url.pathname === "/health") return await this.handleHealthPage(request, url);
      if (url.pathname === "/test") return Response.redirect(new URL("/health", url.origin).toString(), 302);
      if (url.pathname === "/me") return Response.redirect(new URL("/dashboard", url.origin).toString(), 302);
      if (url.pathname === "/dashboard") return await this.handleDashboardPage(request, url);
      if (url.pathname === "/about") return htmlResponse(renderAboutPage());
      if (url.pathname === "/login") return htmlResponse(renderLoginPage());
      if (url.pathname === "/register") return htmlResponse(renderRegisterPage());
      if (url.pathname === "/room") return await this.handleRoomPage(request, url);
      if (url.pathname === "/log") return await this.handleLogPage(request, url);
      if (url.pathname === "/log/clear") return await this.handleLogClear(request, url);
      if (url.pathname === "/settings") return this.handleSettingsPage(request, url);
      if (url.pathname === "/admin/rooms" && request.method === "POST") return await this.handleAdminAddRoom(request, url);
      if (url.pathname === "/admin/rooms/password" && request.method === "POST") return await this.handleAdminSetRoomPassword(request, url);
      if (url.pathname === "/admin" || url.pathname === "/admin/config") return await this.handleAdminPage(request, url);
      if (url.pathname === "/config") return await this.handleConfigDownload(request, url);
      if (url.pathname.startsWith("/api/")) return await this.handleApiRequest(request, url);
      return Response.redirect("https://github.com/lmq8267/vnts2-cf", 302);
    } catch (error) {
      this.reportError("请求处理失败", error);
      return Response.json({ ok: false, error: "请求处理失败" }, { status: 500 });
    }
  }

  async init() {
    if (this.initialized) return;
    const saved = await this.state.storage.get(STORAGE_KEY);
    // 恢复管理员添加的房间（持久化键 vnts2-admin-rooms）
    try {
      const adminRooms = await this.state.storage.get("vnts2-admin-rooms");
      if (Array.isArray(adminRooms)) {
        for (const code of adminRooms) {
          if (code && code.length <= 32 && !this.allowedNetworks.has(code)) {
            this.allowedNetworks.add(code);
          }
        }
      }
    } catch (error) {
      this.reportError("恢复管理员房间失败", error);
    }
    // 恢复管理员设置的房间组网密码（持久化键 vnts2-network-passwords）
    try {
      const savedPasswords = await this.state.storage.get("vnts2-network-passwords");
      if (savedPasswords && typeof savedPasswords === "object" && !Array.isArray(savedPasswords)) {
        for (const [code, password] of Object.entries(savedPasswords)) {
          if (code && code.length <= 32 && typeof password === "string") {
            this.networkPasswords.set(code, password);
          }
        }
      }
    } catch (error) {
      this.reportError("恢复房间组网密码失败", error);
    }
    let restoredDevices = 0;
    if (saved?.networks && typeof saved.networks === "object" && !Array.isArray(saved.networks)) {
      for (const [code, value] of Object.entries(saved.networks)) {
        try {
          if (this.networks.size >= MAX_NETWORKS || restoredDevices >= MAX_STORED_DEVICES) break;
          if (!code || code.length > 32 || !this.isNetworkAllowedByConfig(code) || !value || typeof value !== "object") continue;
          const net = this.ensureNetwork(code, storedNetworkConfig(value.config, this.defaultGatewayIp));
          net.dataVersion = safeNonNegativeInteger(value.dataVersion);
          for (const record of Array.isArray(value.devices) ? value.devices : []) {
            if (restoredDevices >= MAX_STORED_DEVICES) break;
            if (!record || typeof record.deviceId !== "string" || !record.deviceId || record.deviceId.length > 64 || !isUint32(record.ip)) continue;
            if (record.ip === net.config.gateway || !contains(net.config, record.ip) || net.ipToDevice.has(record.ip >>> 0)) continue;
            net.devices.set(record.deviceId, {
              ...record,
              ip: record.ip >>> 0,
              online: false,
              socket: undefined,
              sessionId: undefined,
              disconnectTime: safeTimestamp(record.disconnectTime, Date.now())
            });
            net.ipToDevice.set(record.ip >>> 0, record.deviceId);
            restoredDevices += 1;
          }
        } catch (error) {
          this.reportError(`恢复网络状态失败 网络编号=${code}`, error);
        }
      }
    }
    this.initialized = true;
    if (this.peerToken) this.peerTokenHash = await sha256Hex(this.peerToken);
    if (this.logPassword) this.logPasswordHash = await sha256Hex(this.logPassword);
    if (this.adminPassword) this.adminPasswordHash = await sha256Hex(this.adminPassword);
    // 恢复服务端账户（用户名 + 密码哈希 + 已加入房间）
    try {
      const savedAccounts = await this.state.storage.get(ACCOUNTS_KEY);
      if (savedAccounts && typeof savedAccounts === "object" && !Array.isArray(savedAccounts)) {
        for (const [name, value] of Object.entries(savedAccounts)) {
          if (!name || name.length > 64 || !value || typeof value !== "object" || typeof value.passwordHash !== "string") continue;
          this.accounts.set(name, {
            passwordHash: value.passwordHash,
            passwordSalt: value.passwordSalt || "",
            deviceName: value.deviceName || name,
            virtualIp: value.virtualIp || "",
            createdAt: value.createdAt || toBeijingTime(new Date()),
            joinedRooms: Array.isArray(value.joinedRooms) ? value.joinedRooms.filter((c) => typeof c === "string").slice(0, MAX_JOINED_ROOMS) : []
          });
        }
      }
    } catch (error) {
      this.reportError("恢复账户数据失败", error);
    }
    // 恢复账户会话（持久化登录态，DO 重启后 Cookie 仍有效）
    try {
      const savedSessions = await this.state.storage.get(SESSIONS_KEY);
      if (savedSessions && typeof savedSessions === "object" && !Array.isArray(savedSessions)) {
        for (const [token, s] of Object.entries(savedSessions)) {
          if (token && s && typeof s.username === "string" && typeof s.expires === "number" && s.expires > Date.now()) {
            this.accountSessions.set(token, { username: s.username, expires: s.expires });
          }
        }
      }
    } catch (error) {
      this.reportError("恢复账户会话失败", error);
    }
    // 恢复注册模式（管理员设置优先于环境变量）
    try {
      const savedMode = await this.state.storage.get(REG_MODE_KEY);
      if (savedMode === REG_MODE_OPEN || savedMode === REG_MODE_INVITE || savedMode === REG_MODE_CLOSED) {
        this.registrationMode = savedMode;
      }
    } catch (error) {
      this.reportError("恢复注册模式失败", error);
    }
    // 恢复邀请码
    try {
      const savedInvites = await this.state.storage.get(INVITES_KEY);
      if (savedInvites && typeof savedInvites === "object" && !Array.isArray(savedInvites)) {
        for (const [code, inv] of Object.entries(savedInvites)) {
          if (code && inv && typeof inv.remaining === "number") {
            this.invites.set(code, {
              code,
              remaining: inv.remaining,
              maxUses: inv.maxUses || inv.remaining,
              expiresAt: inv.expiresAt || 0,
              createdAt: inv.createdAt || "",
              disabled: !!inv.disabled
            });
          }
        }
      }
    } catch (error) {
      this.reportError("恢复邀请码失败", error);
    }
    // 设置 UI 显示的服务端版本
    setUiVersion(this.serverVersion);
    // 先恢复日志，再记录启动日志，避免被 restoreLogs 覆盖
    await this.restoreLogs();
    this.logDebug(`存储恢复完毕 网络数=${this.networks.size} 设备数=${this.totalDeviceCount()}`);
    await this.scheduleAlarm();
    for (const message of this.configErrors) this.reportError("配置错误", new Error(message));
  }

  async alarm() {
    try {
      await this.cleanupExpired();
      await this.refreshPeerClientCache(true);
      this.pingLocalClients();
    } catch (error) {
      this.reportError("维护任务失败", error);
    } finally {
      try {
        // 持久化网络状态
        const dirty = this._dataDirty;
        await this.persist();
        if (dirty) this.logDebug(`持久化保存 网络数=${this.networks.size} 设备数=${this.totalDeviceCount()}`);
        // 持久化日志（兜底，防止日志在 DO 休眠前未写入）
        if (!this._logPersistScheduled && this.logs.length > 0) {
          this._logPersistScheduled = true;
          await this.state.storage.put("vnts2-logs", this.logs.slice());
          this._logPersistScheduled = false;
        }
      } catch (error) {
        this.reportError("数据持久化保存失败", error);
      }
      await this.scheduleAlarm();
    }
  }

  acceptWebSocket(request) {
    if (this.sessions.size >= MAX_SESSIONS) return Response.json({ ok: false, error: "服务端连接数已达到上限" }, { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const sessionId = this.nextSessionId++;
    const remote = getClientIp(request);
    this.sessions.set(sessionId, { id: sessionId, socket: server, registered: false, remote, openedAt: Date.now() });
    this.logInfo(`收到 WebSocket 连接，会话=${sessionId} 来源=${remote || "未知"}`);
    server.addEventListener("message", (event) => this.handleMessage(sessionId, event.data).catch((error) => this.closeWithError(sessionId, error).catch((closeError) => this.reportError(`关闭异常会话失败 会话=${sessionId}`, closeError))));
    server.addEventListener("close", (event) => {
      const promise = this.offline(sessionId);
      if (typeof this.state.waitUntil === "function") this.state.waitUntil(promise);
      promise.catch((error) => this.reportError(`处理客户端离线失败 会话=${sessionId}`, error));
    });
    server.addEventListener("error", (event) => {
      const promise = this.offline(sessionId);
      if (typeof this.state.waitUntil === "function") this.state.waitUntil(promise);
      promise.catch((error) => this.reportError(`处理 WebSocket 错误失败 会话=${sessionId}`, error));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(sessionId, raw) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const bytes = await toBytes(raw);
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error(`消息超过大小限制：${bytes.length} > ${MAX_MESSAGE_BYTES}`);
    if (!session.registered) {
      await this.handleRegister(session, bytes);
      return;
    }
    if (session.pendingConfirmation) {
      const req = tryParseRequest(bytes);
      if (req?.confirmReg) {
        session.pendingConfirmation = false;
        session.registrationStatus = "confirmed";
        this.send(session, encodeConfirmRegResponse(true));
        await this.persistSoon();
      }
      return;
    }
    await this.handleData(session, bytes);
  }

  async handleRegister(session, bytes) {
    const req = parseRequestMessage(bytes);
    if (!req.reg) throw new Error("首包必须是注册请求");
    const reg = req.reg;
    this.validateReg(reg);
    if (!this.isNetworkAllowedByConfig(reg.networkCode)) {
      throw new Error(`network_code '${reg.networkCode}' is not allowed by server configuration or database`);
    }

    const isNewNetwork = !this.networks.has(reg.networkCode);
    if (isNewNetwork && this.networks.size >= MAX_NETWORKS) throw new Error("服务端网络数量已达到上限");
    const resolvedConfig = this.resolveNetworkConfig(reg.networkCode, reg.ip);
    if (!resolvedConfig) throw new Error("IP 网段已被其他网络占用，请更换虚拟 IP 或使用不同网段的 IP");
    const net = this.ensureNetwork(reg.networkCode, resolvedConfig);
    const cfg = net.config;
    let allocation;
    try {
      if (!net.devices.has(reg.deviceId) && this.totalDeviceCount() >= MAX_STORED_DEVICES) throw new Error("服务端设备数量已达到上限");
      allocation = this.allocateIp(net, cfg, reg, session.id);
    } catch (error) {
      if (isNewNetwork && !net.devices.size) this.networks.delete(reg.networkCode);
      throw error;
    }
    const { ip, device } = allocation;
    this._dataDirty = true;
    session.registered = true;
    session.networkCode = reg.networkCode;
    session.deviceId = reg.deviceId;
    session.ip = ip;
    session.pendingConfirmation = reg.registrationMode === REG_PRE_REGISTER;
    session.registrationStatus = session.pendingConfirmation ? "pending" : "confirmed";
    device.socket = session.socket;
    device.sessionId = session.id;
    device.online = true;

    this.send(session, encodeRegResponse({ ip, prefixLen: cfg.prefix, gateway: cfg.gateway, serverVersion: this.serverVersion }));
    this.logInfo(`注册成功 网络编号=${reg.networkCode} 设备ID=${reg.deviceId} 虚拟IP=${intToIp(ip)} 注册模式=${session.pendingConfirmation ? "预注册" : "普通"} 客户端版本=${reg.version || "未知"}${reg.name ? ` 设备名称=${reg.name}` : ""}`);
    if (!session.pendingConfirmation) {
      await this.persistSoon();
      this.logDebug(`注册后持久化完成 网络编号=${reg.networkCode} 设备ID=${reg.deviceId} 虚拟IP=${intToIp(ip)}`);
    }
  }

  validateReg(reg) {
    if (!reg.networkCode) throw new Error("网络编号不能为空");
    if (reg.networkCode.length > 32) throw new Error("网络编号长度不能超过 32 个字符");
    if (!reg.deviceId) throw new Error("设备 ID 不能为空");
    if (reg.deviceId.length > 64) throw new Error("设备 ID 长度不能超过 64 个字符");
    if ((reg.name || "").length > 128) throw new Error("设备名称长度不能超过 128 个字符");
    if ((reg.version || "").length > 32) throw new Error("客户端版本长度不能超过 32 个字符");
  }

  allocateIp(net, cfg, reg, sessionId) {
    const existing = net.devices.get(reg.deviceId);
    const expected = reg.ip;
    const currentMatches = existing && (expected === undefined || existing.ip === expected);
    if (currentMatches) {
      if (!existing.ip) existing.ip = this.findAvailableIp(net, cfg);
      existing.name = reg.name || "";
      existing.version = reg.version || "";
      existing.keySign = reg.keySign;
      existing.lastConnectedTime = unixSeconds();
      existing.disconnectTime = undefined;
      existing.sessionId = sessionId;
      existing.online = true;
      net.ipToDevice.set(existing.ip, reg.deviceId);
      this.bump(net, existing);
      return { ip: existing.ip, device: existing };
    }

    const oldIp = existing?.ip;
    let ip = expected;
    if (ip !== undefined) {
      if (ip === cfg.gateway) {
        if (!reg.ipVariable) throw new Error("此IP为网关IP，不允许使用");
        ip = undefined;
      } else if (!contains(cfg, ip)) {
        if (!reg.ipVariable) throw new Error(`IP网段错误，应使用${cfg.cidr}网段中的IP`);
        ip = undefined;
      } else if (net.ipToDevice.has(ip) && net.ipToDevice.get(ip) !== reg.deviceId) {
        if (!reg.ipVariable) {
          const deviceId = net.ipToDevice.get(ip);
          const device = net.devices.get(deviceId);
          if (device) throw new Error(`IP重复，设备${device.name || ""}[${device.deviceId}]已使用此IP`);
          throw new Error("IP重复，服务端数据错误");
        }
        ip = undefined;
      }
    }
    if (ip === undefined) ip = this.findAvailableIp(net, cfg);
    if (oldIp) net.ipToDevice.delete(oldIp);

    const device = {
      deviceId: reg.deviceId,
      ip,
      name: reg.name || "",
      version: reg.version || "",
      keySign: reg.keySign,
      online: true,
      lastConnectedTime: unixSeconds(),
      disconnectTime: undefined,
      dataVersion: 0,
      txBytes: existing?.txBytes || 0,
      rxBytes: existing?.rxBytes || 0,
      sessionId
    };
    net.devices.set(reg.deviceId, device);
    net.ipToDevice.set(ip, reg.deviceId);
    this.bump(net, device);
    return { ip, device };
  }

  findAvailableIp(net, cfg) {
    for (let i = cfg.network + 1; i < cfg.broadcast; i++) {
      const ip = i >>> 0;
      if (ip !== cfg.gateway && !net.ipToDevice.has(ip)) return ip;
    }
    throw new Error("IP exhaustion");
  }

  async handleData(session, bytes) {
    const packet = readPacket(bytes);
    const net = this.ensureNetwork(session.networkCode);
    const srcDevice = net.devices.get(session.deviceId);
    if (srcDevice) srcDevice.txBytes = (srcDevice.txBytes || 0) + bytes.length;

    if (packet.isGateway) {
      await this.handleGateway(session, packet, bytes);
      return;
    }

    if ([MSG.TURN, MSG.PING, MSG.PONG, MSG.PUNCH_START_1, MSG.PUNCH_START_2, MSG.QUIC, MSG.RELAY_PROBE, MSG.RELAY_PROBE_CLIENT, MSG.RELAY_PROBE_REPLY_CLIENT].includes(packet.msgType)) {
      if (this.disableRelay && isRelayDataMessage(packet.msgType)) {
        this.logDebug(`禁止中转已启用，丢弃数据中转 网络编号=${session.networkCode} 类型=${packet.msgType} 目标=${intToIp(packet.destId)}`);
        return;
      }
      const copy = new Uint8Array(bytes);
      if (!decrementTtl(copy)) return;
      if (this.peerServers.length) await this.refreshPeerClientCache();
      if (!this.forwardToIp(net, packet.destId, copy)) await this.forwardToPeers(session.networkCode, packet.destId, copy);
    } else if (packet.msgType === MSG.BROADCAST) {
      if (this.disableRelay) {
        this.logDebug(`禁止中转已启用，丢弃广播中转 网络编号=${session.networkCode} 来源=${intToIp(packet.srcId)}`);
        return;
      }
      const copy = new Uint8Array(bytes);
      if (!decrementTtl(copy)) return;
      this.broadcast(net, packet.srcId, copy);
    } else if (packet.msgType === MSG.EXCLUDE_BROADCAST || packet.msgType === MSG.TARGET_BROADCAST) {
      if (this.disableRelay) {
        this.logDebug(`禁止中转已启用，丢弃选择性广播中转 网络编号=${session.networkCode} 来源=${intToIp(packet.srcId)}`);
        return;
      }
      const selective = parseSelectiveBroadcast(packet.payload);
      const inner = new Uint8Array(selective.data);
      const innerPacket = readPacket(inner);
      if (!decrementTtl(inner)) return;
      if (packet.msgType === MSG.EXCLUDE_BROADCAST) {
        for (const device of net.devices.values()) {
          if (device.online && device.ip !== packet.srcId && !selective.ips.has(device.ip)) this.sendDevice(device, inner);
        }
      } else {
        for (const ip of selective.ips) {
          if (ip !== packet.srcId && !this.forwardToIp(net, ip, inner, innerPacket.destId)) await this.forwardToPeers(session.networkCode, ip, inner);
        }
      }
    }
  }

  async handleGateway(session, packet, bytes) {
    if (packet.msgType === MSG.TURN) {
      const reply = makeIcmpEchoReply(packet);
      if (reply) this.send(session, reply);
    } else if (packet.msgType === MSG.PING_TURN) {
      if (packet.payload.length === 16) {
        const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
        const time = Number(view.getBigUint64(0, false));
        const dataVersion = Number(view.getBigUint64(8, false));
        await this.refreshPeerClientCache();
        const changed = this.changedClientSimpleList(session, dataVersion, time);
        if (changed) this.send(session, makePacket(MSG.PUSH_CLIENT_IPS, encodeClientSimpleInfoList(changed), { gateway: true, ttl: 1 }));
        else {
          const pong = new Uint8Array(bytes);
          pong[0] = 0x80 | MSG.PONG_TURN;
          this.send(session, pong);
        }
      } else if (packet.payload.length === 8) {
        const pong = new Uint8Array(bytes);
        pong[0] = 0x80 | MSG.PONG_TURN;
        this.send(session, pong);
      }
    } else if (packet.msgType === MSG.PONG && packet.payload.length === 8) {
      const device = this.ensureNetwork(session.networkCode).devices.get(session.deviceId);
      if (device) device.latencyMs = Math.max(0, Math.floor((Date.now() - Number(new DataView(packet.payload.buffer, packet.payload.byteOffset, 8).getBigUint64(0, false))) / 2));
    } else if (packet.msgType === MSG.RPC_REQ) {
      const req = parseRpcRequest(packet.payload);
      if (!req.clientListReq) return;
      await this.refreshPeerClientCache();
      const payload = encodeRpcClientListResponse(req.id, this.clientInfoList(session));
      this.send(session, makePacket(MSG.RPC_RES, payload, { gateway: true, ttl: 1 }));
    }
  }

  changedClientSimpleList(session, dataVersion, time) {
    const net = this.ensureNetwork(session.networkCode);
    if (dataVersion === net.dataVersion) return null;
    const isAll = dataVersion > net.dataVersion;
    const list = [];
    for (const device of net.devices.values()) {
      if (!device.ip || device.ip === session.ip) continue;
      if (isAll || device.dataVersion > dataVersion) list.push({ ip: device.ip, online: !!device.online });
    }
    for (const remote of this.remoteClients(session.networkCode)) {
      if (remote.ip !== session.ip) list.push({ ip: remote.ip, online: !!remote.online });
    }
    return { dataVersion: net.dataVersion, list, isAll, time };
  }

  clientInfoList(session) {
    const net = this.ensureNetwork(session.networkCode);
    const localKeySign = net.devices.get(session.deviceId)?.keySign || "";
    const cfg = net.config;
    const list = [];
    list.push({
      name: this.env.GATEWAY_NAME || "服务器",
      version: this.serverVersion,
      ip: cfg.gateway,
      keySign: localKeySign,
      online: true,
      lastConnectedTime: unixSeconds(),
      id: `gateway-${session.networkCode}`
    });
    for (const device of net.devices.values()) {
      if (!device.ip || device.ip === session.ip) continue;
      list.push({
        name: device.name || "",
        version: device.version || "",
        ip: device.ip,
        keySign: device.keySign,
        online: !!device.online,
        lastConnectedTime: device.lastConnectedTime || 0,
        id: device.deviceId
      });
    }
    for (const remote of this.remoteClients(session.networkCode)) {
      if (remote.ip === session.ip) continue;
      list.push({
        name: remote.name || "",
        version: remote.version || "",
        ip: remote.ip,
        keySign: remote.keySign || localKeySign,
        online: !!remote.online,
        lastConnectedTime: remote.lastConnectedTime || 0,
        id: remote.deviceId || ""
      });
    }
    return list;
  }

  forwardToIp(net, ip, bytes) {
    const deviceId = net.ipToDevice.get(ip >>> 0);
    const device = deviceId ? net.devices.get(deviceId) : undefined;
    if (!device?.online) return false;
    device.rxBytes = (device.rxBytes || 0) + bytes.length;
    this.sendDevice(device, bytes);
    this.logDebug(`本地转发 目标=${intToIp(ip)} 字节=${bytes.length}`);
    return true;
  }

  broadcast(net, srcIp, bytes) {
    for (const device of net.devices.values()) {
      if (device.online && device.ip !== srcIp) this.sendDevice(device, bytes);
    }
  }

  sendDevice(device, bytes) {
    if (device.socket?.readyState !== 1) return false;
    try {
      device.socket.send(bytes);
      return true;
    } catch (error) {
      this.reportError(`发送客户端数据失败 设备ID=${device.deviceId || "未知"}`, error);
      return false;
    }
  }

  send(session, bytes) {
    if (session.socket?.readyState !== 1) return false;
    try {
      session.socket.send(bytes);
      return true;
    } catch (error) {
      this.reportError(`发送会话数据失败 会话ID=${session.id}`, error);
      return false;
    }
  }

  async closeWithError(sessionId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.logInfo(`会话异常关闭 会话=${sessionId} 原因=${error.message || String(error)}`);
    if (!session.registered) {
      try {
        this.send(session, encodeErrorResponse(400, error.message || String(error)));
      } catch {}
    }
    try {
      session.socket.close(1011, "server error");
    } catch {}
    await this.offline(sessionId);
  }

  async handlePeerRequest(request, url) {
    // 安全：所有 /peer/* 接口（包括 /peer/message）都先经过 HTTP 层认证，
    // 避免未授权请求获得 authRes 响应（防暴力尝试 authReq）。
    // 合法的互联协议请求（forwardToPeers/refreshPeerClientCache）均携带 X-Peer-Token(-Hash) 头。
    if (!this.peerAuthorized(request)) return new Response("未授权", { status: 401 });
    if (url.pathname === "/peer/message") return this.handlePeerMessage(request);
    if (url.pathname === "/peer/ping") return Response.json({ ok: true, server: this.serverVersion, now: Date.now() });
    if (url.pathname === "/peer/client-info") return Response.json({ networks: this.exportPeerClientInfo() });
    if (url.pathname === "/peer/forward") {
      const networkCode = url.searchParams.get("network") || "";
      const dest = Number(url.searchParams.get("dest") || 0) >>> 0;
      const net = this.networks.get(networkCode);
      if (!net) return Response.json({ delivered: false });
      const bytes = await readRequestBytes(request);
      let packet;
      try {
        packet = readPacket(bytes);
      } catch {
        return Response.json({ delivered: false });
      }
      // 与本地转发一致：禁止中转模式下丢弃 TURN/QUIC 类数据，且每次转发递减 TTL
      if (this.disableRelay && isRelayDataMessage(packet.msgType)) {
        this.logDebug(`禁止中转已启用，丢弃互联转发 网络编号=${networkCode} 类型=${packet.msgType} 目标=${intToIp(dest)}`);
        return Response.json({ delivered: false });
      }
      const relay = new Uint8Array(bytes);
      if (!decrementTtl(relay)) return Response.json({ delivered: false });
      const delivered = this.forwardToIp(net, dest, relay);
      this.logDebug(`互联转发接收 网络=${networkCode} 目标=${intToIp(dest)} 已投递=${delivered}`);
      return Response.json({ delivered });
    }
    return Response.redirect("https://github.com/lmq8267/vnts2-cf", 302);
  }

  peerAuthorized(request) {
    if (!this.peerToken) return false;
    // 安全：常量时间比较，避免逐字节短路泄露令牌前缀
    return safeEqual(request.headers.get("X-Peer-Token") || "", this.peerToken) || safeEqual(request.headers.get("X-Peer-Token-Hash") || "", this.peerTokenHash);
  }

  async handlePeerMessage(request) {
    const msg = parseServerMessage(await readRequestBytes(request));
    if (msg.authReq) {
      const success = !!this.peerTokenHash && safeEqual(msg.authReq.tokenHash || "", this.peerTokenHash);
      return peerProtoResponse({ authRes: { success, message: success ? "OK" : "Invalid token" } });
    }
    if (!this.peerAuthorized(request)) return new Response("未授权", { status: 401 });

    if (msg.pingReq) {
      return peerProtoResponse({
        pingRes: {
          requestTimestamp: msg.pingReq.timestamp,
          responseTimestamp: Date.now()
        }
      });
    }

    if (msg.clientInfoReq) {
      return peerProtoResponse({ clientInfoRes: this.peerClientInfoResponse(msg.clientInfoReq.networkCodes) });
    }

    if (msg.forwardData) {
      const networkCode = msg.forwardData.networkCode || "";
      const net = this.networks.get(networkCode);
      let delivered = false;
      if (net) {
        let packet = null;
        try {
          packet = readPacket(msg.forwardData.data);
        } catch {}
        // 与本地转发一致：禁止中转模式下丢弃 TURN/QUIC 类数据，且每次转发递减 TTL
        if (packet && this.disableRelay && isRelayDataMessage(packet.msgType)) {
          this.logDebug(`禁止中转已启用，丢弃互联转发 网络编号=${networkCode} 类型=${packet.msgType} 目标=${intToIp(packet.destId)}`);
        } else if (packet) {
          const relay = new Uint8Array(msg.forwardData.data);
          if (decrementTtl(relay)) delivered = this.forwardToIp(net, packet.destId, relay);
        }
        this.logDebug(`互联 protobuf 转发接收 网络编号=${networkCode} 目标=${packet ? intToIp(packet.destId) : "无效包"} 已投递=${delivered}`);
      }
      return peerProtoResponse({ authRes: { success: delivered, message: delivered ? "delivered" : "not delivered" } });
    }

    return peerProtoResponse({ authRes: { success: false, message: "unsupported peer message" } });
  }

  async forwardToPeers(networkCode, dest, bytes) {
    if (!this.peerServers.length || !this.peerToken) return false;
    let delivered = false;
    const init = {
      method: "POST",
      headers: {
        "X-Peer-Token": this.peerToken,
        "X-Peer-Token-Hash": this.peerTokenHash,
        "Content-Type": "application/octet-stream"
      },
      body: encodeServerMessage({ forwardData: { networkCode, data: bytes } }),
      signal: AbortSignal.timeout(15000)
    };
    for (const peer of this.peerServers) {
      try {
        const url = `${peer}/peer/message`;
        const res = await fetch(url, init);
        if (res.ok) {
          const body = parseServerMessage(await readResponseBytes(res));
          const peerDelivered = !!body.authRes?.success;
          delivered = delivered || peerDelivered;
          this.logDebug(`互联 protobuf 转发发送 网络编号=${networkCode} 目标=${intToIp(dest)} 节点=${peer} 已投递=${peerDelivered}`);
        }
      } catch (error) {
        this.logInfo(`互联转发失败 网络=${networkCode} 目标=${intToIp(dest)} 节点=${peer} 原因=${error.message || String(error)}`);
      }
    }
    return delivered;
  }

  async refreshPeerClientCache(force = false) {
    if (!this.peerServers.length || !this.peerToken) return;
    const now = Date.now();
    if (!force && now - this.peerClientCacheTime < 5000) return;
    const next = new Map();
    const networkCodes = Array.from(this.networks.keys());
    const newPeerStatus = new Map();
    for (const peer of this.peerServers) {
      let online = false;
      try {
        const res = await fetch(`${peer}/peer/message`, {
          method: "POST",
          headers: {
            "X-Peer-Token": this.peerToken,
            "X-Peer-Token-Hash": this.peerTokenHash,
            "Content-Type": "application/octet-stream"
          },
          body: encodeServerMessage({ clientInfoReq: { networkCodes } }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) continue;
        online = true;
        const body = parseServerMessage(await readResponseBytes(res));
        for (const network of body.clientInfoRes?.networks || []) {
          if (!this.isNetworkAllowedByConfig(network.networkCode)) continue;
          const list = next.get(network.networkCode) || [];
          for (const client of network.clients || []) {
            list.push({ ip: client.ip >>> 0, latencyMs: client.latencyMs || 10, online: true, remotePeer: peer });
          }
          next.set(network.networkCode, list);
        }
      } catch (error) {
        this.logInfo(`互联客户端列表刷新失败 节点=${peer} 原因=${error.message || String(error)}`);
      }
      newPeerStatus.set(peer, online);
    }
    this.peerServerStatus = newPeerStatus;
    const signature = JSON.stringify(Array.from(next.entries()).map(([code, list]) => [code, list.map((c) => [c.ip, c.online, c.dataVersion || 0, c.remotePeer]).sort()]).sort());
    if (signature !== this.peerClientCacheSignature) {
      for (const code of next.keys()) {
        if (!this.isNetworkAllowedByConfig(code)) continue;
        const net = this.ensureNetwork(code);
        net.dataVersion += 1;
      }
      this.peerClientCacheSignature = signature;
      this.logDebug(`互联客户端列表已更新 网络数=${next.size}`);
    }
    this.peerClientCache = next;
    this.peerClientCacheTime = now;
  }

  remoteClients(networkCode) {
    return this.peerClientCache.get(networkCode) || [];
  }

  exportPeerClientInfo() {
    const networks = [];
    for (const [code, net] of this.networks.entries()) {
      networks.push({
        networkCode: code,
        dataVersion: net.dataVersion,
          clients: Array.from(net.devices.values())
          .filter((d) => d.ip && d.online)
          .map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            version: d.version,
            ip: d.ip,
            keySign: d.keySign,
            online: !!d.online,
            lastConnectedTime: d.lastConnectedTime || 0,
            dataVersion: d.dataVersion || 0
          }))
      });
    }
    return networks;
  }

  peerClientInfoResponse(networkCodes) {
    const requested = new Set((networkCodes || []).filter(Boolean));
    const networks = [];
    for (const [code, net] of this.networks.entries()) {
      if (requested.size && !requested.has(code)) continue;
      networks.push({
        networkCode: code,
        clients: Array.from(net.devices.values())
          .filter((d) => d.ip && d.online)
          .map((d) => ({ ip: d.ip, latencyMs: d.latencyMs || 10 }))
      });
    }
    return { networks };
  }

  async offline(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (!session.registered) return;
    const net = this.ensureNetwork(session.networkCode);
    const device = net.devices.get(session.deviceId);
    if (!device || device.sessionId !== sessionId) return;
    if (session.pendingConfirmation) {
      net.devices.delete(session.deviceId);
      net.ipToDevice.delete(session.ip);
      this.logInfo(`预注册未确认，释放地址 网络编号=${session.networkCode} 设备ID=${session.deviceId} 虚拟IP=${intToIp(session.ip)}`);
    } else {
      device.online = false;
      device.socket = undefined;
      device.sessionId = undefined;
      device.disconnectTime = Date.now();
      this._dataDirty = true;
      this.bump(net, device);
      this.logInfo(`客户端离线 网络编号=${session.networkCode} 设备ID=${session.deviceId} 虚拟IP=${intToIp(session.ip)}`);
    }
    await this.persistSoon();
    this.logDebug(`离线后持久化完成 网络编号=${session.networkCode} 设备ID=${session.deviceId} 虚拟IP=${intToIp(session.ip)}`);
  }

  ensureNetwork(code, config) {
    if (!config) config = defaultNetworkConfig(this.defaultGatewayIp);
    let net = this.networks.get(code);
    if (!net) {
      net = { code, config, dataVersion: 0, devices: new Map(), ipToDevice: new Map() };
      this.networks.set(code, net);
    }
    return net;
  }

  bump(net, device) {
    net.dataVersion += 1;
    device.dataVersion = net.dataVersion;
  }

  async cleanupExpired() {
    const now = Date.now();
    let deletedDevices = 0;
    let deletedNetworks = 0;
    // 安全：回收长时间未注册的 WebSocket 会话，防止空连接占满 MAX_SESSIONS
    for (const session of Array.from(this.sessions.values())) {
      if (!session.registered && now - (session.openedAt || now) > SESSION_IDLE_TIMEOUT_MS) {
        this.sessions.delete(session.id);
        try {
          session.socket.close(4000, "registration timeout");
        } catch {}
        this.logInfo(`未注册会话超时回收 会话=${session.id} 来源=${session.remote || "未知"}`);
      }
    }
    await this.cleanupAccountSessions();
    for (const [code, net] of this.networks.entries()) {
      for (const [deviceId, device] of Array.from(net.devices.entries())) {
        if (!device.online && device.disconnectTime && now - device.disconnectTime > this.leaseDurationMs) {
          net.devices.delete(deviceId);
          net.ipToDevice.delete(device.ip);
          net.dataVersion += 1;
          this._dataDirty = true;
          deletedDevices++;
          this.logInfo(`租约过期，释放地址 网络编号=${net.code} 设备ID=${deviceId} 虚拟IP=${intToIp(device.ip)}`);
        }
      }
      if (!net.devices.size && !this.remoteClients(code).length) {
        if (this.networks.has(code)) this._dataDirty = true;
        this.networks.delete(code);
        deletedNetworks++;
      }
    }
    if (deletedDevices || deletedNetworks) {
      this.logDebug(`过期清理 删除设备=${deletedDevices} 删除网络=${deletedNetworks}`);
    }
  }

  totalDeviceCount() {
    let count = 0;
    for (const net of this.networks.values()) count += net.devices.size;
    return count;
  }

  pingLocalClients() {
    const timestamp = BigInt(Date.now());
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setBigUint64(0, timestamp, false);
    const packet = makePacket(MSG.PING, payload, { gateway: true, ttl: 1 });
    for (const net of this.networks.values()) {
      for (const device of net.devices.values()) {
        if (device.online) this.sendDevice(device, packet);
      }
    }
  }

  async persistSoon() {
    try {
      await this.persist();
    } catch (error) {
      this.reportError("数据持久化状态保存失败", error);
    }
  }

  async persist() {
    if (!this._dataDirty) return;
    // this.logDebug(`正在持久化保存 网络数=${this.networks.size} 设备数=${this.totalDeviceCount()}`);
    const out = { networks: {} };
    for (const [code, net] of this.networks.entries()) {
      out.networks[code] = { dataVersion: net.dataVersion, config: net.config, devices: [] };
      for (const device of net.devices.values()) {
        out.networks[code].devices.push({
          deviceId: device.deviceId,
          ip: device.ip,
          name: device.name,
          version: device.version,
          keySign: device.keySign,
          online: false,
          lastConnectedTime: device.lastConnectedTime,
          disconnectTime: device.disconnectTime,
          dataVersion: device.dataVersion,
          txBytes: device.txBytes || 0,
          rxBytes: device.rxBytes || 0
        });
      }
    }
    await this.state.storage.put(STORAGE_KEY, out);
    this._dataDirty = false;
    // this.logDebug(`持久化完成 网络数=${this.networks.size} 设备数=${this.totalDeviceCount()}`);
  }

  async scheduleAlarm() {
    try {
      await this.state.storage.setAlarm(Date.now() + this.maintenanceIntervalMs);
    } catch (error) {
      this.reportError("调度维护任务失败", error);
    }
  }

  status() {
    let totalOnlineClients = 0;
    let totalOfflineClients = 0;
    for (const net of this.networks.values()) {
      for (const device of net.devices.values()) {
        if (device.online) totalOnlineClients++;
        else totalOfflineClients++;
      }
    }
    // 统计互联服务端上的客户端
    let peerOnlineClients = 0;
    for (const clients of this.peerClientCache.values()) {
      peerOnlineClients += clients.length;
    }
    // 统计互联服务端在线/离线
    let peerOnline = 0;
    let peerOffline = 0;
    for (const online of this.peerServerStatus.values()) {
      if (online) peerOnline++;
      else peerOffline++;
    }
    return {
      "WebSocket服务": "正常",
      "服务端版本": this.serverVersion,
      "启动时间": this.getStartTimeBeijing(),
      "已运行": this.getRunningDuration(),
      "支持协议": "VNT2 WebSocket",
      "服务状态": "可用",
      "网络编号数": this.roomList().length,
      "在线客户端": totalOnlineClients + peerOnlineClients,
      "离线客户端": totalOfflineClients,
      "互联服务端在线": peerOnline,
      "互联服务端离线": peerOffline,
      "服务端中转": this.disableRelay ? "已禁止" : "已启用"
    };
  }

  getStartTimeBeijing() {
    const d = new Date(this.startTime);
    const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} ${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
  }

  getRunningDuration() {
    const diff = Date.now() - this.startTime;
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}天`);
    if (h > 0) parts.push(`${h}小时`);
    if (m > 0) parts.push(`${m}分`);
    parts.push(`${sec}秒`);
    return parts.join("");
  }

  roomInfo() {
    const networks = [];
    const gateways = [];
    for (const [code, net] of this.networks.entries()) {
      const cfg = net.config;
      gateways.push({
        networkCode: code,
        deviceId: `gateway-${code}`,
        name: this.env.GATEWAY_NAME || "服务器",
        version: this.serverVersion,
        ip: intToIp(cfg.gateway),
        online: true,
        role: "gateway"
      });
      networks.push({
        networkCode: code,
        dataVersion: net.dataVersion,
        devices: Array.from(net.devices.values()).map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          version: d.version,
          ip: intToIp(d.ip),
          online: !!d.online,
          keySign: d.keySign,
          lastConnectedTime: d.lastConnectedTime,
          txBytes: d.txBytes || 0,
          rxBytes: d.rxBytes || 0
        }))
      });
    }
    return { networks, gateways };
  }

  async handleHealthPage(request, url) {
    const data = this.status();
    if (wantsJson(request, url)) return Response.json(data);
    return htmlResponse(renderHealthHtml(data));
  }

  async handleDashboardPage(request, url) {
    const status = this.status();
    const config = this.exportConfigSnapshot();
    const payload = {
      status,
      config,
      rooms: config.networks,
      serverVersion: this.serverVersion,
      startTime: this.getStartTimeBeijing(),
      runDuration: this.getRunningDuration()
    };
    // 已登录账户：返回其加入房间的真实设备流量（供仪表盘差分计算速度/质量/总量）
    const user = this.currentUser(request);
    if (user) {
      const roomMap = new Map(this.roomList().map((r) => [r.networkCode, r]));
      const fallback = defaultNetworkConfig(this.defaultGatewayIp);
      payload.joinedRooms = (user.joinedRooms || []).map((code) => {
        const base = roomMap.get(code);
        const net = this.networks.get(code);
        const devices = net
          ? Array.from(net.devices.values()).map((d) => ({
              deviceId: d.deviceId,
              name: d.name || d.deviceId,
              ip: intToIp(d.ip),
              online: !!d.online,
              txBytes: d.txBytes || 0,
              rxBytes: d.rxBytes || 0
            }))
          : [];
        return {
          networkCode: code,
          cidr: base?.cidr || fallback.cidr,
          gateway: base?.gateway || intToIp(fallback.gateway),
          deviceCount: base?.deviceCount || 0,
          onlineDevices: base?.onlineDevices || 0,
          devices
        };
      });
    }
    if (wantsJson(request, url)) return Response.json(payload);
    return htmlResponse(renderDashboardHtml(payload));
  }

  handleSettingsPage(request, url) {
    if (wantsJson(request, url)) {
      return Response.json({
        version: this.serverVersion,
        networks: Array.from(this.allowedNetworks).filter((n) => !String(n).startsWith("__")),
        gateway: this.defaultGatewayIp,
        logEnabled: !!this.logPassword,
        peerEnabled: this.peerServers.length > 0,
        relayDisabled: this.disableRelay,
        startTime: this.getStartTimeBeijing()
      });
    }
    return htmlResponse(renderSettingsHtml());
  }

  async handleRoomPage(request, url) {
    const network = url.searchParams.get("network") || "";
    const gateway = url.searchParams.get("gateway") || url.searchParams.get("ip") || "";
    // 房间列表模式：未指定网络编号/网关时，展示所有已存在房间
    if (!network && !gateway) {
      const rooms = this.exportConfigSnapshot().networks;
      return htmlResponse(renderRoomListHtml({ rooms, serverVersion: this.serverVersion }));
    }
    const auth = await this.authorizeStatusRequest(request, url);
    if (!auth.ok) return htmlResponse(renderLoginHtml(auth.message || "请输入正确的网络编号和网关"));
    const info = this.roomInfo();
    // 互联服务端上客户端
    info.peerClients = Array.from(this.peerClientCache.entries()).map(([networkCode, clients]) => ({
      networkCode,
      clients: clients.map((client) => ({
        ip: intToIp(client.ip),
        peer: client.remotePeer
      }))
    }));
    // 构建设备列表：网关 + 本地客户端 + 互联客户端
    const devices = [];
    for (const g of info.gateways || []) {
      devices.push({ 类型: "网关", 虚拟IP: g.ip, 名称: g.name, 版本: g.version, 状态: "在线", 上线时间: formatTime(Math.floor(this.startTime / 1000)) });
    }
    for (const net of info.networks || []) {
      for (const d of net.devices) {
        devices.push({
          类型: "客户端",
          虚拟IP: d.ip, 名称: d.name || d.deviceId, 版本: d.version || "",
          状态: d.online ? "在线" : "离线",
          设备ID: d.deviceId,
          加密: d.keySign ? "是" : "否",
          上传: formatBytes(d.txBytes),
          下载: formatBytes(d.rxBytes),
          上线时间: formatTime(d.lastConnectedTime)
        });
      }
    }
    // 互联服务端上客户端
    for (const pc of info.peerClients || []) {
      for (const c of pc.clients || []) {
        devices.push({
          类型: "互联", 虚拟IP: c.ip, 状态: "在线", 服务端: c.peer
        });
      }
    }
    const onlineCount = devices.filter(d => d.状态 === "在线" && d.类型 !== "网关").length;
    const offlineCount = devices.filter(d => d.状态 === "离线").length;
    if (wantsJson(request, url)) return jsonAuthResponse({ devices, peerServers: this.peerServers }, auth);
    return htmlResponse(renderRoomHtml({ devices, peerServers: this.peerServers, onlineCount, offlineCount }), auth);
  }

  async handlePeerPage(request, url) {
    if (!this.peerToken) return Response.redirect("https://github.com/lmq8267/vnts2-cf", 302);
    const auth = await this.authorizePeerRequest(request, url);
    if (!auth.ok) {
      // POST 登录失败 → 401，前端可区分失败原因
      if (request.method === "POST") return Response.json({ error: auth.message || "未授权" }, { status: 401 });
      return htmlResponse(renderPeerLoginHtml(auth.message || "请输入互联令牌"), auth);
    }
    // 登录成功（POST）→ 设置会话 Cookie 并重定向到本页 GET
    if (auth.setCookie) {
      const res = new Response(null, { status: 302, headers: { Location: new URL(url.pathname, url.origin).toString() } });
      return applySessionCookie(res, auth);
    }
    // 构建互联服务端列表
    const list = this.peerServers.map((addr) => ({
      addr,
      online: this.peerServerStatus.get(addr) || false
    }));
    if (wantsJson(request, url)) return applySessionCookie(Response.json({ servers: list }), auth);
    return applySessionCookie(htmlResponse(renderPeerHtml(list), auth), auth);
  }

  async handleLogPage(request, url) {
    if (!this.logPassword) return new Response(null, { status: 404 });
    const auth = await this.authorizeLogRequest(request, url);
    if (!auth.ok) {
      // POST 登录失败 → 401，前端可区分失败原因
      if (request.method === "POST") return Response.json({ error: auth.message || "未授权" }, { status: 401 });
      return htmlResponse(renderLogLoginHtml(auth.message || "请输入日志密码"), auth);
    }
    if (auth.setCookie) {
      const res = new Response(null, { status: 302, headers: { Location: new URL(url.pathname, url.origin).toString() } });
      return applySessionCookie(res, auth);
    }
    const logs = this.logs.slice().reverse();
    if (wantsJson(request, url)) return applySessionCookie(Response.json({ logs, count: logs.length }), auth);
    return applySessionCookie(htmlResponse(renderLogHtml({ logs }), auth), auth);
  }

  async handleLogClear(request, url) {
    if (!this.logPassword) return new Response(null, { status: 404 });
    const auth = await this.authorizeLogRequest(request, url);
    if (!auth.ok) return Response.json({ error: "未授权" }, { status: 401 });
    try {
      this.logs = [];
      await this.state.storage.delete("vnts2-logs");
      return Response.json({ status: "ok", message: "日志已清空" });
    } catch (error) {
      return Response.json({ error: "清空失败: " + errorMessage(error) }, { status: 500 });
    }
  }

  /**
   * 统一会话认证（安全版）。
   * - 会话 Cookie `vnts2_session` 存「已校验密钥的 SHA-256 哈希」，不存明文。
   * - Cookie 带 HttpOnly + Secure + SameSite=Strict，防 XSS 读取、防明文传输、防 CSRF。
   * - 登录通过 POST 提交 JSON `{password}`，服务端校验明文后设置哈希 Cookie 并重定向；
   *   不再支持经 URL 查询参数传密码（避免密码进入浏览器历史/访问日志）。
   * @param {Request} request
   * @param {string} secret   明文密钥（LOG_PASSWORD / SERVER_TOKEN / ADMIN_PASSWORD）
   * @param {string} hash     密钥的 SHA-256 哈希（会话 Cookie 比对值）
   * @returns {{ok:boolean, message?:string, setCookie?:string}}
   */
  async authorizeSession(request, secret, hash) {
    if (!secret) return { ok: false, message: "未配置" };
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    if (hash && cookies.vnts2_session === hash) return { ok: true };

    // POST 登录：校验明文密码
    if (request.method === "POST") {
      // 手动读取文本并解析 JSON：Miniflare 中转发 Request 后 request.json() 可能不可用
      let body = null;
      try {
        body = JSON.parse(await request.text());
      } catch {
        body = null;
      }
      if (body && typeof body.password === "string" && body.password === secret && hash) {
        return { ok: true, setCookie: `vnts2_session=${hash}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400` };
      }
      return { ok: false, message: "密码不正确" };
    }
    return { ok: false, message: "需要密码登录" };
  }

  /** 管理员认证（共享 ADMIN_PASSWORD，用于 /admin 与 /config） */
  authorizeAdminRequest(request, url) {
    return this.authorizeSession(request, this.adminPassword, this.adminPasswordHash);
  }

  /** 管理页：展示运行状态、网络/设备/会话、配置摘要、日志，并支持清空日志 */
  async handleAdminPage(request, url) {
    if (!this.adminPassword) return Response.redirect("https://github.com/lmq8267/vnts2-cf", 302);
    const auth = await this.authorizeAdminRequest(request, url);
    if (!auth.ok) {
      // POST 登录失败 → 401，前端可区分失败原因
      if (request.method === "POST") return Response.json({ error: auth.message || "未授权" }, { status: 401 });
      return htmlResponse(renderAdminLoginHtml("请输入管理员密码"), auth);
    }
    // 登录成功（POST）→ 设置会话 Cookie 并重定向到本页 GET
    if (auth.setCookie) {
      const res = new Response(null, { status: 302, headers: { Location: new URL(url.pathname, url.origin).toString() } });
      return applySessionCookie(res, auth);
    }

    // 配置快照
    const config = this.exportConfigSnapshot();
    const info = this.roomInfo();
    const status = this.status();

    // 设备列表
    const devices = [];
    for (const g of info.gateways || []) {
      devices.push({ type: "网关", networkCode: g.networkCode, ip: g.ip, name: g.name, version: g.version, online: true, role: "gateway", deviceId: g.deviceId, lastSeen: formatTime(Math.floor(this.startTime / 1000)) });
    }
    for (const net of info.networks || []) {
      for (const d of net.devices) {
        devices.push({
          type: "客户端",
          networkCode: net.networkCode,
          ip: d.ip,
          name: d.name || d.deviceId,
          version: d.version || "",
          online: !!d.online,
          deviceId: d.deviceId,
          keySign: d.keySign ? "已启用" : "未启用",
          tx: formatBytes(d.txBytes),
          rx: formatBytes(d.rxBytes),
          lastSeen: formatTime(d.lastConnectedTime)
        });
      }
    }

    // 会话信息
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      registered: !!s.registered,
      deviceId: s.deviceId || "",
      networkCode: s.networkCode || "",
      ip: s.ip !== undefined ? intToIp(s.ip) : "",
      remote: s.remote || "",
      status: s.registrationStatus || (s.registered ? "confirmed" : "connecting")
    }));

    const payload = {
      status,
      config,
      devices,
      sessions,
      logs: this.logs.slice().reverse().slice(0, 200),
      rooms: this.roomList().map((r) => ({
        ...r,
        password: this.networkPasswords.get(r.networkCode) || ""
      })),
      startTime: this.getStartTimeBeijing(),
      runDuration: this.getRunningDuration(),
      serverVersion: this.serverVersion,
      registrationMode: this.registrationMode
    };

    if (url.pathname === "/admin/config") {
      // 返回配置快照 JSON
      if (wantsJson(request, url) || request.headers.get("Accept")?.includes("application/json")) {
        return applySessionCookie(jsonAuthResponse(payload, auth), auth);
      }
      return applySessionCookie(htmlResponse(renderAdminHtml(payload), auth), auth);
    }

    if (wantsJson(request, url)) return applySessionCookie(jsonAuthResponse(payload, auth), auth);
    return applySessionCookie(htmlResponse(renderAdminHtml(payload), auth), auth);
  }

  /** 管理员添加房间：POST /admin/rooms { networkCode } */
  async handleAdminAddRoom(request, url) {
    const auth = await this.authorizeAdminRequest(request, url);
    if (!auth.ok) return Response.json({ error: "未授权" }, { status: 401 });
    let body = null;
    try { body = JSON.parse(await request.text()); } catch { body = null; }
    const code = String(body?.networkCode || "").trim();
    if (!code || code.length > 32) return Response.json({ error: "网络编号无效" }, { status: 400 });
    const password = String(body?.password || "").slice(0, 128);
    if (!this.allowedNetworks.has(code)) this.allowedNetworks.add(code);
    this.ensureNetwork(code, this.resolveNetworkConfig(code, undefined));
    // 持久化管理员添加的房间
    const rooms = (await this.state.storage.get("vnts2-admin-rooms")) || [];
    if (!rooms.includes(code)) {
      rooms.push(code);
      await this.state.storage.put("vnts2-admin-rooms", rooms);
    }
    // 保存管理员设置的组网密码：仅当填写了密码时覆盖；空密码不修改已有密码（清空请用房间密码管理表）
    if (password) {
      this.networkPasswords.set(code, password);
      await this.saveNetworkPasswords();
    }
    this._dataDirty = true;
    await this.persist();
    return Response.json({ ok: true, networkCode: code });
  }

  /** 管理员修改房间组网密码：POST /admin/rooms/password { networkCode, password } */
  async handleAdminSetRoomPassword(request, url) {
    const auth = await this.authorizeAdminRequest(request, url);
    if (!auth.ok) return Response.json({ error: "未授权" }, { status: 401 });
    let body = null;
    try { body = JSON.parse(await request.text()); } catch { body = null; }
    const code = String(body?.networkCode || "").trim();
    if (!code || code.length > 32) return Response.json({ error: "网络编号无效" }, { status: 400 });
    const password = String(body?.password || "").slice(0, 128);
    if (password) {
      this.networkPasswords.set(code, password);
    } else {
      this.networkPasswords.delete(code);
    }
    await this.saveNetworkPasswords();
    return Response.json({ ok: true, networkCode: code, passwordSet: !!password });
  }

  /** 持久化房间组网密码到 DO Storage */
  async saveNetworkPasswords() {
    const obj = {};
    for (const [code, password] of this.networkPasswords.entries()) {
      obj[code] = password;
    }
    await this.state.storage.put("vnts2-network-passwords", obj);
  }

  /** 配置文件下载页：用户客户端配置（登录后可用，无需管理员密码） */
  async handleConfigDownload(request, url) {
    const snapshot = this.exportConfigSnapshot();
    if (wantsJson(request, url)) return Response.json({ config: snapshot });
    // 仅当请求方通过 ?rooms= 声明已加入的房间时，才附加这些房间的组网密码（避免页面源码泄露全部房间密码）
    const requestedRooms = new Set(
      (url.searchParams.get("rooms") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    // 安全：组网密码属于敏感凭据，必须校验会话后才发放——
    // 管理员会话可获取全部房间密码；普通用户需持有对应房间的会话 Cookie
    // （由 /room 认证成功后种下 network_code + gateway_ip），
    // 或已登录账户且已加入该房间（账户级授权，跨浏览器共享）。
    const sessionCookie = parseCookies(request.headers.get("Cookie") || "");
    const isAdminSession = !!this.adminPasswordHash && sessionCookie.vnts2_session === this.adminPasswordHash;
    const accountUser = this.currentUser(request);
    const accountJoinedRooms = accountUser ? new Set(accountUser.joinedRooms || []) : new Set();
    const pageData = {
      ...snapshot,
      networks: snapshot.networks.map((r) => ({
        ...r,
        password: requestedRooms.has(r.networkCode) && (isAdminSession || this.hasRoomSession(sessionCookie, r.networkCode) || accountJoinedRooms.has(r.networkCode))
          ? this.networkPasswords.get(r.networkCode) || ""
          : ""
      }))
    };
    return htmlResponse(renderConfigHtml(pageData));
  }

  /** 校验请求方是否持有指定房间的有效会话 Cookie（与 /room 认证同等强度） */
  hasRoomSession(sessionCookie, networkCode) {
    const gateway = sessionCookie.gateway_ip || "";
    if (!networkCode || (sessionCookie.network_code || "") !== networkCode || !gateway) return false;
    const cfg = this.networks.get(networkCode)?.config || defaultNetworkConfig(this.defaultGatewayIp);
    return gateway === intToIp(cfg.gateway);
  }

  /** 网络编号是否允许：NETWORKS 为空（未配置白名单）时允许任意，否则仅允许配置/管理员添加的房间 */
  isNetworkAllowedByConfig(code) {
    return this.allowAllNetworks || this.allowedNetworks.has(code);
  }

  /**
   * 解析网络配置：已存在网络返回原配置；新网络优先使用客户端指定 IP 的 /24 网段（若未占用），
   * 否则（未指定 IP 或指定网段已被占用）自动分配下一个空闲 /24 网段。
   * 返回 null 表示客户端指定的网段已被其他网络占用。
   */
  resolveNetworkConfig(code, ip) {
    const existing = this.networks.get(code);
    if (existing) return existing.config;
    if (ip !== undefined && ip !== null) {
      const cfg = networkConfigFromClientIp(ip, this.defaultGatewayIp);
      if (this.gatewayOccupied(cfg.gateway)) return null;
      return cfg;
    }
    return this.findAvailableNetworkConfig();
  }

  /** 查找下一个未被占用的 /24 网段（从默认网关所在网段开始按 /24 递增） */
  findAvailableNetworkConfig() {
    const base = defaultNetworkConfig(this.defaultGatewayIp);
    for (let offset = 0; offset < 65536; offset += 256) {
      const gw = (base.gateway + offset) >>> 0;
      if (!this.gatewayOccupied(gw)) return networkConfigFromGateway(gw);
    }
    return base;
  }

  /** 该网关是否已被其他网络占用 */
  gatewayOccupied(gateway) {
    for (const net of this.networks.values()) {
      if (net.config.gateway === gateway) return true;
    }
    return false;
  }

  /* ============================================================
   * 服务端账户与会话（跨浏览器共享登录态与已加入房间）
   * ============================================================ */

  /** 统一处理 /api/* 请求 */
  async handleApiRequest(request, url) {
    if (url.pathname === "/api/auth/register") return this.handleApiRegister(request);
    if (url.pathname === "/api/auth/login") return this.handleApiLogin(request);
    if (url.pathname === "/api/auth/me") return this.handleApiMe(request);
    if (url.pathname === "/api/auth/logout") return this.handleApiLogout(request);
    if (url.pathname === "/api/auth/config") return this.handleApiAuthConfig(request);
    if (url.pathname === "/api/rooms/join") return this.handleApiJoin(request, true);
    if (url.pathname === "/api/rooms/leave") return this.handleApiJoin(request, false);
    if (url.pathname === "/api/admin/registration" && request.method === "POST") return this.handleAdminSetRegistration(request);
    if (url.pathname === "/api/admin/invites" && request.method === "GET") return this.handleAdminListInvites(request);
    if (url.pathname === "/api/admin/invites" && request.method === "POST") return this.handleAdminCreateInvite(request);
    if (url.pathname === "/api/admin/invites/disable" && request.method === "POST") return this.handleAdminDisableInvite(request);
    return Response.json({ error: "未知接口" }, { status: 404 });
  }

  /** 从 HttpOnly 会话 Cookie 中解析当前账户；未登录返回 null */
  currentUser(request) {
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const token = cookies.vnts2_account || "";
    if (!token) return null;
    const session = this.accountSessions.get(token);
    if (!session || session.expires <= Date.now()) return null;
    const user = this.accounts.get(session.username);
    if (!user) return null;
    return { username: session.username, ...user };
  }

  async handleApiLogin(request) {
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    if (!username || username.length > 64) return Response.json({ error: "用户名不能为空或过长" }, { status: 400 });
    if (!password || password.length > 256) return Response.json({ error: "密码不能为空或过长" }, { status: 400 });
    const user = this.accounts.get(username);
    if (!user) return Response.json({ error: "用户不存在" }, { status: 401 });
    const hash = await pbkdf2Hex(password, user.passwordSalt);
    if (hash !== user.passwordHash) return Response.json({ error: "密码不正确" }, { status: 401 });
    const token = crypto.randomUUID();
    this.accountSessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
    await this.saveAccountSessions();
    const res = Response.json({ ok: true, username, joinedRooms: user.joinedRooms });
    res.headers.append("Set-Cookie", `vnts2_account=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return res;
  }

  /** 注册新账户：注册模式由管理员控制（开放 / 邀请码 / 关闭） */
  async handleApiRegister(request) {
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    const inviteCode = String(body?.inviteCode || "").trim();
    if (!username || username.length > 64) return Response.json({ error: "用户名不能为空或过长" }, { status: 400 });
    if (password.length < 6 || password.length > 256) return Response.json({ error: "密码长度需为 6-256 位" }, { status: 400 });
    if (this.accounts.has(username)) return Response.json({ error: "用户名已存在" }, { status: 409 });
    if (this.registrationMode === REG_MODE_CLOSED) return Response.json({ error: "当前未开放注册" }, { status: 403 });
    if (this.registrationMode === REG_MODE_INVITE) {
      if (!inviteCode) return Response.json({ error: "需要邀请码" }, { status: 400 });
      const consumed = await this.consumeInvite(inviteCode);
      if (!consumed) return Response.json({ error: "邀请码无效或已用完" }, { status: 400 });
    }
    const salt = randomHex(16);
    const user = {
      passwordHash: await pbkdf2Hex(password, salt),
      passwordSalt: salt,
      deviceName: username,
      virtualIp: "",
      createdAt: toBeijingTime(new Date()),
      joinedRooms: []
    };
    this.accounts.set(username, user);
    await this.saveAccounts();
    this.logInfo(`注册账户 用户名=${username} 方式=${this.registrationMode === REG_MODE_INVITE ? "邀请码" : "开放"}`);
    const token = crypto.randomUUID();
    this.accountSessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
    await this.saveAccountSessions();
    const res = Response.json({ ok: true, username, joinedRooms: [] });
    res.headers.append("Set-Cookie", `vnts2_account=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    return res;
  }

  /** 返回当前注册模式，供注册页判断是否显示邀请码 */
  handleApiAuthConfig(request) {
    return Response.json({
      ok: true,
      registrationMode: this.registrationMode,
      inviteRequired: this.registrationMode === REG_MODE_INVITE,
      registrationClosed: this.registrationMode === REG_MODE_CLOSED
    });
  }

  /** 校验并消耗一个邀请码；无效返回 null */
  async consumeInvite(code) {
    const invite = this.invites.get(code);
    if (!invite || invite.disabled) return null;
    if (invite.expiresAt && Date.now() > invite.expiresAt) return null;
    if (invite.remaining <= 0) return null;
    invite.remaining -= 1;
    if (invite.remaining <= 0) invite.disabled = true;
    await this.saveInvites();
    return invite;
  }

  /** 持久化邀请码到 DO Storage */
  async saveInvites() {
    const obj = {};
    for (const [code, inv] of this.invites.entries()) {
      obj[code] = {
        remaining: inv.remaining,
        maxUses: inv.maxUses,
        expiresAt: inv.expiresAt,
        createdAt: inv.createdAt,
        disabled: inv.disabled
      };
    }
    await this.state.storage.put(INVITES_KEY, obj);
  }

  /** 管理员会话校验（/api/admin/* 专用） */
  async requireAdmin(request) {
    const sessionCookie = parseCookies(request.headers.get("Cookie") || "");
    return !!this.adminPasswordHash && sessionCookie.vnts2_session === this.adminPasswordHash;
  }

  async handleAdminSetRegistration(request) {
    if (!await this.requireAdmin(request)) return Response.json({ error: "未授权" }, { status: 401 });
    let body = null;
    try { body = await request.json(); } catch {}
    const mode = String(body?.mode || "").trim();
    if (mode !== REG_MODE_OPEN && mode !== REG_MODE_INVITE && mode !== REG_MODE_CLOSED) {
      return Response.json({ error: "注册模式无效" }, { status: 400 });
    }
    this.registrationMode = mode;
    await this.state.storage.put(REG_MODE_KEY, mode);
    this.logInfo(`管理员设置注册模式=${mode}`);
    return Response.json({ ok: true, registrationMode: mode });
  }

  async handleAdminListInvites(request) {
    if (!await this.requireAdmin(request)) return Response.json({ error: "未授权" }, { status: 401 });
    const list = Array.from(this.invites.values())
      .map((inv) => ({ ...inv }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return Response.json({ ok: true, invites: list });
  }

  async handleAdminCreateInvite(request) {
    if (!await this.requireAdmin(request)) return Response.json({ error: "未授权" }, { status: 401 });
    let body = null;
    try { body = await request.json(); } catch {}
    const maxUses = Math.min(1000, Math.max(1, Math.floor(Number(body?.maxUses) || 1)));
    const hours = Number(body?.hours);
    const expiresAt = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600 * 1000 : 0;
    const code = randomInviteCode();
    this.invites.set(code, {
      code,
      remaining: maxUses,
      maxUses,
      expiresAt,
      createdAt: toBeijingTime(new Date()),
      disabled: false
    });
    await this.saveInvites();
    this.logInfo(`管理员生成邀请码=${code} 次数=${maxUses} 过期=${expiresAt ? toBeijingTime(new Date(expiresAt)) : "永久"}`);
    return Response.json({ ok: true, invite: { code, remaining: maxUses, maxUses, expiresAt, createdAt: toBeijingTime(new Date()), disabled: false } });
  }

  async handleAdminDisableInvite(request) {
    if (!await this.requireAdmin(request)) return Response.json({ error: "未授权" }, { status: 401 });
    let body = null;
    try { body = await request.json(); } catch {}
    const code = String(body?.code || "").trim();
    const invite = this.invites.get(code);
    if (!invite) return Response.json({ error: "邀请码不存在" }, { status: 404 });
    invite.disabled = true;
    await this.saveInvites();
    return Response.json({ ok: true, code });
  }

  async handleApiMe(request) {
    const user = this.currentUser(request);
    if (!user) return Response.json({ error: "未登录" }, { status: 401 });
    return Response.json({
      ok: true,
      username: user.username,
      deviceName: user.deviceName || user.username,
      virtualIp: user.virtualIp || "",
      createdAt: user.createdAt || "",
      joinedRooms: user.joinedRooms || []
    });
  }

  async handleApiLogout(request) {
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const token = cookies.vnts2_account || "";
    this.accountSessions.delete(token);
    await this.saveAccountSessions();
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", "vnts2_account=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return res;
  }

  /** 加入/退出房间（共享账户级状态） */
  async handleApiJoin(request, isJoin) {
    const user = this.currentUser(request);
    if (!user) return Response.json({ error: "未登录" }, { status: 401 });
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const code = String(body?.networkCode || "").trim();
    if (!code || code.length > 32 || !this.isNetworkAllowedByConfig(code)) {
      return Response.json({ error: "网络编号无效" }, { status: 400 });
    }
    // 直接修改持久化账户对象（currentUser 返回的是浅拷贝，写回其属性不会生效）
    const account = this.accounts.get(user.username);
    if (!account) return Response.json({ error: "账户不存在" }, { status: 401 });
    const rooms = account.joinedRooms.filter((c) => c !== code);
    if (isJoin) {
      if (rooms.length >= MAX_JOINED_ROOMS) return Response.json({ error: "加入的房间数已达上限" }, { status: 400 });
      rooms.push(code);
    }
    account.joinedRooms = rooms;
    await this.saveAccounts();
    return Response.json({ ok: true, joinedRooms: rooms });
  }

  async saveAccounts() {
    const obj = {};
    for (const [name, user] of this.accounts.entries()) {
      obj[name] = {
        passwordHash: user.passwordHash,
        passwordSalt: user.passwordSalt,
        deviceName: user.deviceName,
        virtualIp: user.virtualIp,
        createdAt: user.createdAt,
        joinedRooms: user.joinedRooms
      };
    }
    await this.state.storage.put(ACCOUNTS_KEY, obj);
  }

  /** 清理过期的账户会话并持久化 */
  async cleanupAccountSessions() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of this.accountSessions.entries()) {
      if (session.expires <= now) {
        this.accountSessions.delete(token);
        changed = true;
      }
    }
    if (changed) await this.saveAccountSessions();
  }

  /** 持久化账户会话到 DO Storage */
  async saveAccountSessions() {
    const obj = {};
    for (const [token, session] of this.accountSessions.entries()) {
      obj[token] = { username: session.username, expires: session.expires };
    }
    await this.state.storage.put(SESSIONS_KEY, obj);
  }

  /** 导出配置快照（供管理页 / 配置下载页使用） */
  /** 房间列表：允许的网络编号 + 活跃网络 合并去重（管理员添加的房间无需设备注册即可展示；NETWORKS 为空时客户端注册的网络也展示） */
  roomList() {
    const allowed = Array.from(this.allowedNetworks).filter((n) => !String(n).startsWith("__"));
    const codes = new Set(allowed);
    for (const code of this.networks.keys()) codes.add(code);
    return Array.from(codes).map((code) => {
      const net = this.networks.get(code);
      const cfg = net?.config || defaultNetworkConfig(this.defaultGatewayIp);
      return {
        networkCode: code,
        cidr: cfg.cidr,
        gateway: intToIp(cfg.gateway),
        prefix: cfg.prefix,
        deviceCount: net?.devices.size || 0,
        onlineDevices: net ? Array.from(net.devices.values()).filter((d) => d.online).length : 0,
        dataVersion: net?.dataVersion || 0
      };
    });
  }

  exportConfigSnapshot() {
    const allowed = Array.from(this.allowedNetworks).filter((n) => !String(n).startsWith("__"));
    const rooms = this.roomList();
    return {
      exportedAt: toBeijingTime(new Date()),
      serverVersion: this.serverVersion,
      environment: {
        NETWORKS: allowed.length ? allowed.join(",") : "",
        GATEWAY: this.defaultGatewayIp,
        LEASE_DURATION: Math.floor(this.leaseDurationMs / 1000),
        MAINTENANCE_INTERVAL: Math.floor(this.maintenanceIntervalMs / 1000),
        DISABLE_RELAY: this.disableRelay ? "1" : "0",
        LOG_LEVEL: this.logLevel,
        PEER_SERVERS: this.peerServers.join(","),
        LOCATION_HINT: this.env.LOCATION_HINT || ""
      },
      security: {
        logEnabled: !!this.logPassword,
        peerEnabled: this.peerServers.length > 0,
        adminEnabled: !!this.adminPassword
      },
      runtime: {
        startTime: this.getStartTimeBeijing(),
        runDuration: this.getRunningDuration(),
        networkCount: rooms.length,
        deviceCount: this.totalDeviceCount(),
        onlineCount: this.status()["在线客户端"] || 0
      },
      networks: rooms
    };
  }

  async authorizeStatusRequest(request, url) {
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const networkCode = url.searchParams.get("network") || cookies.network_code || "";
    const gateway = url.searchParams.get("gateway") || url.searchParams.get("ip") || cookies.gateway_ip || "";
    if (!this.isNetworkAllowedByConfig(networkCode)) return { ok: false, message: `网络编号 ${networkCode} 未被服务端允许` };
    const cfg = this.networks.get(networkCode)?.config || defaultNetworkConfig(this.defaultGatewayIp);
    if (gateway !== intToIp(cfg.gateway)) return { ok: false, message: "网关地址不匹配" };
    return { ok: true, networkCode, gateway };
  }

  async authorizeLogRequest(request, url) {
    if (!this.logPassword) return { ok: true };
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const session = cookies.vnts2_session || "";
    // 日志会话（日志密码哈希）或管理员会话（管理员密码哈希）均可访问日志
    if (this.logPasswordHash && session === this.logPasswordHash) return { ok: true };
    if (this.adminPasswordHash && session === this.adminPasswordHash) return { ok: true };
    // POST 登录：校验明文日志密码
    if (request.method === "POST") {
      let body = null;
      try {
        body = JSON.parse(await request.text());
      } catch {
        body = null;
      }
      if (body && typeof body.password === "string" && body.password === this.logPassword && this.logPasswordHash) {
        return { ok: true, setCookie: `vnts2_session=${this.logPasswordHash}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400` };
      }
      return { ok: false, message: "密码不正确" };
    }
    return { ok: false, message: "需要密码登录" };
  }

  authorizePeerRequest(request, url) {
    return this.authorizeSession(request, this.peerToken, this.peerTokenHash);
  }

  logInfo(message) {
    if (this.logLevel !== "off" && this.logPassword) {
      const text = `[vnts2-cf] ${message}`;
      this.appendLog("info", text);
      console.log(text);
    }
  }

  logDebug(message) {
    if (this.logLevel === "debug" && this.logPassword) {
      const text = `[vnts2-cf][调试] ${message}`;
      this.appendLog("debug", text);
      console.log(text);
    }
  }

  appendLog(level, message) {
    if (!this.logPassword) return;
    this.logs.push({
      timestamp: toBeijingTime(new Date()),
      level,
      message: limitText(message, 4096)
    });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    // 持久化保存到存储
    this._scheduleLogPersist();
  }

  async restoreLogs() {
    try {
      if (!this.logPassword) {
        await this.state.storage.delete("vnts2-logs");
        return;
      }
      const savedLogs = await this.state.storage.get("vnts2-logs");
      if (Array.isArray(savedLogs) && savedLogs.length > 0) {
        this.logs = savedLogs.map((entry) => ({
          timestamp: entry.timestamp || (entry.time ? toBeijingTime(new Date(entry.time)) : toBeijingTime(new Date())),
          level: entry.level,
          message: entry.message
        }));
      }
    } catch (error) {
      console.error("[vnts2-cf] 恢复日志失败", error);
    }
  }

  _scheduleLogPersist() {
    if (this._logPersistScheduled) return;
    this._logPersistScheduled = true;
    this.state.storage.put("vnts2-logs", this.logs.slice()).then(() => {
      this._logPersistScheduled = false;
    }).catch((error) => {
      this._logPersistScheduled = false;
      console.error("[vnts2-cf] 日志持久化保存失败", error);
    });
  }

  reportError(context, error) {
    const text = limitText(`[vnts2-cf] ${context}：${errorMessage(error)}`, 4096);
    this.lastError = text;
    this.appendLog("error", text);
    if (this.logPassword) console.error(text, error);
  }
}

function tryParseRequest(bytes) {
  try {
    return parseRequestMessage(bytes);
  } catch {
    return null;
  }
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(await value.arrayBuffer());
}

async function readRequestBytes(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MESSAGE_BYTES) {
    throw new Error(`请求体超过大小限制：${contentLength} > ${MAX_MESSAGE_BYTES}`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error(`请求体超过大小限制：${bytes.length} > ${MAX_MESSAGE_BYTES}`);
  return bytes;
}

async function readResponseBytes(response) {
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MESSAGE_BYTES) {
    throw new Error(`响应体超过大小限制：${contentLength} > ${MAX_MESSAGE_BYTES}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error(`响应体超过大小限制：${bytes.length} > ${MAX_MESSAGE_BYTES}`);
  return bytes;
}

function positiveSeconds(raw, fallback, minimum) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function safeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeTimestamp(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function storedNetworkConfig(config, defaultGateway) {
  return config && isUint32(config.gateway) ? networkConfigFromClientIp(config.gateway) : defaultNetworkConfig(defaultGateway);
}

function errorMessage(error) {
  return limitText(error instanceof Error ? error.message : String(error), 1024);
}

function limitText(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function toBeijingTime(date) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} ${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
}

function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeIcmpEchoReply(packet) {
  const payload = packet.payload;
  if (payload.length < 28) return null;
  const ihl = (payload[0] & 0x0f) * 4;
  if ((payload[0] >> 4) !== 4 || ihl < 20 || payload.length < ihl + 8) return null;
  const totalLength = ((payload[2] << 8) | payload[3]) >>> 0;
  if (totalLength < ihl + 8 || payload.length < totalLength) return null;
  if (payload[9] !== 1) return null;
  const icmpOffset = ihl;
  if (payload[icmpOffset] !== 8) return null;

  const replyIp = payload.slice(0, totalLength);
  const src = replyIp.slice(12, 16);
  replyIp.set(replyIp.slice(16, 20), 12);
  replyIp.set(src, 16);
  replyIp[10] = 0;
  replyIp[11] = 0;
  const ipSum = checksum16(replyIp.slice(0, ihl));
  replyIp[10] = (ipSum >>> 8) & 0xff;
  replyIp[11] = ipSum & 0xff;

  replyIp[icmpOffset] = 0;
  replyIp[icmpOffset + 1] = 0;
  replyIp[icmpOffset + 2] = 0;
  replyIp[icmpOffset + 3] = 0;
  const icmpSum = checksum16(replyIp.slice(icmpOffset));
  replyIp[icmpOffset + 2] = (icmpSum >>> 8) & 0xff;
  replyIp[icmpOffset + 3] = icmpSum & 0xff;

  return makePacket(MSG.TURN, replyIp, { gateway: true, ttl: 1, seq: packet.seq });
}

function checksum16(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const word = ((bytes[i] << 8) | (bytes[i + 1] || 0)) >>> 0;
    sum += word;
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

function parseBool(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw || "").trim().toLowerCase());
}

/** 常量时间字符串比较：长度不同直接返回 false（长度本身不敏感），等长时逐字符异或累加 */
function safeEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function isRelayDataMessage(msgType) {
  return msgType === MSG.TURN || msgType === MSG.QUIC;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成指定字节数的随机十六进制字符串 */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成 8 位随机邀请码（去掉易混淆字符） */
function randomInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[buf[i] % chars.length];
  return code;
}

/** 规范化注册模式：仅接受 invite/closed，其他值（含空）视为开放注册 */
function normalizeRegistrationMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === REG_MODE_INVITE || v === REG_MODE_CLOSED) return v;
  return REG_MODE_OPEN;
}

/** PBKDF2（100000 次迭代，SHA-256）派生密码哈希，返回十六进制字符串 */
async function pbkdf2Hex(password, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function peerProtoResponse(message) {
  return new Response(encodeServerMessage(message), {
    headers: { "Content-Type": "application/octet-stream" }
  });
}

function wantsJson(request, url) {
  return url.searchParams.get("format") === "json" || request.headers.get("Accept")?.includes("application/json");
}

function htmlResponse(html, auth) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  if (auth?.ok) {
    if (auth.networkCode) headers.append("Set-Cookie", `network_code=${encodeURIComponent(auth.networkCode)}; path=/; max-age=86400; SameSite=Lax`);
    if (auth.gateway) headers.append("Set-Cookie", `gateway_ip=${encodeURIComponent(auth.gateway)}; path=/; max-age=86400; SameSite=Lax`);
    if (auth.logPassword) headers.append("Set-Cookie", `log_auth=${encodeURIComponent(auth.logPassword)}; path=/; max-age=86400; SameSite=Lax`);
    if (auth.peerToken) headers.append("Set-Cookie", `peer_auth=${encodeURIComponent(auth.peerToken)}; path=/; max-age=86400; SameSite=Lax`);
  }
  return new Response(html, { headers });
}

function jsonAuthResponse(value, auth) {
  const response = Response.json(value);
  if (auth?.ok) {
    if (auth.networkCode) response.headers.append("Set-Cookie", `network_code=${encodeURIComponent(auth.networkCode)}; path=/; max-age=86400; SameSite=Lax`);
    if (auth.gateway) response.headers.append("Set-Cookie", `gateway_ip=${encodeURIComponent(auth.gateway)}; path=/; max-age=86400; SameSite=Lax`);
  }
  return response;
}

/** 若认证结果携带 setCookie，则附加到响应头 */
function applySessionCookie(response, auth) {
  if (auth && auth.ok && auth.setCookie) {
    response.headers.append("Set-Cookie", auth.setCookie);
  }
  return response;
}

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw).split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getClientIp(request) {
  const h = {};
  for (const [k, v] of request.headers.entries()) h[k.toLowerCase()] = v;
  return h["cf-connecting-ip"] || h["x-real-ip"] || (h["x-forwarded-for"] || "").split(",")[0]?.trim() || "";
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function formatTime(ts) {
  if (!ts || ts === 0) return "-";
  const d = new Date(ts * 1000);
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} ${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
}

