# 豆迹 Coffee Dashboard

豆迹是一个单用户、本地优先的咖啡豆收藏、购买、饮用、评价与导出工具。它不需要账号，不上传个人记录，也不会自动下单。

v1.0 支持：

- 从两份历史 Excel 预览并迁移咖啡豆数据
- 连续补录未登记的饮用与个人评价
- 分开记录多豆购买订单和单豆饮用
- 陈列馆筛选、豆档案追溯与三豆比较
- 基于本地事实和显式偏好的离线个性化推荐
- 用户主动触发的商品搜索、链接解析与确认式合并
- 按筛选结果或指定咖啡豆导出同一快照的 Markdown / PDF
- 原子写入、校验备份、恢复模式和 revision 并发保护

## 快速开始

要求：Windows、macOS 或 Linux；Node.js `>=22.12 <27`；npm。

从仓库根目录执行：

```powershell
cd app
npm ci
npm run setup
npm run doctor
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:4173`。服务只监听本机 loopback，不会向局域网或公网开放。

开发模式：

```powershell
cd app
npm ci
npm run setup
npm run dev
```

开发页面位于 `http://127.0.0.1:5173`。

## 数据与隐私

默认数据位于仓库根目录的 `data/`，与 `app/` 平级：

```text
coffee-dashboard/
├─ app/
└─ data/
   ├─ coffee-data.json
   ├─ coffee-data.revision.json
   ├─ backups/
   └─ exports/
```

`data/` 已被 Git 忽略，不应提交。Excel 文件只作为用户主动选择的只读迁移输入。只有主动搜索商品或解析链接时，服务才访问外部网络；购买、饮用、评价和完整本地数据库不会发送给采集来源。

更新应用前，请先退出豆迹并复制整个 `data/` 目录。若启动页显示恢复模式，不要直接修改 JSON，应优先使用页面列出的已校验备份恢复。

## 文档

- [完整使用手册](docs/USER_GUIDE.md)
- [v1.0 变更记录](CHANGELOG.md)
- [一期验收报告](ACCEPTANCE.md)

## 验证

```powershell
npm run verify
npm run test:e2e
npm run test:pdf
```

真实 Excel 工作簿不随公开仓库分发；对应只读 dry-run 测试在工作簿缺失时会自动跳过，固定夹具迁移测试仍会执行。

## 产品边界

豆迹永久不包含在线账号、多用户协作、云端同步、移动端原生应用或自动下单。价格监控属于后续能力；v1.0 的个性化推荐完全基于本地数据，不依赖实时联网更新。

当前仓库尚未声明开源许可证。公开可见不等于授予复制、修改或再分发代码的许可。
