/**
 * 执行引擎测试：node test/engine.js
 *
 * 把 index.js 的逻辑段（CUT-LOGIC-END 之前）加载进 vm，用「假内核 + 临时目录」
 * 把 executeRenames / scanDocument 的每条分支跑一遍：
 *   成功改名 / 容器块不被误改 / 中途失败回滚 / 复查有残留回滚 /
 *   附件缺失 / 目标被占 / 一条引用都没改到 / 两个文件同时改 / 扫描判定
 *
 * 全程不碰真实思源库，文件都造在系统临时目录里，跑完删掉。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "index.js");
const raw = fs.readFileSync(SRC, "utf8");
const cut = raw.indexOf("/* ==== CUT-LOGIC-END ====");
if (cut < 0) throw new Error("找不到 CUT-LOGIC-END 标记");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + (extra !== undefined ? "\n       " + extra : "")); }
}

/* ---------------- 假内核 ---------------- */
const RE_PATH = /(\/?assets\/)([^)"\n]*)/g;
function pathsOf(k) {
  const out = [];
  const re = new RegExp(RE_PATH.source, "g");
  let m;
  while ((m = re.exec(String(k || ""))) !== null) out.push(m[2].replace(/\s+$/, ""));
  return out;
}
function textOf(k) {
  return String(k || "")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ x]\]\s*)?/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeKernel() {
  const K = {
    blocks: new Map(),
    failIds: new Set(),
    blocksQueryCount: 0,
    beforeSql: null,
    written: [],
    calls: { update: 0, read: 0 },
  };

  K.rootOf = (id) => {
    const b = K.blocks.get(id);
    if (!b) return "";
    return (b.path || "").split("/").filter(Boolean)[0] || "";
  };

  K.refresh = (id) => {
    const b = K.blocks.get(id);
    if (!b) return;
    // 真实思源的 blocks.content 里存的是完整 href（含 assets/ 前缀），这里照此模拟
    b.content = [textOf(b.kramdown), ...pathsOf(b.kramdown).map((p) => "assets/" + p)]
      .join(" ").trim();
  };

  // 把 other 块 kramdown 里的旧路径换成新路径（按位置对应，不按子串猜）
  K.syncPaths = (other, a, b) => {
    if (a.length !== b.length) return;
    a.forEach((p, i) => {
      if (p !== b[i]) {
        other.kramdown = other.kramdown.split("assets/" + p).join("assets/" + b[i]);
      }
    });
    const oid = [...K.blocks.entries()].find((e) => e[1] === other);
    if (oid) K.refresh(oid[0]);
  };

  // 内核在子块更新后会重建祖先块的 DOM，子孙块也跟着变，这里照此模拟
  K.propagate = (id, oldK, newK) => {
    const a = pathsOf(oldK);
    const b = pathsOf(newK);
    if (a.length !== b.length) return;
    const bPath = K.blocks.get(id).path;
    for (const [oid, other] of K.blocks) {
      if (oid === id) continue;
      const op = other.path || "";
      const isDescendant = op.indexOf(bPath + "/") === 0;
      const isAncestor = bPath.indexOf(op + "/") === 0;
      if (isDescendant || isAncestor) K.syncPaths(other, a, b);
    }
  };

  K.fetchSyncPost = async (url, payload) => {
    if (url === "/api/query/sql") {
      const stmt = payload.stmt;
      if (K.beforeSql) K.beforeSql(stmt);

      if (stmt.indexOf("FROM assets") !== -1) {
        const m = /name='((?:[^']|'')*)'/.exec(stmt);
        return { code: 0, data: m ? [] : [] };
      }
      if (stmt.indexOf("FROM blocks") !== -1) {
        K.blocksQueryCount += 1;
        const rootM = /root_id='((?:[^']|'')*)'/.exec(stmt);
        const needleM = /instr\(content,'((?:[^']|'')*)'\)/.exec(stmt);
        const needle = needleM ? needleM[1].replace(/''/g, "'") : null;
        const onlyType = /type<>'d'/.test(stmt);
        const rootId = rootM ? rootM[1] : null;
        const rows = [];
        for (const [id, b] of K.blocks) {
          if (onlyType && b.type === "d") continue;
          if (rootId !== null && K.rootOf(id) !== rootId) continue;
          if (needle !== null && (b.content || "").indexOf(needle) === -1) continue;
          rows.push({ id, type: b.type, path: b.path || "", content: b.content || "" });
        }
        return { code: 0, data: rows };
      }
      return { code: 0, data: [] };
    }
    if (url === "/api/block/getBlockKramdown") {
      K.calls.read += 1;
      const b = K.blocks.get(payload.id);
      if (!b) return { code: -1, msg: "块不存在" };
      return { code: 0, data: { kramdown: b.kramdown } };
    }
    if (url === "/api/block/updateBlock") {
      K.calls.update += 1;
      K.written.push(payload.id);
      const b = K.blocks.get(payload.id);
      if (!b) return { code: -1, msg: "块不存在" };
      if (K.failIds.has(payload.id)) return { code: -1, msg: "模拟写入失败" };
      const old = b.kramdown;
      b.kramdown = payload.data;
      K.refresh(payload.id);
      K.propagate(payload.id, old, payload.data);
      return { code: 0, data: {} };
    }
    return { code: 0, data: {} };
  };

  K.addBlock = (id, type, kramdown, parentPath) => {
    const b = { type, path: (parentPath || "") + "/" + id, kramdown, content: "" };
    K.blocks.set(id, b);
    K.refresh(id);
    return b;
  };
  return K;
}

