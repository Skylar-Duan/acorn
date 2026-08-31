; 卸载前的清理钩子。挂在 tauri.conf.json 的 bundle.windows.nsis.installerHooks 上，
; 由 Tauri 的 NSIS 模板 include 进去，在 Section Uninstall 的最前面执行。
;
; 不要去改 src-tauri/target/release/nsis/x64/installer.nsi —— 那是每次 build
; 从 CLI 内嵌模板重新生成的产物，改了必丢。
;
; **这个钩子里只许有无害动作，一行破坏性的都不许加。** 只删两样，都不是用户内容：
;   1) auth.json —— 登录令牌。留着就等于「卸载了还留着一枚有效的 bearer token」
;   2) $LOCALAPPDATA\${BUNDLEID}\EBWebView —— WebView2 的浏览缓存
; 删了这两样，一条待办都不会少。
;
; **绝不碰用户的任务数据**，尤其绝不碰 datadir.txt 指向的那个自定义数据文件夹：
; 那是用户拿系统文件夹选择器随便挑的一个已有目录（可能就是「我的文档」，也可能是一块
; 两台机器共用的盘），橡果并不独占它，RMDir /r 下去会把跟橡果无关的东西一起删光，
; 在一台机器上卸载还会把另一台正在用的那份一起带走。
; 用户数据的删除完全交回卸载向导里那个「删除应用程序数据」勾选框（Tauri 模板自带，
; 只动 $APPDATA\${BUNDLEID} 与 $LOCALAPPDATA\${BUNDLEID}，本来就不碰自定义数据文件夹）。
; 那个勾选框的判断在模板里排在本钩子**之后**，所以钩子里但凡删了数据，界面上显示的
; 就跟实际做的相反——这是不许有破坏性动作的第二个理由。
;
; 「删掉软件、本地不留」的正路是软件里的「退出登录并清空本机」：那条路有真闸门
; （必须当场同步成功才肯删，失败一条都不清）。要彻底清干净：**先在软件里清，再卸载**。
;
; 升级保护：$UpdateMode <> 1 这道闸保留着——升级时连令牌都别删。
; **它现在真的成立了**：App 内升级不再用 openPath（那样递不进命令行参数、$UpdateMode 是 0，
; 每升一次就把用户静默登出一次），改由 Rust 的 run_installer 起安装器并带上 /UPDATE。
; 带了 /UPDATE 的安装器在 PageLeaveReinstall 里直接走「不卸载、原地覆盖」那一支，
; 旧 uninstaller 压根不会启动，这个钩子一次都不执行，auth.json 原样留着。
; 即便如此，钩子里仍然绝不许有破坏性动作：万一哪天闸门又失效（比如有人手工双击安装器
; 选了「先卸载再装」），最坏的后果也只能是「升级后要重新登录」。

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; 登录令牌（连写一半留下的临时文件一起）
    Delete "$APPDATA\${BUNDLEID}\auth.json"
    Delete "$APPDATA\${BUNDLEID}\auth.json.tmp"
    ; WebView2 的浏览缓存。应用内的清空动作删不掉它（进程还占着），只能在这儿删
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView"
  ${EndIf}
!macroend
