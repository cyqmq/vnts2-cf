/**
 * vnts2-cf 统一 UI 框架
 *
 * 设计基础：
 * - 布局参考 vnts（Rust 服务端）的 Web 管理端：固定侧边栏 + 顶栏 + 内容区
 * - 视觉风格参考 Vnt2App（Flutter 客户端）：Teal 青绿色主色(#00BFA5)、
 *   Material 3 风格卡片（圆角 12px）、按钮圆角 8px、支持暗黑模式
 * - 实现方式：无构建，服务端渲染 HTML 模板字符串 + Vue 3 CDN
 */

export let UI_VERSION = "2.0.7";

/** 设置运行时显示的服务端版本 */
export function setUiVersion(v) {
  if (v) UI_VERSION = v;
}

/* ---------- Material 风格图标（内联 SVG） ---------- */
const ICON_PATHS = {
  dashboard:
    "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  room:
    "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  log: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z",
  peer:
    "M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1zM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1zM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z",
  settings:
    "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  logout:
    "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
  sun: "M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v1.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z",
  moon: "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z",
  user: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  config: "M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z",
  about: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  admin: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  speed: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  quality: "M12 7c-2.76 0-5 2.24-5 5 0 1.63.79 3.08 2 3.98v-2.13c-.61-.82-1-1.84-1-2.85C8 9.79 9.79 8 12 8s4 1.79 4 4c0 1.01-.39 2.03-1 2.85v2.13c1.21-.9 2-2.35 2-3.98 0-2.76-2.24-5-5-5zm0 6c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2s2-.9 2-2v-4c0-1.1-.9-2-2-2z",
  traffic: "M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z",
  device: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
  ip: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
  relay: "M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 15H5v-2h8v2zm6 0h-2v-2h2v2zm0-4H5v-2h14v2zm0-4H5V8h14v2z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
  warn: "M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z",
  symmetric: "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"
};

/**
 * 返回内联 SVG 图标字符串
 * @param {string} name 图标名
 * @param {number} size 尺寸
 */
export function icon(name, size = 20) {
  const path = ICON_PATHS[name] || ICON_PATHS.dashboard;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}

