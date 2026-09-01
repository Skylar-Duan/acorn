# 橡果 Acorn

Windows 桌面待办工具（另有安卓版）。随手打一句「周五下午3点 提交周报 /工作 @李哥 !高」，
日期、时间、清单、需求方、重要性一次到位。带日历、四象限、习惯打卡、云同步。

**下载安装包**：[Releases](https://github.com/Skylar-Duan/acorn/releases)

## 这个仓库怎么分层

| | |
|---|---|
| `工程/` | 源码、服务端、测试、文档。**npm 命令都在这一层跑**，详见 [`工程/README.md`](工程/README.md) |
| `00-说明.md` | 给使用者的一页纸：装在哪、怎么用、该看哪份文档 |

`安装包/`、`交付验收/`、`界面截图/`、`userdata/` 这几个目录只在本地磁盘上，不进仓库。

## 技术栈

Tauri 2 + React 18 + TypeScript + zustand；服务端是 FastAPI + SQLite。
每个版本改了什么见 [`工程/CHANGELOG.md`](工程/CHANGELOG.md)。
