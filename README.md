# LMCL

一个正在开发的通用 Minecraft Java 启动器，支持 Windows 和 M 系列 Mac

日常可以用来管理游戏版本、模组和整合包，玩单人存档也不需要接入任何服务器。

另外提供可选的服务器模式：添加服务器提供的接口后，查看服务器状态、安装对应整合包，并同步后续更新。LID 也通过这套接口接入，不在公开版本中内置。

计划支持：

- 微软正版、LittleSkin 和离线登录，优先推荐正版
- 游戏版本、加载器、模组、整合包、光影、资源包和投影原理图下载
- 普通模式独立使用整合包，服务器模式接入服务器列表、在线人数和整合包同步
- 工具箱里打开已安装的基岩版

目前先保留现有 UI 风格，后续按反馈调整。窗口默认 960×660，可缩小到 820×560。Mac 版仅适配 Apple Silicon，最低 macOS 13；后续考虑 Linux，Android 先研究可行性

公开版本不附带 LID 的服务器地址、整合包、素材或访问凭据。其他服务器可以实现同一套[接入接口](docs/server-api.md)，由用户自行添加。右上角可以切换普通／服务器模式，切换模式不会更换账户或删除已有实例。

## 目前进度

目前提供 Windows x64 和 macOS ARM64 功能预览版。下载见 [Releases](https://github.com/llroxy-by/LMCL/releases)，构建会保留安装包和测试截图。

已接入原版游戏下载、文件校验、离线角色、Java 检测、标准原版目录导入与启动。Java 需要自行安装，启动时检查主版本是否符合游戏要求。M 系列 Mac 需要 ARM64 / AArch64 版 Java。普通／服务器模式可以切换，服务器接口支持保存与目录查询，默认没有预设服务器。

下载页提供模组、整合包、光影和资源包的搜索与安装，内容来自 Modrinth 公开目录，按类型放进实例的 mods、modpacks、shaderpacks、resourcepacks 目录。投影原理图没有公开目录，支持链接下载与本地导入到 schematics。下载源可切换自动／官方／第三方，自动模式先走第三方镜像，超时或速度过慢时回落到官方。

微软与 LittleSkin 登录、加载器安装，以及自动更新执行器还没完成。整合包目前只下载 `.mrpack`，尚未安装成实例；整合包更新计划器已有独立测试，尚未接入写盘。当前桌面端使用 Electron，正式界面和应用图标都还没定稿。

## 本地运行与构建

```sh
npm ci
npm start
```

在 Windows 上执行 `npm run build:win`，生成免安装的 x64 EXE。在 M 系列 Mac 上执行 `npm run build:mac`，生成 ARM64 DMG 和 ZIP。

构建配置见 `.github/workflows/windows.yml` 和 `.github/workflows/macos.yml`，使用方法见 [docs/preview.md](docs/preview.md)。

## 跑测试

开发需要 Node.js 22 或更新版本；运行启动器无需额外安装 Node.js。

```sh
npm test
```

开发范围见 [docs/development.md](docs/development.md)。
