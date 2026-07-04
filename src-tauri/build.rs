fn main() {
    // Track the runtime window icon so Cargo rebuilds when it
    // changes. We `include_bytes!` `icons/icon.png` in `lib.rs` to
    // set the GTK window + dock icon at startup; rustc tracks
    // `include_bytes!` targets for incremental rebuilds, but adding
    // an explicit `rerun-if-changed` is the belt-and-suspenders
    // version and saves debugging "why is the old icon still
    // showing" if the heuristic ever drifts.
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
