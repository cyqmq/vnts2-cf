# vnts2-cf 项目交接文档

- 交接日期：2026-10-05
- 项目地址：`cyqmq/vnts2-cf`（GitHub）
- 项目简介：兼容 Rust VNTS2 的 Cloudflare Worker 版 WebSocket 服务端，支持 VNT2 客户端注册、P2P 打洞信息交换、TURN 中继、广播/选择性广播、多服务端互联，并带 Web 管理界面（账户系统 + 仪表盘 + 注册邀请码）。

---

## 1. 环境与依赖

- Node.js >= 22（本地实测 v22.22.0）
- npm 依赖：`wrangler@^3`（仅 devDependencies）
- 无原生依赖，代码为纯 ES Module。

```bash
cd vnts2-cf
npm install
npm test          # node --test，当前 19/19 通过
npm run dev       # 本地启动 wrangler dev（https://127.0.0.1:8787，自签名证书）
npm run deploy    # 部署到 Cloudflare Workers
```

- 本地调试需信任自签名证书或使用 `curl -k`；vnt2 客户端连接用 `--cert-mode skip`。
- 仓库含 `test/vnt2_cli`、`test/vnt2_ctrl`（Linux x86-64 ELF，vnt 2.0.0 客户端），可直接在本机运行，无需 Docker。
- 本地密钥写入 `.dev.vars`（参考 `.dev.vars.example`，已被 gitignore）。

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

## 3. 已修复的 Bug（已提交）

### 3.1 [高危] `/config` 页面泄露管理员设置的组网密码

- 问题：任何匿名访问者 `GET /config?rooms=<房间名>` 即可在 HTML 源码中看到该房间的组网密码。
- 修复（`room.js` `handleConfigDownload`）：组网密码仅对三类会话发放——管理员会话（`vnts2_session` = adminHash）、持有该房间 `/room` 认证 Cookie 的普通用户、或已登录账户且已加入该房间（账户级授权）。
- 新增 `hasRoomSession()` 校验房间会话。

### 3.2 [中] 登录页反射型 XSS（`</script>` 逃逸）

- 问题：`renderLoginHtml`/`renderPeerLoginHtml`/`renderAdminLoginHtml`/`renderLogLoginHtml` 把 `message` 用 `JSON.stringify` 直接嵌进 `<script>` 块。
- 修复（`ui-pages.js`）：4 处 `JSON.stringify(message)` 全部改为 `jsonScript(message)`（转义 `<`、U+2028/2029）。

### 3.3 [中] `DISABLE_RELAY=1` 被互联转发绕过

- 问题：`/peer/forward` 与 `/peer/message` 的 forwardData 路径不检查 `disableRelay`；且互联转发不递减 TTL。
- 修复（`room.js`）：两条路径均解析包头，命中 `isRelayDataMessage` 且 `disableRelay` 时丢弃；转发前先 `decrementTtl`。

### 3.4 [低] 未注册 WebSocket 会话可占满连接上限（DoS）

- 修复（`room.js`）：会话记录 `openedAt`，`cleanupExpired`（随 alarm 每 ≥5s 跑）回收未注册超过 60 秒（`SESSION_IDLE_TIMEOUT_MS`）的会话。

### 3.5 [低] 互联令牌比较非恒定时间

- 修复（`room.js`）：新增 `safeEqual()` 常量时间字符串比较。

### 3.6 [低] `jsonAuthResponse` 可能写入 `undefined` Cookie

- 修复：`network_code`/`gateway_ip` 仅在值存在时写入。

---

## 4. 服务端账户系统 + 仪表盘 + 注册邀请码（已完成）

> ✅ 2026-10-05：账户 API、前端接线、注册邀请码、仪表盘真实数据均已实现并提交。

### 4.1 后端

- `src/worker.js`：新增 `/api/*` 路由转发到 Durable Object；`/register` 页面路由。
- `src/room.js`：
  - 常量：`ACCOUNTS_KEY`、`SESSIONS_KEY`、`INVITES_KEY`、`REG_MODE_KEY`、`SESSION_TTL_MS`（7 天）、`MAX_JOINED_ROOMS`(32)。
  - 构造函数新增 `this.accounts`、`this.accountSessions`、`this.invites`、`this.registrationMode`（open/invite/closed）。
  - `init()` 从 DO Storage 恢复账户、账户会话（持久化登录态）、邀请码与注册模式。
  - 接口：
    - `POST /api/auth/register`：注册（受注册模式控制，邀请码模式校验邀请码），成功设置 `vnts2_account` HttpOnly Cookie。
    - `POST /api/auth/login`：仅登录，PBKDF2(100k, SHA-256) 校验。
    - `GET /api/auth/me`：返回当前账户资料与已加入房间。
    - `GET /api/auth/config`：返回当前注册模式（open/invite/closed）。
    - `POST /api/auth/logout`：清会话与 Cookie。
    - `POST /api/rooms/join` / `POST /api/rooms/leave`：账户级加入/退出房间（跨浏览器共享）。
    - `POST /api/admin/registration`：管理员设置注册模式。
    - `GET/POST /api/admin/invites` 与 `POST /api/admin/invites/disable`：邀请码管理。
  - `cleanupExpired()` 中调用 `cleanupAccountSessions()` 清理过期会话并持久化。
  - `handleDashboardPage()`：带有效账户会话时返回 `joinedRooms`（含真实设备流量 txBytes/rxBytes/online），未登录不返回该字段。

