# 方法学实验记录

本机运行的电子实验记录本（ELN），版式照纸本记录页做：**一条实验 = 两页 A4**。
单人单机、数据全在自己的盘上，不联网也能用（除 PubChem 查询是可选联网）。

```
双击 start.command      →  浏览器自动打开 http://127.0.0.1:4780
双击 preview.command    →  开发模式（vite :5173，改代码热更新）
```

需要 Node ≥ 22（用到内置的 `node:sqlite`）。

---

## 一条实验有什么

**第 1 页 · 主记录**：抬头（编号/日期/课题/状态/温湿度）· 反应式 · 投料表 · 条件 · 结果与选择性 · TLC
**第 2 页 · 续页**：实验操作与现象（含照片）· 后处理 · 表征数据 · 讨论与结论 · 附件

- **投料表**：填当量或 mmol，质量/体积自动算；组分可选 底物/试剂/碱/配体/溶剂…；合计行顺手推荐「用多大瓶、多大磁子」
- **结果**：填质量自动算产率与理论产量；粗产物可一键标「不计产率」
- **反应式**：右上「画反应式」在 Ketcher 里画，或「按投料表生成」直接拼一条
- **图片**：⌘V 任意位置粘贴；操作/现象旁边有一栏贴实验照片（可写图注）
- **试剂**：库里没有的试剂直接打名字，会自动去 PubChem 查 MW/密度，查过的进本地词典下次自动带出
- **化合物库**：结构式、谱图、TLC、CAS、二维码瓶签；扫瓶签手机能看档案
- **平行实验**：同一条记录复制/改一个变量，卡片墙上成组展示
- **导出**：单文件网页（.html，图内联）· 打包（.zip：网页 + 原图 + JSON）· 整页长图（.png）· Markdown
- **手机端**：同一 Wi-Fi 下打开局域网地址即可「加到主屏」；能看记录、拍照上传 TLC/照片/谱图（画结构式请在电脑上）

## 文件都是干什么的

```
ELN/
├── start.command / preview.command   启动（生产 / 开发）
├── package.json     依赖与脚本（dev / build / serve）
├── vite.config.js   构建到 public/（4780 直接发这个目录）
├── index.html       开发入口
│
├── server/          本地服务（零框架，node:http）
│   ├── index.js     全部 REST 路由（实验/化合物/附件/导出/查询…）
│   ├── db.js        SQLite 表结构、编号生成、设置读写
│   ├── export.js    Markdown / CSV 导出
│   ├── qr.js        二维码编码（瓶签用，零依赖）
│   └── *.swift      三个 macOS 原生能力（详见下）
│
├── src/             前端（Vue 3 + Vite）
│   ├── views/       页面：工作台、记录页、化合物、筛选、设置、回收站
│   ├── components/  记录页各区块（投料表、结果、反应式、TLC、照片…）
│   ├── lib/         纯逻辑：化学式/结构图、拖拽排序、打印版式、导出、查询
│   ├── styles/      纸张版式与样式（含 @media print）
│   ├── store.js     全局状态（bootstrap 一次拉齐）
│   └── router.js    路由（#/e/:id、#/c/:id、#/m 手机端…）
│
├── scripts/         维护脚本
│   ├── backup.js        备份 data/ 快照
│   ├── normalize-labels.py / fit-canvas.py / normalize-style.py  结构图标签与画布归一
│   └── build-ketcher.sh / copy-indigo.sh   重新生成 vendor/ 里的画板
│
├── data/            全部数据（不进 git）
│   ├── eln.db       SQLite：实验、投料、附件记录、化合物…
│   ├── attachments/ 实验附件（谱图、TLC、反应式、照片）
│   └── compounds/   化合物文件（结构式、谱图）
│
├── vendor/          Ketcher 画板与 Indigo WASM（构建产物，不进 git）
└── public/          前端构建产物（进 git，服务直接发它）
```

## 三个 macOS 原生小工具

都是「用到才编译一次、缓存在 `.cache/`」的薄封装，缺 `swiftc` 时会优雅降级，不影响主流程：

| 文件 | 作用 | 缺了会怎样 |
|---|---|---|
| `server/print.swift` | 用系统 WebKit 把两页 DOM 渲染成 A4 PDF | 提示改用「系统打印」 |
| `server/shot.swift` | 整页长图导出（不分页、不裁切） | 长图导出不可用 |
| `server/ocr.swift` | 本地 Vision 读 TLC/谱图上的手写数字 | OCR 不可用，手动填 |

## 数据与备份

- 一切都在这一个目录：`data/`（SQLite + 文件）。**备份 = 拷走它**，或设置页「下载完整备份 .zip」。
- 想自动备份：把 `data/` 放进时间机器 / 网盘，或定时跑 `node scripts/backup.js`。
- 数据库就是普通 SQLite，十年后任何 SQLite 客户端都能打开。

## 手机端

1. 设置页勾上「允许手机 / 局域网访问」，**重启服务**；
2. 手机连同一个 Wi-Fi，打开 `http://<本机局域网 IP>:4780`（设置页 / 启动日志里有地址）；
3. Safari「添加到主屏幕」当 App 用；扫瓶签二维码可直接看化合物档案。

## 只在本机、只给自己用

- 服务默认只监听 `127.0.0.1`；开「允许局域网访问」＝同一 Wi-Fi 的设备都能打开，请只在自己信得过的网络里开。
- 没有账号体系，也没有云同步。
- 详细开发约定、踩过的坑、历代改动见 `AGENTS.md` 与 `HISTORY.md`；云部署见 `CLOUD-DEPLOY.md`。
