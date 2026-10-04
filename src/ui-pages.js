/**
 * vnts2-cf 页面渲染函数
 *
 * 每个函数返回完整的 HTML 页面（通过 ui.js 的 renderShell 统一外壳）。
 * 页面内容使用 Vue 3 CDN 作为挂载在 #app 上的小程序。
 */

import { renderShell, renderAuthCard, icon } from "./ui.js";

/* ---------- 通用辅助 ---------- */
/**
 * 安全地将值序列化为可嵌入 <script> 的 JSON 字符串。
 * 转义 "<" 防止 "</script>" 逃逸，转义 U+2028/U+2029 防止 JS 字符串被截断。
 */
function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** HTML 转义，用于服务端渲染进 HTML 内容的用户可控字符串 */
function escHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function statusBadge(status) {
  if (status === "在线") return `<span class="badge badge-online"><span class="badge-dot"></span>在线</span>`;
  if (status === "离线") return `<span class="badge badge-offline"><span class="badge-dot"></span>离线</span>`;
  if (status === "正常" || status === "可用" || status === "已启用") {
    return `<span class="badge badge-online"><span class="badge-dot"></span>${status}</span>`;
  }
  if (status === "已禁止") return `<span class="badge badge-offline"><span class="badge-dot"></span>${status}</span>`;
  return `<span class="badge badge-info">${status}</span>`;
}

/* ============================================================
 * 健康检测（公开，免登录；原 /test 仪表盘内容）
 * ============================================================ */
export function renderHealthHtml(status) {
  const cards = [
    { label: "服务状态", value: status["服务状态"] || "可用", cls: "success", iconCls: "green", iconName: "dashboard" },
    { label: "WebSocket 服务", value: status["WebSocket服务"] || "正常", cls: "success", iconCls: "teal", iconName: "peer" },
    { label: "网络编号数", value: String(status["网络编号数"] ?? 0), cls: "", iconCls: "blue", iconName: "settings", extra: "当前已注册网络" },
    { label: "在线客户端", value: String(status["在线客户端"] ?? 0), cls: "success", iconCls: "green", iconName: "room", extra: "包含互联客户端" },
    { label: "离线客户端", value: String(status["离线客户端"] ?? 0), cls: "error", iconCls: "red", iconName: "room", extra: "本地注册设备" },
    { label: "互联服务端在线", value: String(status["互联服务端在线"] ?? 0), cls: "success", iconCls: "teal", iconName: "peer", extra: "跨服连接" },
    { label: "互联服务端离线", value: String(status["互联服务端离线"] ?? 0), cls: "warning", iconCls: "orange", iconName: "peer", extra: "不可达服务端" },
    { label: "服务端中转", value: status["服务端中转"] || "已启用", cls: status["服务端中转"] === "已禁止" ? "error" : "success", iconCls: "blue", iconName: "log", extra: "TURN 数据转发" }
  ];

  const statHtml = cards
    .map(
      (c) => `
      <div class="stat-card">
        <div class="stat-label">
          <span class="stat-icon ${c.iconCls}">${icon(c.iconName, 18)}</span>
          <span>${c.label}</span>
        </div>
        <div class="stat-value ${c.cls}">${c.value}</div>
        ${c.extra ? `<div class="stat-extra">${c.extra}</div>` : ""}
      </div>`
    )
    .join("");

  const content = `
<div id="app">
  <div class="stat-grid">
    ${statHtml}
  </div>

  <div class="card">
    <div class="card-header">
      <h2>延迟检测</h2>
      <span class="subtitle">自动每 5 秒检测一次当前网络到服务端的延迟</span>
    </div>
    <div class="card-body" style="text-align:center;padding:32px;">
      <div style="font-size:48px;font-weight:700;color:var(--text-primary)" :class="{ 'text-success': latencyClass === 'latency-excellent', 'text-warning': latencyClass === 'latency-fair' || latencyClass === 'latency-good' }">{{ latency }}ms</div>
      <div class="text-muted" style="margin:8px 0 24px;">{{ latencyText }}</div>
      <button class="btn btn-primary" @click="toggleAutoDetection" :disabled="testing">
        {{ autoDetecting ? '停止自动检测延迟' : '开始自动检测延迟' }}
      </button>
    </div>
  </div>

  <div class="card mt-16">
    <div class="card-header"><h2>服务信息</h2></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">服务端版本</td><td class="mono">{{ status['服务端版本'] }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">支持协议</td><td>{{ status['支持协议'] }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">启动时间</td><td>{{ status['启动时间'] }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">已运行</td><td>{{ status['已运行'] }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      status: ${jsonScript(status)},
      latency: 0,
      latencyClass: '',
      latencyText: '检测中...',
      testing: false,
      autoDetecting: true,
      autoDetectInterval: null
    };
  },
  mounted() {
    this.testLatency();
    this.startAutoDetection();
  },
  beforeUnmount() { this.stopAutoDetection(); },
  methods: {
    async testLatency() {
      this.testing = true;
      const start = performance.now();
      try {
        await fetch(window.location.href, { method: 'HEAD', cache: 'no-cache' });
        const t = Math.round(performance.now() - start);
        this.latency = t;
        if (t < 50) { this.latencyClass = 'latency-excellent'; this.latencyText = '连接极佳'; }
        else if (t < 100) { this.latencyClass = 'latency-good'; this.latencyText = '连接良好'; }
        else if (t < 200) { this.latencyClass = 'latency-fair'; this.latencyText = '连接一般'; }
        else { this.latencyClass = 'latency-poor'; this.latencyText = '连接较差'; }
      } catch (e) {
        this.latency = 999;
        this.latencyClass = 'latency-poor';
        this.latencyText = '检测失败';
      } finally { this.testing = false; }
    },
    startAutoDetection() {
      if (this.autoDetectInterval) return;
      this.autoDetecting = true;
      this.autoDetectInterval = setInterval(() => {
        if (!this.testing && this.autoDetecting) this.testLatency();
      }, 5000);
    },
    stopAutoDetection() {
      if (this.autoDetectInterval) { clearInterval(this.autoDetectInterval); this.autoDetectInterval = null; }
      this.autoDetecting = false;
    },
    toggleAutoDetection() {
      this.autoDetecting ? this.stopAutoDetection() : this.startAutoDetection();
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "健康检测", active: "health", content, script, sidebar: false });
}

/* ============================================================
 * 登录页（公开，用户名+密码，服务端账户跨浏览器共享）
 * ============================================================ */
export function renderLoginPage() {
  const content = `
<div id="app">
  <div class="auth-wrap" style="min-height:100vh;">
    <div class="card auth-card">
      <div class="logo-center"><div class="logo-mark" style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--primary),var(--primary-dark));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;">V</div></div>
      <h2>登录 VNT 控制台</h2>
      <p class="auth-desc">登录后访问个人中心与组网管理；健康检测无需登录可直接查看</p>
      <div v-if="error" class="alert alert-error">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>{{ error }}</span>
      </div>
      <div class="form-group">
        <label>用户名</label>
        <input class="form-input" v-model="form.username" type="text" placeholder="输入用户名，新用户自动注册" @keyup.enter="submit" autofocus />
      </div>
      <div class="form-group">
        <label>密码</label>
        <input class="form-input" v-model="form.password" type="password" placeholder="输入密码" @keyup.enter="submit" />
      </div>
      <button class="btn btn-primary" style="width:100%" :disabled="loading" @click="submit">{{ loading ? '登录中…' : '登录 / 注册' }}</button>
      <div class="auth-desc" style="text-align:center;margin-top:14px;">新用户名首次输入即自动注册，不同用户拥有独立个人页</div>
      <div style="text-align:center;margin-top:14px;border-top:1px solid var(--divider);padding-top:14px;">
        <a href="/health">无需登录，直接查看健康检测 →</a>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
