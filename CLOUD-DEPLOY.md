# ELN 云服务器部署（2026-10-29 建立）

阿里云 ECS「Ubuntu-tuku」上跑的是 **v2 构建产物（dist）+ 同一个 Node 服务端**，nginx 在前面发静态文件并反代 `/api`。

## 访问

| 项 | 值 |
|---|---|
| 地址 | http://203.0.113.10/ |
| 认证 | **当前没有密码**（用户要求先不设，nginx 里的 `auth_basic` 已注释掉） |

**注意**：没有密码 = 任何拿到这个 IP 的人都能读、改、删全部实验记录和谱图，包括数据库导出的 zip。

要装回密码（一条命令）：

```bash
# 1) 设密码
ssh root@203.0.113.10 'htpasswd -cb /etc/nginx/.eln_htpasswd maple 你的密码'
# 2) 把 /etc/nginx/sites-available/eln 里那两行 auth_basic 的注释去掉
ssh root@203.0.113.10 'sed -i "s|^    # auth_basic|    auth_basic|" /etc/nginx/sites-available/eln && nginx -t && systemctl reload nginx'
```

旧的密码文件还在 `/etc/nginx/.eln_htpasswd`（用户 `maple`，原密码 `REDACTED`），注释掉配置后它没在生效。

## 机器与路径

- 服务器：`root@203.0.113.10`，密钥 `~/.ssh/eln.pem`（权限已改 600）
- 主机指纹记录在 `<本机路径>/.ssh_known_hosts`（沙箱不允许写 `~/.ssh/known_hosts`）
- 系统：Ubuntu 24.04.2 / 2 vCPU / 1.6 GiB / 40 GB，Node v22.23.4（NodeSource）、nginx 1.24.0

| 内容 | 服务器路径 | 权限 |
|---|---|---|
| 代码 + 前端产物 | `/opt/eln`（`server/`、`dist/`） | `root:eln`，只读 |
| 数据（库 + 附件） | `/var/lib/eln`（`eln.db`、`attachments/`、`compounds/`） | `eln:eln` 750 |
| systemd 单元 | `/etc/systemd/system/eln.service` | 用户 `eln`，无登录 shell |
| nginx 站点 | `/etc/nginx/sites-available/eln` → `sites-enabled/eln`（静态 `dist` + 反代 `/api`；**Basic Auth 当前已注释掉**；`/assets/` 走 `try_files $uri =404` 并加 30 天长缓存） | |
| Basic Auth 文件 | `/etc/nginx/.eln_htpasswd` | `root:www-data` 640 |

Node 只监听 `127.0.0.1:4780`，公网只有 nginx 的 80。服务端由 `ELN_DATA_DIR=/var/lib/eln` 指到数据盘位置，不污染代码目录。

## 主从关系（定了，别再反过来）

- **本机 `<本机路径>/Software/ELN/data/` 是主库**，服务器 `/var/lib/eln` 是**同步上去的副本**。
- 数据只往一个方向走：**本机 → 服务器（整份覆盖）**。不要在服务器上录数据再往回拉，那样两边一定会岔。
- 因此服务器上的任何「数据改动」（新建记录、改设置、删化合物）在下次同步时都会**被本机覆盖**。
- 有一个例外必须靠环境变量：**二维码里的地址**。设置页里的「瓶子标签的二维码地址」存在库里，同步会冲掉，所以服务器用 `ELN_LABEL_BASE_URL` 指定（优先级：URL 参数 > 环境变量 > 设置页 > 局域网地址）。

服务器 unit 里要加这一行（`systemctl daemon-reload && systemctl restart eln` 生效）：

```
ELN_LABEL_BASE_URL=http://203.0.113.10
```

```bash
$SSH 'sed -i "/^\[Service\]/a Environment=ELN_LABEL_BASE_URL=http://203.0.113.10" /etc/systemd/system/eln.service && systemctl daemon-reload && systemctl restart eln'
```

设好之后 `curl "$U/api/compounds/35/qr.svg"` 与 `curl "$U/api/compounds/35/qr.svg?base=http%3A%2F%2F203.0.113.10"` 结果要一致。

## 服务端关键环境变量（写在 unit 里）

```
ELN_DATA_DIR=/var/lib/eln
ELN_LABEL_BASE_URL=http://203.0.113.10   # 二维码里的地址，见上面「主从关系」
HOST=127.0.0.1
PORT=4780
NODE_OPTIONS=--disable-warning=ExperimentalWarning
```

systemd 开了 `ProtectSystem=strict` + `ReadWritePaths=/var/lib/eln`：进程只能写数据目录，`/opt/eln` 只读。

## 常用运维

```bash
ssh root@203.0.113.10

systemctl status eln            # 服务状态
journalctl -u eln -f            # 实时日志
systemctl restart eln           # 重启后端
nginx -t && systemctl reload nginx

# 备份数据（整包）
tar -czf /root/eln-data-$(date +%F).tar.gz -C /var/lib/eln .
```

## 更新部署（改了代码之后）