function loadPlugin(kernel, workspace) {
  const sandbox = {
    module: { exports: {} },
    console,
    Date,
    Buffer,
    window: { siyuan: { config: { system: { workspaceDir: workspace } } } },
    require: (name) => {
      if (name === "siyuan") {
        return { Plugin: class {}, showMessage() {}, fetchSyncPost: kernel.fetchSyncPost };
      }
      return require(name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    raw.slice(0, cut) +
      "\nmodule.exports = { splitName, planByAnchor, executeRenames, findReferences," +
      " replaceReferences, scanDocument, workspaceAssetsDir, stripTrailingIAL," +
      " rewriteLinks, hasAssetPath };",
    sandbox
  );
  return sandbox.module.exports;
}

/* ---------------- 临时工作区 ---------------- */
const STAMP = "-20261103101532-e3bi598";
const STAMP2 = "-20261103101533-a1b2c3d";

function freshWorkspace(tag) {
  const ws = path.join(os.tmpdir(), "aa-engine-" + tag + "-" + process.pid + "-" + Date.now());
  fs.mkdirSync(path.join(ws, "data", "assets"), { recursive: true });
  return ws;
}
function writeAsset(ws, name, body) {
  fs.writeFileSync(path.join(ws, "data", "assets", name), body || ("body of " + name), "utf8");
}
function exists(ws, name) {
  return fs.existsSync(path.join(ws, "data", "assets", name));
}
function backups(ws) {
  const root = path.join(ws, "data", "anchor-backup");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, d))) out.push(f);
  }
  return out;
}
function cleanup(ws) {
  fs.rmSync(ws, { recursive: true, force: true });
}

