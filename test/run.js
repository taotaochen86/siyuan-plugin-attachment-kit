/**
 * 判定层单测：node test/run.js
 *
 * 做法：把 index.js 里 CUT-LOGIC-END 之前的纯逻辑段切出来，
 * 用 vm 加一个假的 siyuan 模块跑起来，然后逐项断言。
 * 不装思源、不改任何文件。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.js");
const raw = fs.readFileSync(SRC, "utf8");
const cut = raw.indexOf("/* ==== CUT-LOGIC-END ====");
if (cut < 0) throw new Error("找不到 CUT-LOGIC-END 标记，index.js 结构变了，请同步改本文件");

const head = raw.slice(0, cut);
const sandbox = {
  module: { exports: {} },
  console,
  Date,
  Buffer,
  window: {},
  require: (name) => {
    if (name === "siyuan") {
      return { Plugin: class {}, showMessage() {}, fetchSyncPost: async () => ({}) };
    }
    return require(name);
  },
};
vm.createContext(sandbox);
vm.runInContext(
  head +
    "\nmodule.exports = { splitName, planByAnchor, cleanAnchor, genStamp, STATUS_TEXT," +
    " stripTrailingIAL, rewriteLinks, parseLinks, assetPathsIn, hasAssetPath, RE_LINK," +
    " decodeAssetPath, buildExportPlan, exportName, fitFileName, pad3, makeExportFolderName, RE_ANY_ASSET };",
  sandbox
);

const M = sandbox.module.exports;
const { splitName, planByAnchor, cleanAnchor, stripTrailingIAL, rewriteLinks, parseLinks,
  assetPathsIn, hasAssetPath, decodeAssetPath, buildExportPlan, exportName, fitFileName,
  pad3, makeExportFolderName } = M;

const STAMP = "-20261103101532-e3bi598";
const STAMP2 = "-20261103105657-3d92x86";
let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
    console.log("  ok   " + name);
  } else {
    fail += 1;
    console.log("  FAIL " + name + "\n       got  " + g + "\n       want " + w);
  }
}

console.log("\n[1] splitName 拆词干 / 戳 / 扩展名");
eq("带戳", splitName("答辩材料示例" + STAMP + ".wps"),
  { stem: "答辩材料示例", stamp: STAMP, ext: ".wps" });
eq("无戳", splitName("报表_2026_11.wps"),
  { stem: "报表_2026_11", stamp: "", ext: ".wps" });
eq("多点名", splitName("a.b" + STAMP + ".wps"),
  { stem: "a.b", stamp: STAMP, ext: ".wps" });
eq("无扩展名", splitName("README" + STAMP),
  { stem: "README", stamp: STAMP, ext: "" });
eq("戳在扩展名之后（异常名）", splitName("A.wps" + STAMP),
  { stem: "A.wps", stamp: STAMP, ext: "" });

console.log("\n[2] cleanAnchor 剥 markdown 修饰");
eq("行内代码", cleanAnchor("`AAAAA.wps`"), "AAAAA.wps");
eq("粗体 **", cleanAnchor("**AAAAA.wps**"), "AAAAA.wps");
eq("粗体 __", cleanAnchor("__AAAAA.wps__"), "AAAAA.wps");
eq("删除线", cleanAnchor("~~AAAAA.wps~~"), "AAAAA.wps");
eq("斜体整串包裹", cleanAnchor("*AAAAA.wps*"), "AAAAA.wps");
eq("下划线不误伤", cleanAnchor("报表_2026_11.wps"), "报表_2026_11.wps");
eq("反斜杠转义", cleanAnchor("1\\. 报告.wps"), "1. 报告.wps");
eq("首尾空格", cleanAnchor("  AAAAA.wps  "), "AAAAA.wps");

console.log("\n[3] planByAnchor：目标名 = 词干 + 戳 + 后缀");
eq("已一致", planByAnchor("答辩材料示例.wps", "答辩材料示例" + STAMP + ".wps"),
  { status: "same" });
eq("锚带后缀·词干不同", planByAnchor("新名字.wps", "旧名字" + STAMP + ".wps"),
  { status: "ok", targetName: "新名字" + STAMP + ".wps" });
eq("锚无后缀·用原附件后缀", planByAnchor("AAAAA", "答辩材料" + STAMP + ".wps"),
  { status: "ok", targetName: "AAAAA" + STAMP + ".wps" });
eq("锚自带戳·不叠双份", planByAnchor("A" + STAMP + ".wps", "B" + STAMP + ".wps"),
  { status: "ok", targetName: "A" + STAMP + ".wps" });
eq("锚是行内代码", planByAnchor("`新名.wps`", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "新名" + STAMP + ".wps" });
eq("后缀不一致·不自动改", planByAnchor("AAAAA.doc", "AAAAA" + STAMP + ".wps"),
  { status: "ext_mismatch", targetName: "AAAAA" + STAMP + ".doc" });
eq("后缀大小写不同·允许", planByAnchor("AAAAA.WPS", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "AAAAA" + STAMP + ".WPS" });
eq("空格·原样保留且照改", planByAnchor("答辩 材料.wps", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "答辩 材料" + STAMP + ".wps", hasSpace: true });
eq("无空格·不被打标记", planByAnchor("答辩材料.wps", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "答辩材料" + STAMP + ".wps" });
eq("特殊字符过滤 /", planByAnchor("a/b.wps", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "ab" + STAMP + ".wps", filtered: true });
eq("特殊字符过滤 多个", planByAnchor("A:B*C?D.wps", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "ABCD" + STAMP + ".wps", filtered: true });
eq("特殊字符过滤 引号尖括号",
  planByAnchor('报告"终"版<1>.wps', "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "报告终版1" + STAMP + ".wps", filtered: true });
eq("特殊字符过滤 反斜杠", planByAnchor("C\\Users\\a.wps", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "CUsersa" + STAMP + ".wps", filtered: true });
eq("全是特殊字符 → 非法", planByAnchor("***", "旧名" + STAMP + ".wps"), { status: "illegal" });
eq("空锚文本", planByAnchor("", "旧名" + STAMP + ".wps"), { status: "empty" });
eq("只有点", planByAnchor(".", "旧名" + STAMP + ".wps"), { status: "illegal" });
eq("结尾点被去掉", planByAnchor("AAAAA.", "旧名" + STAMP + ".wps"),
  { status: "ok", targetName: "AAAAA" + STAMP + ".wps", filtered: true });
eq("正常名字不带 filtered", planByAnchor("AAAAA.wps", "旧名" + STAMP + ".wps").filtered, undefined);
eq("Windows 保留名", planByAnchor("CON.wps", "旧名" + STAMP + ".wps"), { status: "illegal" });
eq("超长名字", planByAnchor("长".repeat(120) + ".wps", "旧名" + STAMP + ".wps").status, "toolong");

const r = planByAnchor("报表.wps", "报表_2026_11.wps");
eq("无戳·补戳 status", r.status, "ok");
eq("补戳格式", /^报表-\d{14}-[a-z0-9]{7}\.wps$/.test(r.targetName), true);
const r2 = planByAnchor("报表.wps", "报表_2026_11.wps");
eq("两次补戳不同（随机码）", r.targetName === r2.targetName, false);

console.log("\n[4] stripTrailingIAL 只剥块尾");
eq("单个尾部 IAL",
  stripTrailingIAL('正文 [a](assets/x.wps)\n{: id="20260101000000-abcdefg" updated="20260101000000"}'),
  "正文 [a](assets/x.wps)");
eq("无 IAL", stripTrailingIAL("正文"), "正文");
eq("中间 IAL 保留",
  stripTrailingIAL('a\n{: id="x"}\nb'),
  'a\n{: id="x"}\nb');
eq("表格 colgroup 被剥",
  stripTrailingIAL('|a|b|\n| - | - |\n|c|d|\n{: id="t" colgroup="|"}'),
  '|a|b|\n| - | - |\n|c|d|');

console.log("\n[5] rewriteLinks 只改 assets 路径");
eq("普通",
  rewriteLinks("[a.wps](assets/old.wps)", "old.wps", "new.wps"),
  "[a.wps](assets/new.wps)");
eq("前导斜杠原样保留",
  rewriteLinks("[a.wps](/assets/old.wps)", "old.wps", "new.wps"),
  "[a.wps](/assets/new.wps)");
eq("带标题",
  rewriteLinks('[a.wps](assets/old.wps "标题")', "old.wps", "new.wps"),
  '[a.wps](assets/new.wps "标题")');
eq("正文提到名字不改",
  rewriteLinks("这是 old.wps 的说明", "old.wps", "new.wps"),
  "这是 old.wps 的说明");
eq("同段两个链接都改",
  rewriteLinks("[a](assets/old.wps) 与 [b](assets/old.wps)", "old.wps", "new.wps"),
  "[a](assets/new.wps) 与 [b](assets/new.wps)");
eq("不误伤名字更长的别的文件",
  rewriteLinks("[a](assets/old.wps.bak)", "old.wps", "new.wps"),
  "[a](assets/old.wps.bak)");
eq("图片链接也一并改",
  rewriteLinks("![图](assets/old.wps)", "old.wps", "new.wps"),
  "![图](assets/new.wps)");

console.log("\n[6] parseLinks 解析");
eq("普通链接",
  parseLinks("[a.wps](assets/x" + STAMP + ".wps)").map((x) => [x.anchor, x.rawPath]),
  [["a.wps", "assets/x" + STAMP + ".wps"]]);
eq("带标题",
  parseLinks('[a](assets/x.wps "t")').map((x) => [x.rawPath, x.titlePart]),
  [["assets/x.wps", ' "t"']]);
eq("路径含空格",
  parseLinks("[a](assets/x y.wps)").map((x) => x.rawPath),
  ["assets/x y.wps"]);
eq("图片不匹配",
  parseLinks("![图](assets/x.png)").length, 0);
eq("网络链接不匹配",
  parseLinks("[a](https://a.com/x.wps)").length, 0);
eq("两个链接",
  parseLinks("[a](assets/1.wps) 和 [b](assets/2.wps)").length, 2);
eq("锚文本含方括号内文字",
  parseLinks("[看这里](assets/1.wps)").map((x) => x.anchor), ["看这里"]);

console.log("\n[7] 路径精确匹配（新名以旧名结尾也不会误判）");
const OLD7 = "甲" + STAMP + ".wps";
const NEW7 = "新甲" + STAMP + ".wps";
eq("新名含旧名·能正确替换",
  rewriteLinks("[x](assets/" + OLD7 + ")", OLD7, NEW7),
  "[x](assets/" + NEW7 + ")");
eq("替换后旧名不再算存在", hasAssetPath("[x](assets/" + NEW7 + ")", OLD7), false);
eq("替换后新名算存在", hasAssetPath("[x](assets/" + NEW7 + ")", NEW7), true);
eq("名字是别的文件的前缀·不动",
  rewriteLinks("[x](assets/报告.wps.bak)", "报告.wps", "新报告.wps"),
  "[x](assets/报告.wps.bak)");
eq("路径提取（带标题）", assetPathsIn('[x](assets/a.wps "t")'), ["a.wps"]);
eq("路径提取（前导斜杠）", assetPathsIn("[x](/assets/a.wps)"), ["a.wps"]);
eq("路径提取（两个）", assetPathsIn("[a](assets/1.wps) [b](assets/2.wps)"), ["1.wps", "2.wps"]);

console.log("\n[8] decodeAssetPath 解码 %20 残留");
eq("无编码原样", decodeAssetPath("assets/报告.pdf"), "assets/报告.pdf");
eq("%20 解码", decodeAssetPath("assets/a%20b.pdf"), "assets/a b.pdf");
eq("%E4%B8%AD 解码", decodeAssetPath("assets/%E4%B8%AD.pdf"), "assets/中.pdf");
eq("前导斜杠去掉", decodeAssetPath("/assets/a.pdf"), "assets/a.pdf");
eq("尾部空格去掉", decodeAssetPath("assets/a.pdf   "), "assets/a.pdf");
eq("畸形 % 不抛错", decodeAssetPath("assets/100%.pdf"), "assets/100%.pdf");

console.log("\n[9] pad3 / exportName 编号");
eq("1 → 001", pad3(1), "001");
eq("9 → 009", pad3(9), "009");
eq("10 → 010", pad3(10), "010");
eq("100 → 100", pad3(100), "100");
eq("1000 → 1000（超三位不截断）", pad3(1000), "1000");
eq("拼接", exportName(1, "报告.pdf"), "001-报告.pdf");
eq("拼接两位", exportName(12, "图.png"), "012-图.png");

console.log("\n[9.5] fitFileName 超长名截断（防 Windows 260 上限）");
eq("够短就原样不动", fitFileName("报告.pdf", 60), "报告.pdf");
eq("正好等于预算也原样", fitFileName("abcd.pdf", 8), "abcd.pdf");
{
  const long = "Yu-et-al.-2027-Straw-to-biochar-in-China-A-meta-analysis-of-long-term-field-trials.pdf";
  const got = fitFileName(long, 40);
  eq("超长被截到预算内", got.length <= 40, true);
  eq("扩展名保住", got.endsWith(".pdf"), true);
  eq("留下截断标记", got.includes("…"), true);
}
{
  const noExt = "x".repeat(80);
  const got = fitFileName(noExt, 30);
  eq("无扩展名也截到预算内", got.length <= 30, true);
  eq("无扩展名以 … 收尾", got.endsWith("…"), true);
}
eq("中文按字符数算", fitFileName("甲".repeat(50) + ".docx", 20).length <= 20, true);
eq("预算过小时仍给个非空名", fitFileName("一个很长的名字.pdf", 4).length > 0, true);

console.log("\n[10] buildExportPlan 按文档顺序抽附件");
const KD10 =
  "# 标题\n\n" +
  "第一段 [甲附件](assets/甲" + STAMP + ".pdf)\n\n" +
  "![乙图片](assets/乙" + STAMP2 + ".png)\n\n" +
  "第二段 [丙.doc](assets/丙" + STAMP + ".doc \"这是标题\")\n\n" +
  "- 列表 [丁](assets/丁" + STAMP2 + ".xlsx)\n";
eq("顺序 = 出现顺序",
  buildExportPlan(KD10).map((x) => x.displayName),
  ["甲.pdf", "乙.png", "丙.doc", "丁.xlsx"]);
eq("图片被识别", buildExportPlan(KD10).map((x) => x.isImage),
  [false, true, false, false]);
eq("带 title 的不多吃字符",
  buildExportPlan(KD10)[2].fileName, "丙" + STAMP + ".doc");
eq("stripStamp=false 时保留原文件名",
  buildExportPlan(KD10, { stripStamp: false })[0].displayName, "甲" + STAMP + ".pdf");

console.log("\n[11] buildExportPlan 去重 / 兼容写法 / 异常");
eq("同一附件两处链接只导一次",
  buildExportPlan("[a](assets/x" + STAMP + ".pdf) 和 [b](assets/x" + STAMP + ".pdf)")
    .map((x) => x.displayName), ["x.pdf"]);
eq("去重后占第一次出现的位置",
  buildExportPlan("![p](assets/p" + STAMP + ".png) [x](assets/x" + STAMP + ".pdf) [p2](assets/p" + STAMP + ".png)")
    .map((x) => x.displayName), ["p.png", "x.pdf"]);
eq("HTML <img src> 也抓",
  buildExportPlan('<img src="assets/h' + STAMP + '.jpg">').map((x) => x.displayName), ["h.jpg"]);
eq("前导斜杠 /assets/ 也抓",
  buildExportPlan("[a](/assets/s" + STAMP + ".pdf)").map((x) => x.fileName),
  ["s" + STAMP + ".pdf"]);
eq("%20 链接解码成真文件名",
  buildExportPlan("[a](assets/a%20b" + STAMP + ".pdf)").map((x) => x.fileName),
  ["a b" + STAMP + ".pdf"]);
eq("assets/assets/ 重复前缀不导出",
  buildExportPlan("[a](assets/assets/x.pdf)").length, 0);
eq("网络链接不抓",
  buildExportPlan("[a](https://a.com/x.pdf)").length, 0);
eq("空文档", buildExportPlan(""), []);
eq("非法字符被清洗",
  buildExportPlan("[a](assets/报告%3A终版.pdf)").map((x) => x.displayName), ["报告终版.pdf"]);
eq("带空格文件名原样保留",
  buildExportPlan("[a](assets/答辩 材料" + STAMP + ".pdf)").map((x) => x.displayName),
  ["答辩 材料.pdf"]);

// 剥戳后撞名：两份同名不同戳 → 第二个加 -2，扩展名不被吃掉
const KD11 = "[a](assets/x_asset_031-20261004174122-AAAAAAAA.pdf) " +
  "[b](assets/x_asset_031-20261004174122-BBBBBBBB.pdf)";
eq("剥戳撞名 → -2",
  buildExportPlan(KD11).map((x) => x.displayName),
  ["x_asset_031.pdf", "x_asset_031-2.pdf"]);

console.log("\n[12] makeExportFolderName 随机文件夹名");
const F1 = makeExportFolderName();
const F2 = makeExportFolderName();
eq("带中文前缀与时间戳", /^思源附件-\d{8}-\d{6}-[a-z0-9]{6}$/.test(F1), true);
eq("两次不重复", F1 !== F2, true);

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
