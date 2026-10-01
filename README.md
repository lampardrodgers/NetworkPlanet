# 🌍 Network Planet

用 Three.js 3D 地球实时展示你遍布全球的 VPS：位置、在线状态、CPU/内存/网速、服务器之间的连接、延迟、丢包与带宽。

- **3D 地球**：离线生成的矢量世界地图（Natural Earth），带大气层光晕和星空；滚轮按「离地高度」缩放，可以一路放大到城市级别
- **同城多台自动聚合/展开**：比如洛杉矶有 5 台，远看是一个「洛杉矶 5」的聚合点；滚轮放大到城市级别、或者点一下聚合点，它们会以「蜘蛛腿」的方式在屏幕上散开，每台都能单独点选
- **实时状态**：Hub 定时对每台服务器做 TCP 探测（无需安装任何东西）；装上 Agent 后还能看到 CPU / 内存 / 磁盘 / 上下行网速，SSE 每 3 秒推送一次
- **互联连线**：大圆弧连线，颜色表示实测延迟，光点流动速度对应延迟、数量对应吞吐；没有实测时显示灰色虚线和按距离估算的延迟
- **延迟矩阵**：所有服务器两两之间的延迟热力表
- **手动增删改**：服务器、连接都可以在界面上加/改/删；支持按 IP 自动定位、在地球上点选位置、JSON/CSV 批量导入导出
- **供应商 API 导入**：Vultr、DigitalOcean、Linode/Akamai、Hetzner Cloud、搬瓦工 KiwiVM、通用 JSON URL；拉取后勾选导入，再次拉取会更新 IP/配置/状态

> 首次启动会自动载入一组**演示数据**（24 台、19 条连接，数据为模拟），方便你先看效果。在 ⚙ 设置 →「清除演示数据」一键删除。

---

## 快速开始

需要 Node.js ≥ 18.17。

```bash
cd network-planet
npm install

# 开发模式：同时启动 Hub(50000) 和 Vite(50001)
npm run dev
# 打开 http://localhost:50001

# 生产模式：构建前端，由 Hub 一个进程托管全部
npm run build
npm start
# 打开 http://localhost:50000
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `50000` | Hub 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_TOKEN` | 空 | 设置后，界面和 API 都需要这个口令（**部署到公网时务必设置**） |
| `NP_DATA_DIR` | `./data` | 数据目录（`db.json` 存服务器/连接/API Key） |
| `NP_DEMO` | `1` | 设为 `0` 时首次启动不灌入演示数据 |
| `NP_GEOIP` | 开 | 设为 `off` 禁用 IP 定位（ip-api.com）对外请求 |

---

## 使用说明

### 地球操作

| 操作 | 效果 |
| --- | --- |
| 拖拽 | 旋转地球（越贴近地表转得越慢，方便精确定位） |
| 滚轮 / 双指捏合 / 底栏 ＋－ | 缩放 |
| 双击地表 | 飞到该点并放大 |
| 点击聚合点（如「洛杉矶 5」） | 飞过去并展开同城的所有服务器 |
| 点击服务器 / 连线 | 右侧打开详情 |
| `Esc` | 取消选中 |
| `/` | 聚焦搜索框 |
| `n` | 添加服务器 |

底栏开关：自转、手动连接、实测网格（Agent 测出的全部两两延迟）、连线 ms 标签、服务器名称。

### 同城多台怎么看

1. 远看时同一城市（25km 内）的服务器聚合成一个点，徽标显示数量，红色 `n↓` 表示其中 n 台离线
2. 滚轮放大到大约「一个州」的范围，所有聚合点自动展开；或者直接点击聚合点
3. 展开后的间距按**屏幕像素**计算，任何缩放级别下都不会挤在一起；每台服务器之间的连线也会从各自的位置连出
4. 左侧列表按城市分组，点任意一台会飞过去并选中它

### 添加服务器（手动）

顶栏「＋ 服务器」。位置有四种填法，任选其一：

- 输入城市（中英文都行，下拉里有 100+ 个常见机房城市）
- 「按 IP 定位」：用 ip-api.com 根据 IP 查经纬度
- 「在地球上选点」：弹窗暂时隐藏，在地球上点一下
- 直接填经纬度

只填 IP 也能保存，后端会自动按 IP 定位。

### 通过供应商 API 导入

顶栏「☁ API 导入」→ 选择供应商、填 API Key →「保存并拉取」→ 勾选 →「导入 / 更新选中」。

| 供应商 | 需要的凭据 | 位置来源 |
| --- | --- | --- |
| Vultr | API Key | region 代码 |
| DigitalOcean | Personal Access Token（只读即可） | region slug |
| Linode / Akamai | Personal Access Token（Linodes 只读） | region |
| Hetzner Cloud | 项目 API Token（只读即可） | API 直接给经纬度 |
| 搬瓦工 KiwiVM | 每行一个 `VEID:API_KEY` | node_location_id |
| 通用 JSON URL | URL +（可选）Bearer Token | 数据里的 lat/lon 或 city |