/* ================= 1. 成功路径 + 容器块不被误改 ================= */
async function caseSuccess() {
  console.log("\n[1] 成功改名：多块型引用，容器块只跟着内核重建、不自己重写");
  const ws = freshWorkspace("ok");
  const A = "旧名甲" + STAMP + ".wps";
  writeAsset(ws, A, "AAA");

  const K = makeKernel();
  K.addBlock("doc1", "d", "# 标题 [新名甲.wps](assets/" + A + ")", "");
  K.addBlock("h1", "h", "## 标题 [新名甲.wps](assets/" + A + ")\n{: id=\"h1\"}", "/doc1");
  K.addBlock("l1", "l", "- 列表 [新名甲.wps](assets/" + A + ")\n  {: id=\"p1\"}\n{: id=\"l1\"}", "/doc1");
  K.addBlock("i1", "i", "- {: id=\"p1\"}列表 [新名甲.wps](assets/" + A + ")\n{: id=\"i1\"}", "/doc1/l1");
  K.addBlock("p1", "p", "列表 [新名甲.wps](assets/" + A + ")\n{: id=\"p1\"}", "/doc1/l1/i1");
  K.addBlock("t1", "t", "|a|b|\n| - | - |\n|[新名甲.wps](assets/" + A + ")|x|\n{: id=\"t1\" colgroup=\"|\"}", "/doc1");
  K.addBlock("p2", "p", "正文提到旧名甲" + STAMP + ".wps 但没有 assets/ 前缀\n{: id=\"p2\"}", "/doc1");

  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([{ fileName: A, targetName: "新名甲" + STAMP + ".wps", status: "ok" }]);

  check("改名计数 1", rep.renamed === 1, JSON.stringify(rep));
  check("引用块计数 3（h1 + p1 + t1）", rep.refs === 3, "refs=" + rep.refs);
  check("新文件存在", exists(ws, "新名甲" + STAMP + ".wps"));
  check("旧文件已删", !exists(ws, A));
  check("备份留了原名", backups(ws).includes(A), JSON.stringify(backups(ws)));
  check("列表容器 l 自己没被写", !K.written.includes("l1"), JSON.stringify(K.written));
  check("内容块 p1 已改", P.hasAssetPath(K.blocks.get("p1").kramdown, "新名甲" + STAMP + ".wps"));
  check("标题块已改", P.hasAssetPath(K.blocks.get("h1").kramdown, "新名甲" + STAMP + ".wps"));
  check("表格块已改", P.hasAssetPath(K.blocks.get("t1").kramdown, "新名甲" + STAMP + ".wps"));
  check("表格 kramdown 没被塞进 IAL", K.blocks.get("t1").kramdown.indexOf("{:") === -1,
    K.blocks.get("t1").kramdown);
  check("纯正文提到的名字没被改", K.blocks.get("p2").kramdown.indexOf("旧名甲") !== -1);
  check("文档块没被当成引用块重写", !K.written.includes("doc1"), JSON.stringify(K.written));
  check("容器块没被写（i1）", !K.written.includes("i1"), JSON.stringify(K.written));
  check("只写了 h1/p1/t1 三个块", K.written.filter((x) => x !== "doc1").length === 3,
    JSON.stringify(K.written));

  cleanup(ws);
}

/* ================= 2. 中途写入失败 → 全量回滚 ================= */
async function caseRollbackOnFailure() {
  console.log("\n[2] 中途写入失败：已改的块要还原、新文件要删、旧文件要留");
  const ws = freshWorkspace("rb");
  const A = "旧名乙" + STAMP + ".wps";
  writeAsset(ws, A, "BBB");

  const K = makeKernel();
  K.addBlock("doc2", "d", "", "");
  const p1 = K.addBlock("q1", "p", "[新名乙.wps](assets/" + A + ")\n{: id=\"q1\"}", "/doc2");
  const p2 = K.addBlock("q2", "p", "另一个 [新名乙.wps](assets/" + A + ")\n{: id=\"q2\"}", "/doc2");
  const before = { q1: p1.kramdown, q2: p2.kramdown };
  K.failIds.add("q2");

  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([{ fileName: A, targetName: "新名乙" + STAMP + ".wps", status: "ok" }]);

  check("没有算成成功", rep.renamed === 0, JSON.stringify(rep));
  check("有 1 条失败记录", rep.failed.length === 1, JSON.stringify(rep.failed));
  check("旧文件仍在", exists(ws, A));
  check("新文件已删", !exists(ws, "新名乙" + STAMP + ".wps"));
  check("已改的块 q1 被还原", P.stripTrailingIAL(K.blocks.get("q1").kramdown) === P.stripTrailingIAL(before.q1),
    JSON.stringify(K.blocks.get("q1").kramdown));
  check("失败的块 q2 原样", K.blocks.get("q2").kramdown === before.q2);
  check("q1 里没有残留新名", !P.hasAssetPath(K.blocks.get("q1").kramdown, "新名乙" + STAMP + ".wps"));

  cleanup(ws);
}

