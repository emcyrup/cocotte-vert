// EPARK の仮受付に載せる「誰のご予約か」。
//
// これまでは枠を押さえるだけの無名の仮受付だったので、EPARK の受付表を見ても
// 誰の予約か分からず、結局こちらの画面と突き合わせる手間が残っていた。
// 空き枠から開く「顧客検索及び新規受付登録」の院内メモにこの1行を入れる。
//
// **EPARK 側の顧客台帳は検索も選択も新規登録もしない。** 同姓同名や複数ヒットで
// 別のお客様に紐づけると、相手の台帳が壊れて元に戻せない。メモに書くだけなら
// 間違っていても消せる。「受付」ではなく「仮受付」のままにするのも同じ理由で、
// 仮受付の印（li.tentative-reservation）が付いているうちは、取消のときに
// 「自分が入れたものだけ」を見分けて開け直せる。
//
// ここが返す文字列には氏名・電話番号が入る。**ログにも Slack にも出さない。**

// EPARK のメモ欄に収まる長さ。溢れると相手側で切られ方が読めない
const MAX_LENGTH = 200;

// 受付表を見た人が「LINE から入った予約」と分かるようにする
const SOURCE = 'LINE予約';

/** ハイフン無しの番号を読みやすく戻す。桁が想定外ならそのまま出す */
function prettyPhone(raw) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (/^0[789]0\d{8}$/.test(digits)) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  return digits;
}

/**
 * 一覧の1行から院内メモの本文を作る。
 * 載せる中身が何も無ければ null（＝これまでどおりの無名の仮受付にする）。
 * @returns {string|null}
 */
export function detailsText(row) {
  if (!row) return null;
  const parts = [SOURCE];

  const name = String(row.customer_name ?? '').trim();
  if (name) parts.push(`${name} 様`);

  // ペットが複数いる予約は、どの子か決められないので一覧側で null にしてある
  const pet = String(row.pet_name ?? '').trim();
  if (pet) parts.push(`${pet}ちゃん`);

  const phone = prettyPhone(row.phone_norm);
  if (phone) parts.push(phone);

  const menu = String(row.menu ?? '').trim();
  if (menu) parts.push(menu);

  // こちらの予約番号。EPARK 側で見つけた受付を、こちらの画面で引けるようにする
  if (row.id) parts.push(`res=${row.id}`);

  if (parts.length === 1) return null;
  return parts.join(' / ').slice(0, MAX_LENGTH);
}
