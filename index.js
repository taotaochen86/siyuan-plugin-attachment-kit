/**
 * 文档附件管家 (siyuan-plugin-attachment-kit)
 *
 * 两个功能，都从顶栏图标的下拉菜单进：
 *   1) 按锚文本改附件文件名（只扫当前文档；别处若引用同一文件，链接自动跟着改对以保住链），
 *      点即执行，不再二次确认
 *   2) 一键导出当前文档的全部附件（含图片）到随机命名的临时文件夹，按文档顺序编号 001-，导完弹窗
 *
 * 功能 1 的规则：
 *
 * 规则（只对齐词干，时间戳-随机码保留）：
 *   锚文本带后缀 [AAAAA.doc](assets/旧名…)  →  assets/AAAAA-<时间戳>-<7位随机码>.doc
 *   锚文本无后缀 [AAAAA](assets/旧名…)      →  assets/AAAAA-<时间戳>-<7位随机码>.<原附件后缀>
 *   原文件已有 -时间戳-7位随机码 就沿用，没有才 genStamp() 补一段。
 *
 * 空格原样保留：不转 %20、不替成下划线、不加反斜杠；带空格也照改
 * （思源自己插入带空格附件时写的就是原样空格，插件产出形态与之一致）。
 *
 * ===== 关键实测结论（思源 3.8.9，2026-11-03）=====
 * 1. /api/asset/renameAsset 会自动改引用，但会强制补回时间戳 → 用不上
 * 2. /api/file/renameFile   不加时间戳，但不改引用 → 引用要自己改
 * 3. 一个链接会同时出现在 l / i / p 三个块里（容器 + 内容块）。
 *    必须只改最内层那个块，否则会重写整个列表，子块 ID 全变 → 引用二次损坏。
 * 4. updateBlock(markdown) 对 p / h / b 内 p / 表格 t 都能保持结构，
 *    表格的 colgroup 属性会被内核自动还原。
 * 5. blocks.content 里含有附件 href，可以拿 instr() 定位引用块；
 *    但写入后索引有延迟，所以校验一律读 getBlockKramdown，不读 SQL。
 *
 * 执行顺序（每个文件）：备份 → 复制成新名 → 改全库引用 → 逐个校验 → 复查无残留 → 删旧名
 * 任何一步不过：还原已改的块、删掉新文件、保留旧文件。旧文件在改名成功前始终存在。
 */

const { Plugin, showMessage, fetchSyncPost } = require("siyuan");

let fs = null;
try { fs = require("fs"); } catch (e) { fs = null; }
const path = require("path");
const os = require("os");

/* ============================ 常量与工具 ============================ */

