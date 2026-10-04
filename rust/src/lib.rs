//! ST-Render-Wasm · SillyTavern 渲染加速内核
//!
//! 只做一件事：把 markdown 转成 HTML，但比 JS 实现快。
//! 刻意**不做 HTML 净化** —— 净化涉及安全边界，保留酒馆的 DOMPurify，
//! 避免自己重写净化规则引入 XSS 风险。
//!
//! 导出的是最朴素的 C ABI，不需要 wasm-bindgen / wasm-pack：
//!   st_alloc(len) -> ptr        在 wasm 线性内存里分配缓冲区
//!   st_free(ptr, len)           释放
//!   st_markdown_to_html(ptr, len, &out_len) -> ptr   返回结果指针，长度写入 out_len
//!   st_abi_version() -> u32

use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use pulldown_cmark::{html, Options, Parser};

/// ABI 版本：JS 侧核对用，避免加载到不兼容的 wasm
#[no_mangle]
pub extern "C" fn st_abi_version() -> u32 {
    1
}

/// 分配 len 字节的缓冲区，交给 JS 侧写入 UTF-8 文本
#[no_mangle]
pub extern "C" fn st_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    // 按 8 字节对齐，满足后续可能的对齐读取
    match Layout::from_size_align(len, 8) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// 释放 st_alloc / st_markdown_to_html 返回的缓冲区
#[no_mangle]
pub extern "C" fn st_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(len, 8) {
        unsafe { dealloc(ptr, layout) };
    }
}

fn gfm_options() -> Options {
    let mut opt = Options::empty();
    opt.insert(Options::ENABLE_TABLES);
    opt.insert(Options::ENABLE_STRIKETHROUGH);
    opt.insert(Options::ENABLE_TASKLISTS);
    opt.insert(Options::ENABLE_FOOTNOTES);
    // 与 showdown 的行为对齐：保留原始 HTML 片段
    opt.insert(Options::ENABLE_SMART_PUNCTUATION);
    opt
}

/// markdown -> HTML（UTF-8 进出）
///
/// # Safety
/// `ptr` 必须指向 `len` 字节的可读内存，`out_len` 必须是可写的 usize 指针。
#[no_mangle]
pub unsafe extern "C" fn st_markdown_to_html(
    ptr: *const u8,
    len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if ptr.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = slice::from_raw_parts(ptr, len);
    let input = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };

    let parser = Parser::new_ext(input, gfm_options());
    let mut out = String::with_capacity(len + len / 2 + 64);
    html::push_html(&mut out, parser);

    let out_bytes = out.as_bytes();
    let n = out_bytes.len();
    let buf = st_alloc(n);
    if buf.is_null() {
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(out_bytes.as_ptr(), buf, n);
    *out_len = n;
    buf
}