// 清理旧版 localStorage 登录/房间状态，避免与新账户体系混用
try {
  localStorage.removeItem('vnts2_users');
  localStorage.removeItem('vnts2_current_user');
  localStorage.removeItem('vnts2_joined_rooms');
} catch (e) {}
createApp({
  data() {
    return { form: { username: '', password: '' }, error: '', loading: false };
  },
  methods: {
    async submit() {
      const name = this.form.username.trim();
      if (!name || !this.form.password) { this.error = '请输入用户名和密码'; return; }
      this.error = '';
      this.loading = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: name, password: this.form.password })
        });
        const data = await res.json();
        if (!data.ok) { this.error = data.error || '登录失败'; return; }
        const redirect = new URLSearchParams(location.search).get('redirect') || '/dashboard';
        location.href = redirect;
      } catch (e) {
        this.error = '网络错误，请重试';
      } finally {
        this.loading = false;
      }
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "登录", active: "login", content, script, sidebar: false, topbar: false });
}

/* ============================================================
 * 个人中心（需登录；客户端 localStorage 校验）
 * ============================================================ */
export function renderMePage(data) {
  const status = data.status || {};
  const config = data.config || {};
  const env = config.environment || {};
  const content = `
<div id="app" v-if="currentUser">
  <!-- 个人资料 -->
  <div class="card">
    <div class="card-header">
      <h2>个人资料</h2>
      <span class="badge badge-online"><span class="badge-dot"></span>{{ currentUser }}</span>
    </div>
    <div class="card-body">
      <div class="grid-2">
        <div class="form-group">
          <label>设备名称</label>
          <input class="form-input" v-model="profile.deviceName" placeholder="输入设备名称" />
        </div>
        <div class="form-group">
          <label>虚拟 IP</label>
          <input class="form-input mono" v-model="profile.virtualIp" placeholder="如 10.26.0.100" />
        </div>
      </div>
      <div class="flex" style="display:flex;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap;">
        <button class="btn btn-primary" @click="saveProfile">{{ saved ? '✓ 已保存' : '保存资料' }}</button>
        <button class="btn btn-danger" @click="logout">退出登录</button>
        <span class="text-muted" style="font-size:12px;">加入时间：{{ profile.createdAt || '-' }}</span>
      </div>
    </div>
  </div>

  <!-- 账号 / 身份信息 -->
  <div class="card mt-16">
    <div class="card-header"><h2>账号 / 身份信息</h2></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">当前用户</td><td style="color:var(--primary);font-weight:600;">{{ currentUser }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">设备名称</td><td>{{ profile.deviceName || currentUser }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">虚拟 IP</td><td class="mono">{{ profile.virtualIp || '-' }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">访问身份</td><td>浏览器用户（localStorage 独立资料）</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 我的配置 -->
  <div class="card mt-16">
    <div class="card-header"><h2>我的配置</h2><span class="subtitle">服务端当前生效配置</span></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">允许网络</td><td class="mono">${escHtml(env.NETWORKS) || "(全部允许)"}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">默认网关</td><td class="mono">${env.GATEWAY || "-"}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">租约时长</td><td>${env.LEASE_DURATION ? env.LEASE_DURATION + " 秒" : "-"}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">中转转发</td><td>${env.DISABLE_RELAY === "1" ? "已禁止" : "已启用"}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">日志级别</td><td class="mono">{{ logLevel }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 本机设备信息 -->
  <div class="card mt-16">
    <div class="card-header"><h2>本机设备信息</h2></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">平台</td><td>{{ device.platform }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">浏览器</td><td>{{ device.browser }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">屏幕</td><td>{{ device.screen }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">语言</td><td>{{ device.language }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">在线状态</td><td><span class="badge" :class="navigatorOnLine ? 'badge-online' : 'badge-offline'"><span class="badge-dot"></span>{{ navigatorOnLine ? '在线' : '离线' }}</span></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 服务信息 -->
  <div class="card mt-16">
    <div class="card-header"><h2>服务信息</h2></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">服务端版本</td><td class="mono">{{ serverVersion }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">启动时间</td><td>{{ startTime }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">已运行</td><td>{{ runDuration }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">网络编号数</td><td>{{ status['网络编号数'] ?? 0 }}</td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">在线客户端</td><td>{{ status['在线客户端'] ?? 0 }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 快捷操作 -->
  <div class="card mt-16">
    <div class="card-header"><h2>快捷操作</h2></div>
    <div class="card-body">
      <div class="quick-grid">
        <a class="quick-action" href="/health">📊 健康检测</a>
        <a class="quick-action" href="/room">🚪 房间设备</a>
        <a class="quick-action" href="/log">📄 查看日志</a>
        <a class="quick-action" href="/peer">🌐 互联状态</a>
        <a class="quick-action" href="/admin">🛡️ 服务管理</a>
        <a class="quick-action" href="/config">📥 配置下载</a>
      </div>
    </div>
  </div>
</div>
<div id="app" v-else class="auth-wrap"><div class="card auth-card" style="text-align:center;"><h2>请先登录</h2><p class="auth-desc">登录后才能访问个人中心</p><a class="btn btn-primary" href="/login?redirect=/me" style="display:inline-block;margin-top:12px;">去登录</a></div></div>`;

  const script = `
const { createApp } = Vue;
const CURRENT_KEY = 'vnts2_current_user';
const USERS_KEY = 'vnts2_users';
function loadUsers() { try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch (e) { return {}; } }
const current = localStorage.getItem(CURRENT_KEY) || '';
if (!current) {
  location.href = '/login?redirect=/me';
}
const users = loadUsers();
const profile = users[current] || { deviceName: current, virtualIp: '', createdAt: '-' };
const ua = navigator.userAgent;
const browser = ua.includes('Edg/') ? 'Edge' : ua.includes('Firefox/') ? 'Firefox' : ua.includes('Chrome/') ? 'Chrome' : ua.includes('Safari/') ? 'Safari' : '未知';
createApp({
  data() {
    return {
      currentUser: current,
      profile: { ...profile },
      saved: false,
      navigatorOnLine: navigator.onLine,
      serverVersion: ${jsonScript(data.serverVersion || "")},
      startTime: ${jsonScript(data.startTime || "")},
      runDuration: ${jsonScript(data.runDuration || "")},
      status: ${jsonScript(status)},
      logLevel: ${jsonScript(env.LOG_LEVEL || "info")},
      device: {
        platform: navigator.platform || navigator.userAgentData?.platform || '未知',
        browser,
        screen: screen.width + ' × ' + screen.height + '（' + (window.devicePixelRatio || 1) + 'x）',
        language: navigator.language || '未知'
      }
    };
  },
  methods: {
    saveProfile() {
      if (!this.currentUser) return;
      const users = loadUsers();
      if (!users[this.currentUser]) users[this.currentUser] = {};
      users[this.currentUser] = {
        ...users[this.currentUser],
        ...this.profile,
        deviceName: (this.profile.deviceName || '').trim() || this.currentUser
      };
      localStorage.setItem(USERS_KEY, JSON.stringify(users));
      this.saved = true;
      setTimeout(() => { this.saved = false; }, 1500);
    },
    logout() {
      localStorage.removeItem(CURRENT_KEY);
      location.href = '/login';
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "个人中心", active: "me", content, script });
}

/* ============================================================
 * 仪表盘（需登录；客户端 localStorage 校验）
 * ============================================================ */
export function renderDashboardHtml(data) {
  const status = data.status || {};
  const config = data.config || {};
  const rooms = data.rooms || [];
  const relayDisabled = !!(config.environment && config.environment.DISABLE_RELAY === "1");
  const content = `
<div id="app">
  <div class="dash-grid">
    <!-- 第1行：数据监控 -->
    <div class="dash-card col-2">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("speed", 16)}</span>网络速度</div>
      </div>
      <div class="dash-chart-box">
        <svg viewBox="0 0 300 90" width="100%" height="90" preserveAspectRatio="none" style="max-width:280px;">
          <polyline fill="none" stroke="rgba(0,191,165,.12)" stroke-width="1" points="0,75 60,75 120,75 180,75 240,75 300,75"/>
          <polyline fill="none" stroke="#F44336" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="0,62 30,58 60,60 90,52 120,55 150,47 180,50 210,42 240,45 270,37 300,40"/>
          <polyline fill="none" stroke="#4CAF50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="0,72 30,64 60,68 90,58 120,61 150,50 180,54 210,44 240,47 270,31 300,36"/>
        </svg>
      </div>
      <div class="dash-footer">
        <span><span style="color:var(--error);font-weight:600;">↑ 上传</span> {{ uploadSpeed }}</span>
        <span><span style="color:var(--success);font-weight:600;">↓ 下载</span> {{ downloadSpeed }}</span>
      </div>
    </div>

    <div class="dash-card col-2">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("quality", 16)}</span>网络质量</div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;flex:1;">
        <svg viewBox="0 0 80 80" width="80" height="80" style="flex-shrink:0;">
          <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(0,191,165,.15)" stroke-width="8"/>
          <circle cx="40" cy="40" r="34" fill="none" stroke="#00BFA5" stroke-width="8" stroke-linecap="round" stroke-dasharray="202.9 213.6" transform="rotate(-90 40 40)"/>
          <text x="40" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">{{ qualityPercent }}</text>
        </svg>
        <div class="dash-legend">
          <span class="dash-legend-item"><span class="dash-dot" style="background:#fff;border:1px solid var(--divider);"></span>未连接</span>
          <span class="dash-legend-item"><span class="dash-dot" style="background:var(--success);"></span>在线率</span>
        </div>
      </div>
      <div class="dash-footer">
        <span>延迟 <strong>{{ latency }}</strong></span>
        <span>丢包 <strong>0.00%</strong></span>
      </div>
    </div>

    <div class="dash-card col-2">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("traffic", 16)}</span>流量统计</div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;flex:1;">
        <svg viewBox="0 0 80 80" width="80" height="80" style="flex-shrink:0;">
          <circle cx="40" cy="40" r="30" fill="none" stroke="#2196F3" stroke-width="12" stroke-dasharray="141.4 188.5" transform="rotate(-90 40 40)"/>
          <circle cx="40" cy="40" r="30" fill="none" stroke="#00E5FF" stroke-width="12" stroke-dasharray="47.1 188.5" stroke-dashoffset="-141.4" transform="rotate(-90 40 40)"/>
          <text x="40" y="44" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">{{ totalTxText }}</text>
        </svg>
        <div class="dash-legend">
          <span class="dash-legend-item"><span class="dash-dot" style="background:#00E5FF;"></span>上传</span>
          <span class="dash-legend-item"><span class="dash-dot" style="background:#2196F3;"></span>下载</span>
        </div>
      </div>
      <div class="dash-footer">
        <span>上传 <strong>{{ totalTxText }}</strong></span>
        <span>下载 <strong>{{ totalRxText }}</strong></span>
      </div>
    </div>

    <!-- 第2行：状态信息 -->
    <div class="dash-card col-3">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("device", 16)}</span>当前设备</div>
      </div>
      <div class="dash-card-body">
        <div class="dash-value">{{ profile.deviceName || currentUser }}</div>
        <div class="dash-sub" style="display:flex;align-items:center;gap:4px;margin-top:6px;">${icon("symmetric", 14)} {{ profile.virtualIp || '未分配' }}</div>
      </div>
    </div>

    <div class="dash-card col-3">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("config", 16)}</span>当前配置</div>
      </div>
      <div class="dash-card-body">
        <div class="dash-value">{{ joinedCount }} 个房间</div>
        <div class="dash-sub" style="display:flex;align-items:center;gap:4px;margin-top:6px;">${icon("lock", 14)} 中继{{ relayDisabled ? '已禁止' : '已启用' }}</div>
      </div>
    </div>

    <!-- 第3行：网络信息 -->
    <div class="dash-card col-3">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("room", 16)}</span>连接设备</div>
      </div>
      <div class="dash-card-body">
        <div class="dash-value">{{ onlineDevices }} 台</div>
        <div class="dash-sub"><span style="color:var(--success);font-weight:600;">{{ onlineDevices }} 在线</span> / {{ offlineDevices }} 离线</div>
      </div>
    </div>

    <div class="dash-card col-3">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("ip", 16)}</span>虚拟 IP</div>
        <button class="dash-copy-btn" @click="copy(profile.virtualIp || '')" title="复制虚拟 IP">${icon("copy", 15)}</button>
      </div>
      <div class="dash-card-body">
        <div class="dash-value mono">{{ profile.virtualIp || '未分配' }}</div>
        <div class="dash-sub">账户资料指定</div>
      </div>
    </div>

    <!-- 第4行：服务器信息 -->
    <div class="dash-card col-6">
      <div class="dash-card-header">
        <div class="dash-card-title"><span class="dash-icon">${icon("relay", 16)}</span>中继服务器</div>
        <button class="dash-copy-btn" @click="copy(relayServer)" title="复制服务器地址">${icon("copy", 15)}</button>
      </div>
      <div class="dash-card-body">
        <div class="dash-value mono" style="font-size:18px;">{{ relayServer }}</div>
        <div class="dash-sub">注册和中继服务器（WSS）</div>
      </div>
    </div>

    <!-- 第5行：操作按钮 -->
    <div class="dash-card col-6" style="border:none;box-shadow:none;background:transparent;padding:0;">
      <div class="dash-actions">
        <a class="dash-action" href="/config">${icon("plus", 18)} 新建配置</a>
        <a class="dash-action" href="/admin">${icon("settings", 18)} 系统设置</a>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
