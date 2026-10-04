# vnts2-cf 项目交接文档

- 交接日期：2026-10-04
- 项目地址：`cyqmq/vnts2-cf`（GitHub）
- 项目简介：兼容 Rust VNTS2 的 Cloudflare Worker 版 WebSocket 服务端，支持 VNT2 客户端注册、P2P 打洞信息交换、TURN 中继、广播/选择性广播、多服务端互联，并带 Web 管理界面。

---

## 1. 环境与依赖

- Node.js >= 22（本地实测 v22.22.0）
- npm 依赖：`wrangler@^3`（仅 devDependencies）
- 无原生依赖，代码为纯 ES Module。

```bash
cd vnts2-cf
npm install
npm test          # node --test，当前 17/17 通过
npm run dev       # 本地启动 wrangler dev（https://127.0.0.1:8787，自签名证书）
npm run deploy    # 部署到 Cloudflare Workers
```

- 本地调试需信任自签名证书或使用 `curl -k`；vnt2 客户端连接用 `--cert-mode skip`。
- 仓库含 `test/vnt2_cli`、`test/vnt2_ctrl`（Linux x86-64 ELF，vnt 2.0.0 客户端），可直接在本机运行，无需 Docker。

---

## 2. Demo 验证记录（已完成）

### 2.1 本地服务

```bash
npm run dev
```
启动后 `https://127.0.0.1:8787`，`/health?format=json` 返回真实状态。

### 2.2 客户端注册 + P2P 打洞

两个终端分别运行：

```bash
cd test
./vnt2_cli -s wss://127.0.0.1:8787 -n default --ip 10.46.0.2 --cert-mode skip --device-id cf-client-a --device-name client-a --no-tun --ctrl-port 11233
./vnt2_cli -s wss://127.0.0.1:8787 -n default --ip 10.46.0.3 --cert-mode skip --device-id cf-client-b --device-name client-b --no-tun --ctrl-port 11234
```

验证结果：

- 双方注册成功：A=10.46.0.2/24，B=10.46.0.3/24。
- 服务端协调打洞成功：客户端日志出现
  `PunchReq 打洞成功 ... / PunchRes 打洞成功 10.46.0.3->10.46.0.2`，
  UDP（双端口）与 TCP 均打通。
- `./vnt2_ctrl -p 11233 clients` 显示 `P2P: true, RTT: 0, Loss: 0.0%`。
- `/room?format=json&network=default&gateway=10.46.0.1` 返回网关+两台设备。

注意：沙箱无公网，STUN（stun.miwifi.com 等）失败属正常，打洞走本地地址。

---

## 3. 本次已修复的 Bug（已提交）

> 以下 6 个安全/稳定性修复已随账户系统一并提交（见 git log）。

### 3.1 [高危] `/config` 页面泄露管理员设置的组网密码

- 问题：任何匿名访问者 `GET /config?rooms=<房间名>` 即可在 HTML 源码中看到该房间的组网密码（管理员通过 `/admin/rooms/password` 设置）。
- 修复（`room.js` `handleConfigDownload`）：组网密码仅对两种会话发放——管理员会话（`vnts2_session` = adminHash），或持有该房间 `/room` 认证 Cookie（`network_code` + `gateway_ip`）的普通用户。
- 新增 `hasRoomSession()` 校验房间会话。

### 3.2 [中] 登录页反射型 XSS（`</script>` 逃逸）

- 问题：`renderLoginHtml`/`renderPeerLoginHtml`/`renderAdminLoginHtml`/`renderLogLoginHtml` 把 `message` 用 `JSON.stringify` 直接嵌进 `<script>` 块；`/room` 的 `authorizeStatusRequest` 会把 URL 参数 `networkCode` 反射进 message，当 `NETWORKS` 配置为白名单时，攻击者可注入 `</script><script>...`。
- 修复（`ui-pages.js`）：4 处 `JSON.stringify(message)` 全部改为 `jsonScript(message)`（转义 `<`、U+2028/2029）。
- 新增测试 `test/ui.test.js` 覆盖 4 个登录页的逃逸防护，17/17 通过。

