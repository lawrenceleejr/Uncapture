// Uncapture: clean up the Photos library. Photos taken close together are
// shown side by side; keep the best, delete the rest.
//
//   uncapture                              open the app window (macOS)
//   uncapture --serve [--port 4880] [--no-open] [--fake FOLDER]
//        terminal mode: serve the UI and open a browser. --fake uses a folder
//        of JPEGs instead of the Photos library (tests, Linux, trying it out).

mod cluster;
mod exif;
mod fake;
#[cfg(feature = "gui")]
mod gui;
#[cfg(target_os = "macos")]
mod photokit;
mod resize;
mod server;
mod source;

use source::PhotoSource;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!(
            "uncapture — keep the best of each burst of photos, delete the rest\n\n\
             usage: uncapture [--serve] [--port 4880] [--no-open] [--fake FOLDER]\n\n  \
             --serve    run in the terminal and use Uncapture in your browser\n  \
             --port     port to listen on (default 4880)\n  \
             --no-open  don't open a browser window\n  \
             --fake     a folder of JPEGs instead of the Photos library"
        );
        return;
    }
    let fake = arg_after(&args, "--fake");
    let serve = args.iter().any(|a| a == "--serve") || !cfg!(feature = "gui");
    let src = match source_for(fake) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(2);
        }
    };
    if serve {
        serve_mode(&args, src);
    } else {
        #[cfg(feature = "gui")]
        gui::run(src);
    }
}

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn source_for(fake: Option<String>) -> Result<Arc<dyn PhotoSource>, String> {
    if let Some(dir) = fake {
        let p = std::fs::canonicalize(&dir).map_err(|e| format!("--fake {}: {}", dir, e))?;
        return Ok(Arc::new(fake::FakeSource::new(p)));
    }
    #[cfg(target_os = "macos")]
    return Ok(Arc::new(photokit::PhotoKitSource::new()));
    #[cfg(not(target_os = "macos"))]
    Err("The Photos library is only on a Mac. Use --fake FOLDER for a folder of JPEGs.".into())
}

fn serve_mode(args: &[String], src: Arc<dyn PhotoSource>) {
    let port = arg_after(args, "--port").and_then(|p| p.parse().ok()).unwrap_or(4880u16);
    let app = server::App::new(src, "browser");
    // the link carries this launch's key: only whoever has it can use the API
    let key = app.key.clone();
    let port = server::start(app, port).expect("could not start server");
    let url = format!("http://127.0.0.1:{}/?key={}", port, key);
    println!("\n  uncapture  →  {}\n  ctrl-c to quit\n", url);
    if !args.iter().any(|a| a == "--no-open") {
        server::open_url(&url);
    }
    let _ = ctrlc::set_handler(|| std::process::exit(0));
    loop {
        std::thread::park();
    }
}
