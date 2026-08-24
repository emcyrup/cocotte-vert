// EPARK 管理画面を操作する駆動部の「約束事」。
//
// EPARK には外部から予約枠を操作する口が無いため、実装はブラウザ操作になる。
// 実際の画面を見ないとセレクタが書けないので、**ここには契約とスタブだけ**を置く。
// 画面が分かった時点で `src/epark/browserDriver.js` を足し、ここに差し込む。
//
// 駆動部が満たすべき契約:
//
//   open()                       … ログインする。失敗したら例外を投げる
//   close()                      … 後始末（ブラウザを閉じる）
//   closeSlot(slot)              … 枠を閉じる
//   openSlot(slot)               … 閉じた枠を開け直す
//   isSlotClosed(slot) => bool   … いま閉じているかを**画面から読み直す**
//
// isSlotClosed が要になる。書き込んだつもりで書けていない、という壊れ方を
// 検知できるのはここだけで、これが無いと「自動化できているつもり」になる。
// 読み直せない駆動部は受け付けない（sync 側で拒否する）。

const REQUIRED = ['open', 'close', 'closeSlot', 'openSlot', 'isSlotClosed'];

/** 契約を満たしているか。満たさない駆動部は使わせない */
export function isValidDriver(driver) {
  return Boolean(driver) && REQUIRED.every((name) => typeof driver[name] === 'function');
}

/**
 * 何もしない駆動部。EPARK の設定が無い環境と、テストで使う。
 * 「閉じた」と嘘をつかない（isSlotClosed は常に false）ため、
 * これを live で使っても済みにはならず、チェックリストに残り続ける。
 */
export function createNullDriver() {
  return {
    async open() {},
    async close() {},
    async closeSlot() {},
    async openSlot() {},
    async isSlotClosed() { return false; },
  };
}
