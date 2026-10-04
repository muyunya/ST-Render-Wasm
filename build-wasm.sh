#!/usr/bin/env bash
# 重新编译 wasm（改动 rust/src 后运行）。需要 rustup + wasm32-unknown-unknown 目标。
# 编译产物会被复制到 wasm/ 并随仓库提交，用户无需安装 Rust 即可直接使用。
set -euo pipefail
cd "$(dirname "$0")/rust"
# 重映射源码路径：否则编译产物里会写入本机的 /Users/<用户名>/...
export RUSTFLAGS="--remap-path-prefix=$HOME=/build --remap-path-prefix=$(cd "$(dirname "$0")" && pwd)=/src"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/st_render_wasm.wasm ../wasm/st_render_wasm.wasm
ls -la ../wasm/st_render_wasm.wasm