### 4.2 前端接线

- `renderLoginPage()`：仅登录，`POST /api/auth/login`，移除 localStorage。
- `renderRegisterPage()`（`/register`）：注册页，通过 `GET /api/auth/config` 感知注册模式并显示邀请码输入框。
- `renderRoomListHtml()`：初始化 `GET /api/auth/me` 拉取已加入房间，加入/退出调用 `POST /api/rooms/join|leave`。
- `renderConfigHtml()`：初始化 `GET /api/auth/me`，手动添加走 `POST /api/rooms/join`；下载配置自动补随机 `device_id`、`server_address` 自动补 `:443`。
- 登录/房间列表/仪表盘/配置页 401 统一跳 `/login?redirect=...`。
- 清理旧 `vnts2_users` / `vnts2_current_user` / `vnts2_joined_rooms` localStorage 键。

### 4.3 仪表盘真实图表

- 网络速度：5s 轮询 `/dashboard?format=json`，对 `joinedRooms[].devices[].txBytes/rxBytes` 差分算 KB/s；**折线图按最近 20 个采样点动态绘制**。
- 网络质量：已加入房间设备在线率百分比 + 前端 `HEAD /health` 延迟实测；**环形图按真实在线率动态填充**。
- 流量统计：`joinedRooms` 各房间设备 tx/rx 求和；**环形图按真实上传/下载比例动态分割**。
- 当前设备：`me.deviceName`、`me.virtualIp`；当前配置：真实 `relayServer`、已加入房间数、`DISABLE_RELAY` 状态。

### 4.4 注册与邀请码管理

- 登录页 `/login` 与注册页 `/register` 已分离。
- 注册模式由管理员控制（`/admin` 页面"注册与邀请码"卡片）：`open` 开放 / `invite` 邀请码 / `closed` 关闭。
- 环境变量 `REGISTER_MODE` 可作为部署默认值；管理员保存后写入 DO Storage 覆盖。
- 邀请码：管理员生成时可设置可用次数（1-1000）与有效小时数（0=永久）；每次注册消耗一次，用完自动停用，可手动停用；8 位随机字符（去易混淆字符）。

### 4.5 房间自动分配独立网段

- 新房间创建时自动分配独立 /24 网段（默认从 `10.46.0.0/24` 开始按 /24 递增，跳过已占用网段），避免不同房间共用同一网关。
- 客户端指定 `--ip` 时优先使用该 IP 所在 /24；若该网段已被其他网络占用，注册返回明确错误提示更换网段。
- 管理员添加房间同样走自动分配。

### 4.6 部署安全化

- `wrangler.toml` **不再包含任何明文密钥**（`SERVER_TOKEN` / `LOG_PASSWORD` / `ADMIN_PASSWORD` 已移除）。
- 本地开发：密钥写入 `.dev.vars`（gitignore，模板见 `.dev.vars.example`）。
- 线上部署：使用 `wrangler secret put` 注入 Secrets。
- `README.md` 已补充完整部署指南（CLI + GitHub 集成 + 自定义域名 + Secrets）。

### 4.7 子网同步（SubnetSync）与 vnt 2.0.10 注册新字段

- `src/protocol.js`：
  - 注册请求解析 `advertised_subnets`(10)、`allow_ikev2`(11)、`allow_wireguard`(12)、`client_instance_id`(14)。
  - 注册响应补齐 `subnet_sync_supported`(5)、`subscription_config_supported`(6)、`server_instance_id`(8)。
  - 新增 `SubnetSyncReq/Res`（包类型 23/24）编解码；`encodeClientSimpleInfoList` 带 `ClientType`。
- `src/room.js`：设备保存新字段；处理 `SubnetSyncReq`，生成 canonical 快照哈希（SHA-256，重复 CIDR 只保留最小节点 IP）。
- 实测：客户端宣告 `192.168.10.0/24`，`SubnetSyncRes` 正确返回多节点子网路由。

### 4.8 订阅配置（Subscription）