/* ---------- 全局 UI 样式（Vnt2App 风格 + 暗黑模式） ---------- */
export const UI_CSS = `
:root {
  --primary: #00BFA5;
  --primary-light: #5DF2D6;
  --primary-dark: #008E76;
  --accent: #1DE9B6;
  --success: #4CAF50;
  --warning: #FFC107;
  --error: #F44336;
  --info: #2196F3;

  --bg: #F5F7FA;
  --surface: #FFFFFF;
  --card: #FFFFFF;
  --text-primary: #1A1A1A;
  --text-secondary: #666666;
  --text-muted: #9E9E9E;
  --divider: #E0E0E0;
  --nav-bg: #FFFFFF;
  --nav-hover: rgba(0, 191, 165, 0.08);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 8px 30px rgba(0, 0, 0, 0.12);
  --table-stripe: #F8FAF9;
  --table-hover: rgba(0, 191, 165, 0.05);
  --input-bg: #FFFFFF;
  --code-bg: #F1F3F4;
}

.dark {
  --bg: #121212;
  --surface: #1E1E1E;
  --card: #2C2C2C;
  --text-primary: #E0E0E0;
  --text-secondary: #9E9E9E;
  --text-muted: #757575;
  --divider: #424242;
  --nav-bg: #1E1E1E;
  --nav-hover: rgba(0, 191, 165, 0.15);
  --shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 30px rgba(0, 0, 0, 0.5);
  --table-stripe: #262626;
  --table-hover: rgba(0, 191, 165, 0.1);
  --input-bg: #1E1E1E;
  --code-bg: #232323;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text-primary);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.6;
  transition: background-color .2s ease, color .2s ease;
}

a { color: var(--primary); text-decoration: none; }
a:hover { opacity: .85; }

/* ---------- 布局：侧边栏 + 主区 ---------- */
.shell { display: flex; min-height: 100vh; }

.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: 180px;
  background: var(--nav-bg);
  border-right: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  z-index: 40;
  transition: background-color .2s ease, border-color .2s ease;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 60px;
  padding: 0 14px;
  border-bottom: 1px solid var(--divider);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: .3px;
}

.sidebar-logo .logo-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 800;
  font-size: 14px;
  flex-shrink: 0;
}

.sidebar-nav { flex: 1; padding: 12px 8px; overflow-y: auto; }

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 9px 4px;
  margin-bottom: 2px;
  border-radius: 12px;
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 12px;
  transition: background-color .15s ease, color .15s ease;
  border: none;
  background: transparent;
  width: 100%;
  cursor: pointer;
  text-align: center;
  letter-spacing: .2px;
}

.nav-item:hover { background: var(--nav-hover); color: var(--text-primary); }
.nav-item.active {
  background: rgba(0, 191, 165, 0.14);
  color: var(--primary);
  font-weight: 600;
}
.dark .nav-item.active { background: rgba(0, 191, 165, 0.2); color: var(--primary-light); }
.dark .nav-item.active .icon { color: var(--primary-light); }
.nav-item .icon { flex-shrink: 0; margin: 0 auto; }

.sidebar-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--divider);
  font-size: 12px;
  color: var(--text-muted);
}

/* ---------- 主区 ---------- */
.main {
  flex: 1;
  min-width: 0;
  margin-left: 180px;
  display: flex;
  flex-direction: column;
}

/* 无侧边栏页面（登录、健康检测）：主区占满全宽 */
.shell.no-sidebar .main { margin-left: 0; }

.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  height: 60px;
  background: var(--surface);
  border-bottom: 1px solid var(--divider);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  backdrop-filter: blur(8px);
  transition: background-color .2s ease, border-color .2s ease;
}

.page-title { font-size: 18px; font-weight: 600; color: var(--text-primary); }

.topbar-actions { display: flex; align-items: center; gap: 10px; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1px solid var(--divider);
  background: var(--card);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all .15s ease;
}
.icon-btn:hover { color: var(--primary); border-color: var(--primary); }

.topbar-user {
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--divider);
  background: var(--card);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: all .15s ease;
}
.topbar-user:hover { color: var(--primary); border-color: var(--primary); opacity: 1; }

.topbar-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: all .15s ease;
  border: 1px solid transparent;
}
.topbar-link:hover { color: var(--primary); background: var(--nav-hover); opacity: 1; }

.quick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.quick-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--divider);
  background: var(--card);
  color: var(--text-primary);
  font-weight: 500;
  font-size: 13px;
  transition: all .15s ease;
}
.quick-action:hover { border-color: var(--primary); color: var(--primary); opacity: 1; }

.content {
  flex: 1;
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

/* ---------- 卡片 ---------- */
.card {
  background: var(--card);
  border-radius: 12px;
  box-shadow: var(--shadow);
  border: 1px solid var(--divider);
  overflow: hidden;
  transition: background-color .2s ease, border-color .2s ease, box-shadow .2s ease;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--divider);
  flex-wrap: wrap;
  gap: 10px;
}

.card-header h2 { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.card-header .subtitle { font-size: 13px; color: var(--text-muted); }

.card-body { padding: 20px; }
.card-body.nopad { padding: 0; }

/* ---------- 仪表盘 ---------- */
.dash-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 14px;
}
.dash-card {
  background: var(--card);
  border: 1px solid var(--divider);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.dash-card.col-2 { grid-column: span 2; }
.dash-card.col-3 { grid-column: span 3; }
.dash-card.col-6 { grid-column: span 6; }
.dash-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 8px;
}
.dash-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}
.dash-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(0, 191, 165, 0.12);
  color: var(--primary);
  flex-shrink: 0;
}
.dash-card-body { flex: 1; display: flex; flex-direction: column; }
.dash-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.3;
}
.dash-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.dash-footer {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.dash-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all .15s ease;
}
.dash-copy-btn:hover { color: var(--primary); background: var(--nav-hover); }
.dash-legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.dash-legend-item { display: flex; align-items: center; gap: 6px; }
.dash-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dash-chart-box { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 90px; }
.dash-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.dash-action {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--divider);
  color: var(--text-primary);
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  box-shadow: var(--shadow);
  transition: transform .15s ease, box-shadow .15s ease;
}
.dash-action:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); opacity: 1; color: var(--primary); }

@media (max-width: 900px) {
  .dash-card.col-2, .dash-card.col-3 { grid-column: span 6; }
  .dash-actions { grid-template-columns: 1fr; }
}

/* ---------- 统计卡片 ---------- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--card);
  border: 1px solid var(--divider);
  border-radius: 12px;
  padding: 18px 16px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: transform .15s ease, box-shadow .15s ease;
}
.stat-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }

.stat-card .stat-label {
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.stat-card .stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-card .stat-value.accent { color: var(--primary); }
.stat-card .stat-value.success { color: var(--success); }
.stat-card .stat-value.warning { color: var(--warning); }
.stat-card .stat-value.error { color: var(--error); }

.stat-card .stat-extra { font-size: 12px; color: var(--text-muted); }

.stat-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}
.stat-icon.teal { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); }
.stat-icon.green { background: linear-gradient(135deg, #66BB6A, #388E3C); }
.stat-icon.red { background: linear-gradient(135deg, #EF5350, #D32F2F); }
.stat-icon.orange { background: linear-gradient(135deg, #FFA726, #F57C00); }
.stat-icon.blue { background: linear-gradient(135deg, #42A5F5, #1976D2); }

/* ---------- 按钮 ---------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 8px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s ease;
  text-decoration: none;
  line-height: 1.4;
}
.btn:disabled { opacity: .6; cursor: not-allowed; }

.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-dark); box-shadow: 0 4px 12px rgba(0, 191, 165, .3); }

.btn-outline {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
}
.btn-outline:hover:not(:disabled) { background: rgba(0, 191, 165, .08); }

.btn-danger { background: var(--error); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #D32F2F; box-shadow: 0 4px 12px rgba(244, 67, 54, .3); }

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--divider);
}
.btn-ghost:hover:not(:disabled) { color: var(--primary); border-color: var(--primary); }

.btn-sm { padding: 6px 12px; font-size: 13px; border-radius: 6px; }

.btn.active { background: var(--primary); color: #fff; }
.btn.active:hover:not(:disabled) { background: var(--primary-dark); }

/* ---------- 徽章 ---------- */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-online { background: rgba(76, 175, 80, .12); color: #2E7D32; }
.dark .badge-online { color: #81C784; }
.badge-offline { background: rgba(244, 67, 54, .12); color: #C62828; }
.dark .badge-offline { color: #E57373; }
.badge-info { background: rgba(33, 150, 243, .12); color: #1565C0; }
.dark .badge-info { color: #64B5F6; }
.badge-warn { background: rgba(255, 193, 7, .15); color: #F57F17; }
.dark .badge-warn { color: #FFD54F; }
.badge-gateway { background: rgba(0, 191, 165, .12); color: #008E76; }
.dark .badge-gateway { color: #5DF2D6; }

/* ---------- 表格 ---------- */
.table-wrapper { overflow-x: auto; }
.table { width: 100%; border-collapse: collapse; font-size: 14px; }
.table th {
  background: var(--surface);
  color: var(--text-secondary);
  font-weight: 600;
  text-align: left;
  padding: 12px 14px;
  border-bottom: 1px solid var(--divider);
  white-space: nowrap;
  font-size: 13px;
}
.table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--divider);
  color: var(--text-primary);
  vertical-align: middle;
}
.table tbody tr:nth-child(even) td { background: var(--table-stripe); }
.table tbody tr:hover td { background: var(--table-hover); }
.table .mono { font-family: Consolas, Monaco, 'Courier New', monospace; font-size: 13px; }
.table .right { text-align: right; }

/* ---------- 过滤芯片 ---------- */
.filter-chip {
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid var(--divider);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s ease;
}
.filter-chip:hover { border-color: var(--primary); color: var(--primary); }
.filter-chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

/* ---------- 表单 ---------- */
.form-group { margin-bottom: 18px; }
.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.form-input, .form-select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--text-primary);
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.form-input:focus, .form-select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(0, 191, 165, .15);
}
.form-input::placeholder { color: var(--text-muted); }

/* ---------- 认证卡片 ---------- */
.auth-wrap {
  min-height: calc(100vh - 140px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 0;
}
.auth-card { width: 100%; max-width: 400px; padding: 32px; }
.auth-card h2 {
  font-size: 20px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.auth-card .auth-desc {
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 24px;
}
.auth-card .logo-center {
  display: flex;
  justify-content: center;
  margin-bottom: 14px;
}
.alert {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.alert-error { background: rgba(244, 67, 54, .1); color: #C62828; border: 1px solid rgba(244, 67, 54, .3); }
.dark .alert-error { color: #E57373; }
.alert-success { background: rgba(76, 175, 80, .1); color: #2E7D32; border: 1px solid rgba(76, 175, 80, .3); }
.dark .alert-success { color: #81C784; }
.alert-info { background: rgba(33, 150, 243, .1); color: #1565C0; border: 1px solid rgba(33, 150, 243, .3); }
.dark .alert-info { color: #64B5F6; }

/* ---------- 日志 ---------- */
.log-list { max-height: 70vh; overflow-y: auto; }
.log-item {
  display: flex;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--divider);
  font-family: Consolas, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  align-items: baseline;
}
.log-item:last-child { border-bottom: none; }
.log-item:hover { background: var(--table-hover); }
.log-time { color: var(--text-muted); flex-shrink: 0; }
.log-level {
  padding: 1px 8px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
  min-width: 52px;
  text-align: center;
}
.level-info { background: rgba(33,150,243,.12); color: #1565C0; }
.level-debug { background: rgba(156,39,176,.12); color: #7B1FA2; }
.level-warn { background: rgba(255,193,7,.15); color: #F57F17; }
.level-error { background: rgba(244,67,54,.12); color: #C62828; }
.dark .level-info { color: #64B5F6; }
.dark .level-debug { color: #CE93D8; }
.dark .level-warn { color: #FFD54F; }
.dark .level-error { color: #E57373; }
.log-message { color: var(--text-primary); word-break: break-all; }

/* ---------- 空状态 ---------- */
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-muted);
}
.empty-state .empty-icon { font-size: 40px; margin-bottom: 10px; opacity: .5; }

/* ---------- 工具类 ---------- */
.flex { display: flex; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.gap-8 { gap: 8px; }
.gap-12 { gap: 12px; }
.mb-16 { margin-bottom: 16px; }
.mb-24 { margin-bottom: 24px; }
.mt-16 { margin-top: 16px; }
.flex-1 { flex: 1; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.text-muted { color: var(--text-muted); }
.text-sm { font-size: 13px; }
.text-success { color: var(--success); }
.text-warning { color: var(--warning); }
.mono { font-family: Consolas, Monaco, monospace; }
.wrap { flex-wrap: wrap; }

/* ---------- 响应式 ---------- */
@media (max-width: 900px) {
  .sidebar { transform: translateX(-100%); }
  .sidebar.open { transform: translateX(0); box-shadow: var(--shadow-lg); }
  .main { margin-left: 0; }
  .content { padding: 16px; }
  .mobile-menu-btn { display: inline-flex; }
}

@media (min-width: 901px) {
  .mobile-menu-btn { display: none; }
}

/* 主题过渡动画 */
html.theme-transitioning, html.theme-transitioning * {
  transition: background-color .18s ease, color .18s ease, border-color .18s ease !important;
}

/* 滚动条 */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
::-webkit-scrollbar-track { background: transparent; }
`;

