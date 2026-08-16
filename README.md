# dsh-ui-state

界面状态持久化插件（DSH Web GUI）——官方侧边栏与详情面板跨重启恢复。

## 功能

- **侧边栏开合**：展开/收起状态自动持久化，重启 DSH 后自动恢复。
- **侧边栏宽度**：拖拽后的宽度自动持久化，重启后模拟拖拽恢复到上次宽度（264–420px 官方契约范围）。
- **详情面板（details 列）开合**：右侧详情面板的打开/关闭自动持久化并恢复（仅在会话打开时记录，避免把"无会话"误判为用户关闭）。
- **对话滚动位置**：切走/隐藏页面时保存当前对话的非底部阅读位置；视图因重连/重建回到顶部后自动恢复到切走前的位置（按消息 anchor 对齐，新消息追加也不会偏）。
- **无需配置**：全自动，无设置界面。

## 原理

官方 layout store 是瞬态设计（宽度/开合不持久化）。插件：

1. **检测**：轮询 AppFrame（`[data-shell-overlay]` 锚点）的 `data-sidebar-collapsed` 属性与
   `grid-template-columns` 第一列，变化防抖 600ms 写入 settings.yaml。
2. **恢复**：启动后从 `~/.dsh/settings.yaml` 读 `ui-state` 段：
   - 侧边栏开合：调用官方 `ctx.layout.toggleSidebar()`（等 layout 服务挂载，自动重试）
   - 侧边栏宽度：找到 `[data-side="sidebar"]` 拖拽手柄，派发合成 pointer 序列（pointerdown/move/up，
     与官方 DragHandle 的监听协议一致；同步窗口内 stub pointer capture）
   - 详情面板：`ctx.layout.openDetails() / closeDetails()`（仅在会话打开时恢复）
3. **窄屏保护**：视口 < 1024px 时官方自动折叠侧边栏，此时不持久化、不恢复，避免与自动行为打架。

## 配置存储

```yaml
ui-state:
  sidebarCollapsed: false   # 用户显式折叠后为 true
  sidebarWidth: 360         # 最近一次展开宽度
  chatScroll:               # 按会话保存的非底部阅读位置（自动维护，可手删）
    "<sessionId>":
      anchorKey: "..."
      anchorTop: 120
      scrollTop: 480
      updatedAt: 1750000000000
```

## 关联

better-sidebar 等插件把状态存浏览器 localStorage——localStorage 按「域名+端口」隔离，
DSH 启动端口随机（--port 0）时每次重启都会丢失。配套修复：DSH Desktop 源码
（`D:\Code\dsh-desktop\main.js`）已支持从 config.json 读 `port` 字段，把
`%APPDATA%\DSH Desktop\config.json` 的 `"port"` 固定为 13372 后，localStorage 状态
（含 better-sidebar 的面板布局）跨重启稳定。

## 结构

- `lib/index.js` — Node half：注册 `ui-state` settings namespace + loopback 桥接路由。
- `lib/client.js` — 浏览器 half：状态轮询持久化 + 开合/宽度恢复。