### 3.3 [中] `DISABLE_RELAY=1` 被互联转发绕过

- 问题：`/peer/forward` 与 `/peer/message` 的 forwardData 路径不检查 `disableRelay`，互联服务端发来的 TURN/QUIC 中转流量仍会投递给本地客户端，与"仅 P2P"配置矛盾；且互联转发不递减 TTL，与本地路径不一致。
- 修复（`room.js`）：两条路径均解析包头，命中 `isRelayDataMessage` 且 `disableRelay` 时丢弃（返回 `delivered:false`）；转发前先 `decrementTtl`。打洞握手（PUNCH 系列）不受影响，与配置注释一致。

### 3.4 [低] 未注册 WebSocket 会话可占满连接上限（DoS）

- 问题：`MAX_SESSIONS=1024`，但未注册会话无超时，攻击者可空连接占满。
- 修复（`room.js`）：会话记录 `openedAt`，`cleanupExpired`（随 alarm 每 ≥5s 跑）回收未注册超过 60 秒（`SESSION_IDLE_TIMEOUT_MS`）的会话。

### 3.5 [低] 互联令牌比较非恒定时间

- 修复（`room.js`）：新增 `safeEqual()` 常量时间字符串比较，用于 `peerAuthorized` 和 `authReq.tokenHash` 校验。

### 3.6 [低] `jsonAuthResponse` 可能写入 `undefined` Cookie

- 修复：`network_code`/`gateway_ip` 仅在值存在时写入。

---

## 4. 服务端账户系统 + 仪表盘真实数据（已完成）

> ✅ 2026-10-04：后端账户 API 与前端页面已全部接线，仪表盘使用真实设备流量数据。
> 该功能已随第 3 节 Bug 修复一并提交。

### 4.1 已实现（后端）

- `src/worker.js`：新增 `/api/*` 路由转发到 Durable Object。
- `src/room.js`：
  - 常量：`ACCOUNTS_KEY`、`SESSION_TTL_MS`（7 天）、`MAX_JOINED_ROOMS`(32)。
  - 构造函数新增 `this.accounts`（用户名→账户对象）、`this.accountSessions`（token→会话）。
  - `init()` 从 DO Storage 恢复账户（用户名、PBKDF2 密码哈希+盐、deviceName、virtualIp、createdAt、joinedRooms）。
  - 接口：
    - `POST /api/auth/login`：注册/登录，PBKDF2(100k, SHA-256) 校验，成功设置 `vnts2_account` HttpOnly Cookie。
    - `GET /api/auth/me`：返回当前账户资料与已加入房间。
    - `POST /api/auth/logout`：清会话与 Cookie。
    - `POST /api/rooms/join` / `POST /api/rooms/leave`：账户级加入/退出房间（跨浏览器共享）。
  - `cleanupExpired()` 中调用 `cleanupAccountSessions()` 清理过期会话。
  - `handleDashboardPage()` 已扩展：当请求带有效账户会话时，`joinedRooms` 返回用户已加入房间的**真实设备流量**（txBytes/rxBytes/online）。

### 4.2 前端接线（已完成 2026-10-04）

- [x] `ui-pages.js` 的 `renderLoginPage()`：改用 `POST /api/auth/login`（新用户自动注册），移除 localStorage 用户名密码（`vnts2_users`）。
- [x] `ui-pages.js` 的 `renderRoomListHtml()`：初始化 `GET /api/auth/me` 拉取已加入房间，加入/退出调用 `POST /api/rooms/join|leave`，移除 localStorage。
- [x] `ui-pages.js` 的 `renderDashboardHtml()`：真实数据接入：
  - 网络速度：轮询 `/dashboard?format=json`（5s 间隔），对 `joinedRooms[].devices[].txBytes/rxBytes` 差分算 KB/s。
  - 网络质量：已加入房间设备在线率百分比 + 前端 `HEAD /health` 延迟实测。
  - 流量统计：`joinedRooms` 各房间设备 tx/rx 求和。
  - 当前设备：`me.deviceName`、`me.virtualIp`。
  - 当前配置：真实 `relayServer`（wss://host）、已加入房间数、`DISABLE_RELAY` 状态。
