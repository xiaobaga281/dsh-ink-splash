# dsh-ink-splash · 水墨开屏

![dsh-ink-splash 水墨开屏](https://raw.githubusercontent.com/xiaobaga281/dsh-ink-splash/main/docs/hero.jpg)

> Ink-wash splash and theme for DeepSeek Harness. One ink front writes the DeepSeek wordmark and wakes the landscape behind it.

一条墨锋同时写出 **DeepSeek** 字标、唤醒背后的山水。夜山 / 宣纸两套皮肤，字标、运笔、画面三轴独立选择；开屏结束自动交棒给 DSH。

## 亮点

- **一条墨锋**：字标的纸帘扫写与背景显影共用同一套墨锋节奏，不是两层各自动画。
- **首笔更快**：0.3.3 默认湿墨 / 横扫 / 侠客五次首笔为 884、882、883、888、884 ms，中位 884 ms，较 0.3.2 基线约 1514 ms 缩短约 41.6%。
- **四档清晰度**：1600 / 1920 / 2560 / 3200 按视口做 cover-aware 选档；当前 1280×822 @ DPR1.5 选 2560 档，底图 0.84×、夜山字标 0.72×，不做上行放大。
- **两套皮肤**：夜山、宣纸；字标（湿墨 / 枯笔）× 运笔（横扫 / 山起 / 生山）× 画面（侠客 / 鲸鱼）自由组合。
- **声音实时合成**：墨韵、古琴、空山三套古风写法，随包不携带任何音频文件。
- **只走合成层**：动画主体只改 transform / opacity，不使用全屏实时 blur/filter；`prefers-reduced-motion` 下隐藏新增纸帘。

## 预览

| 夜山 | 宣纸 |
| --- | --- |
| ![夜山](https://raw.githubusercontent.com/xiaobaga281/dsh-ink-splash/main/docs/night.jpg) | ![宣纸](https://raw.githubusercontent.com/xiaobaga281/dsh-ink-splash/main/docs/xuan.jpg) |

## 安装

需要一个已能正常运行的 DSH 桌面版（0.2.x）。

1. 打开 DSH 侧栏「插件」页，点「添加插件」。
2. 任选一种来源填入对话框：
   - npm：`dsh-ink-splash@0.3.5`
   - Git：`https://github.com/xiaobaga281/dsh-ink-splash.git`
   - 发布包 `dsh-ink-splash-0.3.5.tgz`，或源码目录的绝对路径。
3. 确认安装；如果提示需要重启，重启 DSH。
4. 打开设置 → 开屏水墨，可以改三轴、主题、音量、重播时长，也可以点「重播」预览。

不要手工把解压目录放进 `%USERPROFILE%\.dsh\plugins\`，也不要在 profile 里自建 `node_modules` junction；这条旧路径会绕开官方插件管理器的依赖记录和版本检查。

## 设置

| 项目 | 可选值 |
| --- | --- |
| 主题 | 夜山 / 宣纸 |
| 字标 | 湿墨 / 枯笔 |
| 运笔 | 横扫 / 山起 / 生山 |
| 画面 | 侠客 / 鲸鱼 |
| 其他 | 音量、重播时长、重播预览 |

## 兼容性

- 仅桌面版 DSH（渲染进程使用 `dsh-app://app/`）。纯 Web 部署也可用，但开屏注入依赖 DSH 的 `webserver/index-inject` 钩子。
- 主题会改写 DSH 的一批 `--dsw-*` token；与其它改同一批 token 的主题插件不要同时启用。

## 版本

当前 **0.3.5**。完整变更记录见 [CHANGELOG.md](https://github.com/xiaobaga281/dsh-ink-splash/blob/main/CHANGELOG.md)。

0.3.5 是清理与适配版本：插件页顶栏、左栏底部渐隐改为统一的磨砂材质；移除未使用导出、运行时回执与未使用 catch 绑定，修正过期注释。开屏动画、设置页和既有资产不变。

## 许可

MIT。主题曲 / 画面为随包资产，允许随本插件一起分发。