// 清理旧版 localStorage 状态，避免与新账户体系混用
try {
  localStorage.removeItem('vnts2_users');
  localStorage.removeItem('vnts2_current_user');
  localStorage.removeItem('vnts2_joined_rooms');
} catch (e) {}
function fmtBytes(n) {
  n = n || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n >= 100 ? 0 : 2) + ' ' + units[i];
}
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 401) { location.href = '/login?redirect=' + encodeURIComponent(location.pathname); return null; }
  return res.json();
}
createApp({
  data() {
    return {
      currentUser: '',
      profile: { deviceName: '', virtualIp: '', createdAt: '-' },
      status: ${jsonScript(status)},
      rooms: ${jsonScript(rooms)},
      serverVersion: ${jsonScript(data.serverVersion || "")},
      startTime: ${jsonScript(data.startTime || "")},
      runDuration: ${jsonScript(data.runDuration || "")},
      relayServer: 'wss://' + window.location.host,
      relayDisabled: ${jsonScript(relayDisabled)},
      joinedCount: 0,
      uploadSpeed: '0.00 KB/s',
      downloadSpeed: '0.00 KB/s',
      totalTxText: '0 B',
      totalRxText: '0 B',
      qualityPercent: '0%',
      latency: '-',
      onlineDevices: 0,
      offlineDevices: 0,
      _prev: null,
      _prevTime: 0
    };
  },
  methods: {
    copy(text) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => alert('已复制：' + text));
    },
    async tick() {
      const snap = await fetchJson('/dashboard?format=json');
      if (!snap) return;
      this.status = snap.status || this.status;
      this.rooms = snap.rooms || this.rooms;
      const joined = snap.joinedRooms || [];
      this.joinedCount = joined.length;
      if (snap.config && snap.config.environment) {
        this.relayDisabled = snap.config.environment.DISABLE_RELAY === '1';
      }
      let tx = 0, rx = 0, online = 0, total = 0;
      for (const room of joined) {
        for (const d of room.devices || []) {
          tx += d.txBytes || 0;
          rx += d.rxBytes || 0;
          total++;
          if (d.online) online++;
        }
      }
      const now = Date.now();
      if (this._prev && this._prevTime) {
        const dt = (now - this._prevTime) / 1000;
        if (dt > 0) {
          this.uploadSpeed = (Math.max(0, tx - this._prev.tx) / dt / 1024).toFixed(2) + ' KB/s';
          this.downloadSpeed = (Math.max(0, rx - this._prev.rx) / dt / 1024).toFixed(2) + ' KB/s';
        }
      }
      this._prev = { tx, rx };
      this._prevTime = now;
      this.totalTxText = fmtBytes(tx);
      this.totalRxText = fmtBytes(rx);
      this.qualityPercent = total ? Math.round((online / total) * 100) + '%' : '0%';
      this.onlineDevices = this.status['在线客户端'] || 0;
      this.offlineDevices = this.status['离线客户端'] || 0;
    },
    async measureLatency() {
      try {
        const t0 = performance.now();
        await fetch('/health', { method: 'HEAD', cache: 'no-store' });
        this.latency = Math.max(1, Math.round(performance.now() - t0)) + ' ms';
      } catch (e) {}
    }
  },
  async mounted() {
    const me = await fetchJson('/api/auth/me');
    if (!me) return;
    this.currentUser = me.username || '';
    this.profile = {
      deviceName: me.deviceName || me.username || '',
      virtualIp: me.virtualIp || '',
      createdAt: me.createdAt || '-'
    };
    await this.tick();
    setInterval(() => this.tick(), 5000);
    this.measureLatency();
  }
}).mount('#app');
`;

  return renderShell({ title: "仪表盘", active: "dashboard", content, script });
}

/* ============================================================
 * 房间列表（需登录；账户级已加入房间，跨浏览器共享）
 * ============================================================ */
export function renderRoomListHtml(data) {
  const rooms = data.rooms || [];
  const content = `
