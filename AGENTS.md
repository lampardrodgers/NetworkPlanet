# AGENTS.md

给在这个仓库里工作的 AI 编码助手看的说明。用户文档见 README.md。

## 项目概览

Network Planet：Three.js 3D 地球，实时展示用户的全球 VPS（位置、状态、互联延迟/带宽）。

- **Hub（`server/`）**：零第三方依赖的 Node ESM 服务（只用 `node:` 内置模块）。REST API + SSE 推送 + 生产模式下托管 `dist/`。
- **前端（`src/`）**：Vite + 原生 JS + Three.js，**不使用框架**。UI 用模板字符串拼 HTML + 事件委托。
- **Agent / 探针（`agent/`）**：纯 bash + curl，运行在用户的 Linux VPS 上。可选依赖只有 ping、iperf3，缺了要能降级。
- **共享（`shared/`）**：前后端都 import 的纯 JS（城市坐标表、距离/延迟估算）。

UI 文案、注释、文档统一用**简体中文**。

## 本地测量与新增节点（0.3.0）

- 涉及本地监控、延迟测试、线路识别、VLESS、frp 或 SSH 按需测量时，先读 [本地测量方案](docs/LOCAL_MONITORING_PLAN.md)。该文档列出实现、数据格式与实测限制。
- 用户要求新增、导入、配置 VPS / 中转 / VLESS / frp 节点时，无论改动位于哪个目录，都必须先读并遵循 [节点接入流程](docs/node-onboarding/AGENTS.md)。不要依赖嵌套 AGENTS.md 的目录作用域自动加载。
- 新模式只在用户指定的本地电脑运行。VPS 不要求安装常驻 np-agent；远程测量由本地程序通过 SSH 执行有界命令，完成后退出。
- 延迟测试默认手动。线路分析有独立开关，初始关闭。打开线路分析不启动自动任务。只有用户明确开启自动测试并设置周期后，程序才按周期运行；后续测量不依赖智能体。
- 新增节点不启动测试、不改变已有调度、不安装常驻探针。用户明确要求验证时才运行对应的一轮测试。读取接入配置所需的 SSH 连接不等同于延迟测试。
- 当前默认 `NP_MODE=local`，只监听回环地址；旧 Hub 自动 TCP、自动带宽和告警评估需要 `NP_MODE=legacy`。主机实际连通性必须与本地模拟测试区分。
- 本地测量代码位于 `server/local/`，界面位于 `src/ui/local.js`。`npm test` 使用本地测试服务和模拟 SSH，不访问用户 VPS。

## 常用命令

```bash
npm install
npm run dev      # Hub :50000 + Vite :50001（/api、/agent 代理到 Hub）
npm run build    # 构建到 dist/
npm start        # 生产模式，Hub 托管 dist/，访问 :50000
```

本地测量使用 Node 内置测试运行器（`npm test`）。改动后至少做到：

1. `npm run build` 无报错
2. 启动 Hub，`curl localhost:50000/api/state`、`/api/status` 正常
3. 改了 Agent：`bash -n agent/np-agent.sh agent/install.sh`。macOS 上跑不了整个 Agent（依赖 /proc），但可以把函数段 source 进来单独测 `apply_directives` / `run_batch` 等
4. 改了地球/UI：在浏览器里实际看一眼（页面暴露了 `window.np = { store, globe, markers, links, select }` 便于调试，例如 `np.globe.flyTo({lat:34.05, lon:-118.24, alt:0.15})`）

## 架构要点

### 数据流

```
供应商 API ──sync/import──┐
手动表单 / JSON 导入 ─────┼─> server/store.js (data/db.json)
Agent 自动注册 ───────────┘
Hub TCP 探测 ─────────────┐
Agent 上报（/api/agent/*）┴─> server/monitor.js（内存）──SSE status 每 3s──> 前端 store.status
                              ├─ traffic.js（db.traffic，saveLazy 低频落盘）
                              └─ alerts.js 每 15s 评估 ──SSE alert──> 前端 toast / 🔔
任何 CRUD ──SSE changed──> 前端重新 GET /api/state
带宽测试任务 ──SSE task──> 前端 store.tasks
```

- 持久化数据（服务器、连接、账号、设置、流量累计 `traffic`、带宽结果 `bandwidth`、告警事件 `events`）在 `db.json`；**高频运行时指标只在内存**（`monitor.js` 的 `status` / `peers` / `targetResults`），不要落盘。
- `db.settings` 的 `probe` / `targets` / `alerts` / `enroll` 一律经过 `server/config.js` 的 `normalize*` 清洗，启动加载时也会补齐默认值。新增配置项要在那里加默认值和校验。
- 前端 `src/state.js` 的 `store` 是唯一状态源，事件：`data`（结构变化）、`status`（指标刷新）、`select`、`view`。
- 连线 key 统一为排序后的 `"idA|idB"`（`pairKey`），选中连线时 `selection = { type: 'link', id: key }`。