/* ================= 3. 复查有残留 → 回滚 ================= */
async function caseLeftover() {
  console.log("\n[3] 改完后复查发现还有块引用旧名：不许删旧文件");
  const ws = freshWorkspace("left");
  const A = "旧名丙" + STAMP + ".wps";
  writeAsset(ws, A, "CCC");

  const K = makeKernel();
  K.addBlock("doc3", "d", "", "");
  K.addBlock("r1", "p", "[新名丙.wps](assets/" + A + ")\n{: id=\"r1\"}", "/doc3");

  let blocksQueries = 0;
  K.beforeSql = (stmt) => {
    if (stmt.indexOf("FROM blocks") === -1) return;
    blocksQueries += 1;
    // 第 2 次查询就是「复查」，这时悄悄出现一个改不动的引用块
    if (blocksQueries === 2) {
      K.addBlock("ghost", "p", "[x](assets/" + A + ")\n{: id=\"ghost\"}", "/doc3");
      K.failIds.add("ghost");
    }
  };

  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([{ fileName: A, targetName: "新名丙" + STAMP + ".wps", status: "ok" }]);

  check("没有算成成功", rep.renamed === 0, JSON.stringify(rep));
  check("旧文件仍在", exists(ws, A));
  check("新文件已删", !exists(ws, "新名丙" + STAMP + ".wps"));
  check("失败原因提到回滚", /回滚/.test((rep.failed[0] || {}).reason || ""), JSON.stringify(rep.failed));

  cleanup(ws);
}

/* ================= 4. 前置检查 ================= */
async function casePrecheck() {
  console.log("\n[4] 前置检查：附件不在磁盘 / 目标名已被占用");
  const ws = freshWorkspace("pre");
  const A = "不存在" + STAMP + ".wps";
  const B = "占用源" + STAMP + ".wps";
  writeAsset(ws, B, "DDD");
  writeAsset(ws, "占用目标" + STAMP + ".wps", "already here");

  const K = makeKernel();
  K.addBlock("doc4", "d", "", "");

  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([
    { fileName: A, targetName: "不存在" + STAMP + ".wps", status: "ok" },
    { fileName: B, targetName: "占用目标" + STAMP + ".wps", status: "ok" },
  ]);
  check("两个都没改", rep.renamed === 0, JSON.stringify(rep));
  check("1 条 failed（磁盘没有）", rep.failed.length === 1, JSON.stringify(rep.failed));
  check("1 条 skipped（目标被占）", rep.skipped.length === 1, JSON.stringify(rep.skipped));
  check("占用源文件没被动", exists(ws, B));

  cleanup(ws);
}

/* ================= 5. 一条引用都没改到 ================= */
async function caseNoRefChanged() {
  console.log("\n[5] 一条引用都没改到：绝不删旧文件");
  const ws = freshWorkspace("noref");
  const A = "孤儿" + STAMP + ".wps";
  writeAsset(ws, A, "EEE");
  const K = makeKernel();
  K.addBlock("doc5", "d", "", "");
  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([{ fileName: A, targetName: "孤儿新" + STAMP + ".wps", status: "ok" }]);
  check("没算成功", rep.renamed === 0, JSON.stringify(rep));
  check("旧文件仍在", exists(ws, A));
  check("新文件已删", !exists(ws, "孤儿新" + STAMP + ".wps"));
  cleanup(ws);
}

/* ================= 6. 两个文件同时改 ================= */
async function caseTwoFiles() {
  console.log("\n[6] 两个文件同时改（其中一段同时含两个链接）");
  const ws = freshWorkspace("two");
  const A = "甲" + STAMP + ".wps";
  const B = "乙" + STAMP2 + ".wps";
  writeAsset(ws, A, "A");
  writeAsset(ws, B, "B");

  const K = makeKernel();
  K.addBlock("doc6", "d", "", "");
  K.addBlock("m1", "p", "[新甲.wps](assets/" + A + ")\n{: id=\"m1\"}", "/doc6");
  K.addBlock("m2", "p", "[新甲.wps](assets/" + A + ") 与 [新乙.wps](assets/" + B + ")\n{: id=\"m2\"}", "/doc6");
  K.addBlock("m3", "p", "[新乙.wps](assets/" + B + ")\n{: id=\"m3\"}", "/doc6");

  const P = loadPlugin(K, ws);
  const rep = await P.executeRenames([
    { fileName: A, targetName: "新甲" + STAMP + ".wps", status: "ok" },
    { fileName: B, targetName: "新乙" + STAMP2 + ".wps", status: "ok" },
  ]);
  check("改名 2 个", rep.renamed === 2, JSON.stringify(rep));
  check("引用 4 处（m1 + m2 两次 + m3）", rep.refs === 4, "refs=" + rep.refs);
  check("m2 两个名字都换好",
    P.hasAssetPath(K.blocks.get("m2").kramdown, "新甲" + STAMP + ".wps")
    && P.hasAssetPath(K.blocks.get("m2").kramdown, "新乙" + STAMP2 + ".wps"),
    K.blocks.get("m2").kramdown);
  check("两个旧文件都删了", !exists(ws, A) && !exists(ws, B));
  check("两个新文件都在", exists(ws, "新甲" + STAMP + ".wps") && exists(ws, "新乙" + STAMP2 + ".wps"));

  cleanup(ws);
}

