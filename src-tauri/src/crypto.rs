//! Cryptographic primitives for encrypted vaults.
//!
//! Vault notes are sealed with XChaCha20-Poly1305 under a per-vault data
//! encryption key (DEK). The DEK is wrapped by a key encryption key (KEK)
//! derived from the user's password with Argon2id, so the password never
//! touches the file format directly.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// File header that marks a sealed vault file.
pub const MAGIC: &[u8; 8] = b"MOJIANM1";

/// Length of the XChaCha20-Poly1305 nonce in bytes.
pub const NONCE_LEN: usize = 24;

/// Length of the Poly1305 authentication tag in bytes.
pub const TAG_LEN: usize = 16;

/// Length of a symmetric key in bytes.
pub const KEY_LEN: usize = 32;

/// Length of a vault identifier in bytes.
pub const VAULT_ID_LEN: usize = 16;

/// Length of an Argon2 salt in bytes.
pub const SALT_LEN: usize = 16;

/// Associated data that binds a wrapped DEK to its purpose.
pub const KEY_AAD: &[u8] = b"MOJIAN-KEY";

/// Argon2id cost parameters for deriving the KEK from a password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub memory_kib: u32,
    /// Time cost as the number of passes.
    pub iterations: u32,
    /// Degree of parallelism (lanes).
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            memory_kib: 65_536,
            iterations: 3,
            parallelism: 1,
        }
    }
}

impl KdfParams {
    /// Validate the parameters against the ranges this app accepts.
    pub fn validate(&self) -> Result<(), String> {
        if !(8_192..=262_144).contains(&self.memory_kib) {
            return Err("KDF memory cost is outside the accepted range.".to_string());
        }
        if !(1..=10).contains(&self.iterations) {
            return Err("KDF iteration count is outside the accepted range.".to_string());
        }
        if !(1..=8).contains(&self.parallelism) {
            return Err("KDF parallelism is outside the accepted range.".to_string());
        }
        Ok(())
    }
}

/// A 256-bit vault data encryption key.
///
/// The key is zeroized on drop and deliberately cannot be cloned or debug
/// formatted.
pub struct VaultKey([u8; KEY_LEN]);

impl VaultKey {
    /// Generate a fresh random DEK.
    pub fn generate() -> Self {
        let mut bytes = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    /// Reconstruct a DEK from raw bytes.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Borrow the raw key material.
    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

/// An unlocked vault session: the vault's DEK and its public identifier.
pub struct VaultSession {
    /// The unwrapped vault data encryption key.
    pub key: VaultKey,
    /// The random identifier that binds ciphertexts to this vault.
    pub vault_id: [u8; VAULT_ID_LEN],
}

impl VaultSession {
    /// Create a session from an unwrapped key and its vault identifier.
    pub fn new(key: VaultKey, vault_id: [u8; VAULT_ID_LEN]) -> Self {
        Self { key, vault_id }
    }
}

/// Derive the key encryption key from a password and salt with Argon2id.
pub fn derive_kek(
    password: &str,
    salt: &[u8],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    params.validate()?;
    if salt.len() < 8 {
        return Err("The KDF salt is too short.".to_string());
    }
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|_| "Invalid KDF parameters.".to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *out)
        .map_err(|_| "Unable to derive a key from the password.".to_string())?;
    Ok(out)
}

/// Wrap the DEK under the KEK. Returns `nonce (24) || ciphertext (48)`.
pub fn wrap_dek(
    kek: &[u8; KEY_LEN],
    key: &VaultKey,
    vault_id: &[u8; VAULT_ID_LEN],
) -> Result<Vec<u8>, String> {
    let cipher = new_cipher(kek)?;
    let nonce = random_nonce();
    let aad = aad_for(KEY_AAD, vault_id);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: key.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| "Unable to wrap the vault key.".to_string())?;

    let mut wrapped = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    wrapped.extend_from_slice(&nonce);
    wrapped.extend_from_slice(&ciphertext);
    Ok(wrapped)
}

/// Unwrap the DEK from `nonce (24) || ciphertext (48)`.
pub fn unwrap_dek(
    kek: &[u8; KEY_LEN],
    wrapped: &[u8],
    vault_id: &[u8; VAULT_ID_LEN],
) -> Result<VaultKey, String> {
    const WRAPPED_LEN: usize = NONCE_LEN + KEY_LEN + TAG_LEN;
    if wrapped.len() != WRAPPED_LEN {
        return Err("The wrapped vault key has an invalid length.".to_string());
    }

    let cipher = new_cipher(kek)?;
    let nonce = &wrapped[..NONCE_LEN];
    let ciphertext = &wrapped[NONCE_LEN..];
    let aad = aad_for(KEY_AAD, vault_id);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "Unable to unwrap the vault key.".to_string())?,
    );

    let bytes: [u8; KEY_LEN] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| "The wrapped vault key has an invalid length.".to_string())?;
    Ok(VaultKey::from_bytes(bytes))
}

