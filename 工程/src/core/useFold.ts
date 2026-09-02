// 「这一块收着还是摊着」的记忆，落 localStorage。
//
// 2026-09-01 从 Sidebar 里抽出来共用：设置页分节折叠也要这一套，别抄第三份。
// key 一律 `acorn-` 开头——退出登录清空本机时 persist.clearLocalPrefs() 按这个前缀扫。

import { useEffect, useState } from "react";

const OPEN_EVENT = "acorn:fold-open";

/**
 * 返回 [open, toggle]。
 * @param key    这一块的名字（会拼上 prefix 当 localStorage 键）
 * @param initial 没记过时的默认态
 * @param prefix  localStorage 键前缀。侧栏是 `acorn-side-`，设置页是 `acorn-set-`
 */
export function useFold(key: string, initial: boolean, prefix = "acorn-side-"): [boolean, () => void] {
  const lsKey = `${prefix}${key}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });

  // 别处要求「把这一块打开」（比如侧栏同步指示点一下要滚到「云账号」）——
  // 那一节要是收着，滚到一个收起的标题上用户什么也看不见。
  // 走事件而不是把状态搬进 store：这是纯界面记忆，不该进撤销栈也不该同步
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === lsKey) setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [lsKey]);

  return [
    open,
    () =>
      setOpen((v) => {
        try {
          localStorage.setItem(lsKey, v ? "0" : "1");
        } catch {
          /* 隐私模式之类存不了就算了，只是这次会话不记住 */
        }
        return !v;
      }),
  ];
}

/** 让某一块强制打开（同时写进记忆，这样还没挂载的那一页挂载时读到的也是「开」） */
export function forceFoldOpen(key: string, prefix = "acorn-side-"): void {
  const lsKey = `${prefix}${key}`;
  try {
    localStorage.setItem(lsKey, "1");
  } catch {
    /* 同上 */
  }
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: lsKey }));
}