- 认证机制：**不依赖 X.509 证书**。`client_proof=SHA256(credential_key‖0x01‖client_nonce)`，`server_proof=SHA256(key‖0x02‖nonce‖server_nonce)`，全部用 Web Crypto 实现。
- `cert_mode`：订阅链接可带 `standard`（生产用公共 CA 验证）或 `finger:<证书指纹>`（本地 wrangler 自签证书用）。
- `src/protocol.js`：订阅消息编解码（`SubscriptionRegistration`、`SubscriptionConfigEnvelope`、`SubscriptionServerProof`、`SubscriptionConfigFetchRequest/RegisterRequest/Ack/Ping`、`ResponseMessage` 封装）。
- `src/room.js`：
  - DO Storage 键 `vnts2-subscriptions`：`joinId → {networkCode, deviceId, credentialKey, revision, toml, managedIp, managedPrefixLen, managedDeviceName, subscriptionServer, certMode}`。
  - 首包分发：`SubscriptionRegisterRequest` → 返回 `ResponseMessage{subscription_register: envelope}` 并建立订阅控制长连接（心跳 Ping/Pong、ACK）。
  - 普通注册携带 `subscription` 字段时验证共享密钥证明并返回 `SubscriptionServerProof`。
  - 管理 API：`GET/POST /api/admin/subscriptions`、`POST /api/admin/subscriptions/issue`（重新签发）。
- 客户端实测（vnt 2.0.10 `--sub <link>`）：自动获取受管配置 `10.88.0.32/24` 并启动网络，订阅长连接稳定保持（>60s）。
- 注意：vnt 2.0.10 订阅设备（固定 IP）**不发起普通流量注册**，订阅控制连接仅用于配置分发与控制；设备不进入 P2P 数据平面。

---

## 5. 测试

- `test/protocol.test.js`（18 个）：协议编解码、IP 分配、protobuf 安全边界、子网同步、订阅协议与密钥证明。
- `test/ui.test.js`（10 个）：4 个登录页 `</script>` 转义 + 无 message 渲染、注册页包含注册接口与模式查询、登录页不再包含自动注册逻辑。
- 当前 `npm test`：**28/28 通过**。
- 注意：`test/ui.test.js` 断言字符串为 `\u003c/script>`（jsonScript 只转义 `<`）。

---

## 6. 部署指引（摘要，详见 README.md）

```bash
# 1. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 2. 注入线上密钥
npx wrangler secret put SERVER_TOKEN
npx wrangler secret put LOG_PASSWORD
npx wrangler secret put ADMIN_PASSWORD

# 3. 部署
npm run deploy
```

- 部署后访问 `https://vnts2-cf.<子域>.workers.dev`。
- 自定义域名：控制台 Worker → Settings → Domains & Routes → Add Custom Domain；或 `wrangler.toml` 配置 `routes`（见 README）。
- 客户端连接：`wss://你的域名:443`（必须带端口，配置页会自动补 `:443`）。

---

## 7. 已知遗留问题 / 建议

- 免费计划每日 100k 请求（Worker + DO + WebSocket 消息 + Alarm 全部计入）；alarm 每 15s 约 5,760 次/天。中小规模可用，生产建议 Workers Paid。
- `/dashboard`、`/room`（列表模式）、`/settings` 无需登录即可查看房间清单（网络编号、网段、在线数），属当前产品设计；如需收紧可加登录墙。
- `peerAuthorized` 已做常量时间比较，但长度不同仍会短路（长度信息泄露风险极低，可接受）。
- 沙箱无公网环境，真实 NAT 穿透需在公网部署后使用两台真实 NAT 内机器验证。

---

## 8. 关键文件索引

| 文件 | 说明 |
|---|---|
| `src/worker.js` | Worker 入口/路由（含 `/api/*`、`/register`） |
| `src/room.js` | Durable Object 核心：注册/IP/转发/打洞/互联/账户/邀请码 API |
| `src/protocol.js` | 16 字节包头 + protobuf 协议解析 |
| `src/protobuf.js` | protobuf 读写器（2MB 上限） |
| `src/ip.js` | IP/CIDR 工具（含网段自动分配） |
| `src/ui.js` | 页面外壳/公共 UI |
| `src/ui-pages.js` | 所有页面渲染（登录/注册/仪表盘/房间/日志/管理…） |
| `test/vnt2_cli` | vnt2 官方 Linux 客户端（demo 用） |
| `test/vnt2_ctrl` | 控制端（clients/route） |
| `scripts/docker-e2e-test.sh` | 双服务端 + 双客户端端到端测试（需 Docker） |
| `wrangler.toml` | Worker 配置（无明文密钥） |
| `.dev.vars.example` | 本地密钥模板 |
| `README.md` | 完整使用与部署文档 |