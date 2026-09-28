# 豆迹 Coffee Dashboard — 终态数据归档

- 项目于 2026-09-28 决定砍掉（用户结论：当前形态无特别大的价值）。
- 本分支是应用期最终数据快照，源头是 vault `30-私人内容/咖啡豆/data/`（schemaVersion 2，42 豆 / 15 品牌 / 6 评价，dataRevision 14，最后更新 2026-09-22）。
- 原始数据以 vault 保留的两份 Excel 为准：`意式咖啡豆_完整版.xlsx`、`意式咖啡豆_选单.xlsx`。
- 服务器端部署（coffee.hsrplan.com）已于 2026-09-28 全部拆除；`main` 分支保留 v1.1.0 完整源码与 Release（exe）。
- 如需恢复：clone 本仓库 → `cd app && npm ci` → `COFFEE_DASHBOARD_DATA_DIR` 指向数据目录 → `npm start`。
