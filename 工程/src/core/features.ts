// 功能开关：暂时不想露出来的功能收在这儿，一处改值，全部入口跟着开关。
//
// FOCUS_ENABLED —— 专注（番茄钟）。
// 为什么关：这套计时器还没想清楚该怎么跟后面的养成/经营系统接上，
// 半成品摆在侧栏里反而占位置，先收起来。
// 关掉了什么：只关 UI 入口——侧栏「专注」、命令面板的跳转项、右键菜单「▶ 开始专注」、
// 任务卡的「▶ 专注」按钮、设置里的「默认专注时长」、今天页底栏与统计页的专注数字。
// 没关什么：FocusView / focusCtl / focus 迷你浮窗（focus.html、windows/focus.tsx、
// vite rollup input、tauri.conf.json 的 focus 窗口、capabilities）全部原样保留；
// Task.focusMinutes、AppData.sessions、Settings.focusMinutesDefault 三个数据字段一个没动，
// 历史记录不丢，导出/导入/云同步合并照旧；App.tsx 的 case "focus" 路由也留着。
// 怎么开回来：把下面这行改成 true，功能整套回来，不用改别的地方。
// 标注成 boolean 而不是字面量 false：否则 TS 会把所有 `FOCUS_ENABLED &&` 的分支
// 当成死代码去推断类型，开关翻回 true 时反而先报一堆类型错。
export const FOCUS_ENABLED: boolean = false;