<div id="app">
  <div class="card">
    <div class="card-header">
      <h2>房间列表</h2>
      <span class="subtitle">共 {{ rooms.length }} 个房间，加入后可在「配置」页下载对应客户端配置</span>
    </div>
    <div class="card-body">
      <div v-if="rooms.length" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;">
        <div class="dash-card" v-for="room in rooms" :key="room.networkCode">
          <div class="dash-card-header">
            <div class="dash-card-title" style="font-size:15px;">${icon("room", 16)} {{ room.networkCode }}</div>
            <span class="badge" :class="room.onlineDevices > 0 ? 'badge-online' : 'badge-offline'"><span class="badge-dot"></span>{{ room.onlineDevices }} 在线</span>
          </div>
          <div class="dash-card-body">
            <div class="dash-sub">网关：<span class="mono">{{ room.gateway }}</span></div>
            <div class="dash-sub">网段：<span class="mono">{{ room.cidr }}</span></div>
            <div class="dash-sub">设备：{{ room.deviceCount }} 台（{{ room.onlineDevices }} 在线 / {{ room.deviceCount - room.onlineDevices }} 离线）</div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
            <button class="btn btn-sm" :class="isJoined(room.networkCode) ? 'btn-primary' : 'btn-ghost'" :disabled="busy" @click="toggleJoin(room)">{{ isJoined(room.networkCode) ? '✓ 已加入' : '加入' }}</button>
            <a class="btn btn-ghost btn-sm" :href="'/room?network=' + encodeURIComponent(room.networkCode) + '&gateway=' + encodeURIComponent(room.gateway)">查看设备</a>
          </div>
        </div>
      </div>
      <div v-else-if="!loading" class="empty-state">
        <div class="empty-icon">🚪</div>
        <div>暂无房间，请联系管理员添加房间</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
try { localStorage.removeItem('vnts2_joined_rooms'); } catch (e) {}
async function loadMe() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) { location.href = '/login?redirect=' + encodeURIComponent(location.pathname); return null; }
  const data = await res.json();
  return data.ok ? data : null;
}
createApp({
  data() {
    return {
      rooms: ${jsonScript(rooms)},
      joined: [],
      loading: true,
      busy: false
    };
  },
  methods: {
    isJoined(code) { return this.joined.includes(code); },
    async toggleJoin(room) {
      const idx = this.joined.indexOf(room.networkCode);
      const isJoin = idx < 0;
      this.busy = true;
      try {
        const res = await fetch('/api/rooms/' + (isJoin ? 'join' : 'leave'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCode: room.networkCode })
        });
        if (res.status === 401) { location.href = '/login?redirect=' + encodeURIComponent(location.pathname); return; }
        const data = await res.json();
        if (data.ok) { this.joined = data.joinedRooms || []; }
        else { alert(data.error || '操作失败'); }
      } catch (e) {
        alert('网络错误，请重试');
      } finally {
        this.busy = false;
      }
    }
  },
  async mounted() {
    const me = await loadMe();
    if (me) { this.joined = me.joinedRooms || []; }
    this.loading = false;
  }
}).mount('#app');
`;

  return renderShell({ title: "房间", active: "room", content, script });
}

/* ============================================================
 * 关于页
 * ============================================================ */
export function renderAboutPage() {
  const content = `
<div id="app">
  <div class="card">
    <div class="card-header"><h2>关于 vnts2-cf</h2></div>
    <div class="card-body">
      <p>vnts2-cf 是基于 Cloudflare Workers + Durable Objects 的 VNTS2 服务端实现，支持 VNT2 客户端通过 WSS 注册组网，提供中继转发（TURN/QUIC/广播）与 P2P 打洞信息交换。</p>
      <ul style="margin:12px 0 0 18px;line-height:2;">
        <li>WSS 客户端注册与 IP 分配</li>
        <li>中继转发：TURN / QUIC / 广播 / 选择性广播</li>
        <li>P2P 打洞信息交换（客户端列表 RPC）</li>
        <li>多服务端互联</li>
      </ul>
    </div>
  </div>
  <div class="card mt-16">
    <div class="card-header"><h2>项目信息</h2></div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table">
          <tbody>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">项目地址</td><td><a href="https://github.com/lmq8267/vnts2-cf" target="_blank" rel="noopener">github.com/lmq8267/vnts2-cf</a></td></tr>
            <tr><td style="width:180px;color:var(--text-muted);font-weight:500;">客户端项目</td><td><a href="https://github.com/vnt-dev/vnt" target="_blank" rel="noopener">github.com/vnt-dev/vnt</a></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>`;

  return renderShell({ title: "关于", active: "about", content });
}

/* ============================================================
 * 房间认证（原 /room 未认证）
 * ============================================================ */
export function renderLoginHtml(message) {
  const content = `
<div id="app">
  ${renderAuthCard({
    title: "房间查询",
    desc: "输入网络编号和网关地址，查看该房间内的组网设备",
    fields: [
      { name: "network", label: "网络编号", placeholder: "vnt2 组网编号" },
      { name: "gateway", label: "网关地址", placeholder: "组网编号对应的网关 IP" }
    ]
  })}
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      form: { network: '', gateway: '' },
      message: ${message ? jsonScript(message) : "''"}
    };
  },
  methods: {
    submit() {
      if (!this.form.gateway) { this.message = '请输入网关地址'; return; }
      const p = new URLSearchParams();
      p.set('network', this.form.network || '');
      p.set('gateway', this.form.gateway);
      location.href = '/room?' + p.toString();
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "房间认证", active: "room", content, script });
}

/* ============================================================
 * 房间设备列表（原 /room 已认证）
 * ============================================================ */
