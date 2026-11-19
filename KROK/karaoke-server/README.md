# K 歌排行榜的腾讯云宝塔部署指南

服务提供在线曲库、逐曲排行榜和双人对战。服务端根据音高采样重算分数，同一首歌每位歌手保留最高成绩，同分先达成者优先。SQLite 数据库由服务自动创建。

访问链路为 **Rokid 应用 → HTTPS 域名 → 宝塔 Nginx → 127.0.0.1:3100 → SQLite**。下文用 `karaoke-api.example.com` 作示例，部署时换成自己的域名。

## 1. 配置域名和端口

1. 在腾讯云实例详情复制**公网 IPv4**。在域名当前使用的 DNS 服务商添加 A 记录。使用 DNSPod 时，进入「权威解析」，点开主域名并添加记录。主机记录填 `karaoke-api`，类型选 `A`，线路选「默认」，记录值填公网 IPv4。 [腾讯云 A 记录说明](https://intl.cloud.tencent.com/zh/document/product/1295/76974?lang=zh)
2. 放通入站 TCP `80`、`443`。轻量应用服务器在实例的「防火墙」配置，CVM 在实例关联的「安全组 → 入站规则」配置。宝塔「安全」如果启用了主机防火墙，也检查这两个端口。API 的 `3100` 只监听 `127.0.0.1`，供 Nginx 本机连接。 [轻量应用服务器防火墙](https://cloud.tencent.com/document/product/1207/44577/) · [CVM 安全组](https://cloud.tencent.com/document/faq/213/43698)
3. 腾讯云中国大陆地域对外开通前，按腾讯云流程完成适用的 ICP 备案或接入备案。备案期间可以先做服务器内的本机自测。 [腾讯云备案指引](https://cloud.tencent.com/document/product/243/39038)
4. 在电脑终端运行 `nslookup karaoke-api.example.com`，核对解析结果是否为该公网 IP。

## 2. 安装组件和上传代码

1. 在宝塔「软件商店」安装 Nginx（已安装可跳过）和「Node.js 版本管理器」。在版本管理器安装 **Node.js 24.x LTS**。后端使用 Node 自带的 `node:sqlite`，WebSocket 依赖由锁文件固定。 [宝塔 Node 项目部署](https://docs.bt.cn/practical-tutorials/nextjs-deployment/) · [Node.js 版本](https://nodejs.org/en/about/previous-releases) · [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
2. 在宝塔「终端」或 SSH 执行下列 Linux 命令。已用 root 登录时省略 `sudo`。运行身份按宝塔默认的 `www` 写。
   
   ```bash
   sudo install -d -m 0755 /www/karaoke-api
   sudo install -d -o www -g www -m 0750 /www/karaoke-api/data
   sudo install -d -o www -g www -m 0755 /www/karaoke-api/media/songs
   ```

3. 在宝塔「文件」打开 `/www/karaoke-api`，上传并解压新的 `karaoke-api-deploy.zip`。确认 `server.js`、两份曲库 JSON 和 `source/` 直接位于此目录。
4. 在「网站 → Node 项目」把命令行 Node 版本设为刚装好的 24.x。重新打开终端，用下面三条命令检查版本和文件。
   
   ```bash
   node --version
   node -e "require('node:sqlite'); console.log('SQLite OK')"
   ls -l /www/karaoke-api/server.js /www/karaoke-api/package.json
   cd /www/karaoke-api
   npm ci --omit=dev
   ```

## 3. 在宝塔启动 Node 项目

进入「网站 → Node 项目 → 添加 Node 项目」。有启动脚本的界面选择 `start`。使用「通用项目」时填写启动文件。 [宝塔创建 Node 项目](https://docs.bt.cn/practical-tutorials/nextjs-deployment/) · [宝塔 Node 项目字段](https://docs.bt.cn/ai-ops/mcp/tools-reference/)

| 字段 | 填写 |
| --- | --- |
| 项目名称 | `karaoke_api` |
| 项目目录 | `/www/karaoke-api` |
| 启动脚本 | `start`。如果要求填命令，填写 `node server.js` |
| 启动文件（通用项目） | `/www/karaoke-api/server.js` |
| Node 版本 | 已安装的 24.x |
| 项目端口 | `3100` |
| 运行用户 | `www` |
| 开机启动 | 开启 |
| 实例数（有此项时） | 1 |
| 安装依赖（有此项时） | 已执行 `npm ci` 可关闭 |
| 域名与外网映射 | 留空，下一步用独立站点做反代 |
| 放行项目端口（有此项时） | 关闭 |

添加后在项目列表点「启动」，然后在服务器终端检查监听端口和接口。

```bash
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS 'http://127.0.0.1:3100/api/leaderboard?songId=morning-light'
ss -ltn | grep ':3100'
```

依次应看到 `{"ok":true}`、首次运行的 `{"list":[],"myRank":null}` 和 `127.0.0.1:3100` 监听。数据库默认在 `/www/karaoke-api/data/karaoke.sqlite`。

## 4. 配置反向代理和 SSL

1. 在宝塔「网站 → 反向代理」添加反代站点。填自己的完整子域名，代理路径 `/`，目标 URL `http://127.0.0.1:3100`，发送域名保留默认值，缓存关闭。较旧界面可创建同域名的纯静态站点，再进入「站点设置 → 反向代理 → 添加反向代理」。按所用版本选其中一个入口。 [宝塔反向代理指南](https://docs.bt.cn/user-guide/site/php/site-config/reverse-proxy)
2. 检查代理把 `X-Real-IP` 设置为 `$remote_addr`。服务用它做请求限流。需要手工配置时，在对应域名的现有代理 `location /` 内检查以下指令，每项保留一份。
   
   ```nginx
   proxy_pass http://127.0.0.1:3100;
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header Authorization $http_authorization;
   proxy_read_timeout 60s;
   proxy_cache off;
   client_max_body_size 64k;
   ```

3. 在同一站点启用 WebSocket 转发。手工配置时，将下面的 `location` 放在对应站点的 `server` 内，和 `location /` 同级。已有精确匹配 `/ws` 时，保留一份配置。 [Nginx WebSocket 反向代理](https://nginx.org/en/docs/http/websocket.html)

   ```nginx
   location = /ws {
       proxy_pass http://127.0.0.1:3100;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 60s;
   }
   ```

4. 在该站点的「SSL」中申请 Let's Encrypt 证书或部署已有证书。HTTP 验证要求 DNS 已指向服务器且 80 端口可访问。反代影响文件验证时，可按面板提示使用 DNS 验证。启用证书后打开「强制 HTTPS」。 [宝塔 SSL 部署](https://docs.bt.cn/getting-started/deploy-ssl/) · [宝塔站点 SSL 设置](https://docs.bt.cn/user-guide/site/php/site-config/ssl/)
5. 在**自己的电脑**运行下面两条命令。Windows PowerShell 可使用 `curl.exe`。
   
   ```bash
   curl -fsS 'https://karaoke-api.example.com/healthz'
   curl -fsS 'https://karaoke-api.example.com/api/leaderboard?songId=morning-light'
   ```

## 5. 连接 Rokid 应用并验收

在项目根目录用自己的 HTTPS 根地址重打包，生成 `Karaoke.aix`。

```bash
node tools/pack-karaoke.cjs --api https://karaoke-api.example.com
```

本机联调用 `node tools/pack-karaoke.cjs --local`，生成连接 `127.0.0.1:3100` 的 `Karaoke-Studio.aix`。独立单机包可用 `--offline` 生成。Studio 中重新上传新包。线上发布前在 AIUI 开发者后台报备请求域名。 [AIUI 网络使用说明](https://open.rokid.com/aiui/guide/basic/network/usage?lang=zh-CN&version=0.19.0)

使用 Rokid 账号绑定时在 AIUI Studio 配置「Rokid 账号信息」权限，并在宝塔 Node 项目环境变量设置 `ROKID_DEVELOPER_SK`。无 SK 或未授权时应用可使用匿名歌手。新版要求官方校验通过才新增账号绑定，旧库未经验证的绑定数据单独保留。 [Rokid 授权说明](https://open.rokid.com/aiui/guide/account/authorization?lang=zh-CN&version=0.19.0)

1. 在 Studio 效果预览或眼镜打开 K 歌，进入「排行榜」。应看到「服务器排行榜」，首次运行显示「暂无成绩」。
2. 在支持音频的全屏页面唱完整首《晨光小路》，在结果页选「提交成绩」。上传成功应显示「成绩已上传排行榜」。
3. 返回排行榜，核对分数和「我的第 N 名」。再用另一台设备或独立安装提交，验证两位歌手能看到同一张榜。再次提交较低分时，榜单保留该歌手最高分。
4. Studio 若只能做无声练习，可用它验证榜单读取。实际演唱与上传在音频可用的全屏环境复测。

服务器暂时不可达时，结果页显示「已存本机 · 联网后补传」。应用会持久保存完整采样，恢复联网或重新打开应用后补传，最多保存 20 次待上传演唱。匿名歌手清除应用存储后会获得新身份。历史榜单记录保留在 SQLite，新榜单显示服务器根据采样计算的成绩。服务端可检查采样结构和重算分数，采样仍由客户端提供。

当前计分版本为 **2**：音高采样独立于绘图，每 40ms 记录一次，包括静音标记。有效谱面时段采样完整度不足 95% 时要求重唱；静音仍扣除演唱覆盖率。客户端 AIX 与服务端曲库需要同时更新，旧版成绩保留在本地与数据库，排行榜按当前曲目和计分版本查询。

## 6. API 与排查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 检查服务和数据库 |
| POST | `/api/players` | 领取匿名歌手 token |
| POST | `/api/scores` | 带 Bearer token 提交成绩 |
| GET | `/api/leaderboard?songId=morning-light` | 查询前 50 名，带 token 时附带个人名次 |

`POST /api/scores` 上传 `attemptId`、`songId`、`chartVersion`、`scoringVersion`、`completed` 和完整 `samples`。每个采样为 `[40ms 格子编号, MIDI 音高或 null]`，以格子中心时刻匹配谱面。应用和服务器使用相同的曲目及评分版本。客户端上传音高采样，服务端重新计算分数。

不能只发送几个准音采样点作为完整演唱，否则返回 `422 INSUFFICIENT_SAMPLES`。下方演练使用谱面生成完整测试数据，只用于检查测试库接口。

### 用测试库演练写入

如果 Studio 的音频还没跑通，可以先从宝塔终端执行下面这段命令。它会开启一个临时端口和数据库，创建一条测试成绩、查榜，然后关闭测试进程。

```bash
(
  set -eu
  cd /www/karaoke-api
  trial=$(mktemp -d)
  PORT=0 KARAOKE_DB="$trial/scores.sqlite" node server.js >"$trial/server.log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  for step in 1 2 3 4 5; do
    base=$(sed -n 's/^Karaoke API listening on //p' "$trial/server.log")
    if [ -n "$base" ]; then break; fi
    sleep 1
  done
  if [ -z "$base" ]; then cat "$trial/server.log"; exit 1; fi
  token=$(curl -fsS -X POST "$base/api/players" | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).token')
  payload=$(curl -fsS "$base/api/songs/morning-light" | node -e '
    const { song } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const samples = Array.from({ length: Math.ceil(song.durationMs / 40) }, (_, i) => {
      const timeMs = i * 40 + 20;
      const note = song.refNotes.find(n => n.startMs <= timeMs && timeMs < n.endMs);
      return [i, note ? note.midi : null];
    });
    process.stdout.write(JSON.stringify({ attemptId: "sample-0001", songId: song.id,
      chartVersion: song.chartVersion, scoringVersion: song.scoringVersion, completed: true, samples }));
  ')
  curl -fsS -X POST "$base/api/scores" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d "$payload"
  echo
  curl -fsS "$base/api/leaderboard?songId=morning-light" -H "Authorization: Bearer $token"
  echo
)
```

预期先看到 `{"ok":true,"duplicate":false}`，再看到一条 100 分的测试成绩及 `"myRank":1`。

### 常见问题

| 症状 | 检查 |
| --- | --- |
| 启动后立即停止 | 看 Node 项目日志。`node:sqlite` 报错时查项目 Node 版本。`SQLITE_CANTOPEN` 时查 `data` 所有者与运行用户。`EADDRINUSE` 时查 `3100` 是否被占用 |
| 本机 `/healthz` 正常，公网返回 502 | 查反代目标地址和 Nginx 错误日志 |
| 域名访问超时或证书失败 | 查 DNS、腾讯云入站规则、宝塔防火墙和 SSL |
| 公网接口正常，Studio 仍显示本机成绩 | 检查是否导入了最新文件、是否配置 HTTPS 域名，查看 Studio Console，并核对发布环境的域名报备 |
| 提交返回 409 | `VERSION_MISMATCH` 表示应用和服务器版本不一致。`ATTEMPT_CONFLICT` 表示同一演唱编号对应了不同成绩 |
| 提交返回 422 | `INSUFFICIENT_SAMPLES` 表示谱面时段采样完整度不足 95%，请在音频可用的环境重唱 |
| 提交返回 429 | 等待 `Retry-After` 指定的秒数后重试 |

联机客户端每 10 秒发送心跳，无回应达到 30 秒后结束连接；服务端定期清理超过 35 秒未发消息的连接。发送积压超过 64KB 时跳过实时进度，关键消息无法发送时断开并取消本轮，避免用户一直等待结算。

更新前备份 `data`。上传新的部署包，运行 `npm ci --omit=dev`，然后在宝塔重启项目。备份可用 SQLite 的 `VACUUM INTO` 对运行中的数据库生成独立文件。

```bash
cd /www/karaoke-api
sudo install -d -m 0700 /www/karaoke-backups
sudo "$(command -v node)" -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("data/karaoke.sqlite", { timeout: 5000 }); db.prepare("VACUUM INTO ?").run("/www/karaoke-backups/karaoke-" + Date.now() + ".sqlite"); db.close()'
```
