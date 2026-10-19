<p align="center">
  <img src="src-tauri/icons/128x128.png" width="132" alt="CatSVN" />
</p>

<h1 align="center">CatSVN</h1>

<p align="center">
  只下载你真正打开的文件 —— 一个桌面版 Subversion 客户端。
  <br />
  <sub><a href="README.md">English</a> | 中文</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-lightgrey.svg" />
  <img alt="Built with Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg" />
</p>

![CatSVN 连接界面](docs/screenshot-connect.png)

## 为什么做这个

传统 SVN 客户端默认要完整检出仓库。遇到几万个文件的仓库，第一次检出要等很久，本地也会被一堆可能永远不会打开的文档占满。macOS 上现成的客户端要么是收费软件，要么界面老旧，而且大多仍然假设你要准备一份完整工作副本。

CatSVN 反过来做：连接时只创建一个 **空深度** 工作副本，内容在浏览过程中按文件逐个拉取。需要正式在某个目录里工作时，仍然可以正常检出该目录，用完再删掉释放空间。

## 功能

**浏览**

- 可保存多个仓库配置，在切换页一键打开
- 通过 `svn list` 惰性浏览远端仓库，不检出也能先看目录结构
- 当前目录内筛选名称，方向键上下移动，`Enter` 打开或预览
- 通过工具栏、鼠标侧键或 `⌘[` / `⌘]` 在访问过的目录间前进后退
- 仓库 / 目录 / 文件历史，以及任意版本与 HEAD 的差异对比

**稀疏工作副本**

- 直接从仓库流式预览单个文件（`svn cat`），不落盘
- 编辑时只拉取该文件（`svn update --parents`）
- 目录检出支持四种深度：仅本层文件、一级子目录、完整目录、自定义层级
- 用 `--set-depth exclude` 删除已检出目录以释放空间，仓库内容不受影响
- 本地视图刷新会对当前目录执行 `svn update`，且不改变原有稀疏深度

**编辑与提交**

- 文本编辑 + 提交前统一格式 diff
- 内置 Markdown（GFM 表格、代码块，链接用浏览器打开）、图片、PDF、Word
  `.docx`、Excel/CSV 多工作表预览，全部从仓库流式读取，不落盘
- 更新、还原、提交当前文件
- 上传文件或文件夹到当前远端目录，作为一个原子版本提交
- 支持从访达直接拖拽文件或整个文件夹进来
- 待上传与本地未提交变更可查看、可丢弃
- 二进制文件按需拉取后交给系统默认程序打开，而不是在编辑器里报错

**界面**

- 中英文双语，跟随系统语言
- 原生 macOS 窗口毛玻璃，浅色 / 深色外观自动跟随
- 仓库面板与变更面板宽度可拖动调整

## 环境要求

