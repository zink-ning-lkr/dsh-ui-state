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

## 兼容性

目标 **DSH 0.1.0-rc.8**（`dsh` CLI / profile 装配线 rc.8 时代）。0.2.0 已对 rc.8
组合逐项核对，本插件用到的官方契约全部原样保留：

- **settings 接缝**：`@deepseek-ai/dsh-settings@^0.1.0-rc.8`，`register / describe /
  mutate`（含 `SettingsConflictError` 冲突拒绝与 revision 乐观锁）不变。
- **webServer 路由**：`register({ kind: "exact", path, handler })` 签名不变。
- **layout 服务**：`ctx.layout.toggleSidebar() / openDetails() / closeDetails()`
  与 AppFrame 的 `data-sidebar-collapsed` / `data-details-collapsed` /
  `grid-template-columns` 契约不变；拖拽手柄 `[data-side="sidebar"]`（展开时才渲染）、
  窄屏 1024px 自动折叠同样保留。
- **DOM 锚点**：`[data-shell-overlay]`（AppFrame 直接子节点）、`[data-chat-flow]`、
  `[data-chat-anchor-key]`、`[data-conversation-scroll]`、`[data-composer-seat]`
  在官方会话视图原样保留（官方自身滚动恢复同用这套锚点）。
- **client 通道**：`window.__ModuleLoader__.load` 包格式、`sessions.list.getSnapshot()
  .current`、`connection.isLoopback` 探针均不变。
- 兼容性核对中发现 `dsh-settings` 的 rc.6 与 rc.8 各 JS 文件字节一致，因此旧 rc.6
  宿主同样可用；依赖线仍升级到 `^0.1.0-rc.8` 以对齐 rc.8 生态并防未来漂移。

## 安装 / 下载

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @zink-ning-lkr/dsh-ui-state
```

也可以手动安装依赖并装配：

```bash
npm install @zink-ning-lkr/dsh-ui-state
```

然后在 profile 的 `package.json` 中把 `@zink-ning-lkr/dsh-ui-state` 加入 `dsh.profile.bundles`。

### 从 GitHub Release 下载

到 [Releases](https://github.com/zink-ning-lkr/dsh-ui-state/releases) 下载
`dsh-ui-state-0.2.0.tgz`，然后安装：

```bash
dsh plugin --profile web add ./dsh-ui-state-0.2.0.tgz
```

### 本地开发 / 热装

profile `package.json` 的 `dsh.profile.bundles` 加入 `@zink-ning-lkr/dsh-ui-state`，依赖用 `link:` 指向本目录；
或使用 dev_install_package 热装（junction + loader.create，免重启）。

## License

[MIT](LICENSE) © zink-ning (zink_ning)

## 关联

better-sidebar 等插件把状态存浏览器 localStorage——localStorage 按「域名+端口」隔离，
DSH 启动端口随机（--port 0）时每次重启都会丢失。配套修复：DSH Desktop 源码
（`D:\Code\dsh-desktop\main.js`）已支持从 config.json 读 `port` 字段，把
`%APPDATA%\DSH Desktop\config.json` 的 `"port"` 固定为 13372 后，localStorage 状态
（含 better-sidebar 的面板布局）跨重启稳定。

## 结构

- `lib/index.js` — Node half：注册 `ui-state` settings namespace + loopback 桥接路由。
- `lib/client.js` — 浏览器 half：状态轮询持久化 + 开合/宽度恢复。
