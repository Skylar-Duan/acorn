// 账号名字框的草稿（桌面账号小面板、手机账号纸共用）。
//
// 9-21 复核修的毛病：草稿只在打开那一刻取一次名字，之后同步带回别处改的新名字，框里还是旧的；
// 关面板 / 点走时拿旧草稿去比新名字，「不一样」就把旧名字盖上新戳写回去，别的设备的改名被撤销
// （首轮同步没回来时打开，甚至会把名字清空）。用户一个字都没输入。
//
// 口径：记一个「基准」= 草稿最后一次对齐到的名字。
//   · 没改过（草稿 === 基准）：名字变了草稿跟着变，关面板、点走都**不写**；
//   · 改过：照用户打的存，跟原来一样；
//   · 退回（Esc）：退到最新的名字。
import { useEffect, useRef, useState } from "react";

export interface NameDraft {
  draft: string;
  setDraft: (v: string) => void;
  /** 草稿动过没有（跟基准比，不跟最新名字比） */
  edited: () => boolean;
  /** 动过才存；存了返回 true（调用方据此闪一下「已存」） */
  commit: () => boolean;
  /** 丢掉草稿，退回最新的名字 */
  revert: () => void;
}

export function useNameDraft(name: string, save: (v: string) => void): NameDraft {
  const [draft, setDraftState] = useState(name);
  const draftRef = useRef(name);
  const base = useRef(name);
  const nameRef = useRef(name);
  nameRef.current = name;
  const setDraft = (v: string) => {
    draftRef.current = v;
    setDraftState(v);
  };
  useEffect(() => {
    // 没动过的草稿跟着最新名字走；动过的留着用户打的字
    if (draftRef.current === base.current) {
      base.current = name;
      setDraft(name);
    }
  }, [name]);
  const edited = () => draftRef.current !== base.current;
  return {
    draft,
    setDraft,
    edited,
    commit: () => {
      if (!edited()) return false;
      const v = draftRef.current.trim();
      base.current = v;
      setDraft(v);
      if (v === nameRef.current) return false;
      save(v);
      return true;
    },
    revert: () => {
      base.current = nameRef.current;
      setDraft(nameRef.current);
    },
  };
}