/* ================= 7. 扫描判定 ================= */
async function caseScan() {
  console.log("\n[7] 扫描层：特殊字符过滤 / 重名目标 / 磁盘缺失 / 目标被占");
  const ws = freshWorkspace("scan");
  const A = "扫描甲" + STAMP + ".wps";
  const B = "扫描乙" + STAMP + ".wps";
  const C = "扫描丙" + STAMP + ".wps";
  const D = "占位源" + STAMP + ".wps";
  const E = "扫描戊" + STAMP + ".wps";
  writeAsset(ws, A, "a");
  writeAsset(ws, B, "b");
  writeAsset(ws, D, "d");
  writeAsset(ws, E, "e");
  writeAsset(ws, "占位" + STAMP + ".wps", "已存在");
  // C 故意不落盘

  const K = makeKernel();
  K.addBlock("doc7", "d", "", "");
  K.addBlock("s1", "p", "[同名.wps](assets/" + A + ")", "/doc7");
  K.addBlock("s2", "p", "[同名.wps](assets/" + B + ")", "/doc7");
  K.addBlock("s3", "p", "[丙.wps](assets/" + C + ")", "/doc7");
  K.addBlock("s4", "p", "[占位.wps](assets/" + D + ")", "/doc7");
  K.addBlock("s5", "p", "[报告/终:版.wps](assets/" + E + ")", "/doc7");

  const P = loadPlugin(K, ws);
  const items = await P.scanDocument("doc7");
  const byBlock = {};
  items.forEach((it) => { byBlock[it.blockId] = it; });

  check("扫出 5 条", items.length === 5, JSON.stringify(items.map((i) => i.blockId + ":" + i.status)));
  check("两个不同附件算出同名目标 → dup_target", byBlock.s1.status === "dup_target", byBlock.s1.status);
  check("同上", byBlock.s2.status === "dup_target", byBlock.s2.status);
  check("磁盘缺失 → missing", byBlock.s3.status === "missing", byBlock.s3.status);
  check("目标名已被占 → conflict", byBlock.s4.status === "conflict", byBlock.s4.status);
  check("特殊字符被过滤后仍可改", byBlock.s5.status === "ok", byBlock.s5.status);
  check("过滤后名字=" + "报告终版" + STAMP + ".wps",
    byBlock.s5.targetName === "报告终版" + STAMP + ".wps", byBlock.s5.targetName);
  check("过滤标记为真", byBlock.s5.filtered === true);

  cleanup(ws);
}

/* ================= 8. 幂等：改完再扫，全部 same ================= */
async function caseIdempotent() {
  console.log("\n[8] 幂等：改完再扫一遍，应当没有可改项");
  const ws = freshWorkspace("idem");
  const A = "幂等旧" + STAMP + ".wps";
  writeAsset(ws, A, "x");

  const K = makeKernel();
  K.addBlock("doc8", "d", "", "");
  K.addBlock("k1", "p", "[幂等新.wps](assets/" + A + ")", "/doc8");

  const P = loadPlugin(K, ws);
  const first = await P.scanDocument("doc8");
  check("第一次扫出 1 条可改", first.filter((i) => i.status === "ok").length === 1,
    JSON.stringify(first.map((i) => i.status)));

  await P.executeRenames(first.filter((i) => i.status === "ok"));

  const second = await P.scanDocument("doc8");
  check("第二次没有可改项", second.filter((i) => i.status === "ok").length === 0,
    JSON.stringify(second.map((i) => i.status)));
  check("第二次判为已一致", second[0] && second[0].status === "same", second[0] && second[0].status);

  cleanup(ws);
}

