// store.js — 小さなファイル保存（キーと文字列の組を JSON 1ファイルに書く）。
// ブラウザの localStorage と同じ感覚で使う：{ get(key), set(key, value) }
// 書き込みは1秒まとめてから行い、書きかけで壊れないよう一時ファイルから置き換える
"use strict";
const fs = require("fs"),
  path = require("path");

function fileStore(file) {
  let data = {}, timer = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {}
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(data));
      fs.renameSync(file + ".tmp", file);
    } catch (e) {
      console.error("store: 保存できませんでした", e.message);
    }
  };
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    set: (k, v) => {
      data[k] = String(v);
      timer ||= setTimeout(flush, 1000);
    },
    flush,
  };
}
module.exports = { fileStore };
