/**
 * ST-Render-Wasm
 * ---------------------------------------------------------------
 * 1) 内置 Rust 编译的 markdown 引擎（wasm32-unknown-unknown + pulldown-cmark），
 *    通过 window.STRenderWasm 暴露给其它扩展使用。
 * 2) 基准测试：用当前聊天里真实的消息正文，把「渲染一条消息」的开销拆成三份
 *    分别计时，判断哪一份值得优化：
 *       a. markdown 解析  → Rust/WASM 可以加速
 *       b. HTML 净化      → DOMPurify 是 DOM 型实现，WASM 无法替代
 *       c. 模板编译求值   → new Function，V8 的活，WASM 无法替代
 *
 * 刻意不做的事：本扩展**不接管**酒馆或其它扩展的渲染流程，只提供引擎与测量。
 * 原因见 README「兼容性」一节：Rust 版与 showdown 在边角语义上存在差异
 * （例如 <status!> 这类非标准标签 showdown 原样保留、CommonMark 会转义），
 * 直接替换会改变现有卡片的渲染结果。
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'ST-Render-Wasm';
const CTX = getContext();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const defaultSettings = { rounds: true };

// ---------------------------------------------------------------- WASM 引擎

let wasm = null;

async function loadWasm() {
    const url = new URL('./wasm/st_render_wasm.wasm', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`wasm 拉取失败：HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    const abi = ex.st_abi_version();
    if (abi !== 1) {
        throw new Error(`wasm ABI 版本不匹配：期望 1，实际 ${abi}`);
    }
    return ex;
}

/** 调用 wasm 渲染 markdown（UTF-8 进、UTF-8 出） */
function makeRenderer(ex) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    return function render(markdown) {
        const input = encoder.encode(String(markdown));
        const inPtr = ex.st_alloc(input.length);
        if (!inPtr) throw new Error('wasm 内存分配失败');
        new Uint8Array(ex.memory.buffer, inPtr, input.length).set(input);

        const outLenPtr = ex.st_alloc(4);
        const outPtr = ex.st_markdown_to_html(inPtr, input.length, outLenPtr);
        if (!outPtr) {
            ex.st_free(inPtr, input.length);
            ex.st_free(outLenPtr, 4);
            throw new Error('wasm 渲染失败');
        }

        const outLen = new Uint32Array(ex.memory.buffer, outLenPtr, 1)[0];
        const html = decoder.decode(new Uint8Array(ex.memory.buffer, outPtr, outLen));

        ex.st_free(inPtr, input.length);
        ex.st_free(outPtr, outLen);
        ex.st_free(outLenPtr, 4);
        return html;
    };
}

// ---------------------------------------------------------------- 基准测试

/** 近似 ST-Prompt-Template 的模板求值：每次 new Function 编译（这正是它的开销形态） */
function templateEval(text, data) {
    let body = 'let __out="";\n';
    const parts = String(text).split(/(<%[\s\S]*?%>)/g);
    for (const part of parts) {
        if (part.startsWith('<%') && part.endsWith('%>')) {
            const code = part.slice(2, -2).trim();
            if (code.startsWith('=') || code.startsWith('-')) {
                // 直接拼接代码字符串：不要用模板字符串，否则 ${} 会被转义吞掉
                body += '__out += (' + code.slice(1).trim() + ');\n';
            } else {
                body += code + '\n';
            }
        } else if (part) {
            body += '__out += ' + JSON.stringify(part) + ';\n';
        }
    }
    body += 'return __out;';
    // eslint-disable-next-line no-new-func
    return new Function('data', body)(data);
}

function pickMessages(minChars = 80) {
    const chat = Array.isArray(CTX.chat) ? CTX.chat : [];
    return chat.map((m) => String(m.mes || '')).filter((t) => t.length >= minChars);
}

function timeIt(label, fn, messages, rounds) {
    // 预热
    for (let i = 0; i < Math.min(3, messages.length); i++) {
        try { fn(messages[i], i); } catch { /* 忽略单条异常 */ }
    }
    const started = performance.now();
    for (let r = 0; r < rounds; r++) {
        for (let i = 0; i < messages.length; i++) {
            try { fn(messages[i], i); } catch { /* 忽略单条异常 */ }
        }
    }
    const totalMs = (performance.now() - started) / rounds;
    return {
        label,
        totalMs: +totalMs.toFixed(2),
        perMessageMs: +(totalMs / Math.max(1, messages.length)).toFixed(3),
    };
}

