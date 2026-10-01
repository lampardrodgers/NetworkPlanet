# 交给 AI 助手批量安装探针

机器多、不想一台台 ssh 登录时，可以把安装工作交给能执行 shell / ssh 的 AI 编码助手（Claude Code、Codex 等）：你给它一份任务说明和每台 VPS 的登录方式，它逐台检查、安装、验证，最后用表格汇报结果。

手动安装的完整流程见 [README → 安装部署](../README.md#安装部署手动)。无论手动还是交给 AI，安装都只是执行一条 curl：

| 装什么 | 命令 |
| --- | --- |
| 探针（每台 VPS） | `curl -fsSL https://你的hub/agent/install.sh \| sudo NP_HUB=https://你的hub NP_KEY=注册密钥 bash` |
| 再装一份 Hub | `curl -fsSL https://你的hub/hub/install.sh \| sudo bash` |
| 第一台 Hub | 在开发机的项目目录执行 `npm run deploy -- root@服务器IP`（这时还没有能下载代码包的地方） |

AI 助手做的事就是：登录每台机器 → 检查环境 → 执行这条命令 → 验证 → 汇报。下面以批量装探针为例，**Hub 要先部署好**。

---

## 准备

1. **Hub 已部署，且 VPS 能访问到**，并在 ⚙ 设置 →「通用」里填好了「Hub 公网地址」。
2. **运行 AI 助手的那台电脑能 ssh 到每台 VPS。**
3. **准备一把临时 ssh 密钥**（推荐，不要把 root 密码直接贴进对话）：

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/np_install -N '' -C np-install
   # 把公钥加到每台 VPS（会要求输入一次该机密码）
   ssh-copy-id -i ~/.ssh/np_install.pub -p 22 root@1.2.3.4
   ```

   装完后从各台 `~/.ssh/authorized_keys` 里删掉 `np-install` 这一行即可收回权限。

## 拿到任务说明

两种方式，内容相同：

- **推荐**：网页顶栏「⤓ 安装探针」→「🤖 复制给 AI 助手的部署说明」。复制出来的内容已经填好你的 Hub 地址和注册密钥（弹窗里填的 NP_NAME / NP_TAGS / NP_CITY 也会带上）。
- 或者复制下面的模板，自己把 `https://你的hub` 和 `注册密钥` 换掉（注册密钥在「⤓ 安装探针」弹窗的命令里）。

然后在末尾「VPS 列表」里写上每台的登录方式，整段发给 AI 助手。

## 任务说明模板

````markdown
# 任务：在我的 VPS 上安装 Network Planet 探针

你可以通过 ssh 登录我的 VPS。请在下面「VPS 列表」里的每一台上安装 Network Planet 探针（np-agent），装完逐台汇报结果。

## 安装命令（每台机器都一样）
```bash
curl -fsSL https://你的hub/agent/install.sh | sudo NP_HUB=https://你的hub NP_KEY=注册密钥 bash
```
- 必须以 root 执行（非 root 用户加 sudo）。
- 想给某台机器指定显示名 / 城市 / 标签，就在 `bash` 前面加 `NP_NAME=xxx`、`NP_CITY='Los Angeles'`、`NP_TAGS=cn2,proxy`（列表里有写才加，没写就不加，探针会按公网 IP 自动定位）。

## 每台机器的步骤
1. ssh 登录，执行 `uname -a; cat /etc/os-release | head -3; command -v systemctl curl`，确认是 Linux、有 systemd 和 curl。
   - 没有 curl：用系统包管理器装（apt-get / dnf / yum）。
   - 没有 systemd（如 Alpine / OpenRC）：**不要安装**，记为「不支持」，继续下一台。
2. 检查能否连到 Hub：`curl -sS -o /dev/null -w '%{http_code}\n' https://你的hub/agent/install.sh`，应输出 200。不是 200 时记下报错（多半是 Hub 地址不对或防火墙），跳过这台。
3. 执行上面的安装命令。输出里出现「已注册为 …」和「✅ np-agent … 已运行」就是成功。
4. 验证：`systemctl is-active np-agent` 应为 active；`journalctl -u np-agent -n 20 --no-pager` 里不应有反复报错。

## 规则
- 只做上面这些事：不要改 ssh 配置、防火墙、内核参数，不要升级系统，不要重启机器。安装脚本自己会尝试装 ping 和 iperf3，不需要你另装。
- 已经装过的机器重新执行同一条命令即可（会原地升级，不会重复注册）。
- 不要把注册密钥、密码、私钥写进任何文件或发到别处；汇报里不要出现它们。
- 某台失败就记下原因继续下一台，不要为了装上而做上面没提到的改动；拿不准的先问我。

## 完成后汇报
用表格列出每台：主机 / 系统 / 结果（成功、不支持、连不上 Hub、其它失败）/ 失败原因。

## VPS 列表
（在这里写每台的登录方式，例如：）
- 1.2.3.4 端口 22 用户 root，用私钥 ~/.ssh/id_ed25519 登录，NP_NAME=HK-01
- 5.6.7.8 端口 2222 用户 ubuntu（有 sudo），密码见我的密码管理器 / 我会单独发给你
````

### VPS 列表怎么写

每台一行，写清楚 **地址、端口、用户、认证方式**，需要的话加上 NP_NAME / NP_CITY / NP_TAGS：

```text
- 203.0.113.10 端口 22 用户 root，私钥 ~/.ssh/np_install，NP_NAME=LA-CN2-01 NP_TAGS=cn2
- 203.0.113.20 端口 2222 用户 debian（有 sudo），私钥 ~/.ssh/np_install
- hk.example.com 端口 22 用户 root，私钥 ~/.ssh/np_install，NP_CITY='Hong Kong'
```

如果你在 `~/.ssh/config` 里已经配好了 Host 别名，直接写别名即可（例如 `- hk-01（ssh hk-01 能直接登录）`）。

## 安全建议

- **用临时密钥，不要贴密码。** 对话内容可能被记录；密钥装完即可删除，密码泄露则要改密码。
- **任务说明里含注册密钥。** 全部装完后，在「⤓ 安装探针」弹窗里点「更换注册密钥」，或关闭「允许自动注册」；已安装的探针用的是各自的 token，不受影响。
- **让 AI 助手每一步都先给你看命令再执行**（多数助手都有需要确认的权限模式），尤其是第一台。
- 探针本身以 systemd 临时无特权用户运行，Hub 只能下发固定格式的配置和测速任务，**不能**在 VPS 上执行任意命令。

## 常见失败

| 汇报结果 | 原因 / 处理 |
| --- | --- |
| 连不上 Hub（非 200 / 超时） | Hub 公网地址填错、Hub 端口没放行、Hub 是 HTTPS 但证书无效。在这台 VPS 上 `curl -v https://你的hub/agent/install.sh` 看具体报错 |
| 不支持（无 systemd） | Alpine / OpenRC 等，暂不支持 |
| 注册失败（HTTP 401） | 注册密钥错误或已更换，重新复制任务说明 |
| 注册失败（HTTP 403） | 关闭了「允许自动注册」，在「⤓ 安装探针」弹窗里打开 |
| 注册失败（HTTP 400，无法确定位置） | 按 IP 定位失败，在列表里给这台加 `NP_CITY='城市英文名'` |
| 服务没有启动成功 | 让 AI 助手贴出 `journalctl -u np-agent -n 50 --no-pager` 的输出 |
| 装上了但地图上没数据 | 等十几秒；仍没有就看上一行的日志，多半还是 Hub 地址或防火墙问题 |
