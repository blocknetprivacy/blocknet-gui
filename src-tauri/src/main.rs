#![windows_subsystem = "windows"]

#[tokio::main]
async fn main() {
    blocknet_wallet_lib::run()
}