async function runBenchmark() {
    setStatus('准备中…');
    if (!wasm) {
        wasm = await loadWasm();
    }
    const renderWasm = makeRenderer(wasm);

    const messages = pickMessages(80);
    if (messages.length < 3) {
        setStatus('当前聊天的消息太少（至少需要 3 条 80 字以上的消息）。换一个聊得多的聊天再试。');
        return;
    }
    const totalChars = messages.reduce((a, t) => a + t.length, 0);
    const rounds = settings().rounds ? 3 : 1;

    const results = [];
    results.push(timeIt('Rust/WASM markdown', (m) => renderWasm(m), messages, rounds));

    const showdownGlobal = window.showdown;
    if (showdownGlobal?.Converter) {
        const converter = new showdownGlobal.Converter({
            tables: true, strikethrough: true, tasklists: true,
            simplifiedAutoLink: true, literalMidWordUnderscores: true,
        });
        results.push(timeIt('showdown (JS) markdown', (m) => converter.makeHtml(m), messages, rounds));
    } else {
        results.push({ label: 'showdown (JS) markdown', totalMs: null, perMessageMs: null, missing: true });
    }

    // 先备好一份 HTML，供净化环节使用
    const htmlSamples = messages.map((m) => {
        try { return showdownGlobal?.Converter ? new showdownGlobal.Converter({ tables: true }).makeHtml(m) : renderWasm(m); }
        catch { return m; }
    });

    const purify = window.DOMPurify;
    if (purify?.sanitize) {
        const clean = purify.sanitize(htmlSamples[0], { USE_PROFILES: { html: true } }) ?? '';
        results.push(timeIt('DOMPurify 净化', (m, i) => purify.sanitize(htmlSamples[i], { USE_PROFILES: { html: true } }), messages, rounds));
        void clean;

        // 上面那一项用的是「理想配置」，而酒馆真实渲染走的是下面这套配置。
        //
        // 关键差别不在配置本身，而在 hook：酒馆给 DOMPurify 注册的 3 个 hook
        // （chats.js 的 addDOMPurifyHooks）开头都有 `if (!config.MESSAGE_SANITIZE) return;`，
        // 所以用 USE_PROFILES 测的时候，它们全部被跳过 —— 其中 uponSanitizeElement
        // 会对**每个未知元素**跑一次 TreeWalker 遍历文本节点，而角色卡消息里
        // 全是 <status!>、<tableEdit> 这类自定义标签，恰好全踩这条路径。
        // 不测这一项，就会得出「消毒很便宜」的错误结论。
        const realConfig = {
            RETURN_DOM: false,
            RETURN_DOM_FRAGMENT: false,
            RETURN_TRUSTED_TYPE: false,
            MESSAGE_SANITIZE: true,
            ADD_TAGS: ['custom-style'],
        };
        results.push(timeIt('DOMPurify 净化（酒馆真实配置，含 hook）',
            (m, i) => purify.sanitize(htmlSamples[i], realConfig), messages, rounds));
    } else {
        results.push({ label: 'DOMPurify 净化', totalMs: null, perMessageMs: null, missing: true });
    }

    const tpl = '<% for (const it of data.items) { %><%= it.k %>: <%= it.v %>\n<% } %>';
    const tplData = { items: [{ k: '好感', v: 80 }, { k: '体力', v: 60 }, { k: '心情', v: '平静' }] };
    results.push(timeIt('模板编译+求值 (new Function)', () => templateEval(tpl, tplData), messages, rounds));

    results.push(timeIt('纯字符串拼接基线', (m) => m.slice(0, m.length), messages, rounds));

    const report = {
        version: 0.2,
        messages: messages.length,
        totalChars,
        rounds,
        engines: results,
        env: { ua: navigator.userAgent, viewport: `${window.innerWidth}×${window.innerHeight}` },
    };

    lastReport = JSON.stringify(report, null, 2);
    appendOutput(formatReport(report));
    setStatus('基准测试完成。');
}

