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

1. **检测（事件驱动）**：MutationObserver 监听 AppFrame 的 `data-sidebar-collapsed` /
   `data-details-collapsed` 属性与 `grid-template-columns`（style），ResizeObserver
   监听视口（窄屏判定）；变化防抖 600ms，聚合为**单次批量 mutate** 写入 settings.yaml。
   另保留 60s 安全兜底轮询，兜住观察者漏网的 DOM 替换 / portal 重渲染。
2. **恢复**：settings 就绪 / 框架挂载 / 会话流挂载等事件触发（600ms 重试链，最多 6 次，
   事件可重新武装）：
   - 侧边栏开合：调用官方 `ctx.layout.toggleSidebar()`（等 layout 服务挂载后自动重试）
   - 侧边栏宽度：找到 `[data-side="sidebar"]` 拖拽手柄，派发合成 pointer 序列（pointerdown/move/up，
     与官方 DragHandle 的监听协议一致；同步窗口内 stub pointer capture）
   - 详情面板：`ctx.layout.openDetails() / closeDetails()`（仅在会话打开时恢复）
3. **窄屏保护**：视口 < 1024px 时官方自动折叠侧边栏，此时不持久化、不恢复，避免与自动行为打架。
4. **卸载保护**：pagehide / freeze / 页面隐藏时同步落盘（fetch 带 keepalive），
   600ms 防抖窗口内关闭页面也不会丢最后一次操作。

## 性能

- **零空闲轮询**：状态读取由事件驱动，空闲时无周期任务；60s 安全兜底仅兜异常路径。
  相对旧版 400ms 轮询，空闲开销从 2.5 次 DOM 扫描/秒降为 0。
- **批量写入**：一次折叠/宽度/详情变更合并为 **1 次** mutate POST（旧版最多 3 次），
  revision 乐观锁只校验一次。
- **观察者收窄**：会话区变更只检查新增节点；滚动恢复按 （scrollport, session） 实例
  只执行一次，聊天流渲染期间不重复扫描。

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

已验证目标为 **DSH 0.1.1-rc.2**（npm 最新已装版本，本仓库按该版本构建逐 seam 核对：
`@deepseek-ai/dsh@0.1.1-rc.2` + `@deepseek-ai/cordis@4.0.1` + React 18.3 运行时），
同一 **0.1.x 版本线**的最低 **0.1.0-rc.8** 同样覆盖。依赖范围故意写成双线
`>=0.1.0-rc.8 <0.2.0 || >=0.1.1-rc.0`：npm 的 prerelease「同元组」规则使
`^0.1.0-rc.8` 并不包含 0.1.1-rc.2，双线范围可让宿主升级后 npm 去重为同一份
dsh-settings 实例（避免双实例导致的 `SettingsConflictError` instanceof 失效）。
实现基于能力探测与事件驱动，不绑定具体 rc 细节，跨版本漂移时以兜底分支降级。

已逐项核对的官方契约（0.1.1-rc.2 构建实测一致）：

- **settings 接缝**：`@deepseek-ai/dsh-settings`（双线范围，见上），`register / describe /
  mutate`（含 `SettingsConflictError` 冲突拒绝与 revision 乐观锁）不变。
- **webServer 路由**：`register({ kind: "exact", path, handler })` 签名不变，返回 disposer。
- **layout 服务**：`ctx.layout.toggleSidebar() / openDetails() / closeDetails()`
  与 AppFrame 的 `data-sidebar-collapsed` / `data-details-collapsed` /
  `grid-template-columns` 契约不变；拖拽手柄 `[data-side="sidebar"]`（展开时才渲染，
  pointer capture + rAF 节流，pointerup 同步落宽）、窄屏 1024px 自动折叠同样保留。
- **DOM 锚点**：`[data-shell-overlay]`（AppFrame 直接子节点）、`[data-chat-flow]`、
  `[data-chat-anchor-key]`、`[data-conversation-scroll]`、`[data-composer-seat]`
  在官方会话视图原样保留（官方自身滚动恢复同用这套锚点）。
- **client 通道**：`window.__ModuleLoader__.load` 包格式、插件清单
  `dsh.client.inject/platform`、`sessions.list.getSnapshot().current`、
  `connection.isLoopback` 探针、`ctx.layout` 面板动作均不变。

### 跨插件兼容与加固（0.3.1）

- **settings 写冲突自动重试**：另一插件抢先写同一 namespace 导致
  `settings-conflict` 时，客户端刷新 revision 后**重试一次**，不再静默丢最后一次操作。
- **存储容错**：schema 全字段 `.loose()`——settings.yaml 被手改/旧版本/其他插件写入
  越界或类型错误的值时，只把该字段降级为「未记录」，不会让整个 namespace 注册失败、
  桥接不可用；下一次正常写入会覆盖。
- **chatScroll 有界**：按 `updatedAt` 保留最近 200 条会话记录，长期使用 settings.yaml
  不会无限增长。
- **探测降级（官方 UI 升级耐性）**：`frameOf` 在 overlay 层级漂移时回退到按
  `data-sidebar-collapsed` / `data-details-collapsed` 直接找框架；会话判定用
  `[data-chat-flow]` 存在性探测。官方 DOM 小幅变更时限入降级，而不是报错。
- **宽度钳制**：恢复侧边栏宽度前先钳到官方契约 264–420px，历史/外来越界值不会把
  面板拖出可渲染范围。
- **热装/重载幂等**：settings 注册与其桥接路由挂在长期存活的 provider/webServer
  fiber 上，二次加载（`loader.create` 热装、HMR 重建）遇到上一实例残留的同名
  namespace / 同 path 路由时**复用而非抛错**，不会因 "already registered" 挂掉挂载。
- **共存原则**：命名空间 `ui-state` 与桥接路由 `/api/dsh-ui-state/*` 均为本插件独占
  （已核对官方与已知插件零冲突）；不补丁原生原型、不注入全局样式、不劫持事件，
  合成拖拽仅同步窗口内 stub pointer capture，与 better-sidebar 等 localStorage 方案
  以及 dsh-chat-width / dsh-client-ui-custom 等设置/样式/快捷键插件无交互冲突。

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
`dsh-ui-state-0.3.0.tgz`，然后安装：

```bash
dsh plugin --profile web add ./dsh-ui-state-0.3.0.tgz
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

- `lib/index.js` — Node half：注册 `ui-state` settings namespace + loopback 桥接路由
  （`makeBridgeHandlers` / `makeBridgeRoutes` / `namespaceSchema` 导出供测试）。
- `lib/client.js` — 浏览器 half：事件驱动的状态持久化 + 开合/宽度/滚动恢复。
- `tests/bridge.test.mjs` — 桥接单测 + cordis 挂载幂等测试（`node --test tests/bridge.test.mjs`）。
