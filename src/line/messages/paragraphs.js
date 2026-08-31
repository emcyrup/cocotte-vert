// 本文テキストを Flex の text ノード列にする。
//
// R1〜R4 の本文は管理画面から書き換えられる。スタッフは空行で段落を分けて書くので、
// 空行区切りを段落（2つ目以降に margin）として組む。1段落なら従来と同じ1ノードになる。
export function toParagraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => ({
      type: 'text',
      text: t,
      size: 'sm',
      wrap: true,
      ...(i > 0 ? { margin: 'md' } : {}),
    }));
}
