# 运行环境自愈准则（Environment Self-Healing）

桌面端已为你预置可写的运行环境，遇到环境/依赖问题时，**自行分析并修复，不要把配置任务丢回给用户**。

## 总则
- 当命令报「缺少模块 / command not found / 无可用字体 / 连接超时」等环境问题时：先判断根因，再用工具自动安装或配置，然后重试，最后才考虑求助用户。
- 安装、构建等可能耗时的命令要加超时与非交互参数，避免卡死（例如 `pip ... --no-input`、`timeout` 包裹、`git -c core.askpass=true`）。
- 所有产物（脚本、图表、数据）保存到工作区目录。

## Python / 数据与绘图
- 已预置环境变量：`MPLBACKEND=Agg`（无界面后端，避免卡在 GUI）、`MPLCONFIGDIR` 指向可写且持久的缓存目录（字体缓存只构建一次，之后秒级），并提供了带中文字体优先级的 `matplotlibrc`。**因此请直接绘图，不要手动删字体缓存或反复重建。**
- 若仍出现中文方块/乱码，在脚本里显式设置：
  ```python
  import matplotlib
  matplotlib.rcParams['font.sans-serif'] = ['Arial Unicode MS','Hiragino Sans GB','PingFang SC','STHeiti','Microsoft YaHei','SimHei','Noto Sans CJK SC']
  matplotlib.rcParams['axes.unicode_minus'] = False
  ```
- 缺少 `pandas/matplotlib/numpy/openpyxl` 等库时，直接安装（已配置国内 PyPI 镜像，速度快）：
  `python3 -m pip install --no-input pandas matplotlib openpyxl`
- 首次绘图若提示「building the font cache」，这是**正常的一次性构建**（数秒），耐心等待即可，不是卡死。

## 网络 / 下载（国内环境）
- 已配置：PyPI 国内镜像（`PIP_INDEX_URL`）、`git` 透明走 GitHub 镜像（`github.com`/`raw.githubusercontent.com` 自动改写到镜像）。所以可以直接 `git clone https://github.com/...` 或 `pip install`，无需手动换源。
- 如个别资源仍超时，可改用 `curl -L` 并套用镜像前缀（如 `https://gh-proxy.com/<原始GitHub直链>`）。

## 技能（Skills）自助安装
- 你的技能目录是 `$CODEX_HOME/skills/`。当用户需要某种当前没有的能力时，你可以**自行创建或下载技能**：
  - 新建：在 `$CODEX_HOME/skills/<名称>/SKILL.md` 写入带 `name`、`description` frontmatter 的说明，即成为可被自动调用的技能。
  - 下载：用 `git clone`（已走镜像）把开源技能仓库拉到 `$CODEX_HOME/skills/<名称>/`，确保包含 `SKILL.md`。
- 安装完成后向用户简述新增了什么技能及用途。

## 失败处理
- 同一错误最多自动重试 2~3 次（可调整参数/换镜像/装依赖），仍不行再向用户说明根因、已尝试的修复，以及需要用户做什么。
