// 独立窗口（随手记小窗 / 说明窗）一律不碰数据文件：补全候选和主题全由主窗下发。
//
// 为什么提出来单放一个模块：下发的时机不止一处。窗口打开那一刻要发一次
// （main.tsx 里 quickadd:pull / guide:pull 的应答），主窗换主题或深浅色时还得再发一次
// （themeCtl），否则开着的说明窗会一直停在打开那一刻的配色。两处必须发同一份东西，
// 各写一份迟早分家。
import { allTags, allWho, appStore } from "./store";

export interface WindowContext {
  listNames: string[];
  tagNames: string[];
  whoNames: string[];
  theme: string;
  mode: string;
}

export function windowContext(): WindowContext {
  const d = appStore.getState().data;
  return {
    listNames: d.lists.map((l) => l.name),
    tagNames: allTags(d).map((t) => t.tag),
    whoNames: allWho(d).map((w) => w.who),
    theme: d.settings.theme,
    mode: d.settings.mode,
  };
}
