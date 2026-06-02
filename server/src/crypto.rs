use rand::Rng;
use sha2::{Digest, Sha256};

fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

// minimal hex (avoid extra crate)
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut s = String::new();
        for b in bytes.as_ref() {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }
}

pub fn hash_password(password: &str) -> String {
    let salt: String = (0..16)
        .map(|_| rand::thread_rng().gen_range(b'a'..=b'z') as char)
        .collect();
    format!("{salt}:{}", sha256_hex(&format!("{salt}{password}")))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    match stored.split_once(':') {
        Some((salt, want)) => sha256_hex(&format!("{salt}{password}")) == want,
        None => false,
    }
}

pub fn random_code(len: i64) -> String {
    let mut rng = rand::thread_rng();
    (0..len).map(|_| rng.gen_range(0..10).to_string()).collect()
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn out_trade_no() -> String {
    let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
    let r: u32 = rand::thread_rng().gen_range(1000..9999);
    format!("DA{ts}{r}")
}