- macOS 10.15 或更新版本（Tauri 的最低要求；开发与测试在较新系统上进行，见 [已知限制](#已知限制)）
- Subversion 命令行客户端 1.8 或更新版本
- Node.js 20.19 或更新版本，或 22.12 以上（Vite 的要求）
- Rust 工具链（从源码构建时）

```bash
brew install subversion node rust
```

CatSVN 调用 `svn` 命令行程序，而不是链接 Subversion 库。它会在 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`/usr/bin`、`/bin` 中查找，因此从访达启动时也能找到 Homebrew 安装的客户端。

## 快速开始

```bash
git clone https://github.com/iamtorson/CatSVN.git
cd CatSVN
npm install
npm run tauri dev     # 开发模式运行
npm run tauri build   # 生成 CatSVN.app 与 dmg，位于 src-tauri/target/release/bundle
```

常用检查：

```bash
npm run typecheck             # TypeScript 类型检查
npm run build                 # 前端打包
cd src-tauri && cargo test    # Rust 单元测试
```

## 使用说明

1. **连接仓库。** 填入仓库地址，默认会在 `~/CatSVN-workspaces/<host>` 创建工作副本。地址与目录会被记住；勾选「启动时使用已保存密码自动连接」后，下次启动会自动连上。
2. **先浏览。** 远端视图按需列出目录，点击文件夹只是导航，此时不会下载任何内容。
3. **按需检出。** 点击目录行上的检出按钮，选择深度：
   - *仅本层文件* —— 该目录及其直接文件
   - *一级子文件夹和文件* —— 再往下一层
   - *完整文件夹* —— 整个子树
   - *自定义深度* —— 指定目录层数
4. **切换视图。** 「远端目录」显示仓库全部内容；「本地已检出」只显示磁盘上已有的内容，并按真实目录层级嵌套。
5. **编辑。** 双击文件预览，点「编辑」只会拉取该文件；确认 diff 后填写说明并提交。
6. **上传。** 用「上传文件」/「上传文件夹」，或直接从访达拖进来。上传内容先暂存在工作副本中，准备好后一起提交。
7. **释放空间。** 「删除本地检出」会用 `--set-depth exclude` 把目录从工作副本中移除。仓库不受影响，但该目录下未提交的本地修改会一并丢失，请先提交。

在目录行上右键可以快速刷新该目录（本地视图下即对该目录执行 `svn update`）。

## 凭据处理

- 凭据通过 stdin 传给 `svn`（`--password-from-stdin --no-auth-cache`），密码不会出现在进程参数里，也不会写进 SVN 自己的凭据缓存。
- 所有命令都带 `--non-interactive`，认证失败会直接报错到界面，而不会卡在终端提示上。
- 勾选「在本机记住密码」后，账号保存在 `~/Library/Application Support/CatSVN/credentials.json`，权限为 `0600`。取消勾选或删除该文件即可清除。
- 刻意不使用登录钥匙串：应用是临时签名（ad-hoc），每次重新构建签名都会变，macOS 会因此反复要求输入登录密码才能取出已保存的密码。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `↑` / `↓` / `Home` / `End` | 在目录列表中移动 |
| `Enter` | 打开聚焦的目录，或预览聚焦的文件 |
| `⌘[` / `⌘]` | 后退 / 前进 |
| 鼠标后退 / 前进键 | 后退 / 前进 |
| 双击文件 | 预览 |
| `Esc` | 关闭当前弹窗或菜单 |
| `⌘C` / `⌘V` | 在输入框和预览区复制粘贴 |

## 稀疏工作副本是怎么工作的

连接仓库时等价于执行：

```bash
svn checkout --depth empty <url> <workspace>
```

此时工作目录里只有 SVN 元数据。打开文件编辑时执行：

```bash
svn update --parents <workspace>/<path/to/file>
```

Subversion 会补上缺失的父目录记录，并且只下载这一个目标。提交时也明确指定文件路径，因此不会把无关内容带进版本里。

## 技术栈

- **外壳：** [Tauri 2](https://tauri.app)（Rust）+ macOS 窗口毛玻璃
- **界面：** React 19 + TypeScript，Vite 打包
- **图标：** [lucide-react](https://lucide.dev)
- **SVN 访问：** 调用 `svn` 命令行客户端，由 Rust 侧驱动
- **解析：** `roxmltree` 解析 `--xml` 输出，`encoding_rs` 处理文件编码

## 目录结构

```
src/                     React 前端
  App.tsx                主窗口：浏览器、文件面板、变更面板、各弹窗
  App.css                液态玻璃设计系统（浅色与深色 token）
  i18n.ts                中英文字符串
src-tauri/               Rust 侧
  src/lib.rs             封装 svn 客户端的 Tauri 命令
  tauri.conf.json        窗口、毛玻璃与打包配置
  icons/                 应用图标
docs/                   本说明用到的截图
```

## 已知限制

- 目前以 macOS 为主要目标。技术栈本身跨平台，但窗口毛玻璃与 `macOSPrivateApi` 是 macOS 专属，Windows / Linux 尚未测试。
- 工作副本状态是用一次 `svn status` 读取整个工作副本，检出内容很多时会偏慢。
- diff 只有统一格式的文本视图，没有并排对比。
- 二进制文件可以拉取并用默认程序打开，但不能在 CatSVN 内编辑。
- 应用需要系统里存在 `svn` 可执行程序，本身不内置。

## 参与贡献

欢迎提 issue 和 PR。提交前请先跑：

```bash
npm run typecheck
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test
```

改动请尽量聚焦，涉及 Rust 侧时说明你依赖的 SVN 命令行为。

## 许可证

[MIT](LICENSE)
