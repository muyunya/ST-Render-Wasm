# ST-Render-Wasm · Rust 渲染引擎 + 开销拆解基准

给 SillyTavern 用的 **Rust 编译 WebAssembly markdown 引擎**，外加一个**开销拆解基准测试**——用来回答"渲染一条消息，时间到底花在哪、值不值得用 Rust 换掉"。

## 先说结论（实测数据，不是宣传）

在真实聊天内容上（38 条消息 / 167,736 字符，同一台机器）：

| 引擎 | 38 条总计 | 每条 |
|---|---|---|
| **Rust/WASM**（pulldown-cmark） | **4.6 ms** | 0.12 ms |
| showdown（SillyTavern 现用） | 17.7 ms | 0.46 ms |
| 纯字符串拼接（理论下限） | ~0 ms | ~0 ms |

**Rust 版快 3.86×——但每条只省 0.34 ms。**

如果你的卡用 `ST-Prompt-Template`，那条消息在它手里要花 **~29 ms**（实测）。也就是说 **markdown 解析只占其中约 1%**，换成 Rust 对卡顿**几乎没有影响**。

所以本扩展的定位是：

- ✅ **提供**一个可用、可测的 Rust/WASM markdown 引擎（`window.STRenderWasm`）
- ✅ **测量**渲染开销的真实构成，避免把力气花在 1% 的地方
- ❌ **不接管**酒馆的渲染流程（原因见下方「兼容性」）

## 兼容性（重要，别直接替换）

Rust 版是严格 CommonMark/GFM 实现，showdown 不是。实测同输入下的差异：

| 输入 | Rust/WASM | showdown |
|---|---|---|
| `<div class="box">你好</div>` | 原样保留 | 原样保留 ✓ 一致 |
| `<style>…</style>` | 原样保留 | 原样保留 ✓ 一致 |
| `\| a \| b \|` 表格 | 标准 GFM 输出 | 输出结构相同、空白不同 |
| `<status!>…</status!>` | **转义成 `&lt;status!&gt;`** | **原样保留** ✗ 差异 |

最后一行是关键：`<status!>` 不是合法 HTML 标签，CommonMark 按规范把它当普通文本转义，而 showdown 会原样透传。SillyTavern 的角色卡大量依赖这类自定义标签（`<status!>`、`<tableEdit>`、`<UpdateVariable>` 等），**直接替换会改变现有卡片的渲染结果**。

因此本扩展默认只提供引擎与测量，不替换任何渲染路径。

## 安装

SillyTavern → **扩展** → **Install extension** → 粘贴：

```
https://github.com/muyunya/ST-Render-Wasm
```

仓库内已包含编译好的 `wasm/st_render_wasm.wasm`，**使用者无需安装 Rust**。

## 使用

扩展面板 →「Render WASM · Rust 渲染引擎 + 基准」：

1. 打开一个聊得多的聊天
2. 点 **运行基准测试** —— 它用你当前聊天真实的消息正文，分别计时：
   - Rust/WASM markdown
   - showdown markdown
   - DOMPurify 净化（DOM 型实现，WASM 无法替代）
   - 模板编译+求值（`new Function`，V8 的活，WASM 无法替代）
   - 纯字符串拼接基线
3. 面板底部会给出结论：**最贵的是哪一项**、以及它能不能用 WASM 优化
4. 点 **复制报告** 把 JSON 贴给需要的人

## 给扩展作者的 API

```js
// 引擎在页面加载后可用
const html = window.STRenderWasm.render('# 标题\n\n**粗体**');
window.STRenderWasm.version();   // '0.1.0'
window.STRenderWasm.backend;     // 'pulldown-cmark (rustc wasm32-unknown-unknown)'
```

**注意**：拿到的是未净化的 HTML。请务必继续用 DOMPurify 等净化器处理后再插入 DOM ——本引擎刻意不含净化逻辑，因为自己重写净化规则等于引入 XSS 风险。

## 关于净化的说明

WASM **不能**替代 DOMPurify：DOMPurify 依赖浏览器 DOM 解析（它用 `DOMParser`/`createElement` 建树后遍历），这类工作必须在 DOM 环境里做。同理，`<% %>` 模板求值依赖 V8 执行 JS，WASM 也无法替代。

**能用 WASM 加速的只有纯字符串/语法处理**，这也是本扩展只做 markdown 的原因。

## 自己编译

```bash
# 需要 rustup + wasm32-unknown-unknown 目标
rustup target add wasm32-unknown-unknown
bash build-wasm.sh
```

内核在 `rust/src/lib.rs`，导出最朴素的 C ABI，**不需要 wasm-bindgen / wasm-pack**：

```
st_abi_version() -> u32
st_alloc(len) -> ptr
st_free(ptr, len)
st_markdown_to_html(ptr, len, &out_len) -> ptr
```

## 许可

MIT
