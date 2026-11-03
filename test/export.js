/**
 * 导出的端到端测试：node test/export.js
 *
 * 把整份 index.js 加载进 vm（假 siyuan 模块 + 假内核），造一个临时「思源工作空间」，
 * 真跑 exportAssets()：真建文件夹、真复制文件、真校验 md5。
 * 覆盖：顺序编号 / 图片 / 同一附件多处 / %20 解码 / 缺文件跳过且不占号 /
 *       文件名剥时间戳 / 一个都没有时不建目录 / 随机文件夹名。
 *
 * 全程只动系统临时目录，跑完删干净。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const SRC = path.join(__dirname, "..", "index.js");
const raw = fs.readFileSync(SRC, "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra !== undefined ? "\n       " + extra : "")); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name + (g === w ? "" : `\n       got  ${g}\n       want ${w}`), g === w);
}
const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");

/* ---------------- 造临时工作空间 ---------------- */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "aa-ws-"));
const ASSETS = path.join(WS, "data", "assets");
fs.mkdirSync(ASSETS, { recursive: true });

const S1 = "-20261103101532-e3bi598";
const S2 = "-20261103105657-3d92x86";

const FILES = [
  ["甲" + S1 + ".pdf", "A"],
  ["乙" + S2 + ".png", "B"],
  ["丙" + S1 + ".doc", "D"],
  ["a b" + S1 + ".pdf", "C"],
  ["丁" + S2 + ".xlsx", "E"],
];
const expectMd5 = {};
for (const [name, body] of FILES) {
  fs.writeFileSync(path.join(ASSETS, name), body);
  expectMd5[name] = md5(path.join(ASSETS, name));
}

// 超长文件名：200 字符词干 + .pdf，用来测「Windows 260 上限」的截断
const LONG_STEM = "L".repeat(200);
const LONG_NAME = LONG_STEM + ".pdf";
fs.writeFileSync(path.join(ASSETS, LONG_NAME), "LONG");
const longMd5 = md5(path.join(ASSETS, LONG_NAME));

// 「缺.pdf」故意不创建，用来测缺文件跳过
const KD = [
  "# 一篇带附件的文档",
  "",
  "第一段 [甲附件](assets/甲" + S1 + ".pdf)",
  "",
  "![乙图片](assets/乙" + S2 + ".png)",
  "",
  "这里是个断链 [缺](assets/缺" + S1 + ".pdf)",
  "",
  "带标题 [丙.doc](assets/丙" + S1 + '.doc "这是标题")',
  "",
  "再来一次 [甲第二次](assets/甲" + S1 + ".pdf)",
  "",
  "编码过的 [空 格](assets/a%20b" + S1 + ".pdf)",
  "",
  "- 列表 [丁](assets/丁" + S2 + ".xlsx)",
  "",
].join("\n");

/* ---------------- 加载插件（假运行环境） ---------------- */
const calls = [];
const sandbox = {
  module: { exports: {} },
  console,
  Date,
  Buffer,
  Math,
  JSON,
  RegExp,
  String,
  Number,
  Object,
  Array,
  Set,
  Map,
  Promise,
  setTimeout,
  requestAnimationFrame: () => 0,
  window: { siyuan: { config: { system: { workspaceDir: WS } } } },
  document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
  require: (name) => {
    if (name === "siyuan") {
      return {
        Plugin: class {},
        showMessage() {},
        fetchSyncPost: async (url, payload) => {
          calls.push(url);
          if (url === "/api/block/getBlockKramdown") {
            if (payload && payload.id === "docid") {
              return { code: 0, data: { kramdown: KD } };
            }
            if (payload && payload.id === "emptydoc") {
              return { code: 0, data: { kramdown: "# 空文档\n\n没有附件。" } };
            }
            if (payload && payload.id === "longdoc") {
              return { code: 0, data: { kramdown: "[超长](assets/" + LONG_NAME + ")\n" } };
            }
            if (payload && payload.id === "missingdoc") {
              return {
                code: 0,
                data: { kramdown: "[甲](assets/没有甲" + S1 + ".pdf)\n\n[乙](assets/没有乙" + S2 + ".png)\n" },
              };
            }
            return { code: 0, data: { kramdown: "" } };
          }
          return { code: 0 };
        },
      };
    }
    return require(name);
  },
};
vm.createContext(sandbox);