export function renderRoomHtml(data) {
  const devices = data.devices || [];
  const peerServers = data.peerServers || [];
  const onlineCount = data.onlineCount || 0;
  const offlineCount = data.offlineCount || 0;
  const totalCount = devices.length;
  const peerCount = devices.filter((d) => d["类型"] === "互联").length;

  const content = `
<div id="app">
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon teal">${icon("room", 18)}</span><span>设备总数</span></div>
      <div class="stat-value">${totalCount}</div>
      <div class="stat-extra">含网关与互联客户端</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon green">${icon("room", 18)}</span><span>在线客户端</span></div>
      <div class="stat-value success">${onlineCount}</div>
      <div class="stat-extra">当前可通信设备</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon red">${icon("room", 18)}</span><span>离线客户端</span></div>
      <div class="stat-value error">${offlineCount}</div>
      <div class="stat-extra">历史注册设备</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon blue">${icon("peer", 18)}</span><span>互联客户端</span></div>
      <div class="stat-value">${peerCount}</div>
      <div class="stat-extra">互联服务端 ${peerServers.length} 个</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>设备列表</h2>
      <div class="flex items-center gap-8 wrap">
        <button class="filter-chip" :class="{ active: filter === 'all' }" @click="filter='all'">全部</button>
        <button class="filter-chip" :class="{ active: filter === 'online' }" @click="filter='online'">在线</button>
        <button class="filter-chip" :class="{ active: filter === 'offline' }" @click="filter='offline'">离线</button>
        <button class="btn btn-ghost btn-sm" @click="logout">退出</button>
      </div>
    </div>
    <div class="card-body nopad">
      <div class="table-wrapper">
        <table class="table" v-if="filteredDevices.length">
          <thead>
            <tr>
              <th>类型</th><th>虚拟IP</th><th>名称</th><th>版本</th><th>状态</th><th>设备ID</th><th>加密</th><th>上传</th><th>下载</th><th>上线时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in filteredDevices" :key="i">
              <td><span :class="badgeForType(d['类型'])">{{ d['类型'] }}</span></td>
              <td class="mono">{{ d['虚拟IP'] }}</td>
              <td>{{ d['名称'] || '-' }}</td>
              <td class="text-muted">{{ d['版本'] || '-' }}</td>
              <td v-html="statusBadgeHtml(d['状态'])"></td>
              <td class="mono">{{ d['设备ID'] || '-' }}</td>
              <td>{{ d['加密'] || '-' }}</td>
              <td class="mono">{{ d['上传'] || '-' }}</td>
              <td class="mono">{{ d['下载'] || '-' }}</td>
              <td class="text-muted">{{ d['上线时间'] || '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-state">
          <div class="empty-icon">📭</div>
          <div>暂无设备记录</div>
        </div>
      </div>
    </div>
  </div>
</div>`;

  // 注意模板中使用了动态 class/函数，需要在 script 中定义
  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      allDevices: ${jsonScript(devices)},
      filter: 'all'
    };
  },
  computed: {
    filteredDevices() {
      if (this.filter === 'online') return this.allDevices.filter(d => d['状态'] === '在线');
      if (this.filter === 'offline') return this.allDevices.filter(d => d['状态'] === '离线');
      return this.allDevices;
    }
  },
  methods: {
    statusBadgeHtml(status) {
      if (status === '在线') return '<span class="badge badge-online"><span class="badge-dot"></span>在线</span>';
      if (status === '离线') return '<span class="badge badge-offline"><span class="badge-dot"></span>离线</span>';
      return '<span class="badge badge-info">' + escHtml(status) + '</span>';
    },
    badgeForType(type) {
      if (type === '网关') return 'badge badge-gateway';
      if (type === '互联') return 'badge badge-info';
      return 'badge badge-warn';
    },
    logout() {
      document.cookie = 'network_code=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      document.cookie = 'gateway_ip=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      window.location.href = '/room';
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "房间", active: "room", content, script });
}

/* ============================================================
 * 互联认证（原 /peer 未认证）
 * ============================================================ */
export function renderPeerLoginHtml(message) {
  const content = `
<div id="app">
  ${renderAuthCard({
    title: "互联服务端",
    desc: "输入互联令牌，查看已配置的互联服务端状态",
    fields: [
      { name: "token", label: "互联令牌", placeholder: "SERVER_TOKEN", type: "password" }
    ]
  })}
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      form: { token: '' },
      message: ${message ? jsonScript(message) : "''"}
    };
  },
  methods: {
    async submit() {
      if (!this.form.token) { this.message = '请输入互联令牌'; return; }
      try {
        const r = await fetch('/peer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.form.token })
        });
        if (r.ok || r.redirected || r.status === 302 || r.status === 200) {
          window.location.href = '/peer';
        } else {
          this.message = '认证失败，请检查互联令牌';
        }
      } catch (e) {
        this.message = '网络错误，请稍后重试';
      }
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "互联认证", active: "peer", content, script });
}

/* ============================================================
 * 互联服务端列表（原 /peer 已认证）
 * ============================================================ */
export function renderPeerHtml(servers) {
  const online = servers.filter((s) => s.online).length;
  const offline = servers.length - online;

  const content = `
<div id="app">
  <div class="stat-grid">
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon teal">${icon("peer", 18)}</span><span>互联服务端总数</span></div>
      <div class="stat-value">${servers.length}</div>
      <div class="stat-extra">已配置地址</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon green">${icon("peer", 18)}</span><span>在线</span></div>
      <div class="stat-value success">${online}</div>
      <div class="stat-extra">连接正常</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="stat-icon red">${icon("peer", 18)}</span><span>离线</span></div>
      <div class="stat-value error">${offline}</div>
      <div class="stat-extra">不可达</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>互联服务端 ({{ servers.length }})</h2>
      <button class="btn btn-ghost btn-sm" @click="logout">退出</button>
    </div>
    <div class="card-body">
      <div class="grid-2" v-if="servers.length">
        <div class="card" v-for="s in servers" :key="s.addr" style="box-shadow:none;">
          <div class="flex items-center justify-between" style="padding:16px;">
            <div>
              <div class="mono" style="font-size:14px;font-weight:600;color:var(--text-primary);">{{ s.addr }}</div>
              <div class="text-muted text-sm mt-16">服务端地址</div>
            </div>
            <span v-html="statusBadgeHtml(s.online)"></span>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">🌐</div>
        <div>未配置互联服务端</div>
        <div class="text-sm mt-16">通过环境变量 PEER_SERVERS 配置</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return { servers: ${jsonScript(servers)} };
  },
  methods: {
    statusBadgeHtml(online) {
      if (online) return '<span class="badge badge-online"><span class="badge-dot"></span>在线</span>';
      return '<span class="badge badge-offline"><span class="badge-dot"></span>离线</span>';
    },
    logout() {
      document.cookie = 'vnts2_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      window.location.href = '/peer';
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "互联服务端", active: "peer", content, script });
}

/* ============================================================
 * 日志认证（原 /log 未认证）
 * ============================================================ */
export function renderLogLoginHtml(errorMessage) {
  const content = `
<div id="app">
  ${renderAuthCard({
    title: "日志验证",
    desc: "输入日志密码，查看服务运行日志",
    fields: [
      { name: "password", label: "日志密码", placeholder: "请输入日志密码", type: "password" }
    ]
  })}
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    const saved = localStorage.getItem('vnts2_log_pwd') || '';
    return {
      form: { password: saved },
      rememberPwd: !!saved,
      inputType: 'password',
      message: ${errorMessage ? jsonScript(errorMessage) : "''"}
    };
  },
  methods: {
    async submit() {
      if (!this.form.password) { this.message = '请输入日志密码'; return; }
      if (this.rememberPwd) {
        localStorage.setItem('vnts2_log_pwd', this.form.password);
      } else {
        localStorage.removeItem('vnts2_log_pwd');
      }
      try {
        const r = await fetch('/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.form.password })
        });
        if (r.ok || r.redirected || r.status === 302 || r.status === 200) {
          window.location.href = '/log';
        } else {
          this.message = '日志密码不正确';
        }
      } catch (e) {
        this.message = '网络错误，请稍后重试';
      }
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "日志认证", active: "log", content, script });
}

/* ============================================================
 * 日志页（原 /log 已认证）
 * ============================================================ */
export function renderLogHtml(data) {
  const logs = data.logs || [];

  const content = `
<div id="app">
  <div v-if="showNotification" :class="notificationType === 'success' ? 'alert alert-success' : 'alert alert-error'" class="mb-16">
    <span>{{ notificationMessage }}</span>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>服务运行日志 ({{ logs.length }})</h2>
      <div class="flex items-center gap-8">
        <button class="btn btn-danger btn-sm" @click="clearLogs">清空日志</button>
        <button class="btn btn-ghost btn-sm" @click="logout">退出</button>
      </div>
    </div>
    <div class="card-body nopad">
      <div class="log-list" v-if="logs.length">
        <div class="log-item" v-for="(log, i) in logs" :key="i">
          <span class="log-time">{{ log.timestamp }}</span>
          <span :class="'log-level level-' + log.level">{{ (log.level || 'info').toUpperCase() }}</span>
          <span class="log-message">{{ log.message }}</span>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">📄</div>
        <div>暂无日志记录</div>
      </div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      logs: ${jsonScript(logs)},
      showNotification: false,
      notificationType: '',
      notificationMessage: ''
    };
  },
  methods: {
    logout() {
      document.cookie = 'vnts2_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      window.location.href = '/log';
    },
    async clearLogs() {
      if (!confirm('确定要清空所有日志吗？此操作不可恢复！')) return;
      try {
        const r = await fetch(window.location.href + '/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const result = await r.json();
        if (r.ok && result.status === 'ok') {
          this.logs = [];
          this.notificationType = 'success';
          this.notificationMessage = '日志已成功清空';
        } else {
          this.notificationType = 'error';
          this.notificationMessage = result.error || result.message || '清空日志失败';
        }
      } catch (e) {
        this.notificationType = 'error';
        this.notificationMessage = '网络错误，请稍后重试';
      }
      this.showNotification = true;
      setTimeout(() => { this.showNotification = false; }, 4000);
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "日志", active: "log", content, script });
}