/* ---------- Shell 公共脚本（主题切换 + 移动端侧边栏） ---------- */
const SHELL_SCRIPT = `
(function () {
  var html = document.documentElement;
  try {
    var saved = localStorage.getItem('vnts2_theme');
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      html.classList.add('dark');
    }
  } catch (e) {}
  function toggleTheme() {
    var isDark = html.classList.toggle('dark');
    try { localStorage.setItem('vnts2_theme', isDark ? 'dark' : 'light'); } catch (e) {}
    html.classList.add('theme-transitioning');
    setTimeout(function () { html.classList.remove('theme-transitioning'); }, 200);
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggleTheme);
    var userBar = document.getElementById('topbar-user');
    if (userBar) {
      var currentUser = '';
      try { currentUser = localStorage.getItem('vnts2_current_user') || ''; } catch (e) {}
      if (currentUser) {
        userBar.textContent = currentUser;
        userBar.href = '/dashboard';
        userBar.title = '我的仪表盘';
      }
    }
    var menuBtn = document.getElementById('mobile-menu-btn');
    var sidebar = document.getElementById('sidebar');
    if (menuBtn && sidebar) {
      menuBtn.addEventListener('click', function () { sidebar.classList.toggle('open'); });
      document.addEventListener('click', function (e) {
        if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== menuBtn) {
          sidebar.classList.remove('open');
        }
      });
    }
  });
})();
`;

