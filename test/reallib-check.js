/**
 * 真实库自检：node test/reallib-check.js [文档ID]
 *
 * 和 export.js 的区别：这里连的是**真的思源内核**（127.0.0.1:6806）和**真的工作空间**，
 * 用真 kramdown 跑一次 exportAssets，然后把导出结果逐条对回磁盘核对。
 * 只读思源库 + 在临时目录写副本，不改任何笔记、不动 assets/。
 *
 * 不给文档ID时默认用「（二）发表论文」（本机附件最多的那篇，含图片）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const crypto = require("crypto");

const DOC = process.argv[2] || "20261004175308-5xyah7e";
const WS = "C:/Users/asus/SiYuan";
const SRC = path.join(__dirname, "..", "index.js");

function fetchSyncPost(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: 6806, path: url, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("返回不是 JSON：" + url)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const sandbox = {
  module: { exports: {} }, console, Date, Buffer, Math, JSON, RegExp, String, Number,
  Object, Array, Set, Map, Promise, setTimeout, requestAnimationFrame: () => 0,
  window: { siyuan: { config: { system: { workspaceDir: WS } } } },
  document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
  require: (name) => {
    if (name === "siyuan") return { Plugin: class {}, showMessage() {}, fetchSyncPost };
    return require(name);
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, "utf8")
  + "\nmodule.exports = { exportAssets, buildExportPlan, workspaceAssetsDir };", sandbox);
const { exportAssets, buildExportPlan } = sandbox.module.exports;

const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log("  ok   " + name); } else {
    fail += 1;
    console.log("  FAIL " + name + (extra !== undefined ? "\n       " + extra : ""));
  }
}

(async () => {
  console.log("文档 " + DOC + "\n工作空间 " + WS + "\n");

  const rep = await exportAssets(DOC);
  console.log("报告：", JSON.stringify({
    dir: rep.dir, total: rep.total, images: rep.images,
    bytes: rep.bytes, missing: rep.missing.length, failed: rep.failed.length,
  }, null, 2), "\n");

  check("建了导出目录", !!rep.dir && fs.existsSync(rep.dir), rep.dir);
  check("目录落在 %TEMP% 下", path.dirname(rep.dir) === path.resolve(os.tmpdir()).replace(/\\/g, "/")
    || path.dirname(rep.dir) === os.tmpdir(), path.dirname(rep.dir));
  check("有导出内容", rep.total > 0, rep.total);
  check("含图片", rep.images > 0, rep.images);
  check("无失败", rep.failed.length === 0, JSON.stringify(rep.failed.slice(0, 3)));

  const names = fs.readdirSync(rep.dir).sort();
  check("文件数 = 报告数", names.length === rep.total, names.length + " vs " + rep.total);
  check("全部 3 位编号", names.every((n) => /^\d{3,}-/.test(n)), names.slice(0, 3).join(","));
  check("编号连续 001..N",
    names.every((n, i) => n.startsWith(String(i + 1).padStart(3, "0") + "-")), names.slice(0, 3).join(","));
  check("不含 %20 残留", names.every((n) => n.indexOf("%") < 0), names.filter((n) => n.indexOf("%") >= 0).join(","));
  check("不含时间戳尾巴", names.every((n) => !/-\d{14}-[a-z0-9]{6,10}\.[A-Za-z0-9]+$/i.test(n)),
    names.filter((n) => /-\d{14}-[a-z0-9]{6,10}\.[A-Za-z0-9]+$/i.test(n)).slice(0, 3).join(","));

  // 逐条把 001- 之后的原名对回 assets/，比 md5
  const assetsDir = path.join(WS, "data", "assets");
  let bad = 0;
  for (const outName of names) {
    const orig = outName.replace(/^\d+-/, "");
    // 剥戳后要回原文件：按词干在 assets/ 里找同词干的唯一文件
    const stem = orig.replace(/\.[^.]+$/, "");
    const hit = fs.readdirSync(assetsDir).filter((f) => {
      const m = /^(.*)-(\d{14})-([a-z0-9]{6,10})(\.[^.]+)?$/i.exec(f);
      const fStem = m ? m[1] + (m[4] || "") : f;
      return fStem === orig;
    });
    if (hit.length !== 1) { bad += 1; continue; }
    if (md5(path.join(rep.dir, outName)) !== md5(path.join(assetsDir, hit[0]))) bad += 1;
  }
  check("每个导出文件的 md5 都对得上原附件", bad === 0, bad + " 个不一致");

  console.log("\n前 5 个文件名：");
  names.slice(0, 5).forEach((n) => console.log("  " + n));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  console.log("（导出目录保留在：" + rep.dir + "，核对完可自行删除）");
  process.exit(fail ? 1 : 0);
})();