/* ================= 9. 同一附件被多处链接：只执行一次 ================= */
async function caseDuplicateLinks() {
  console.log("\n[9] 同一附件被两条链接指向：只改一次，不报假失败");
  const ws = freshWorkspace("dup");
  const A = "重复甲" + STAMP + ".wps";
  writeAsset(ws, A, "R");

  const K = makeKernel();
  K.addBlock("doc9", "d", "", "");
  K.addBlock("u1", "p", "[重复新.wps](assets/" + A + ")", "/doc9");
  K.addBlock("u2", "p", "另一段 [重复新.wps](assets/" + A + ")", "/doc9");

  const P = loadPlugin(K, ws);
  const items = await P.scanDocument("doc9");
  check("扫出 2 条（同一附件的两条链接）", items.length === 2, JSON.stringify(items.map((i) => i.status)));
  check("两条都可改", items.every((i) => i.status === "ok"), JSON.stringify(items.map((i) => i.status)));
  check("两条算出同一目标名 → 不判 multi",
    items[0].targetName === items[1].targetName && items[0].targetName === "重复新" + STAMP + ".wps",
    items[0].targetName + " / " + items[1].targetName);

  const rep = await P.executeRenames(items.filter((i) => i.status === "ok"));
  check("只改名 1 个", rep.renamed === 1, JSON.stringify(rep));
  check("没有假失败", rep.failed.length === 0, JSON.stringify(rep.failed));
  check("两个块都改到", rep.refs === 2, "refs=" + rep.refs);
  check("新文件在、旧文件没了", exists(ws, "重复新" + STAMP + ".wps") && !exists(ws, A));

  // 再扫一遍应当干净
  const again = await P.scanDocument("doc9");
  check("再扫没有可改项", again.filter((i) => i.status === "ok").length === 0,
    JSON.stringify(again.map((i) => i.status)));

  cleanup(ws);
}

/* ================= 10. 锚文本含空格：照改，空格原样保留 ================= */
async function caseSpaces() {
  console.log("\n[10] 锚文本含空格：照改，文件名与链接都原样留空格、不转 %20");
  const ws = freshWorkspace("space");
  const A = "旧 名" + STAMP + ".wps";
  writeAsset(ws, A, "sp");

  const K = makeKernel();
  K.addBlock("doc10", "d", "", "");
  K.addBlock("u1", "p", "[答辩 材料.wps](assets/" + A + ")\n{: id=\"u1\"}", "/doc10");

  const P = loadPlugin(K, ws);
  const items = await P.scanDocument("doc10");
  check("扫出 1 条且可改", items.length === 1 && items[0].status === "ok", JSON.stringify(items));
  check("目标名保留空格", items[0] && items[0].targetName === "答辩 材料" + STAMP + ".wps",
    items[0] && items[0].targetName);
  check("打了 hasSpace 标记", !!(items[0] && items[0].hasSpace));

  const rep = await P.executeRenames(items.filter((i) => i.status === "ok"));
  check("改名 1 个", rep.renamed === 1, JSON.stringify(rep));
  check("没有失败", rep.failed.length === 0, JSON.stringify(rep.failed));
  check("新文件带空格存在", exists(ws, "答辩 材料" + STAMP + ".wps"));
  check("旧文件已删", !exists(ws, A));

  const kd = K.blocks.get("u1").kramdown;
  check("kramdown 里是原样空格", kd.indexOf("assets/答辩 材料" + STAMP + ".wps") !== -1, kd);
  check("没有写成 %20", kd.indexOf("%20") === -1, kd);

  const again = await P.scanDocument("doc10");
  check("再扫没有可改项", again.filter((i) => i.status === "ok").length === 0,
    JSON.stringify(again.map((i) => i.status)));

  cleanup(ws);
}

(async () => {
  await caseSuccess();
  await caseRollbackOnFailure();
  await caseLeftover();
  await casePrecheck();
  await caseNoRefChanged();
  await caseTwoFiles();
  await caseScan();
  await caseIdempotent();
  await caseDuplicateLinks();
  await caseSpaces();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试脚本自身出错：", e);
  process.exit(2);
});