### 坐标约定

- 地球半径 = 1，球心在原点，**地球不旋转，相机绕原点转**。`latLonToVec3` / `vec3ToLatLon` 在 `src/globe/Globe.js`，与 `SphereGeometry` 的 UV 对齐（u=0 对应经度 -180）。
- 「高度」= 相机到球心距离 − 1（`globe.altitude`），缩放是自己实现的指数缩放（OrbitControls 的 zoom 被关掉了）。

### 标记与同城展开（`src/globe/Markers.js`）

- 25km 内的服务器归为一个 site。site id = `site:<lat.2f>,<lon.2f>`（取第一台的坐标），需保持稳定，选中状态依赖它。
- 展开条件：`altitude < AUTO_EXPAND_ALT`，或该 site 被点击/其成员被选中。展开偏移以**像素**定义，每帧用 `globe.worldPerPixel()` 换算成世界坐标，所以任何缩放下都清晰。
- 标记尺寸同样按像素换算。拾取用**屏幕空间最近点**（`pick()`），不是射线检测。
- 连线端点读 `markers.positionOf(id)`，展开动画中会跟着移动。

### 标签（`src/globe/labels.js`）

- 所有 CSS2DObject 标签都要通过 `LabelManager.register({ obj, wanted, priority })` 注册，由它统一控制可见性和避让。节点注册 `required: true`，重叠时移位并加引导线，不隐藏；线路标签仍可用 `.np-hidden` 避让。
- `wanted()` 结果会被转成布尔值——CSS2DRenderer 只认 `visible === false`，返回 `null`/`undefined` 会导致标签无法隐藏。
- 修改标签 innerHTML 后要把 `el._size = null`，让避让重新测量尺寸。

### GPU 缓冲区

每帧更新的几何体（腿线、连线、光点）**必须原地写入预分配的缓冲区**，不要每帧 `setAttribute(new BufferAttribute)` 或 `LineGeometry.setPositions()`——旧的 GL buffer 不会被释放，会泄漏显存。参考 `Links.rebuildArc()` 和 `Markers.update()` 里腿线的写法。

### 平面视图与线路模式（`src/flat/FlatMap.js`、`src/routes.js`、`src/ui/routes.js`）
- `store.view.mode`：`globe` / `flat` / `route`。平面时 `globe.setPaused(true)` 停掉 3D 渲染，`FlatMap.setActive(true)` 启动自己的 rAF 循环。
- FlatMap 用等距圆柱投影，视图是 `{ lon, lat, k(px/度) }`。服务器画在离视图中心最近的那一份世界上（`unwrap`），弧线终点按「走近路」换份，画的时候再加左右两份副本（`copies`）。
- 陆地掩膜来自 countries-50m（4096×2048，首次进入平面时生成）。点阵底图缓存在离屏 canvas，`dirty` 时才重画（视角 / 数据变化，晨昏线每分钟一次）。
- 默认 `fitWorld()` 显示整张世界地图（`worldK()` = 刚好放进面板之间的缩放，`kMin` = 它 × 0.85）；`balancedWorldLongitude()` 优先保持连线连续、给边缘标签留空间，再平衡节点左右分布。海上接缝和起点经度只作次要偏好；线路模式与锁定模式使用同一规则，不强制起点居中。
- 锁定模式（`store.view.flatLocked` → `setLocked`）：只有一份世界（`worldCenter` ± 180°），仍可缩放拖动，由 `clampView` 把左右边缘限制在面板之间的可视区域外，`kMin` = `worldK()`；`unwrap` 以 `worldCenter` 为准，连线和节点裁剪在 `worldX()` 这一份世界里，`flyTo` 不走「经度近路」。
- 节点聚合同时受屏幕距离（`CLUSTER_PX`）与 25km 地理范围约束，不跨国家合并。标签显示所有成员城市，不能用第一台的城市代表其他地点；选中的、`expanded` 的，或已到最大缩放的簇会环形展开。标签和连线胶囊统一按优先级贪心避让（`drawLabels`）。
- 线路模式下 `setRouteView({ origin, segments, info })` 取代普通连线。线段的 `a` 可以是 `'@origin'`，`dests` 记录经过它的终点（用于高亮），`hit` 让点击线段时选中终点。
- 后端：`db.routes` `[{ id, from: 'local'|'srv:<id>'|'tgt:<id>', to, via[], label, hopLabels[] }]`，接口是 `POST/PUT/DELETE /api/routes`，同一个起点和终点只保留一条。本机位置存在 `settings.origin`，由 `normalizeOrigin` 清洗。