- [x] 登录/房间列表/仪表盘/配置页 401 统一跳 `/login?redirect=...`。
- [x] 页面脚本清理旧 `vnts2_users` / `vnts2_current_user` / `vnts2_joined_rooms` localStorage 键。
- [x] 配置页 `renderConfigHtml()`：初始化 `GET /api/auth/me`，手动添加走 `POST /api/rooms/join`，移除 localStorage。
- [x] 后端 `handleDashboardPage()` 扩展：带有效账户会话时返回 `joinedRooms`（含真实设备流量），未登录不返回该字段。
- [x] `npm test` 通过（17/17）。

### 4.3 设计说明（供后续实现参考）

- 会话 Cookie：`vnts2_account=<uuid>`，`HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`，与服务端 `accountSessions` 内存映射对应（DO 重启后会话失效，用户需重新登录；账户数据已持久化到 `vnts2-accounts`）。
- 密码：PBKDF2（100000 次，随机 16 字节盐），辅助函数 `pbkdf2Hex()`、`randomHex()` 已加入 `room.js` 底部。
- 房间密码（组网密码）与账户分离：组网密码仍由管理员在 `/admin` 设置，`/config` 按 3.1 的会话规则发放。

---

## 5. 测试

- 现有 `test/protocol.test.js`（9 个）：协议编解码、IP 分配、protobuf 安全边界。
- 新增 `test/ui.test.js`（8 个）：4 个登录页对 `</script>` 注入的转义 + 无 message 渲染。
- 当前 `npm test`：17/17 通过。
- 注意：`test/ui.test.js` 断言断言字符串为 `\u003c/script>`（jsonScript 只转义 `<`）。

---

## 6. 已知遗留问题 / 建议

- `wrangler.toml` 中提交了默认密钥：`SERVER_TOKEN=peer123`、`LOG_PASSWORD=log123`、`ADMIN_PASSWORD=admin123`，**部署前务必修改**（建议改为通过 Cloudflare Secrets 注入）。
- `/dashboard`、`/room`（列表模式）、`/settings` 无需登录即可查看房间清单（网络编号、网段、在线数），属当前产品设计；如需收紧可参考账户系统接入后做登录墙。
- `peerAuthorized` 已做常量时间比较，但长度不同仍会短路（长度信息泄露风险极低，可接受）。
- 沙箱无公网环境，真实 NAT 穿透需在公网部署后使用两台真实 NAT 内机器验证。

---

## 7. 关键文件索引

| 文件 | 说明 |
|---|---|
| `src/worker.js` | Worker 入口/路由（含新增 `/api/*`） |
| `src/room.js` | Durable Object 核心：注册/IP/转发/打洞/互联/账户 API |
| `src/protocol.js` | 16 字节包头 + protobuf 协议解析 |
| `src/protobuf.js` | protobuf 读写器（2MB 上限） |
| `src/ip.js` | IP/CIDR 工具 |
| `src/ui.js` | 页面外壳/公共 UI |
| `src/ui-pages.js` | 所有页面渲染（登录/仪表盘/房间/日志/管理…） |
| `test/vnt2_cli` | vnt2 官方 Linux 客户端（demo 用） |
| `test/vnt2_ctrl` | 控制端（clients/route） |
| `scripts/docker-e2e-test.sh` | 双服务端 + 双客户端端到端测试（需 Docker，沙箱无 Docker 未跑） |