/* ============================================================
 * 设置页（新增）
 * ============================================================ */
export function renderSettingsHtml() {
  const content = `
<div id="app">
  <div class="card">
    <div class="card-header"><h2>关于 vnts2-cf</h2></div>
    <div class="card-body">
      <p class="text-sm" style="color:var(--text-secondary);line-height:1.8;">
        vnts2-cf 是使用 Cloudflare Worker + Durable Object 实现的 JavaScript 版 VNTS2 服务端，
        支持网络中继转发与 P2P 打洞信息交换。本项目 UI 参考了 vnts 的页面结构，并采用 Vnt2App 的
        青绿色（Teal）主题风格。
      </p>
      <div class="grid-2 mt-16">
        <div class="card" style="box-shadow:none;">
          <div class="card-body">
            <h3 style="font-size:15px;font-weight:600;margin-bottom:10px;color:var(--text-primary);">环境变量配置</h3>
            <ul class="text-sm" style="color:var(--text-secondary);line-height:2;list-style:none;padding:0;">
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">NETWORKS</code> 允许的网络编号列表</li>
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">GATEWAY</code> 默认网关 IP</li>
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">LOG_PASSWORD</code> 日志查看密码</li>
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">SERVER_TOKEN</code> 互联服务端令牌</li>
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">PEER_SERVERS</code> 互联服务端地址（逗号分隔）</li>
              <li><code class="mono" style="background:var(--code-bg);padding:2px 6px;border-radius:4px;">DISABLE_RELAY</code> 设为 1 禁止服务端中转</li>
            </ul>
          </div>
        </div>
        <div class="card" style="box-shadow:none;">
          <div class="card-body">
            <h3 style="font-size:15px;font-weight:600;margin-bottom:10px;color:var(--text-primary);">页面说明</h3>
            <ul class="text-sm" style="color:var(--text-secondary);line-height:2;list-style:none;padding:0;">
              <li>📊 仪表盘：登录后查看设备/网络/服务器状态（侧边栏）</li>
              <li>🚪 房间：浏览所有房间并选择加入，可查看设备列表（侧边栏）</li>
              <li>📥 配置：下载已加入房间的客户端配置文件 YAML/TOML/JSON（侧边栏）</li>
              <li>ℹ️ 关于：项目信息与版本（侧边栏）</li>
              <li>💚 健康检测：公开免登录，服务运行状态与延迟检测（顶栏）</li>
              <li>🛡️ 管理：需管理员密码，网络/设备/会话/日志，并含「日志」「互联」「设置」入口（顶栏）</li>
              <li>📄 日志：需日志密码（管理页内入口）</li>
              <li>🌐 互联：需互联令牌查看互联服务端状态（管理页内入口）</li>
              <li>⚙️ 设置：本页（管理页内入口）</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

  return renderShell({
    title: "设置",
    active: "settings",
    content
  });
}

/* ============================================================
 * 管理页（需 ADMIN_PASSWORD）
 * ============================================================ */
export function renderAdminLoginHtml(message) {
  const content = `
<div id="app">
  ${renderAuthCard({
    title: "管理员验证",
    desc: "输入管理员密码，进入服务管理页面",
    fields: [
      { name: "password", label: "管理员密码", placeholder: "请输入 ADMIN_PASSWORD", type: "password" }
    ]
  })}
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      form: { password: '' },
      message: ${message ? jsonScript(message) : "''"}
    };
  },
  methods: {
    async submit() {
      if (!this.form.password) { this.message = '请输入管理员密码'; return; }
      try {
        const r = await fetch('/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.form.password })
        });
        if (r.ok || r.redirected || r.status === 302 || r.status === 200) {
          window.location.href = '/admin';
        } else {
          this.message = '管理员密码不正确';
        }
      } catch (e) {
        this.message = '网络错误，请稍后重试';
      }
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "管理员验证", active: "admin", content, script });
}

