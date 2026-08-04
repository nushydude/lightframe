use std::{env, fs::File, path::PathBuf, process::ExitCode};

use lightframe_lib::updater_signature::{public_key_from_tauri_config, verify_stream};
use minisign_verify::Signature;

fn argument(name: &str) -> Result<String, String> {
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == name {
            return arguments.next().ok_or_else(|| format!("{name} requires a value"));
        }
    }
    Err(format!("{name} is required"))
}

fn run() -> Result<(), String> {
    let artifact = PathBuf::from(argument("--artifact")?);
    let signature_path = PathBuf::from(argument("--signature")?);
    let config_path = PathBuf::from(argument("--tauri-config")?);
    let config: serde_json::Value = serde_json::from_reader(
        File::open(&config_path).map_err(|error| format!("Cannot open Tauri config: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse Tauri config: {error}"))?;
    let encoded_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Tauri updater public key is missing".to_string())?;
    let public_key = public_key_from_tauri_config(encoded_key)?;
    let signature = Signature::from_file(&signature_path)
        .map_err(|error| format!("Cannot read updater signature: {error}"))?;
    let mut file =
        File::open(&artifact).map_err(|error| format!("Cannot open updater artifact: {error}"))?;
    verify_stream(&public_key, &signature, &mut file)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
