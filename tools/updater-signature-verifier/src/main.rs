use std::{env, fs::File, io::Read, path::PathBuf, process::ExitCode};

use minisign_verify::{PublicKey, Signature};

fn public_key_from_tauri_config(value: &str) -> Result<PublicKey, String> {
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, value.trim())
        .map_err(|_| "Tauri updater public key is not valid base64".to_string())?;
    let key = String::from_utf8(decoded)
        .map_err(|_| "Tauri updater public key is not UTF-8".to_string())?;
    PublicKey::decode(&key).map_err(|error| format!("Tauri updater public key is invalid: {error}"))
}

fn verify_stream<R: Read>(
    public_key: &PublicKey,
    signature: &Signature,
    reader: &mut R,
) -> Result<(), String> {
    let mut verifier = public_key.verify_stream(signature).map_err(|error| {
        format!("Cannot begin streaming updater signature verification: {error}")
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read updater artifact: {error}"))?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize().map_err(|error| format!("Updater signature verification failed: {error}"))
}

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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use minisign_verify::{PublicKey, Signature};

    use super::verify_stream;

    const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn fixture() -> (PublicKey, Signature) {
        (
            PublicKey::from_base64(PUBLIC_KEY).expect("fixture key"),
            Signature::decode(SIGNATURE).expect("fixture signature"),
        )
    }

    #[test]
    fn accepts_the_final_bytes_with_their_signature() {
        let (key, signature) = fixture();
        assert!(verify_stream(&key, &signature, &mut Cursor::new(b"test")).is_ok());
    }

    #[test]
    fn rejects_tampered_final_bytes() {
        let (key, signature) = fixture();
        assert!(verify_stream(&key, &signature, &mut Cursor::new(b"Test")).is_err());
    }

    #[test]
    fn rejects_a_wrong_signature_or_key() {
        let (key, _) = fixture();
        let wrong_signature = Signature::decode(&SIGNATURE.replacen("y/rUw", "z/rUw", 1))
            .expect("modified fixture remains structurally valid");
        assert!(verify_stream(&key, &wrong_signature, &mut Cursor::new(b"test")).is_err());

        let wrong_key = PublicKey::from_base64(&PUBLIC_KEY.replacen("3ml", "3mm", 1))
            .expect("modified key remains structurally valid");
        let (_, signature) = fixture();
        assert!(verify_stream(&wrong_key, &signature, &mut Cursor::new(b"test")).is_err());
    }
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