- region 映射不到城市时会退回到按 IP 定位
- 再次「拉取」会标出已导入的实例；导入时更新 IP/配置/状态，但**保留你自己改过的名称、标签、备注和手动设置的位置**
- API Key 只存在 Hub 的 `data/db.json`（文件权限 600），前端只看到打码值。建议都用只读 Token

通用 JSON URL 的格式：

```json
[
  { "id": "la-1", "name": "LA-1", "ip": "1.2.3.4", "city": "Los Angeles", "provider": "dmit", "tags": ["cn2"] },
  { "name": "HK-1", "ip": "5.6.7.8", "lat": 22.32, "lon": 114.17, "specs": { "cpu": 2, "ramMB": 2048 } }
]
```

### 连接（连线）

- 顶栏「⇄ 连接」，或者在服务器详情里点「＋ 添加」
- 服务器详情的「实测延迟」列表里，每一行右侧的 `＋` 可以一键把实测链路保存成连接
- 连线颜色：<60ms 绿 / <150ms 黄绿 / <250ms 黄 / ≥250ms 红 / 灰色虚线 = 无实测（显示估算值）/ 红色虚线 = 中断

### 安装 Agent（获取 CPU / 网速 / 互联延迟）

只靠 Hub 的 TCP 探测，你能看到在线状态和 **Hub → 服务器** 的延迟。想看服务器**之间**的延迟和资源占用，需要在每台 VPS 上装 Agent：

1. 先在 ⚙ 设置里填好「Hub 公网地址」（VPS 要能访问到）
2. 打开某台服务器的详情 → 「Agent 安装」→ 复制命令，在该 VPS 上以 root 执行：

```bash
curl -fsSL https://你的hub/agent/install.sh | sudo NP_HUB=https://你的hub NP_ID=srv_xxx NP_TOKEN=xxxx bash
```

Agent 是一个纯 bash + curl 脚本（`agent/np-agent.sh`），以 systemd 服务 `np-agent` 运行：

- 每 10 秒上报 CPU / 内存 / 磁盘 / 网卡上下行速率 / 负载 / 运行时间
- 每 60 秒从 Hub 拿到其它服务器列表，逐个 `ping -c 4`，上报 RTT / 丢包 / 抖动 → 构成互联延迟矩阵
- 每台服务器有独立 Token，可在详情里重置

卸载：

```bash
sudo systemctl disable --now np-agent
sudo rm /etc/systemd/system/np-agent.service /usr/local/bin/np-agent.sh /etc/np-agent.env
```

### 导入 / 导出

顶栏 `⇅`：导出全部服务器 + 连接为 JSON（不含 Token 和 API Key）；导入支持 JSON 或 CSV：

```csv
name,ip,city,provider,tags,lat,lon
LA-1,1.2.3.4,Los Angeles,dmit,cn2|proxy,,
HK-1,5.6.7.8,,aliyun,,22.32,114.17
```

---

## 部署建议

```bash
npm ci && npm run build
ADMIN_TOKEN='一个长随机串' PORT=50000 NODE_ENV=production node server/index.js
```

- 前面套一层 Nginx/Caddy 做 HTTPS。SSE 需要关闭缓冲（Hub 已发送 `X-Accel-Buffering: no`）
- 备份 `data/db.json` 即可；里面含 API Key，注意别泄露
- 监控数据（历史曲线、实测延迟）只保存在内存中，重启后从零开始积累

## 目录结构

```
network-planet/
├── server/            Hub：零依赖 Node 后端
│   ├── index.js       HTTP 路由、SSE、静态托管
│   ├── store.js       data/db.json 持久化
│   ├── monitor.js     TCP 探测、Agent 数据、演示数据模拟
│   ├── providers/     各供应商 API 适配器
│   ├── regions.js     供应商 region → 城市坐标
│   ├── geoip.js       IP 定位
│   └── demo.js        演示数据
├── shared/cities.js   机房城市坐标表 + 距离/延迟估算（前后端共用）
├── src/               前端（Vite + Three.js，无框架）
│   ├── globe/         地球、标记、连线、标签避让
│   └── ui/            侧栏、详情、表单、弹窗
├── agent/             VPS 上运行的 Agent 与安装脚本
└── scripts/dev.js     开发模式同时启动前后端
```

## 常见问题

**服务器显示「未知」？** Hub 还没探测到（默认 15 秒一次），或者探测端口不对。在编辑里把「探测端口」改成该机器一定开放的端口（如 22 / 443）。显示「离线」说明 TCP 连接超时且没有 Agent 上报。

**连线是灰色虚线？** 两端都没有 Agent 实测数据，显示的是按大圆距离 × 1.6 绕行系数估算的延迟。

**地球放大后不够清晰？** 贴图分辨率 8192×4096；放大后海岸线和国界会切换为矢量线，始终清晰。

**能加别的供应商吗？** 可以，参考 `server/providers/vultr.js` 写一个 `{ id, name, fields, list(credentials) }` 模块，在 `providers/index.js` 注册，再在 `regions.js` 补上 region 映射。AWS/GCP 这类需要签名的 API 也可以用「通用 JSON URL」配合自己的导出脚本。