// 本地附件链接：[锚文本](assets/xxx) / (...  "标题") / 支持前导斜杠
// 路径允许含空格（思源 kramdown 里就是原样空格），但不允许 ) " 换行
const RE_LINK = /(?<!!)\[([^\]\n]*)\]\((\/?assets\/[^)"\n]*)(\s+"[^"]*")?\)/g;

// 资源路径片段：assets/ 之后直到 ) 或 " 为止（文件名里可以有空格原子符）
const RE_ASSET_PATH = /(\/?assets\/)([^)"\n]*)/g;

/**
 * 导出用：整篇 kramdown 里所有指向本地 assets 的引用，**按出现顺序**。
 * 覆盖四种形态（实测这篇文档里都出现过）：
 *   ![](assets/x.png)           图片
 *   [文字](assets/x.pdf)        附件
 *   [文字](assets/x.pdf "标题")
 *   <img src="assets/x.png">    HTML 块里的图片
 * 终止符用 ) " ' > 换行：带空格的文件名能整段拿到，标题部分（"…"）不会被吃进来。
 */
const RE_ANY_ASSET = /(?:\]\(|<img[^>]*?src=["'])\s*(\/?assets\/[^)"'\n>]*)/g;

// 按扩展名认图片，只用于菜单里报「含 N 张图片」，不影响导出
const RE_IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|ico|heic|avif)$/i;

// 思源附件名的自动后缀：-20261103101532-e3bi598
const RE_STAMP = /^(.*)-(\d{14})-([a-z0-9]{6,10})$/i;

// Windows / 通用文件名非法字符
const RE_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const RE_ILLEGAL_G = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RE_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_REFS = 500;          // 单个文件引用块上限，超过视为异常，不动
const MAX_NAME_BYTES = 200;    // 文件名长度上限（留余量，Windows 上限 255）

const STATUS_TEXT = {
  ok: "可改",
  same: "已一致",
  ext_mismatch: "后缀不一致",
  conflict: "目标名已被占用",
  dup_target: "多个附件算出同一个目标名",
  multi: "同一附件算出多个目标名",
  missing: "磁盘上找不到",
  illegal: "名字非法",
  toolong: "名字过长",
  empty: "锚文本为空",
  bad_path: "路径异常",
};

function sqlQuote(s) {
  return String(s).replace(/'/g, "''");
}

// 只剥掉块尾的 IAL 行（{: id="..." updated="..."}）；中间的 IAL 属于子块，绝不能碰
function stripTrailingIAL(kramdown) {
  const lines = String(kramdown || "").split("\n");
  while (lines.length && /^\{:[^}]*\}$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join("\n").replace(/\s+$/, "");
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// 导出编号：001 / 0099 / 1000（超过三位自然进位，不截断）
function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

// 按思源规范造一段 -时间戳-7位随机码
function genStamp() {
  const d = new Date();
  const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rnd = "";
  for (let i = 0; i < 7; i += 1) rnd += chars[Math.floor(Math.random() * chars.length)];
  return `-${ts}-${rnd}`;
}

/**
 * 把锚文本里的 markdown 修饰剥掉，取出「用户看到的文字」。
 * 只剥成对包裹的标记，不动中间的下划线（报表_2026_11 不能被改坏）。
 */
function cleanAnchor(anchor) {
  let s = String(anchor || "");
  s = s.replace(/`([^`]*)`/g, "$1");                    // 行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");              // 粗体
  s = s.replace(/__([^_]+)__/g, "$1");                  // 粗体（下划线式）
  s = s.replace(/~~([^~]+)~~/g, "$1");                  // 删除线
  s = s.replace(/^\*([^*]+)\*$/, "$1");                 // 斜体（仅在整串包裹时）
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, "$1"); // kramdown 转义
  return s.trim();
}

/**
 * 取扩展名，但只认「像扩展名」的：.wps / .docx / .tar
 * 像 "A.wps-20261103101532-e3bi598" 这种，path.extname 会把整段戳当扩展名，必须拦住
 */
function safeExt(name) {
  const ext = path.extname(name);
  if (!ext || ext === ".") return "";
  if (!/^\.[A-Za-z0-9]{1,10}$/.test(ext)) return "";
  return ext;
}

/**
 * 过滤名字里的特殊字符：锚文本里可能是 `A/B*C?D.wps` 这种写不成文件名的东西。
 * 直接删掉非法字符、去掉首尾的点和空格，剩下的照用（不猜、不替换成下划线）。
 */
function sanitizeName(s) {
  return String(s)
    .replace(RE_ILLEGAL_G, "")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
}

/**
 * 拆解附件文件名：词干 / 思源自带后缀 / 扩展名
 *   "答辩材料示例-20261103103757-lk9lrsy.wps"
 *     → { stem:"答辩材料示例", stamp:"-20261103103757-lk9lrsy", ext:".wps" }
 */
function splitName(fileName) {
  const ext = safeExt(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const m = base.match(RE_STAMP);
  if (m) return { stem: m[1], stamp: `-${m[2]}-${m[3]}`, ext };
  return { stem: base, stamp: "", ext };
}

function workspaceDir() {
  const ws = window.siyuan && window.siyuan.config && window.siyuan.config.system
    && window.siyuan.config.system.workspaceDir;
  if (!ws) throw new Error("取不到思源工作空间路径");
  return ws;
}

function workspaceAssetsDir() {
  return path.join(workspaceDir(), "data", "assets");
}

function backupRoot() {
  return path.join(workspaceDir(), "data", "anchor-backup");
}

// kramdown 里的相对路径 → 磁盘绝对路径
function absOf(rawPath) {
  const rel = String(rawPath).replace(/^\/?assets\//, "");
  return path.join(workspaceAssetsDir(), rel);
}

function isEncoded(p) {
  return /%[0-9a-f]{2}/i.test(p);
}

/* ============================ 内核 API ============================ */

async function api(url, payload) {
  const r = await fetchSyncPost(url, payload || {});
  if (!r || r.code !== 0) throw new Error((r && r.msg) || ("调用失败: " + url));
  return r.data;
}

async function sql(stmt) {
  return api("/api/query/sql", { stmt });
}

async function getKramdown(blockId) {
  try {
    const d = await api("/api/block/getBlockKramdown", { id: blockId });
    return (d && d.kramdown) || "";
  } catch (e) {
    return "";
  }
}

async function updateBlockMarkdown(blockId, markdown) {
  return fetchSyncPost("/api/block/updateBlock", {
    id: blockId,
    dataType: "markdown",
    data: markdown,
  });
}

/* ============================ 链接解析与方案 ============================ */

function parseLinks(kramdown) {
  const out = [];
  RE_LINK.lastIndex = 0;
  let m;
  while ((m = RE_LINK.exec(kramdown)) !== null) {
    out.push({
      anchor: m[1],
      rawPath: (m[2] || "").replace(/\s+$/, ""),
      titlePart: m[3] || "",
    });
  }
  return out;
}

/**
 * 目标文件名 = 锚文本词干 + (原有时间戳 | 新造一段) + 扩展名
 * 扩展名优先取锚文本写的，锚文本没写就用附件自己的。
 */
function planByAnchor(anchor, fileName) {
  const raw = cleanAnchor(anchor);
  if (!raw) return { status: "empty" };

  const info = splitName(fileName);

  const ext = safeExt(raw);
  let rawStem = ext ? raw.slice(0, -ext.length) : raw;

  // 锚文本自己带了 -时间戳-随机码，先剥掉再拼，避免叠成两份
  const m = rawStem.match(RE_STAMP);
  if (m) rawStem = m[1];

  // 特殊字符一律过滤：/ \ : * ? " < > | 和控制字符直接删掉，首尾的点与空格也去掉
  const stem = sanitizeName(rawStem);
  const filtered = stem !== rawStem;
  if (!stem) return { status: "illegal" };

  const useExt = ext || info.ext;
  const targetName = stem + (info.stamp || genStamp()) + useExt;

  if (targetName === fileName) return { status: "same" };
  if (RE_ILLEGAL.test(targetName)) return { status: "illegal" };
  if (RE_RESERVED.test(stem) || RE_RESERVED.test(info.stem)) return { status: "illegal" };
  if (Buffer.byteLength(targetName, "utf8") > MAX_NAME_BYTES) {
    return { status: "toolong", targetName };
  }
  if (ext && info.ext && ext.toLowerCase() !== info.ext.toLowerCase()) {
    // 锚文本写着 .doc、磁盘上却是 .wps：按锚文本后缀改名会把类型说错，不自动做
    return { status: "ext_mismatch", targetName };
  }
  // 空格原样保留：不转 %20、不换下划线、不加反斜杠。
  // 思源自己插入带空格附件时，写出来的 kramdown 就是原样空格（已实测），所以照改。
  // 只在结果上打标记，让人知道这个文件名里带空格。
  const out = { status: "ok", targetName };
  if (filtered) out.filtered = true;   // 只在真的过滤过字符时带上这个标记
  if (/\s/.test(targetName)) out.hasSpace = true;
  return out;
}

/* ============================ 扫描当前文档 ============================ */

async function scanDocument(docId) {
  // 用 instr 而不是 LIKE：文件名里的 _ 和 % 是 LIKE 通配符，会把大量无关块捞进来
  const rows = await sql(
    `SELECT id, type FROM blocks WHERE root_id='${sqlQuote(docId)}' AND instr(content,'assets/')>0`
  );

  const items = [];
  for (const row of rows) {
    const k = await getKramdown(row.id);
    if (!k || k.indexOf("assets/") === -1) continue;
    for (const lk of parseLinks(k)) {
      if (isEncoded(lk.rawPath)) {
        items.push({
          blockId: row.id, anchor: lk.anchor, fileName: lk.rawPath,
          status: "bad_path", targetName: "", rawPath: lk.rawPath,
        });
        continue;
      }
      // assets/assets/xxx 这种重复前缀，真文件在 data/assets/xxx，不猜，报出来
      if (/^\/?assets\/assets\//.test(lk.rawPath)) {
        items.push({
          blockId: row.id, anchor: lk.anchor, fileName: lk.rawPath,
          status: "bad_path", targetName: "", rawPath: lk.rawPath,
        });
        continue;
      }

      const fileName = lk.rawPath.replace(/^\/?assets\//, "");
      const p = planByAnchor(lk.anchor, fileName);
      items.push({
        blockId: row.id,
        anchor: lk.anchor,
        fileName,
        status: p.status,
        targetName: p.targetName || "",
        rawPath: lk.rawPath,
        filtered: !!p.filtered,
        hasSpace: !!p.hasSpace,
      });
    }
  }

  // 同一附件被多条链接指向、却算出不同目标名 → 无法同时满足，全部拦下
  const byFile = new Map();
  for (const it of items) {
    if (it.status !== "ok") continue;
    if (!byFile.has(it.fileName)) byFile.set(it.fileName, new Set());
    byFile.get(it.fileName).add(it.targetName);
  }
  for (const it of items) {
    const set = byFile.get(it.fileName);
    if (set && set.size > 1) it.status = "multi";
  }

  // 不同附件算出同一个目标名 → 两个都不动（否则谁先谁赢，结果不可预期）
  const byTarget = new Map();
  for (const it of items) {
    if (it.status !== "ok") continue;
    if (!byTarget.has(it.targetName)) byTarget.set(it.targetName, new Set());
    byTarget.get(it.targetName).add(it.fileName);
  }
  for (const it of items) {
    const set = byTarget.get(it.targetName);
    if (set && set.size > 1) it.status = "dup_target";
  }

  // 磁盘检查
  const ownNames = new Set(items.map((x) => x.fileName));
  for (const it of items) {
    if (it.status !== "ok") continue;
    try {
      if (!fs.existsSync(absOf(it.rawPath))) { it.status = "missing"; continue; }
      if (fs.existsSync(path.join(workspaceAssetsDir(), it.targetName)) && !ownNames.has(it.targetName)) {
        it.status = "conflict";
      }
    } catch (e) { /* 路径异常就当没通过 */ it.status = "missing"; }
  }

  return items;
}

/* ============================ 全库引用定位 ============================ */

/**
 * 找出全库所有真正引用 assets/fileName 的块，只留最内层。
 * 定位靠 SQL 的 content 预筛，判定靠 getBlockKramdown 实读（不吃索引延迟）。
 */
async function findReferences(fileName) {
  const seen = new Map();

  const pushRow = (id) => {
    if (id && !seen.has(id)) seen.set(id, { id, path: "" });
  };

  try {
    const rows = await sql(
      `SELECT id, type, path FROM blocks WHERE instr(content,'${sqlQuote(fileName)}')>0 AND type<>'d'`
    );
    for (const row of rows) {
      if (!seen.has(row.id)) seen.set(row.id, { id: row.id, path: row.path || "" });
    }
  } catch (e) { /* 预筛失败就用 assets 表 */ }

  // 第二路信号：assets 表里登记过这个名字的块
  try {
    const rows = await sql(
      `SELECT block_id FROM assets WHERE name='${sqlQuote(fileName)}'`
    );
    for (const row of rows) pushRow(row.block_id);
  } catch (e) { /* ignore */ }

  const cands = [];
  for (const c of seen.values()) {
    const k = await getKramdown(c.id);
    if (!k) continue;
    if (!hasAssetPath(k, fileName)) continue;
    cands.push({ id: c.id, path: c.path, kramdown: k });
  }

  // 去掉容器块：只要它的 kramdown 里嵌着另一个候选块的 ID，就说明真身是那个子块。
  // 注意 blocks.path 是 .sy 文件路径（不是块树路径），拿路径前缀判父子会永远失效
  // —— 真机实测过，用路径判会让 l / i / p 三个块都被写一遍。
  const idSet = new Set(cands.map((c) => c.id));
  const RE_IAL_ID = /\{:[^}]*?id="([^"]+)"/g;
  return cands.filter((c) => {
    const re = new RegExp(RE_IAL_ID.source, "g");
    let m;
    while ((m = re.exec(c.kramdown)) !== null) {
      if (m[1] !== c.id && idSet.has(m[1])) return false;
    }
    return true;
  });
}

/* ============================ 改一个文件的引用 ============================ */

function rewriteLinks(kramdown, oldName, newName) {
  const body = stripTrailingIAL(kramdown);
  // 只改「资源路径」位置：assets/ 之后、到 ) 或 " 之前的那一段，必须整段等于旧名。
  // 不能用子串替换：新名常常以旧名结尾（甲-<戳> → 新甲-<戳>），会误判也会误改。
  return body.replace(RE_ASSET_PATH, (whole, prefix, tail) => {
    const p = tail.replace(/\s+$/, "");
    if (p !== oldName) return whole;
    return prefix + newName + tail.slice(p.length);
  });
}

// kramdown 里出现的所有资源路径（去掉末尾空格）
function assetPathsIn(kramdown) {
  const out = [];
  const re = new RegExp(RE_ASSET_PATH.source, "g");
  let m;
  const s = String(kramdown || "");
  while ((m = re.exec(s)) !== null) out.push(m[2].replace(/\s+$/, ""));
  return out;
}

function hasAssetPath(kramdown, fileName) {
  return assetPathsIn(kramdown).some((p) => p === fileName);
}

/**
 * 把全库对 oldName 的引用改成 newName。
 * 返回 { changed, fails:[], touched:[{id, before}] }，touched 用于回滚。
 */
async function replaceReferences(oldName, newName) {
  const refs = await findReferences(oldName);
  if (refs.length > MAX_REFS) {
    return { changed: 0, fails: [{ id: "", msg: `引用块 ${refs.length} 个，超过上限 ${MAX_REFS}` }], touched: [] };
  }

  let changed = 0;
  const fails = [];
  const touched = [];

  for (const ref of refs) {
    const nb = rewriteLinks(ref.kramdown, oldName, newName);
    if (nb === stripTrailingIAL(ref.kramdown)) continue;   // 这个块只是正文提到名字，不是链接

    const before = ref.kramdown;
    const r = await updateBlockMarkdown(ref.id, nb);
    if (!r || r.code !== 0) {
      fails.push({ id: ref.id, msg: (r && r.msg) || "updateBlock 失败" });
      continue;
    }

    // 写后校验：读实文件，不读 SQL。用「整段路径相等」判断，不能用子串
    const after = await getKramdown(ref.id);
    if (!hasAssetPath(after, newName)) {
      fails.push({ id: ref.id, msg: "写后校验失败：新文件名未出现" });
      touched.push({ id: ref.id, before });
      continue;
    }
    if (hasAssetPath(after, oldName)) {
      fails.push({ id: ref.id, msg: "写后校验失败：旧文件名仍在" });
      touched.push({ id: ref.id, before });
      continue;
    }

    touched.push({ id: ref.id, before });
    changed += 1;
  }

  return { changed, fails, touched };
}

async function rollbackBlocks(touched) {
  const bad = [];
  for (const t of touched) {
    try {
      const r = await updateBlockMarkdown(t.id, stripTrailingIAL(t.before));
      if (!r || r.code !== 0) bad.push(t.id);
    } catch (e) {
      bad.push(t.id);
    }
  }
  return bad;
}

/* ============================ 执行 ============================ */

function makeStampDirName() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function executeRenames(entries) {
  const assetsDir = workspaceAssetsDir();
  const bDir = path.join(backupRoot(), makeStampDirName());
  const report = { renamed: 0, refs: 0, skipped: [], failed: [], backupDir: "" };

  // 同一附件可能被多处链接指向，扫出来是多条；只按文件名执行一次，
  // 否则第二次会报「磁盘上找不到」（此时旧名已被第一次删掉）——那是假失败。
  const seenFiles = new Set();

  for (const e of entries) {
    const oldName = e.fileName;
    const newName = e.targetName;
    if (seenFiles.has(oldName)) continue;
    seenFiles.add(oldName);
    const oldAbs = path.join(assetsDir, oldName);
    const newAbs = path.join(assetsDir, newName);
    let touched = [];

    try {
      if (!fs.existsSync(oldAbs)) {
        report.failed.push({ file: oldName, reason: "磁盘上找不到该附件" });
        continue;
      }
      if (fs.existsSync(newAbs)) {
        report.skipped.push({ file: oldName, reason: "目标文件已存在" });
        continue;
      }

      // 1. 备份（放在 data/anchor-backup/<时间>/，不进 assets，免得被当成素材建索引）
      if (!fs.existsSync(bDir)) fs.mkdirSync(bDir, { recursive: true });
      fs.copyFileSync(oldAbs, path.join(bDir, oldName));
      report.backupDir = bDir;

      // 2. 先复制成新名，旧文件仍在 → 这期间两边都能打开
      fs.copyFileSync(oldAbs, newAbs);

      // 3. 改全库引用（含写后校验）
      const res = await replaceReferences(oldName, newName);
      touched = res.touched;

      // 一条引用都没改到 → 说明这个名字判断有误，绝不能删旧文件
      if (res.changed === 0) {
        await rollbackBlocks(touched);
        try { fs.unlinkSync(newAbs); } catch (e) { /* ignore */ }
        report.failed.push({
          file: oldName,
          reason: res.fails.length ? `引用改写失败：${res.fails[0].msg}` : "全库没有任何引用指向它，已回滚",
        });
        continue;
      }

      if (res.fails.length > 0) {
        await rollbackBlocks(touched);
        try { fs.unlinkSync(newAbs); } catch (e) { /* ignore */ }
        report.failed.push({
          file: oldName,
          reason: `有 ${res.fails.length} 个块改写失败，已回滚`,
          detail: res.fails.slice(0, 2),
        });
        continue;
      }

      // 4. 复查：全库再找一遍，确认真的没有残留引用
      const left = await findReferences(oldName);
      if (left.length > 0) {
        await rollbackBlocks(touched);
        try { fs.unlinkSync(newAbs); } catch (e) { /* ignore */ }
        report.failed.push({
          file: oldName,
          reason: `复查发现还有 ${left.length} 个块引用旧名，已回滚`,
        });
        continue;
      }

      // 5. 删旧文件
      fs.unlinkSync(oldAbs);
      report.renamed += 1;
      report.refs += res.changed;
    } catch (err) {
      // 兜底：还原已改的块，新文件删掉，旧文件不动
      await rollbackBlocks(touched);
      try { if (fs.existsSync(newAbs) && fs.existsSync(oldAbs)) fs.unlinkSync(newAbs); } catch (e2) { /* ignore */ }
      report.failed.push({ file: oldName, reason: String((err && err.message) || err) });
    }
  }

  return report;
}

/* ============================ 导出：纯逻辑（可单测） ============================ */

/**
 * 链接里的资源路径 → 磁盘上的真实文件名。
 * 库里确实存在 `%20` 残留（全库 76 处），而盘上没有字面 %20 的文件，
 * 所以必须先解码。解码失败（畸形 %）就原样返回，后面按「找不到」跳过，绝不猜。
 */
function decodeAssetPath(rawPath) {
  const s = String(rawPath || "").replace(/^\/+/, "").replace(/\s+$/, "");
  if (!/%[0-9a-f]{2}/i.test(s)) return s;
  try { return decodeURIComponent(s).replace(/^\/+/, ""); } catch (e) { return s; }
}

/**
 * 整篇 kramdown → 导出清单。纯函数，不碰磁盘。
 *
 * 顺序 = 在 kramdown 里出现的顺序 = 文档里的先后顺序。
 * 同一附件被多处链接指向时只导一次，占它第一次出现的位置。
 *
 * @param {string} kramdown
 * @param {{stripStamp?: boolean}} opts  stripStamp 默认 true：剥掉思源的 -时间戳-随机码
 * @returns {{rawPath:string, fileName:string, displayName:string, isImage:boolean}[]}
 */
function buildExportPlan(kramdown, opts) {
  const o = opts || {};
  const stripStamp = o.stripStamp !== false;
  const s = String(kramdown || "");
  const out = [];
  const seenFile = new Set();
  const usedName = new Set();

  const re = new RegExp(RE_ANY_ASSET.source, "g");
  let m;
  while ((m = re.exec(s)) !== null) {
    const rawPath = (m[1] || "").replace(/\s+$/, "");
    if (!rawPath) continue;

    const decoded = decodeAssetPath(rawPath);
    if (!/^assets\/.+/.test(decoded)) continue;
    // assets/assets/x 这种重复前缀，真文件在 data/assets/x，不猜，当缺失处理
    if (/^assets\/assets\//.test(decoded)) continue;

    const fileName = decoded.slice("assets/".length);
    if (!fileName || seenFile.has(fileName)) continue;
    seenFile.add(fileName);

    // 剥戳：06发表论文_asset_031-20261004174122-ZzCpTJB9.pdf → 06发表论文_asset_031.pdf
    let display = fileName;
    if (stripStamp) {
      const info = splitName(fileName);
      display = info.stem + info.ext;
    }
    display = sanitizeName(display) || sanitizeName(fileName) || "附件";

    // 剥掉时间戳后可能撞车（同一批上传的两个 _asset_031 只有戳不同）→ 加 -2 -3，保留扩展名
    if (usedName.has(display.toLowerCase())) {
      const info = splitName(display);
      let k = 2;
      while (usedName.has((info.stem + "-" + k + info.ext).toLowerCase())) k += 1;
      display = info.stem + "-" + k + info.ext;
    }
    usedName.add(display.toLowerCase());

    out.push({
      rawPath,
      fileName,
      displayName: display,
      isImage: RE_IMAGE_EXT.test(fileName),
    });
  }
  return out;
}

// 导出文件名：001-原名.pdf
function exportName(n, displayName) {
  return pad3(n) + "-" + displayName;
}

/**
 * 文件名长度兜底：Windows 上全路径超过 260 字符时 copyFileSync 直接报
 * ENAMETOOLONG（附件名常常很长，`%TEMP%` 本身又深）。按调用方算出的预算
 * 从词干截断，**扩展名一定保住**，截断处留一个 `…` 让人看得出来。
 *
 * @param {string} displayName
 * @param {number} budget 这个名字最多能占多少字符
 */
function fitFileName(displayName, budget) {
  const name = String(displayName == null ? "" : displayName);
  const b = Math.max(12, Math.floor(Number(budget) || 200));
  if (name.length <= b) return name;
  const info = splitName(name);
  const ext = info.ext || "";
  const stem = info.stem || name;
  const keep = b - ext.length - 1;            // 留 1 位给 …
  if (keep < 1) return (stem.slice(0, Math.max(1, b - 1)) + "…").slice(0, b);
  return stem.slice(0, keep) + "…" + ext;
}

/**
 * 导出文件夹名：随机为主，时间戳只用来排序。
 * 用户要求「随机文件夹名，避免重复」——同一秒连点两次也不会撞。
 */
function makeExportFolderName() {
  const d = new Date();
  const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";   // 去掉 l/o/0/1，肉眼看不出歧义
  let rnd = "";
  for (let i = 0; i < 6; i += 1) rnd += chars[Math.floor(Math.random() * chars.length)];
  return `思源附件-${ts}-${rnd}`;
}

/* ==== CUT-LOGIC-END ==== 以下依赖思源运行时（window/document/Plugin），单测不覆盖 ==== */

/* ============================ 当前文档 ============================ */

function docIdOf(protyle) {
  if (!protyle) return "";
  const title = protyle.querySelector(".protyle-title[data-node-id]");
  if (title) return title.getAttribute("data-node-id") || "";
  const bg = protyle.querySelector(".protyle-background[data-node-id]");
  if (bg) return bg.getAttribute("data-node-id") || "";
  return "";
}

/**
 * 记住「最后一次把光标放进去的文档」。
 * 点顶栏按钮时焦点已经跑到按钮上了，activeElement 不再指向编辑器，
 * 只靠兜底逻辑在多标签/分屏时会挑错文档 → 改错篇。所以点进来那一刻先记下。
 */
let lastDocId = "";

function rememberDocFrom(el) {
  const p = el && el.closest ? el.closest(".protyle") : null;
  if (!p) return;
  const id = docIdOf(p);
  if (id) lastDocId = id;
}

function protyleStillOpen(docId) {
  const list = Array.from(document.querySelectorAll(".protyle-title[data-node-id]"));
  return list.some((t) => t.getAttribute("data-node-id") === docId && t.offsetParent !== null);
}

// 屏幕上真的看得见的编辑器（没被切到后台标签 / 没被折叠）
function visibleProtyles() {
  return Array.from(document.querySelectorAll(".protyle")).filter((el) => {
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  });
}

/**
 * 谁才是「当前文档」。顺序很重要，都是踩出来的：
 *
 * ① 光标/焦点所在的编辑器 —— 最准；
 * ② **屏幕上只开着一篇**时，就是它。这一条原先排在 lastDocId 之后，
 *    结果「用文件树/搜索换了文档、但没在正文里点一下」时，lastDocId 还是上一篇，
 *    菜单头会显示上一篇、动作也作用到上一篇（真机上就抓到了：显示「今天日记」，
 *    实际界面上是另一篇）。单篇可见的情况远多于多标签，所以提到前面；
 * ③ 多篇都在屏幕上（分屏）→ 优先上次编辑过的那篇，其次最右侧那篇；
 * ④ 都拿不到 → 任意一个还开着的标题。
 */
function getActiveDoc() {
  // ① 焦点所在
  const ae = document.activeElement;
  const near = ae && ae.closest ? ae.closest(".protyle") : null;
  if (near && docIdOf(near)) return { id: docIdOf(near) };

  const vis = [];
  visibleProtyles().forEach((el) => {
    const id = docIdOf(el);
    if (id && vis.indexOf(id) < 0) vis.push(id);
  });

  // ② 屏幕上就只有一篇
  if (vis.length === 1) return { id: vis[0] };

  // ③ 分屏：上次编辑过的那篇
  if (lastDocId && vis.indexOf(lastDocId) >= 0) return { id: lastDocId };
  if (vis.length) return { id: vis[vis.length - 1] };

  // ④ 兜底：还在内存里开着的标题
  if (lastDocId && protyleStillOpen(lastDocId)) return { id: lastDocId };

  // 5. 兜底：任意可见标题
  const titles = Array.from(document.querySelectorAll(".protyle-title[data-node-id]"));
  for (let i = titles.length - 1; i >= 0; i -= 1) {
    const id = titles[i].getAttribute("data-node-id");
    if (id) return { id };
  }
  return null;
}

// 顶栏图标：addTopBar 只认内置图标名或 SVG 字符串，不认图片路径
const TOP_BAR_ICON = `<svg viewBox="0 0 32 32" style="width:16px;height:16px">
  <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="#2656a8"/>
  <rect x="9" y="6.5" width="14" height="19" rx="2.5" fill="#ffffff"/>
  <rect x="12" y="11" width="8" height="2.2" rx="1.1" fill="#2656a8"/>
  <rect x="12" y="15.5" width="8" height="2.2" rx="1.1" fill="#2656a8"/>
  <rect x="12" y="20" width="5" height="2.2" rx="1.1" fill="#9db9e4"/>
</svg>`;

/* ============================ 导出：执行 ============================ */

function tmpRootDir() {
  try {
    const t = os.tmpdir();
    if (t) return t;
  } catch (e) { /* ignore */ }
  return path.join(workspaceDir(), "temp");
}

/**
 * 导出当前文档的全部附件（含图片）到 %TEMP%/思源附件-<时间戳>-<随机>/。
 * 编号按「真的复制成功」的顺序连续递增 —— 磁盘上缺的文件直接跳过、不占号，
 * 保证 001、002… 不留空号。
 */
async function exportAssets(docId) {
  const k = await getKramdown(docId);
  const report = { dir: "", total: 0, images: 0, bytes: 0, missing: [], failed: [], trimmed: [] };
  // 空文档 / 内核读不到 → 当「没有附件」处理，不抛错（抛错只会弹一句看不懂的话）
  if (!k) return report;

  const plan = buildExportPlan(k, { stripStamp: true });
  const assetsDir = workspaceAssetsDir();

  // 先筛存在性，再编号（缺文件不占号）
  const usable = [];
  for (const e of plan) {
    const abs = path.join(assetsDir, e.fileName);
    let ok = false;
    try { ok = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch (err) { ok = false; }
    if (ok) usable.push(Object.assign({}, e, { abs }));
    else report.missing.push(e.fileName);
  }
  if (!usable.length) return report;

  const dir = path.join(tmpRootDir(), makeExportFolderName());
  fs.mkdirSync(dir, { recursive: true });
  report.dir = dir;

  let n = 0;
  // Windows 全路径上限 260，这里按 250 留余量；`001-` 最多占 5 位（四位数编号）
  const nameBudget = Math.max(24, 250 - dir.length - 1 - 5);
  for (const e of usable) {
    const next = n + 1;
    const fileName = fitFileName(e.displayName, nameBudget);
    if (fileName.length < e.displayName.length) report.trimmed.push(e.fileName);
    const dst = path.join(dir, exportName(next, fileName));
    try {
      fs.copyFileSync(e.abs, dst);
      n = next;
      report.total += 1;
      if (e.isImage) report.images += 1;
      try { report.bytes += fs.statSync(dst).size; } catch (err) { /* 统计失败不影响导出 */ }
    } catch (err) {
      report.failed.push({ file: e.fileName, reason: String((err && err.message) || err) });
    }
  }
  return report;
}

/**
 * 弹出文件夹。三级降级，任何一级成功就返回 true。
 *
 * ① 思源自己的通道：ipcRenderer.send("siyuan-cmd", {cmd:"openPath", filePath})
 *    —— 主进程里就是 `shell.openPath(filePath)`（app/resources/app/electron/main.js
 *    的 "openPath" 分支），「设置 → 打开主题文件夹」走的是同一条路，最可靠。
 * ② Electron 的 shell.openPath（渲染进程直接调）
 * ③ 兜底：child_process 直接叫 explorer.exe
 *
 * 之前只写了 ③，实测点了没弹（execFile 在插件环境里没抛错、但也没起来），
 * 所以把思源的 IPC 放到第一优先。
 */
function openFolder(dir) {
  let electron = null;
  try { electron = require("electron"); } catch (e) { electron = null; }

  const ipc = electron && (electron.ipcRenderer
    || (electron.default && electron.default.ipcRenderer));
  if (ipc && typeof ipc.send === "function") {
    try {
      ipc.send("siyuan-cmd", { cmd: "openPath", filePath: dir });
      return true;
    } catch (e) { /* 往下退 */ }
  }

  const sh = electron && (electron.shell || (electron.default && electron.default.shell));
  if (sh && typeof sh.openPath === "function") {
    try { sh.openPath(dir); return true; } catch (e) { /* 往下退 */ }
  }

  try {
    const cp = require("child_process");
    cp.execFile("explorer.exe", [dir], { windowsHide: true }, () => {});
    return true;
  } catch (e) { /* ignore */ }

  return false;
}

function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}

/* ============================ 下拉菜单 ============================ */

const MENU_ICON_RENAME = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 20h4L20 8a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>`;

const MENU_ICON_EXPORT = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.6l2 2.5H19A1.5 1.5 0 0 1 20.5 10v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V7.5z"/>
  <path d="M12 11v5.2"/><path d="M9.8 14 12 16.2 14.2 14"/></svg>`;

let menuEl = null;
let menuAnchor = null;
let menuDocListeners = null;

function closeMenu() {
  if (menuDocListeners) {
    document.removeEventListener("mousedown", menuDocListeners.onDown, true);
    document.removeEventListener("keydown", menuDocListeners.onKey, true);
    window.removeEventListener("resize", menuDocListeners.onResize);
    window.removeEventListener("scroll", menuDocListeners.onScroll, true);
    menuDocListeners = null;
  }
  if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
  menuEl = null;
  menuAnchor = null;
}

// 文档标题：先读编辑器里的标题输入框，读不到再问内核
function docTitleOf(docId) {
  try {
    const titles = Array.from(document.querySelectorAll(".protyle-title[data-node-id]"));
    const el = titles.find((t) => t.getAttribute("data-node-id") === docId);
    if (el) {
      const input = el.querySelector(".protyle-title__input") || el;
      const txt = (input.textContent || "").trim();
      if (txt) return txt;
    }
  } catch (e) { /* ignore */ }
  return "";
}

async function menuStats(docId) {
  try {
    const k = await getKramdown(docId);
    const plan = buildExportPlan(k, { stripStamp: true });
    return { total: plan.length, images: plan.filter((e) => e.isImage).length };
  } catch (e) {
    return null;
  }
}

/**
 * 点顶栏图标弹的这个菜单。
 * 全部配色走 --b3-* 变量（见 index.css），亮色 / 暗色主题自动跟随。
 */
function showMenu(anchorEl, handlers) {
  closeMenu();
  menuAnchor = anchorEl;

  const menu = document.createElement("div");
  menu.className = "aa-menu";
  menu.innerHTML =
    `<div class="aa-menu__head">` +
      `<div class="aa-menu__name">文档附件管家</div>` +
      `<div class="aa-menu__meta" data-role="meta">正在读取当前文档…</div>` +
    `</div>` +    `<div class="aa-menu__sep"></div>` +
    `<div class="aa-menu__item" data-act="rename">` +
      `<span class="aa-menu__ico aa-menu__ico--blue">${MENU_ICON_RENAME}</span>` +
      `<span class="aa-menu__body">` +
        `<span class="aa-menu__t">按锚文本改附件名</span>` +
        `<span class="aa-menu__d">保留时间戳-随机码，只改当前文档的附件</span>` +
      `</span>` +
    `</div>` +
    `<div class="aa-menu__item" data-act="export">` +
      `<span class="aa-menu__ico aa-menu__ico--green">${MENU_ICON_EXPORT}</span>` +
      `<span class="aa-menu__body">` +
        `<span class="aa-menu__t">一键导出全部附件</span>` +
        `<span class="aa-menu__d">按文档顺序编号 001-，导出完自动打开文件夹</span>` +
      `</span>` +
    `</div>`;
  document.body.appendChild(menu);
  menuEl = menu;

  // 文档名先摆上（从 DOM 同步读），附件数随后补 —— 让人一眼看清「这次作用在哪篇」
  try {
    const t0 = handlers.title() || "当前文档";
    const m0 = menu.querySelector('[data-role="meta"]');
    if (m0) m0.textContent = t0 + " · 正在统计附件…";
  } catch (e) { /* ignore */ }

  const place = () => {
    if (!menuEl) return;
    const r = menu.getBoundingClientRect();
    const a = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const ax = a ? a.right : window.innerWidth - 12;
    const ay = a ? a.bottom : 48;
    let left = Math.max(8, Math.min(ax - r.width, window.innerWidth - r.width - 8));
    let top = ay + 8;
    if (top + r.height > window.innerHeight - 8) {
      const ah = a ? a.height : 0;
      top = Math.max(8, ay - ah - r.height - 16);
    }
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    menu.classList.add("is-placed");
  };
  menu.style.left = "-9999px";
  menu.style.top = "0px";
  requestAnimationFrame(place);

  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
  menu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".aa-menu__item");
    if (!item || item.classList.contains("is-busy")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const act = item.getAttribute("data-act");
    closeMenu();
    if (act === "export") handlers.onExport();
    else if (act === "rename") handlers.onRename();
  });

  // 点别处 / Esc / 滚动 / 改窗口大小 都收起
  const onDown = (ev) => {
    if (menuEl && menuEl.contains(ev.target)) return;
    if (anchorEl && anchorEl.contains(ev.target)) return;
    closeMenu();
  };
  const onKey = (ev) => { if (ev.key === "Escape") closeMenu(); };
  const onResize = () => closeMenu();
  const onScroll = () => closeMenu();
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onScroll, true);
  menuDocListeners = { onDown, onKey, onResize, onScroll };

  // 统计数字后填进去：当前文档 · 共 N 个附件（含 M 张图片）
  // 注意锁住 own menu：菜单被关掉又重开时，这一发异步结果不能写到新菜单上
  const ownMenu = menu;
  handlers.stats().then((st) => {
    if (!menuEl || menuEl !== ownMenu) return;
    const meta = ownMenu.querySelector('[data-role="meta"]');
    if (!meta) return;
    const title = handlers.title() || "当前文档";
    if (!st) { meta.textContent = title; return; }
    if (!st.total) { meta.textContent = title + " · 正文里没有本地附件"; return; }
    meta.textContent = title + ` · 共 ${st.total} 个附件`
      + (st.images ? `（含 ${st.images} 张图片）` : "");
  });
}

/* ============================ 插件主体 ============================ */

module.exports = class AttachmentAnchorPlugin extends Plugin {

  onload() {
    this._running = false;
  }

  onLayoutReady() {
    // 点进编辑器那一刻就把文档 ID 记下来，点顶栏按钮时就不怕焦点已经跑掉
    // 句柄留着，卸载时能摘掉，避免反复启用/重载后监听越叠越多
    this._docRemember = (e) => rememberDocFrom(e.target);
    document.addEventListener("mousedown", this._docRemember, true);
    document.addEventListener("focusin", this._docRemember, true);

    this._topBar = this.addTopBar({
      icon: TOP_BAR_ICON,
      title: "文档附件管家：改附件名 / 导出全部附件",
      position: "right",
      callback: () => this.toggleMenu(),
    });
  }

  onunload() {
    closeMenu();
    if (this._docRemember) {
      document.removeEventListener("mousedown", this._docRemember, true);
      document.removeEventListener("focusin", this._docRemember, true);
      this._docRemember = null;
    }
    this._topBar = null;
  }

  // 点图标 = 开/收菜单；菜单里再选做哪件事
  toggleMenu() {
    if (menuEl && menuAnchor === this._topBar) {
      closeMenu();
      return;
    }
    // 打开菜单这一刻就把文档定死：菜单头显示哪篇，两个动作就作用在哪篇。
    // 不能等点了菜单项再用 getActiveDoc() 重算 —— 焦点、标签页状态在这一瞬间可能已经变了。
    const doc = getActiveDoc();
    showMenu(this._topBar, {
      stats: () => (doc ? menuStats(doc.id) : Promise.resolve(null)),
      title: () => (doc ? docTitleOf(doc.id) : ""),
      onRename: () => this.runNow(doc && doc.id),
      onExport: () => this.runExport(doc && doc.id),
    });
  }

  // 一键导出：当前文档全部附件（含图片）→ 随机临时文件夹 → 编号 001- → 弹窗
  async runExport(docId) {
    if (!fs) {
      showMessage("这个功能只在桌面端可用", 5000, "error");
      return;
    }
    if (this._running) {
      showMessage("上一轮还在处理，稍等");
      return;
    }
    this._running = true;
    try {
      const doc = docId ? { id: docId } : getActiveDoc();
      if (!doc || !doc.id) {
        showMessage("请先把光标放进一篇文档，再点这个按钮", 5000, "error");
        return;
      }

      showMessage("正在导出附件…", 1500, "info");

      let rep;
      try {
        rep = await exportAssets(doc.id);
      } catch (e) {
        showMessage("导出失败：" + ((e && e.message) || e), 9000, "error");
        return;
      }

      console.info("[attachment-kit] 导出", rep);

      if (!rep.total) {
        const tail = rep.missing.length ? `（${rep.missing.length} 个在磁盘上找不到）` : "";
        showMessage("这篇文档里没有可导出的附件" + tail, 6000, "info");
        return;
      }

      const opts = [];
      if (rep.images) opts.push(`含 ${rep.images} 张图片`);
      opts.push(humanSize(rep.bytes));
      if (rep.missing.length) opts.push(`跳过 ${rep.missing.length} 个找不到的`);
      if (rep.trimmed && rep.trimmed.length) opts.push(`${rep.trimmed.length} 个名字过长已截断`);
      if (rep.failed.length) opts.push(`失败 ${rep.failed.length} 个`);

      const opened = openFolder(rep.dir);
      showMessage(
        `已导出 ${rep.total} 个附件（${opts.join("，")}）` +
        (opened ? "，已打开文件夹" : `，请手动打开：${rep.dir}`),
        rep.failed.length ? 12000 : 9000,
        rep.failed.length ? "error" : "info"
      );
    } finally {
      this._running = false;
    }
  }

  // 不弹窗：点一下就把当前文档里该改的附件全改掉，只回一条 toast
  async runNow(docId) {
    if (!fs) {
      showMessage("这个功能只在桌面端可用", 5000, "error");
      return;
    }
    if (this._running) {
      showMessage("上一轮还在处理，稍等");
      return;
    }
    this._running = true;
    try {
      const doc = docId ? { id: docId } : getActiveDoc();
      if (!doc || !doc.id) {
        showMessage("请先把光标放进一篇文档，再点这个按钮", 5000, "error");
        return;
      }

      showMessage("正在扫描当前文档…", 1200, "info");

      let items = [];
      try {
        items = await scanDocument(doc.id);
      } catch (e) {
        showMessage("扫描失败：" + ((e && e.message) || e), 8000, "error");
        return;
      }

      const todo = items.filter((it) => it.status === "ok");
      const others = items.filter((it) => it.status !== "ok" && it.status !== "same");

      // 调试开关：在控制台执行 window.__anchorDryRun = true 后只报计划、不落盘
      if (window.__anchorDryRun) {
        console.info("[attachment-kit][dry-run] 计划", todo, "其他", others);
        showMessage(`[演练] 将改 ${todo.length} 个附件；${others.length} 处不动（${whyNot(others) || "无"}）`, 9000, "info");
        return;
      }

      if (!todo.length) {
        const tail = others.length ? `；${others.length} 处未处理（${whyNot(others)}）` : "";
        showMessage((items.length ? "没有需要改的附件链接" : "这篇文档里没有本地附件链接") + tail, 5000, "info");
        return;
      }

      let report;
      try {
        report = await executeRenames(todo);
      } catch (e) {
        showMessage("执行失败：" + ((e && e.message) || e), 9000, "error");
        return;
      }

      console.info("[attachment-kit] 报告", report);

      const filteredCount = todo.filter((it) => it.filtered).length;
      const spaceCount = todo.filter((it) => it.hasSpace).length;
      const extra = [];
      if (filteredCount) extra.push(`${filteredCount} 个名字已过滤特殊字符`);
      if (spaceCount) extra.push(`${spaceCount} 个文件名含空格，按原样保留`);
      const okLine = `改名 ${report.renamed} 个附件，改写引用 ${report.refs} 处`;
      const filtLine = extra.length ? `（${extra.join("；")}）` : "";
      const skipLine = report.skipped.length ? `；跳过 ${report.skipped.length}` : "";
      const badLine = report.failed.length ? `；失败 ${report.failed.length}` : "";
      const otherLine = others.length ? `；另有 ${others.length} 处不动（${whyNot(others)}）` : "";

      showMessage(okLine + filtLine + skipLine + badLine + otherLine, report.failed.length ? 12000 : 8000,
        report.failed.length ? "error" : "info");
    } finally {
      this._running = false;
    }
  }
};

// 把「为什么没处理」压成一句短话
function whyNot(list) {
  const kinds = {};
  list.forEach((it) => {
    const t = STATUS_TEXT[it.status] || it.status;
    kinds[t] = (kinds[t] || 0) + 1;
  });
  return Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join("、");
}