### Hub 安装（`scripts/install-hub.sh`、`scripts/deploy.sh`）
- `install-hub.sh` 装到 `/opt/network-planet`，数据 `/var/lib/network-planet`，配置 `/etc/network-planet.env`（首次随机生成 ADMIN_TOKEN，并通过 API 写入 `publicUrl`），systemd 服务 `network-planet`。只依赖 Node 内置模块，所以代码包里不需要 node_modules，但必须带构建好的 `dist/`。
- Hub 自己提供 `/hub/install.sh`（把脚本里的 `__NP_SRC__` 换成 `<publicUrl 或 Host>/hub/bundle.tar.gz`）和 `/hub/bundle.tar.gz`（`tar` 现场打包 `BUNDLE_FILES`，**不含 data/**）。新增运行时需要的目录要加进 `BUNDLE_FILES` 和 `deploy.sh` 的 tar 列表。

## 常见改动指南

### 新增供应商

1. `server/providers/<id>.js`：导出 `{ id, name, docs, fields, list(credentials) }`。`list` 返回数组，元素字段：`providerId`（必需，稳定唯一）、`name`、`ip`、`region`、`status`、`os`、`specs { cpu, ramMB, diskGB, trafficTB, plan }`，能拿到坐标就给 `lat/lon/city/country`。
2. 在 `server/providers/index.js` 注册。
3. 在 `server/regions.js` 的 `REGION_MAP` 补 region → 城市 key；城市不在 `shared/cities.js` 就先加进去（key 不要改动已有的）。
4. 分页要拉全；HTTP 请求统一用 `providers/http.js` 的 `getJson`（自带超时和错误信息提取）。
5. `fields` 里 `secret: true` 的字段在前端只显示打码值；`PUT /api/accounts/:id` 会忽略含 `••••` 的值。

### 新增 API

在 `server/index.js` 用 `route(method, pattern, handler, { admin })` 注册。默认需要 `ADMIN_TOKEN`；Agent 端点用 `{ admin: false }` 并调用 `agentAuth()`。handler 返回对象即 JSON 响应，抛 `HttpError(status, msg)` 返回错误。修改了持久化数据要 `save()` 并 `changed('<what>')` 通知前端。

### Agent / 探针

- 目标环境是各种 Linux 发行版的最小安装：只能依赖 bash、coreutils、awk、sed、curl、ip；ping、iperf3 是可选的。
- 上报 JSON 用 printf 手拼，新增字段注意数字字段为空时输出 `null`，字符串用 `jstr` 转义。
- Hub 端在 `monitor.js` 的 `ingestAgent()` 里白名单式读取字段，新增字段两边都要改。
- 改了 Agent 行为要同时改 `VERSION`，前端靠它提示「需升级」。
- `src/ui/probe.js` 的 `aiDeployPrompt()` 生成「交给 AI 助手批量安装」的任务说明，`docs/AI_INSTALL.md` 里有同样内容的模板；改了安装方式 / 依赖 / 成功输出（`install.sh` 的 `say` 文案）要两处一起改。手动安装流程在 README「安装部署（手动）」。

**协议**（都用每台机器自己的 `agentToken`，请求头 `X-NP-Token`）：

| 端点 | 说明 |
| --- | --- |
| `POST /api/agent/register` | 用注册密钥（`settings.enroll.key`）换 id / token。先按 machine-id、再按 IP 认领已有服务器，否则新建。返回纯文本 `NP_ID=… NP_TOKEN=…` |
| `POST /api/agent/report` | 上报指标；响应是**纯文本配置**（`server/index.js` 的 `agentDirectives()`），首行 `v <hash>`，Agent 带 `cfgv` 回来，没变就只回 `same` |
| `GET /api/agent/poll` | 长轮询（45s），Hub 有指令时立即返回：`refresh` / `task <id> iperf-server|iperf-client|stop …`（见 `server/agentbus.js` 顶部注释） |
| `POST /api/agent/task` | 回报任务进度，body `{ id: 服务器id, task: 任务id, state: ready|done|error, … }`（注意 `id` 是服务器 id，供认证用） |

配置文本格式：`cfg <key> <value>`、`peer <id> <host> <port>`、`target <id> <icmp|tcp|http> <host> <port>`。

**安全底线**：Hub → Agent 只能是上面这几种固定格式，Agent 侧 `apply_directives` / `poll_loop` 对每个参数做正则白名单（`is_num` / `is_host` / `is_id`），**绝不 eval / source Hub 返回的内容**，也不要加「远程执行命令」之类的功能。Hub 侧所有主机名用 `config.js` 的 `safeHost()` 过滤后才下发。

### 流量周期与历史（`server/traffic.js`、`server/history.js`、`shared/cycle.js`）

- **历史桶**（history.js）：每台机器两级桶 m5（5 分钟，保留 8 天）、h1（1 小时，保留 400 天），存「和 + 次数」，查询时才求平均；流量存字节增量，`recordTraffic(t0, t1, …)` 按时长比例分摊到经过的桶。落盘在 `data/history/<id>.json`（列式，`COLS` 新增字段只能往后加），每 5 分钟一次 + 退出时。演示服务器的历史是 `synthDemoHistory()` 生成的，只在内存。
- **周期**：`server.trafficCycle`（`config.js` 的 `normalizeCycle`，null = 跟随全局「每月 resetDay 号 0 点（Hub 时区）」）。周期边界只用 `shared/cycle.js` 的 `cycleAt()` 算，前端表单预览也用它，两边不要各写一份。
- **本周期用量**：`db.traffic[id]` 精确累加 + `offsets[周期起点]`（手动校准）。周期起点一变（自然到期或用户改了设置）就用 `sumTraffic()` 从历史桶重新汇总，不清零。历史周期列表（`/cycles`）全部从历史桶汇总。
- 接口：`GET /api/servers/:id/metrics?from&to&step&tz`（step 300 / 3600 / 86400；按天汇总时用 tz 切日）、`GET /api/servers/:id/cycles?n=12`。
- 前端图表在 `src/ui/chart.js`（canvas，列式数据，null 断线，悬停提示），弹窗在 `src/ui/history.js`。

### 带宽测试（`server/agentbus.js`）

B 起 iperf3 服务端 → 回报 ready → A 跑客户端（正向 + `-R`）→ 回报结果 → 通知 B stop。同一时间只跑一个任务，其余排队；超时 `dur*2+60` 秒。结果存 `db.bandwidth["a|b"] = { a, b, up, down, ts }`，其中 up 是 a→b。前端用 `bandwidthBetween(x, y)` 统一换成 x 的视角。

### 告警（`server/alerts.js`）

规则在 `evaluate()` 里，每条返回 `{ hit, holdMs, text }`；状态机按「持续 holdMs 才触发 / 条件消失即恢复」。新增规则：`config.js` 的 `ALERT_DEFAULTS` + `normalizeAlerts` 加配置，`alerts.js` 加 `RULE_NAMES` 和判断，`src/ui/settings.js` 的告警页加一行。演示服务器和 `alertsMuted` 的服务器跳过。

## 安全注意

- `data/db.json` 含供应商 API Key，写入时 mode 0600；**绝不**在任何 API 响应里返回明文 Key（用 `publicAccount()`）。
- `/api/export` 不导出 `agentToken` / `machineId`。
- 注册密钥只通过 `GET /api/enroll` 返回，`/api/state` 里的 settings 由 `publicSettings()` 去掉密钥并给 Telegram Token / Webhook URL 打码；`PUT /api/settings` 收到含 `••••` 的值会保留原值。
- Agent 端点比较 token 用 `timingSafeEqual`。
- 演示数据使用 RFC 5737 文档地址段 `203.0.113.0/24`，且 `demo: true` 的服务器不会被真实探测。
- 不要在前端引入任何把 API Key 直接发给供应商的代码——调用一律经过 Hub（也顺便解决 CORS）。

## 一次性设备脚本

实现与权限边界见 [设备测试](docs/DEVICE_TESTS.md)。禁止让脚本修改系统代理、路由、执行策略或持久化服务；网卡绑定/物理路由校验失败不得回退。任务令牌只能获取本轮固定脚本及上传本轮结果，设备结果不能覆盖后台主机结果。

## 完整配置备份与同步

- 功能与接口见 [加密备份与同步](docs/BACKUP_SYNC.md)。完整迁移必须用 `/api/backups/*`，不能用普通 JSON 代替凭据迁移。
- 沿用稳定节点 ID；不按相同 IP 合并 frp 后端。先预览，再按用户选择合并或覆盖。导入不自动测试，自动调度保持关闭。
- 私钥仅从节点明确引用的路径读取，导入路径由服务端生成；凭据通过 `server/local/secrets.js` 读取，不假定只有 `local-secrets.json`。
- 不复制浏览器身份、登录令牌、物理网卡和原设备位置。原主机历史必须保留来源，不能冒充新主机结果。
