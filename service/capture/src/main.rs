// SPDX-License-Identifier: GPL-3.0-only
use std::io::{self, IsTerminal};
use wayrill_capture::{controller::Controller, wire};
fn main() -> std::process::ExitCode {
    if io::stdin().is_terminal() || io::stdout().is_terminal() {
        return std::process::ExitCode::from(2);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Capture runtime failed: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let mut controller = Controller::default();
    let result = wire::serve(
        io::stdin().lock(),
        io::stdout().lock(),
        |command, progress| runtime.block_on(controller.command(command, progress)),
    );
    let cleanup = runtime.block_on(controller.stop());
    if let Err(error) = result.and(cleanup) {
        eprintln!("Capture worker stopped: {error}");
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}
