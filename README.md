# 豆迹 · 咖啡豆个人看板

一个永久单用户、本地优先的咖啡豆收藏、购买、饮用与品鉴看板。

项目希望让购买记录和饮用评价持续积累、不再散落，同时为咖啡同好提供可以交流的结构化品鉴记录。应用不包含在线账号、多用户协作、云端同步、移动端原生应用或自动下单。

## 当前进度

- U1：本地应用骨架、领域模型、安全存储与恢复底座。
- 后续：Excel 迁移、历史补评价、购买与饮用闭环、陈列馆、离线推荐、联网采集和同快照导出。

实施范围与验收标准见 [`咖啡豆看板-产品需求文档.md`](./咖啡豆看板-产品需求文档.md)。

## 本地运行

需要 Node.js 24 LTS。

```powershell
cd app
npm install
npm run setup
npm run doctor
npm run dev
```

生产构建与验证：

```powershell
cd app
npm run verify
npm run build
npm run start
```

服务仅监听 `127.0.0.1`，默认不联网、不遥测。

## 数据与隐私边界

公开仓库只保存源码、文档、测试、匿名化夹具，以及用户主动选择发布的品鉴 Markdown。以下内容不会进入公开版本：

- 本地数据库、备份和导出目录
- 原始 Excel、CSV 或 TSV
- 私人 `summary.md`
- 购买明细、未公开评价和其他 Obsidian Vault 内容

请勿在 Issue、Pull Request 或 `community-notes/` 中提交令牌、Cookie、订单信息或未经本人确认的私人记录。

## 分享品鉴记录

经过主动确认、适合公开的品鉴内容放入 [`community-notes/`](./community-notes/)。未来应用的 Markdown 导出功能会作为主要分享入口。

## 贡献

欢迎通过 Issue 讨论咖啡豆字段、品鉴维度、迁移兼容性和界面体验。代码改动请附带与风险相称的测试，并遵循 [`AGENTS.md`](./AGENTS.md) 中的本地优先、来源分层和隐私约束。