/**
 * 渲染统一页面外壳
 * @param {object} opts
 * @param {string} opts.title       页面标题
 * @param {string} opts.active       当前导航项 dashboard|room|log|peer|settings
 * @param {string} opts.content      内容区 HTML
 * @param {string} [opts.script]    页面专属 Vue 脚本
 */
export function renderShell({ title, active, content, script, sidebar = true, topbar = true }) {
  const navItems = [
    { key: "dashboard", label: "仪表盘", href: "/dashboard", icon: icon("dashboard") },
    { key: "room", label: "房间", href: "/room", icon: icon("room") },
    { key: "config", label: "配置", href: "/config", icon: icon("config") },
    { key: "about", label: "关于", href: "/about", icon: icon("about") }
  ];

  const navHtml = navItems
    .map(
      (n) => `
      <a href="${n.href}" class="nav-item${n.key === active ? " active" : ""}">
        ${n.icon}
        <span>${n.label}</span>
      </a>`
    )
    .join("");

  const sidebarHtml = sidebar
    ? `
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-logo">
      <div class="logo-mark">V</div>
      <span>vnts2-cf</span>
    </div>
    <nav class="sidebar-nav">${navHtml}</nav>
    <div class="sidebar-footer">服务端 v${UI_VERSION}</div>
  </aside>`
    : "";

  const topbarHtml = topbar
    ? `
    <header class="topbar">
      <div class="flex items-center gap-8">
        ${sidebar ? `<button class="icon-btn mobile-menu-btn" id="mobile-menu-btn" aria-label="菜单">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>` : ""}
        <h1 class="page-title">${title}</h1>
      </div>
      <div class="topbar-actions">
        <a href="/health" class="topbar-link" title="健康检测（公开）">${icon("health", 16)} 健康检测</a>
        <a href="/admin" class="topbar-link" title="管理员">${icon("admin", 16)} 管理</a>
        <a href="/login" class="topbar-user" id="topbar-user" title="登录">登录</a>
        <button class="icon-btn" id="theme-toggle" title="切换深浅色模式" aria-label="切换主题">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
        </button>
      </div>
    </header>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - vnts2-cf</title>
<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
<style>${UI_CSS}</style>
</head>
<body>
<div class="${sidebar ? "shell" : "shell no-sidebar"}" id="app-shell">
  ${sidebarHtml}

  <div class="main">
    ${topbarHtml}
    <main class="content">
      ${content}
    </main>
  </div>
</div>
<script>${SHELL_SCRIPT}</script>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

/**
 * 渲染认证登录卡片（作为 content 传入 shell，需包裹在 Vue 挂载点 #app 内）
 * @param {object} opts
 * @param {string} opts.title      卡片标题
 * @param {string} opts.desc       描述文字
 * @param {Array<{name:string,label:string,placeholder:string,type?:string}>} opts.fields 表单字段
 */
export function renderAuthCard({ title, desc, fields }) {
  const fieldsHtml = fields
    .map(
      (f) => `
      <div class="form-group">
        <label>${f.label}</label>
        <input class="form-input" v-model="form.${f.name}" type="${f.type || "text"}" placeholder="${f.placeholder}" @keyup.enter="submit" />
      </div>`
    )
    .join("");

  return `
<div class="auth-wrap">
  <div class="card auth-card">
    <div class="logo-center"><div class="logo-mark" style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--primary),var(--primary-dark));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;">V</div></div>
    <h2>${title}</h2>
    <p class="auth-desc">${desc}</p>
    <div v-if="message" class="alert alert-error">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <span>{{ message }}</span>
    </div>
    ${fieldsHtml}
    <button class="btn btn-primary" style="width:100%" @click="submit">进入</button>
  </div>
</div>`;
}