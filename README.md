# 豆迹 · 咖啡豆个人看板

一个永久单用户、本地优先的咖啡豆收藏、购买、饮用与品鉴看板。

项目希望让购买记录和饮用评价持续积累、不再散落，同时为咖啡同好提供可以交流的结构化品鉴记录。应用不包含在线账号、多用户协作、云端同步、移动端原生应用或自动下单。

## v1.0 已完成

- 历史 Excel 迁移与连续补评价。
- 多豆购买、单豆饮用和美式 / 奶咖独立评价。
- 陈列馆、豆档案、三豆比较和本地个性化推荐。
- 用户确认式联网采集与手工回退。
- 当前筛选或指定咖啡豆的 Markdown / PDF 同快照导出。
- 原子写入、校验备份、恢复模式和受约束删除。

实施范围与验收标准见 [`咖啡豆看板-产品需求文档.md`](./咖啡豆看板-产品需求文档.md) 和 [`app/ACCEPTANCE.md`](./app/ACCEPTANCE.md)。完整操作说明见 [`app/docs/USER_GUIDE.md`](./app/docs/USER_GUIDE.md)。

## 本地运行

需要 Node.js `>=22.12 <27`，推荐当前受支持的 LTS 版本。

```powershell
cd app
npm ci
npm run setup
npm run doctor
npm run build
npm start
```

启动后打开 `http://127.0.0.1:4173`。开发模式可运行 `npm run dev` 并打开 `http://127.0.0.1:5173`。

完整验证：

```powershell
cd app
npm run verify
npm run test:e2e
npm run test:pdf
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

经过主动确认、适合公开的品鉴内容可放入 [`community-notes/`](./community-notes/)。应用的 Markdown 导出是主要分享入口；导出前请再次检查是否包含不想公开的购买价格、备注或评价。

## 贡献

欢迎通过 Issue 讨论咖啡豆字段、品鉴维度、迁移兼容性和界面体验。代码改动请附带与风险相称的测试，并遵循 [`AGENTS.md`](./AGENTS.md) 中的本地优先、来源分层和隐私约束。

当前仓库尚未声明开源许可证。公开可见不等于授予复制、修改或再分发代码的许可。