function formatReport(r) {
    const lines = [];
    lines.push('══════ 渲染开销拆解 ══════');
    lines.push(`  样本：${r.messages} 条消息 / ${r.totalChars.toLocaleString()} 字符 / ${r.rounds} 轮平均`);
    lines.push('');
    lines.push(`  ${pad('环节', 30)} ${pad('总计 ms', 12)} ${pad('每条 ms', 10)} 占比`);
    lines.push('  ' + '-'.repeat(74));

    const baseline = r.engines.find((e) => e.label.includes('基线'))?.totalMs ?? 0;
    const sumEngine = r.engines.filter((e) => !e.label.includes('基线') && e.totalMs != null)
        .reduce((a, e) => a + (e.label.includes('showdown') && e.label.includes('markdown') ? e.totalMs : 0) +
            (e.label.includes('DOMPurify') && e.label.includes('真实配置') ? e.totalMs : 0) +
            (e.label.includes('模板') ? e.totalMs : 0), 0);

    for (const e of r.engines) {
        if (e.totalMs == null) {
            lines.push(`  ${pad(e.label, 30)} ${pad('不可用', 12)} ${pad('-', 10)} （该库未暴露到 window）`);
            continue;
        }
        const share = sumEngine > 0 && !e.label.includes('基线') ? `${(e.totalMs / sumEngine * 100).toFixed(1)}%` : '-';
        lines.push(`  ${pad(e.label, 30)} ${pad(e.totalMs, 12)} ${pad(e.perMessageMs, 10)} ${share}`);
    }
    lines.push('  ' + '-'.repeat(74));
    void baseline;

    const wasm = r.engines.find((e) => e.label.includes('WASM'));
    const show = r.engines.find((e) => e.label.includes('showdown') && e.label.includes('markdown'));
    const pur = r.engines.find((e) => e.label.includes('DOMPurify') && e.label.includes('真实配置'))
        ?? r.engines.find((e) => e.label.includes('DOMPurify'));
    const purIdeal = r.engines.find((e) => e.label.includes('DOMPurify') && !e.label.includes('真实配置'));
    const tpl = r.engines.find((e) => e.label.includes('模板'));

    lines.push('');
    lines.push('  结论：');
    if (wasm?.totalMs && show?.totalMs) {
        lines.push(`    · Rust/WASM 比 showdown 快 ${(show.totalMs / wasm.totalMs).toFixed(2)}×`
            + `（每条省 ${(show.perMessageMs - wasm.perMessageMs).toFixed(3)} ms）`);
    }
    const parts = [['markdown(showdown)', show], ['DOMPurify 净化', pur], ['模板编译求值', tpl]]
        .filter(([, e]) => e?.totalMs != null)
        .sort((a, b) => b[1].totalMs - a[1].totalMs);
    if (pur?.totalMs != null && purIdeal?.totalMs != null && purIdeal.totalMs > 0) {
        const ratio = pur.totalMs / purIdeal.totalMs;
        if (ratio >= 1.3) {
            lines.push(`    · 酒馆真实消毒配置比理想配置慢 ${ratio.toFixed(1)}×`
                + `（每条多 ${(pur.perMessageMs - purIdeal.perMessageMs).toFixed(3)} ms）`
                + '—— 差距来自 DOMPurify 的 hook，不是配置本身');
        } else {
            // 两种情况都要如实报，不能只挑符合预设的那个
            lines.push(`    · 真实配置与理想配置相当（${ratio.toFixed(2)}×）→ DOMPurify 的 hook **不是**瓶颈，'
                + '本次渲染的开销在别处`);
        }
    }
    if (parts.length) {
        const [top] = parts;
        lines.push(`    · 三者中最贵的是「${top[0]}」，占 ${(top[1].totalMs / sumEngine * 100).toFixed(1)}%`);
        if (top[0] !== 'markdown(showdown)') {
            lines.push('    · 最贵的那一项 WASM 无法替代 → 优化方向是缓存/减少调用，而不是换语言');
        } else {
            lines.push('    · markdown 确实是大头 → 值得接入 WASM 引擎');
        }
    }
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------- UI

let lastReport = '';
let busy = false;

function settings() {
    extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME] || {});
    return extension_settings[MODULE_NAME];
}

function pad(text, width) {
    const s = String(text ?? '');
    const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
    return s + ' '.repeat(Math.max(0, width - w));
}

function setStatus(text) {
    const el = document.getElementById('st-rw-status');
    if (el) el.textContent = text;
}

function appendOutput(text) {
    const el = document.getElementById('st-rw-output');
    if (el) {
        el.textContent += text;
        el.scrollTop = el.scrollHeight;
    }
}

jQuery(async () => {
    try {
        settings();

        const html = await renderExtensionTemplateAsync('third-party/ST-Render-Wasm', 'settings');
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        container?.insertAdjacentHTML('beforeend', html);

        document.getElementById('st-rw-bench')?.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            try {
                await runBenchmark();
            } catch (err) {
                console.error(`[${MODULE_NAME}]`, err);
                setStatus('出错：' + (err?.message || err));
            } finally {
                busy = false;
            }
        });

        document.getElementById('st-rw-copy')?.addEventListener('click', async () => {
            if (!lastReport) {
                setStatus('还没有报告，先跑一次基准测试。');
                return;
            }
            try {
                await navigator.clipboard.writeText(lastReport);
                setStatus('报告（JSON）已复制到剪贴板。');
            } catch {
                appendOutput('\n\n=== 原始 JSON ===\n' + lastReport + '\n');
                setStatus('剪贴板被拒绝，请从下方文本框手动复制。');
            }
        });

        const roundsEl = document.getElementById('st-rw-rounds');
        if (roundsEl) {
            roundsEl.checked = !!settings().rounds;
            roundsEl.addEventListener('change', () => {
                settings().rounds = roundsEl.checked;
                saveSettingsDebounced();
            });
        }

        // 预加载 wasm，并暴露给其它扩展
        wasm = await loadWasm();
        window.STRenderWasm = {
            version: () => '0.1.0',
            render: makeRenderer(wasm),
            backend: 'pulldown-cmark (rustc wasm32-unknown-unknown)',
        };
        setStatus('Rust/WASM 引擎已就绪（window.STRenderWasm）。');
        console.log(`[${MODULE_NAME}] wasm 已加载，ABI=1`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] 初始化失败：`, err);
        setStatus('初始化失败：' + (err?.message || err));
    }
});
