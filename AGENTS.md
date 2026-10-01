# AGENTS.md

给在这个仓库里工作的 AI 编码助手看的说明。用户文档见 README.md。

## 项目概览

Network Planet：Three.js 3D 地球，实时展示用户的全球 VPS（位置、状态、互联延迟/带宽）。

- **Hub（`server/`）**：零第三方依赖的 Node ESM 服务（只用 `node:` 内置模块）。REST API + SSE 推送 + 生产模式下托管 `dist/`。
- **前端（`src/`）**：Vite + 原生 JS + Three.js，**不使用框架**。UI 用模板字符串拼 HTML + 事件委托。
- **Agent（`agent/`）**：纯 bash + curl，运行在用户的 Linux VPS 上，不能引入其它依赖。
- **共享（`shared/`）**：前后端都 import 的纯 JS（城市坐标表、距离/延迟估算）。

UI 文案、注释、文档统一用**简体中文**。

## 常用命令

```bash
npm install
npm run dev      # Hub :50000 + Vite :50001（/api、/agent 代理到 Hub）
npm run build    # 构建到 dist/
npm start        # 生产模式，Hub 托管 dist/，访问 :50000
```

没有单元测试框架。改动后至少做到：

1. `npm run build` 无报错
2. 启动 Hub，`curl localhost:50000/api/state`、`/api/status` 正常
3. 改了 Agent：`bash -n agent/np-agent.sh agent/install.sh`
4. 改了地球/UI：在浏览器里实际看一眼（页面暴露了 `window.np = { store, globe, markers, links, select }` 便于调试，例如 `np.globe.flyTo({lat:34.05, lon:-118.24, alt:0.15})`）

## 架构要点

### 数据流

```
供应商 API ──sync/import──┐
手动表单 / JSON 导入 ─────┼─> server/store.js (data/db.json)
                          │
Hub TCP 探测 ─────────────┤
Agent 上报（/api/agent/*）┴─> server/monitor.js（内存）──SSE status 每 3s──> 前端 store.status
任何 CRUD ──SSE changed──> 前端重新 GET /api/state
```

- 持久化数据（服务器、连接、账号、设置）在 `db.json`；**运行时指标只在内存**（`monitor.js` 的 `status` / `peers`），不要落盘。
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

- 所有 CSS2DObject 标签都要通过 `LabelManager.register({ obj, wanted, priority })` 注册，由它统一控制可见性和避让（重叠则加 `.np-hidden`）。
- `wanted()` 结果会被转成布尔值——CSS2DRenderer 只认 `visible === false`，返回 `null`/`undefined` 会导致标签无法隐藏。
- 修改标签 innerHTML 后要把 `el._size = null`，让避让重新测量尺寸。

### GPU 缓冲区

每帧更新的几何体（腿线、连线、光点）**必须原地写入预分配的缓冲区**，不要每帧 `setAttribute(new BufferAttribute)` 或 `LineGeometry.setPositions()`——旧的 GL buffer 不会被释放，会泄漏显存。参考 `Links.rebuildArc()` 和 `Markers.update()` 里腿线的写法。

## 常见改动指南

### 新增供应商

1. `server/providers/<id>.js`：导出 `{ id, name, docs, fields, list(credentials) }`。`list` 返回数组，元素字段：`providerId`（必需，稳定唯一）、`name`、`ip`、`region`、`status`、`os`、`specs { cpu, ramMB, diskGB, trafficTB, plan }`，能拿到坐标就给 `lat/lon/city/country`。
2. 在 `server/providers/index.js` 注册。
3. 在 `server/regions.js` 的 `REGION_MAP` 补 region → 城市 key；城市不在 `shared/cities.js` 就先加进去（key 不要改动已有的）。
4. 分页要拉全；HTTP 请求统一用 `providers/http.js` 的 `getJson`（自带超时和错误信息提取）。
5. `fields` 里 `secret: true` 的字段在前端只显示打码值；`PUT /api/accounts/:id` 会忽略含 `••••` 的值。

### 新增 API

在 `server/index.js` 用 `route(method, pattern, handler, { admin })` 注册。默认需要 `ADMIN_TOKEN`；Agent 端点用 `{ admin: false }` 并调用 `agentAuth()`。handler 返回对象即 JSON 响应，抛 `HttpError(status, msg)` 返回错误。修改了持久化数据要 `save()` 并 `changed('<what>')` 通知前端。

### Agent

- 目标环境是各种 Linux 发行版的最小安装：只能依赖 bash、coreutils、awk、sed、curl、ping、ip。
- 上报 JSON 用 printf 手拼，新增字段注意数字字段为空时输出 `null`。
- Hub 端在 `monitor.js` 的 `ingestAgent()` 里白名单式读取字段，新增字段两边都要改。

## 安全注意

- `data/db.json` 含供应商 API Key，写入时 mode 0600；**绝不**在任何 API 响应里返回明文 Key（用 `publicAccount()`）。
- `/api/export` 不导出 `agentToken`。
- 演示数据使用 RFC 5737 文档地址段 `203.0.113.0/24`，且 `demo: true` 的服务器不会被真实探测。
- 不要在前端引入任何把 API Key 直接发给供应商的代码——调用一律经过 Hub（也顺便解决 CORS）。