/// Seal plaintext as `MAGIC || nonce || ciphertext || tag`.
pub fn seal(
    key: &VaultKey,
    vault_id: &[u8; VAULT_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = new_cipher(key.as_bytes())?;
    let nonce = random_nonce();
    let aad = aad_for(MAGIC, vault_id);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "Unable to seal the data.".to_string())?;

    let mut sealed = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    sealed.extend_from_slice(MAGIC);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Open a sealed buffer, verifying its magic, length, and authentication tag.
pub fn open(
    key: &VaultKey,
    vault_id: &[u8; VAULT_ID_LEN],
    sealed: &[u8],
) -> Result<Vec<u8>, String> {
    if !is_sealed(sealed) {
        return Err("The data is not a sealed vault file.".to_string());
    }

    let cipher = new_cipher(key.as_bytes())?;
    let nonce = &sealed[MAGIC.len()..MAGIC.len() + NONCE_LEN];
    let ciphertext = &sealed[MAGIC.len() + NONCE_LEN..];
    let aad = aad_for(MAGIC, vault_id);
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "Unable to open the sealed data.".to_string())
}

/// Return `true` when `bytes` looks like a sealed vault file.
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() + NONCE_LEN + TAG_LEN && bytes.starts_with(MAGIC)
}

fn new_cipher(key: &[u8]) -> Result<XChaCha20Poly1305, String> {
    XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "Unable to initialize the cipher.".to_string())
}

fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

/// Bind the associated data to a purpose (wrapped key or file) and a vault.
fn aad_for(prefix: &[u8], vault_id: &[u8; VAULT_ID_LEN]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(prefix.len() + VAULT_ID_LEN);
    aad.extend_from_slice(prefix);
    aad.extend_from_slice(vault_id);
    aad
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_kdf() -> KdfParams {
        KdfParams {
            memory_kib: 8192,
            iterations: 1,
            parallelism: 1,
        }
    }
    fn key() -> VaultKey {
        VaultKey::from_bytes([7u8; 32])
    }
    const VAULT: [u8; 16] = [9u8; 16];

    #[test]
    fn seal_open_roundtrip_including_empty() {
        let plain = b"hello \xe4\xb8\x96\xe7\x95\x8c";
        let sealed = seal(&key(), &VAULT, plain).unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(open(&key(), &VAULT, &sealed).unwrap(), plain);
        let empty = seal(&key(), &VAULT, b"").unwrap();
        assert_eq!(open(&key(), &VAULT, &empty).unwrap(), b"");
    }

    #[test]
    fn wrong_key_vault_or_tamper_fails() {
        let sealed = seal(&key(), &VAULT, b"secret").unwrap();
        let other = VaultKey::from_bytes([8u8; 32]);
        assert!(open(&other, &VAULT, &sealed).is_err());
        assert!(open(&key(), &[1u8; 16], &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(open(&key(), &VAULT, &tampered).is_err());
        assert!(!is_sealed(b"short"));
    }

    #[test]
    fn every_seal_uses_a_new_nonce() {
        assert_ne!(
            seal(&key(), &VAULT, b"x").unwrap(),
            seal(&key(), &VAULT, b"x").unwrap()
        );
    }

    #[test]
    fn wraps_and_unwraps_the_dek() {
        let kek = derive_kek("correct horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let wrapped = wrap_dek(&kek, &key(), &VAULT).unwrap();
        assert_eq!(wrapped.len(), NONCE_LEN + KEY_LEN + TAG_LEN);
        assert_eq!(
            unwrap_dek(&kek, &wrapped, &VAULT).unwrap().as_bytes(),
            key().as_bytes()
        );
    }

    #[test]
    fn wrong_password_or_vault_id_cannot_unwrap() {
        let kek = derive_kek("correct horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let other = derive_kek("wrong horse", &[3u8; SALT_LEN], &fast_kdf()).unwrap();
        let wrapped = wrap_dek(&kek, &key(), &VAULT).unwrap();
        assert!(unwrap_dek(&other, &wrapped, &VAULT).is_err());
        assert!(unwrap_dek(&kek, &wrapped, &[4u8; 16]).is_err());
    }

    #[test]
    fn kdf_params_are_validated() {
        assert!(fast_kdf().validate().is_ok());
        for params in [
            KdfParams {
                memory_kib: 1024,
                iterations: 1,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 8192,
                iterations: 0,
                parallelism: 1,
            },
            KdfParams {
                memory_kib: 8192,
                iterations: 1,
                parallelism: 0,
            },
            KdfParams {
                memory_kib: 1_000_000,
                iterations: 1,
                parallelism: 1,
            },
        ] {
            assert!(params.validate().is_err());
        }
    }
}