export function renderAdminHtml(data) {
  const json = JSON.stringify(data, null, 2);
  const content = `
<div id="app">
  <div class="card" style="margin-bottom:16px;">
    <div class="card-header">
      <h2>功能入口</h2>
    </div>
    <div class="card-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a class="btn btn-outline btn-sm" href="/log">📄 日志</a>
        <a class="btn btn-outline btn-sm" href="/peer">🌐 互联</a>
        <a class="btn btn-outline btn-sm" href="/settings">⚙️ 设置</a>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
        <input v-model="roomCode" placeholder="输入新房间网络编号，如 myroom" style="max-width:220px;" />
        <input v-model="roomPassword" type="password" placeholder="组网密码（可选）" style="max-width:180px;" />
        <button class="btn btn-primary btn-sm" @click="addRoom" :disabled="addingRoom">添加房间</button>
        <span v-if="roomNotice" class="text-sm" style="color:var(--text-secondary);align-self:center;">{{ roomNotice }}</span>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="card-header">
      <h2>房间密码管理 ({{ rooms.length }})</h2>
      <span class="subtitle">为每个房间设置组网密码，生成客户端配置时自动带入</span>
    </div>
    <div class="card-body nopad">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>网络编号</th><th>网段</th><th>网关</th><th>设备</th><th>组网密码</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="room in rooms" :key="room.networkCode">
              <td><strong>{{ room.networkCode }}</strong></td>
              <td class="mono">{{ room.cidr }}</td>
              <td class="mono">{{ room.gateway }}</td>
              <td>{{ room.deviceCount }} 台</td>
              <td><input v-model="room.pwdInput" type="password" :placeholder="room.password ? '已设置' : '未设置'" style="width:160px;" /></td>
              <td><button class="btn btn-sm" @click="setRoomPassword(room)" :disabled="room.saving">保存</button></td>
            </tr>
            <tr v-if="rooms.length === 0">
              <td colspan="6" class="text-sm" style="color:var(--text-muted);text-align:center;padding:16px;">暂无房间，请先在上方添加房间</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="row">
    <div class="col-6">
      <div class="card">
        <div class="card-header"><h2>运行状态</h2></div>
        <div class="card-body">
          <table class="status-table">
            <tbody>
              <tr><td>服务端版本</td><td>{{ status.serverVersion || '${data.serverVersion || ""}' }}</td></tr>
              <tr><td>启动时间</td><td>{{ status.startTime || '${data.startTime || ""}' }}</td></tr>
              <tr><td>已运行</td><td>{{ status.runDuration || '${data.runDuration || ""}' }}</td></tr>
              <tr><td>网络数量</td><td>{{ status.config.networkCount ?? ${data.config.networkCount ?? 0} }}</td></tr>
              <tr><td>设备总数</td><td>{{ status.config.deviceCount ?? ${data.config.deviceCount ?? 0} }}</td></tr>
              <tr><td>在线客户端</td><td>{{ status.config.onlineCount ?? ${data.config.onlineCount ?? 0} }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="col-6">
      <div class="card">
        <div class="card-header">
          <h2>安全状态</h2>
          <button class="btn btn-sm" @click="copyConfig">复制配置 JSON</button>
          <button class="btn btn-sm btn-danger" @click="logout">退出登录</button>
        </div>
        <div class="card-body">
          <ul class="text-sm" style="color:var(--text-secondary);line-height:2;list-style:none;padding:0;">
            <li>🔒 日志密码：${data.config.security.logEnabled ? "已启用" : "未配置"}</li>
            <li>🔒 互联令牌：${data.config.security.peerEnabled ? "已启用" : "未配置"}</li>
            <li>🔒 管理员密码：${data.config.security.adminEnabled ? "已启用" : "未配置"}</li>
            <li>🌐 网络：${escHtml(data.config.environment.NETWORKS) || "(全部允许)"}</li>
            <li>🌐 网关：${data.config.environment.GATEWAY}</li>
            <li>📄 日志级别：${data.config.environment.LOG_LEVEL}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>设备列表 (${data.devices.length})</h2></div>
    <div class="card-body">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>类型</th><th>网络编号</th><th>IP</th><th>名称</th><th>设备ID</th><th>状态</th><th>最后活跃</th><th>流量 (↓/↑)</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in devices" :key="d.deviceId + d.networkCode">
              <td>{{ d.type }}</td>
              <td>{{ d.networkCode }}</td>
              <td>{{ d.ip }}</td>
              <td>{{ d.name }}</td>
              <td class="mono">{{ d.deviceId }}</td>
              <td><span class="badge" :class="d.online ? 'badge-on' : 'badge-off'">{{ d.online ? '在线' : '离线' }}</span></td>
              <td>{{ d.lastSeen }}</td>
              <td>{{ d.rx }} / {{ d.tx }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>活跃会话 (${data.sessions.length})</h2></div>
    <div class="card-body">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>会话ID</th><th>设备ID</th><th>网络编号</th><th>IP</th><th>远端地址</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.id">
              <td class="mono">{{ s.id }}</td>
              <td class="mono">{{ s.deviceId }}</td>
              <td>{{ s.networkCode }}</td>
              <td>{{ s.ip }}</td>
              <td class="mono">{{ s.remote }}</td>
              <td><span class="badge" :class="s.registered ? 'badge-on' : 'badge-off'">{{ s.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>最近日志 ({{ logs.length }})</h2>
      <button class="btn btn-sm btn-danger" @click="clearLogs">清空日志</button>
    </div>
    <div class="card-body">
      <div v-if="logs.length === 0" class="text-sm" style="color:var(--text-secondary);">暂无日志</div>
      <pre class="log-box" v-else>{{ logs.join('\\n') }}</pre>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      status: ${jsonScript({
        serverVersion: data.serverVersion,
        startTime: data.startTime,
        runDuration: data.runDuration,
        config: {
          networkCount: data.config.networkCount,
          deviceCount: data.config.deviceCount,
          onlineCount: data.status["在线客户端"] || 0
        }
      })},
      devices: ${jsonScript(data.devices)},
      sessions: ${jsonScript(data.sessions)},
      logs: ${jsonScript(data.logs || [])},
      rooms: ${jsonScript((data.rooms || []).map((r) => ({ ...r, pwdInput: "", saving: false })))},
      showNotification: false,
      notificationType: '',
      notificationMessage: '',
      roomCode: '',
      roomPassword: '',
      roomNotice: '',
      addingRoom: false
    };
  },
  methods: {
    async addRoom() {
      const code = this.roomCode.trim();
      if (!code) { this.roomNotice = '请输入网络编号'; return; }
      this.addingRoom = true;
      this.roomNotice = '';
      try {
        const r = await fetch('/admin/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCode: code, password: this.roomPassword.trim() })
        });
        const result = await r.json();
        if (r.ok && result.ok) {
          this.roomNotice = '已添加房间：' + result.networkCode;
          this.roomCode = '';
          this.roomPassword = '';
          this.loadRooms();
        } else {
          this.roomNotice = result.error || '添加失败';
        }
      } catch (e) {
        this.roomNotice = '网络错误，请稍后重试';
      } finally {
        this.addingRoom = false;
      }
    },
    async loadRooms() {
      try {
        const r = await fetch('/admin', { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        const data = await r.json();
        this.rooms = (data.rooms || []).map((room) => ({ ...room, pwdInput: '', saving: false }));
      } catch (e) { /* ignore */ }
    },
    async setRoomPassword(room) {
      room.saving = true;
      try {
        const r = await fetch('/admin/rooms/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCode: room.networkCode, password: room.pwdInput.trim() })
        });
        const result = await r.json();
        if (r.ok && result.ok) {
          room.password = room.pwdInput.trim();
          room.pwdInput = '';
          this.notify('success', '房间密码已保存');
        } else {
          this.notify('error', result.error || '保存失败');
        }
      } catch (e) {
        this.notify('error', '网络错误，请稍后重试');
      } finally {
        room.saving = false;
      }
    },
    async clearLogs() {
      try {
        const r = await fetch('/log/clear', { method: 'POST' });
        const result = await r.json();
        if (r.ok && result.status === 'ok') {
          this.logs = [];
          this.notify('success', '日志已清空');
        } else {
          this.notify('error', result.error || result.message || '清空失败');
        }
      } catch (e) {
        this.notify('error', '网络错误，请稍后重试');
      }
    },
    copyConfig() {
      navigator.clipboard.writeText(${jsonScript(json)}).then(() => {
        this.notify('success', '配置 JSON 已复制到剪贴板');
      }).catch(() => {
        this.notify('error', '复制失败，请手动复制');
      });
    },
    logout() {
      document.cookie = 'vnts2_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      window.location.href = '/admin';
    },
    notify(type, message) {
      this.notificationType = type;
      this.notificationMessage = message;
      this.showNotification = true;
      setTimeout(() => { this.showNotification = false; }, 4000);
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "管理", active: "admin", content, script });
}

/* ============================================================
 * 配置文件下载页（需 ADMIN_PASSWORD）
 * ============================================================ */
export function renderConfigLoginHtml(message) {
  const content = `
<div id="app">
  ${renderAuthCard({
    title: "配置下载验证",
    desc: "输入管理员密码，下载客户端配置文件（YAML/TOML/JSON）与服务端配置快照",
    fields: [
      { name: "password", label: "管理员密码", placeholder: "请输入 ADMIN_PASSWORD", type: "password" }
    ]
  })}
</div>`;

  const script = `
const { createApp } = Vue;
createApp({
  data() {
    return {
      form: { password: '' },
      message: ${message ? jsonScript(message) : "''"}
    };
  },
  methods: {
    async submit() {
      if (!this.form.password) { this.message = '请输入管理员密码'; return; }
      try {
        const r = await fetch('/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: this.form.password })
        });
        if (r.ok || r.redirected || r.status === 302 || r.status === 200) {
          window.location.href = '/config';
        } else {
          this.message = '管理员密码不正确';
        }
      } catch (e) {
        this.message = '网络错误，请稍后重试';
      }
    }
  }
}).mount('#app');
`;

  return renderShell({ title: "配置下载", active: "config", content, script });
}

export function renderConfigHtml(snapshot) {
  const rooms = snapshot.networks || [];
  const content = `
