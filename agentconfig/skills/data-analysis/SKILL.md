---
name: 数据分析
title: 数据分析
description: 读取 CSV / Excel 等表格数据，进行统计、清洗、汇总并给出可视化建议。
---

# 数据分析

用于对本地表格数据做快速分析。

## 工作方式
1. 读取用户在工作区放入的 CSV/Excel 文件（可用 shell 与脚本工具）。
2. 输出数据概览：行列数、字段含义、缺失值情况。
3. 按用户问题做聚合、排序、透视等统计，必要时编写并运行脚本。
4. 给出关键结论，并建议合适的图表类型。

## 注意
- 大文件先采样查看再全量处理。
- 处理结果（清洗后的表、图表）保存到工作区目录，方便用户查看。
- 分析前先与用户确认口径，避免误解字段含义。

## 绘图（避免中文乱码 / 卡死）
- 运行环境已预置无界面后端与中文字体配置，直接绘图即可；**不要手动删除或重建字体缓存**。
- 缺库就装（已配国内镜像）：`python3 -m pip install --no-input pandas matplotlib openpyxl`。
- 保险起见可在脚本开头固定后端与中文字体：
  ```python
  import matplotlib; matplotlib.use('Agg')
  matplotlib.rcParams['font.sans-serif'] = ['Arial Unicode MS','Hiragino Sans GB','PingFang SC','Microsoft YaHei','SimHei','Noto Sans CJK SC']
  matplotlib.rcParams['axes.unicode_minus'] = False
  ```
- 首次出现「building the font cache」属一次性构建（数秒），等待即可，不是卡死。图表保存为 PNG 到工作区。
