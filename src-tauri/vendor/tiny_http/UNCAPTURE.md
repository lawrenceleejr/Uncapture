# tiny_http 0.12.0, with one fix

A copy of [tiny_http](https://github.com/tiny-http/tiny-http) 0.12.0 (MIT or
Apache-2.0, licences here), used through `[patch.crates-io]` in
`src-tauri/Cargo.toml`. Only `src/`, the manifest and the licences are kept.

The fix is in `src/util/task_pool.rs`, `TaskPool::spawn`. Each connection is
a task for the pool's threads. `spawn` queued a new connection whenever
`waiting_tasks > 0`, but a thread woken for an earlier queued task still
counts as waiting until it takes the lock back. Two connections arriving
together were both queued for one thread; the second sat in the queue until
some thread finished a task, and with a browser's keep-alive connections
that can be minutes. In Uncapture that was a thumbnail batch or a picture
that never arrived. Now a task is queued only while there are more waiting
threads than queued tasks; otherwise it gets a new thread.

Drop this copy when a tiny_http release fixes it.