<div id="app">
  <div class="card">
    <div class="card-header">
      <h2>我的客户端配置</h2>
      <span class="subtitle">加入房间后即可下载该房间的客户端配置文件</span>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 16px;margin-bottom:16px;">
        <div>
          <label style="display:block;font-weight:600;margin-bottom:4px;">设备名称</label>
          <input v-model="form.name" placeholder="如 Windows 11" />
        </div>
        <div>
          <label style="display:block;font-weight:600;margin-bottom:4px;">设备 ID</label>
          <div style="display:flex;gap:8px;">
            <input v-model="form.device_id" placeholder="唯一标识，可随机生成" />
            <button type="button" class="btn btn-sm" @click="generateId">随机</button>
          </div>
        </div>
        <div>
          <label style="display:block;font-weight:600;margin-bottom:4px;">虚拟 IP（可选）</label>
          <input v-model="form.ip" placeholder="留空由服务端分配" />
        </div>
      </div>

      <h3 style="font-size:14px;font-weight:600;margin-bottom:10px;">已加入房间</h3>
      <div v-if="joinedRooms.length" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;">
        <div class="dash-card" v-for="room in joinedRooms" :key="room.networkCode">
          <div class="dash-card-header">
            <div class="dash-card-title">${icon("config", 16)} {{ room.networkCode }}</div>
            <span class="dash-sub">{{ room.cidr }}</span>
          </div>
          <div class="dash-card-body">
            <div class="dash-sub">网关：<span class="mono">{{ room.gateway || '-' }}</span></div>
            <div class="dash-sub">设备：{{ room.deviceCount }} 台</div>
            <div class="dash-sub" :style="room.password ? 'color:var(--success);' : ''">{{ room.password ? '🔒 组网密码已由管理员设置' : '组网密码：未设置' }}</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
              <button class="btn btn-sm" @click="download('yaml', room)" title="vnt2_cli -f 导入">YAML</button>
              <button class="btn btn-sm" @click="download('json', room)" title="Vnt2App 导入单个配置">JSON</button>
              <button class="btn btn-sm" @click="download('toml', room)">TOML</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">📥</div>
        <div>还没有加入任何房间，去 <a href="/room">房间</a> 页选择加入</div>
      </div>

      <h3 style="font-size:14px;font-weight:600;margin:18px 0 10px;">手动添加网络编号</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input v-model="manualCode" placeholder="输入网络编号，如 demo" style="max-width:260px;" />
        <button class="btn btn-primary" @click="addManual">添加并生成配置</button>
      </div>
      <div v-if="notice" class="alert alert-info" style="margin-top:12px;">{{ notice }}</div>
    </div>
  </div>
</div>`;

  const script = `
const { createApp } = Vue;
// 清理旧版 localStorage 状态，避免与新账户体系混用
try {
  localStorage.removeItem('vnts2_users');
  localStorage.removeItem('vnts2_current_user');
  localStorage.removeItem('vnts2_joined_rooms');
} catch (e) {}
async function loadMe() {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) { location.href = '/login?redirect=/config'; return null; }
  const data = await res.json();
  return data.ok ? data : null;
}
(async () => {
  const me = await loadMe();
  if (!me) return;
  const current = me.username || '';
  // 按已加入房间重载页面，服务端才会附带这些房间的组网密码（避免未登录/未加入时泄露密码）
  const joinedKey = (me.joinedRooms || []).join(',');
  const currentRooms = new URLSearchParams(location.search).get('rooms') || '';
  if (joinedKey !== currentRooms) {
    location.replace('/config' + (joinedKey ? '?rooms=' + encodeURIComponent(joinedKey) : ''));
    return;
  }
  const profile = { deviceName: me.deviceName || current, virtualIp: me.virtualIp || '', createdAt: me.createdAt || '-' };
  const allRooms = ${jsonScript(rooms)};
  createApp({
    data() {
      return {
        currentUser: current,
        allRooms: allRooms,
        joinedCodes: (me.joinedRooms || []).slice(),
        form: {
          name: profile.deviceName || current,
          device_id: profile.deviceId || '',
          ip: profile.virtualIp || ''
        },
        manualCode: '',
        notice: ''
      };
    },
    computed: {
      joinedRooms() {
        return this.joinedCodes
          .map(code => this.allRooms.find(r => r.networkCode === code) || { networkCode: code, cidr: '手动添加', gateway: '', deviceCount: 0 })
          .filter(r => r.networkCode);
      }
    },
    methods: {
      generateId() {
        this.form.device_id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      },
      async addManual() {
        const code = this.manualCode.trim();
        if (!code) { this.notice = '请输入网络编号'; return; }
        const res = await fetch('/api/rooms/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkCode: code })
        });
        if (res.status === 401) { location.href = '/login?redirect=/config'; return; }
        const data = await res.json();
        if (!data.ok) { this.notice = data.error || '加入失败'; return; }
        // 重新按最新已加入房间加载，获取该房间的管理员密码（如果存在）
        this.joinedCodes = data.joinedRooms || [];
        location.href = '/config?rooms=' + encodeURIComponent(this.joinedCodes.join(','));
      },
      configValues(room) {
        const f = this.form;
        const serverAddress = 'wss://' + window.location.host;
        const name = (f.name || 'vnt2').trim();
        const roomPassword = room.password || '';
        const items = [];
        const push = (key, value, comment) => {
          if (value !== undefined && value !== null && String(value).trim() !== '') items.push({ key, value: String(value).trim(), comment: comment || '' });
        };
        push('token', room.networkCode, '组网编号');
        if (f.ip) push('ip', f.ip, '本机虚拟IP');
        if (f.device_id) push('device_id', f.device_id, '设备ID');
        push('name', name, '设备名称');
        push('server_address', serverAddress, '注册和中继服务器');
        if (roomPassword) {
          push('cipher_model', 'aes_gcm', '加密方式');
          push('password', roomPassword, '组网密码');
        }
        push('mtu', '1420', '虚拟网卡MTU');
        return items;
      },
      buildYaml(room) {
        return this.configValues(room).map(it => it.comment ? it.key + ': ' + it.value + '   # ' + it.comment : it.key + ': ' + it.value).join('\\n');
      },
      buildToml(room) {
        return this.configValues(room).map(it => {
          const val = /^[0-9]+$/.test(it.value) ? it.value : JSON.stringify(it.value);
          return it.comment ? it.key + ' = ' + val + '  # ' + it.comment : it.key + ' = ' + val;
        }).join('\\n');
      },
      buildJson(room) {
        const f = this.form;
        return JSON.stringify({
          config: {
            itemKey: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
              const r = Math.random() * 16 | 0;
              const v = c === 'x' ? r : (r & 0x3 | 0x8);
              return v.toString(16);
            }),
            network_code: room.networkCode,
            config_name: (f.name || 'vnt2').trim(),
            ip: f.ip.trim(),
            server: ['wss://' + window.location.host],
            device_id: f.device_id.trim(),
            device_name: (f.name || 'vnt2').trim(),
            tun_name: 'vnt2',
            password: (room.password || '').trim(),
            cert_mode: 'skip',
            mtu: 1420,
            no_punch: false,
            compress: false,
            rtx: false,
            fec: false,
            input: [],
            output: [],
            port_mapping: [],
            no_nat: false,
            no_tun: false,
            allow_port_mapping: false,
            udp_stun: [],
            tcp_stun: [],
            tunnel_port: 0,
            updated_at: ''
          }
        }, null, 2);
      },
      download(format, room) {
        let content = '', filename = '', mime = 'text/plain';
        if (format === 'yaml') { content = this.buildYaml(room); filename = 'vnt_config-' + room.networkCode + '.yaml'; mime = 'text/yaml'; }
        else if (format === 'toml') { content = this.buildToml(room); filename = 'vnt_config-' + room.networkCode + '.toml'; mime = 'text/plain'; }
        else { content = this.buildJson(room); filename = 'vnt2_config-' + room.networkCode + '.json'; mime = 'application/json'; }
        const blob = new Blob([content], { type: mime + ';charset=utf-8;' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    }
  }).mount('#app');
})();
`;

  return renderShell({ title: "配置", active: "config", content, script });
}