> 2026-10-29 晚改过：本机现在**只有一套前端**，`npm run build` 的产物直接写进 `public/`（不再有 `dist/`），本机 4780 就发这套。服务器上目录名仍是 `/opt/eln/dist`，推的时候把 `public/` 的内容灌进去即可。

在 Mac 上重新构建并推上去，`.cache` / `node_modules` / `data` 都不要传：

```bash
cd <本机路径>/Software/ELN
npm run build            # 产物在 public/（index.html + assets/）

KEY=~/.ssh/eln.pem
SSH="ssh -i $KEY -o UserKnownHostsFile=<本机路径>/.ssh_known_hosts root@203.0.113.10"

# 只同步前端产物 + 服务端代码
tar -C public -czf - . | $SSH 'rm -rf /opt/eln/dist && mkdir -p /opt/eln/dist && tar -xzf - -C /opt/eln/dist'
tar -C server -czf - . | $SSH 'tar -xzf - -C /opt/eln/server'

 # tar 会带上本地文件的 mode（server/*.js 在本机是 600），不补这一步服务会 EACCES 起不来
$SSH 'chown -R root:eln /opt/eln; chmod -R a+rX /opt/eln; systemctl restart eln'
```

**改 `server/db.js` 的字段迁移不用手动跑**：服务重启时 `ensureColumn` 会自动补列。

注意：`public/` 是本地构建产物，你随时可能重新 `npm run build`（文件名带 hash 会变）。每次部署都要**在推送前重新构建**，否则推上去的是一份过期的前端；推完照上面「验证」一节核对资源名与大小对得上。

## 从本地同步数据到服务器（覆盖）

服务器上的库是 2026-10-29 从本机 `data/` 用 `sqlite3 .backup` 做的一致性快照。要再同步一次：

```bash
cd <本机路径>/Software/ELN
# 先停服务端，避免边写边传
$SSH 'systemctl stop eln'
# 一致性快照（本机 4780 正在跑也没关系，.backup 是 WAL-aware 的）
sqlite3 data/eln.db ".backup '/tmp/eln-slave.db'"
scp -i $KEY /tmp/eln-slave.db root@203.0.113.10:/var/lib/eln/eln.db
rsync -a -e "ssh -i $KEY" data/attachments data/compounds root@203.0.113.10:/var/lib/eln/
$SSH 'chown -R eln:eln /var/lib/eln; rm -f /var/lib/eln/eln.db-wal /var/lib/eln/eln.db-shm; systemctl start eln'
```

## 验证部署是否健康

关键点：**不要直接 `curl /assets/xxx.js` 看到 200 就以为好了** —— 之前 `try_files … /index.html` 会把不存在的资源回落成首页，返回 200 + 710 字节的 HTML。现在 `/assets/` 单独加了 `try_files $uri =404`，所以照下面查：

```bash
U=http://203.0.113.10   # 当前没有认证，不用 -u

curl -s "$U/" -o /tmp/i.html
# 逐个校验「首页自己引用的」资源
for f in $(grep -oE 'assets/[^"]+' /tmp/i.html); do
  curl -s -o /dev/null -w "$f → %{http_code} %{content_type} %{size_download}B\n" "$U/$f"
done
curl -s -o /dev/null -w "nope.js → %{http_code}\n" "$U/assets/nope.js"   # 必须 404
curl -s -o /dev/null -w "首页 → %{http_code}\n" "$U/"                        # 现在没有认证，应为 200
```

正常应当是：`index-*.js → 200 application/javascript ~1.2MB`、`index-*.css → 200 text/css ~444KB`、`nope.js → 404`、首页 `200`。装回 Basic Auth 后首页应变 `401`。

## 已知限制

1. **「存成 PDF」在服务器上不可用**。`server/print.swift` 依赖 macOS 的 `swiftc` + WebKit，Linux 没有。启动日志里会写 `打印渲染器 → 不可用，只能用系统打印`，点「存成 PDF」会失败。系统打印（浏览器打印）正常。
2. **没有 HTTPS，而且现在没有认证**。任何知道 `203.0.113.10` 的人都能直接读写整库（含 `data` 的 zip 导出）。这是当前最大风险。装回 Basic Auth 只是把「谁都能进」变成「知道密码才能进」，密码在 HTTP 上仍是 base64 明文；要真安全得上 HTTPS（需要域名）或改成只走 SSH 隧道。
3. **两份数据会分叉**。本机 `Software/ELN/data/`（4780 那份）和服务器 `/var/lib/eln/` 现在已经各自独立。**得先确定哪边是主库**，否则改动会丢在另一边。
4. **二维码地址用环境变量 `ELN_LABEL_BASE_URL`**（服务器 unit 里），不再依赖库里的 `label_base_url` —— 因为数据同步会覆盖库里那份。设好之后码里是 `http://203.0.113.10/#/c/<id>`（实验是 `/#/e/<id>`）。本机不设这个变量，走设置页/局域网地址。
5. **本机和服务器现在都是 v2**：本机 `public/` 就是构建产物（v1 已退役，备份在 `.backup/public-v1-<时间>/`），服务器 `/opt/eln/dist` 也是同一套构建。**不要再往 `public/` 里放 v1 的文件**。