let loaded = null;
try {
  vm.runInContext(
    raw + "\nmodule.exports = { exportAssets, buildExportPlan, makeExportFolderName };",
    sandbox
  );
  loaded = sandbox.module.exports;
} catch (e) {
  console.log("  FAIL 加载 index.js 失败：" + e.message);
  process.exit(1);
}
const { exportAssets } = loaded;

/* ---------------- 跑 ---------------- */
(async () => {
  console.log("\n[1] 正常导出");
  const rep = await exportAssets("docid");

  check("建了导出目录", !!rep.dir && fs.existsSync(rep.dir), rep.dir);
  check("目录在系统临时目录下", path.dirname(rep.dir) === os.tmpdir(), rep.dir);
  check("文件夹名是随机形态",
    /^思源附件-\d{8}-\d{6}-[a-z0-9]{6}$/.test(path.basename(rep.dir)), path.basename(rep.dir));
  eq("导出 5 个", rep.total, 5);
  eq("其中 1 张图片", rep.images, 1);
  eq("缺 1 个", rep.missing.length, 1);
  eq("失败 0 个", rep.failed.length, 0);

  const names = fs.readdirSync(rep.dir).sort();
  eq("文件名与顺序（缺文件不占号）", names, [
    "001-甲.pdf",
    "002-乙.png",
    "003-丙.doc",
    "004-a b.pdf",
    "005-丁.xlsx",
  ]);
  check("编号连续无空号",
    names.every((n, i) => n.startsWith(String(i + 1).padStart(3, "0") + "-")));

  const pairs = [
    ["001-甲.pdf", "甲" + S1 + ".pdf"],
    ["002-乙.png", "乙" + S2 + ".png"],
    ["003-丙.doc", "丙" + S1 + ".doc"],
    ["004-a b.pdf", "a b" + S1 + ".pdf"],
    ["005-丁.xlsx", "丁" + S2 + ".xlsx"],
  ];
  for (const [out, src] of pairs) {
    check("内容一致 " + out, md5(path.join(rep.dir, out)) === expectMd5[src]);
  }

  eq("同一附件只导一次（甲 没有 006）",
    names.filter((n) => n.indexOf("甲") >= 0).length, 1);
  eq("缺文件不占号（没有 006-缺.pdf）",
    names.some((n) => n.indexOf("缺") >= 0), false);
  check("bytes 统计为正", rep.bytes > 0, rep.bytes);

  console.log("\n[2] 再点一次：换新文件夹，不覆盖上一批");
  const rep2 = await exportAssets("docid");
  check("两次目录不同", rep2.dir !== rep.dir, rep2.dir);
  check("上一批仍在", fs.existsSync(path.join(rep.dir, "001-甲.pdf")));
  check("新一批也在", fs.existsSync(path.join(rep2.dir, "001-甲.pdf")));

  console.log("\n[3] 没有附件时不建目录");
  const rep3 = await exportAssets("emptydoc");
  eq("dir 为空", rep3.dir, "");
  eq("导出 0 个", rep3.total, 0);
  eq("失败 0 个", rep3.failed.length, 0);

  console.log("\n[4] 全部附件都缺失时也不建目录");
  const rep4 = await exportAssets("missingdoc");
  eq("dir 为空", rep4.dir, "");
  eq("导出 0 个", rep4.total, 0);
  eq("缺 2 个都报出来", rep4.missing.length, 2);

  console.log("\n[5] 超长文件名按预算截断（防 Windows 260 上限）");
  const rep5 = await exportAssets("longdoc");
  eq("导出 1 个", rep5.total, 1);
  eq("报了 1 个被截断", rep5.trimmed.length, 1);
  const got5 = fs.readdirSync(rep5.dir);
  eq("目录里就 1 个文件", got5.length, 1);
  const full5 = path.join(rep5.dir, got5[0]);
  check("全路径不超过 250 字符", full5.length <= 250, full5.length);
  check("扩展名保住", got5[0].endsWith(".pdf"), got5[0]);
  check("带编号前缀", got5[0].startsWith("001-"), got5[0]);
  check("内容仍与原文件一致", md5(full5) === longMd5);
  eq("失败 0 个", rep5.failed.length, 0);

  /* ---------------- 清理 ---------------- */
  for (const d of [rep.dir, rep2.dir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
