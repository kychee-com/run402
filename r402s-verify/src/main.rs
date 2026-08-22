//! `r402s-verify` CLI — see `README.md`. Exit code 0 iff every check passed.

use clap::{Parser, Subcommand};
use r402s_verify::json::{parse_lenient_layout, pretty, Value};
use r402s_verify::schema::SchemaSet;
use r402s_verify::{chain, gitdiff, receipt, vectors};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "r402s-verify",
    version,
    about = "Independent-lineage verifier for the gitvault r402s/v0 protocol"
)]
struct Cli {
    /// Directory holding the protocol's JSON-Schema set (`common.json`, `head.json`, …).
    /// Defaults to `$R402S_SCHEMAS`, else `<vectors>/../schemas` for `vectors`.
    #[arg(long, global = true)]
    schemas: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Replay the task-1.2 vector set (vectors.json + hpke-interop/golden.json + CONTINUITY.json).
    Vectors {
        /// Path to `vectors.json` (default: `$R402S_VECTORS`, else the sibling private checkout).
        path: Option<PathBuf>,
    },
    /// Verify a vault's heads + admission records + generation continuity from a bucket export.
    Chain {
        dir: PathBuf,
        /// The generation a client already materialized; a newest generation below it is GENERATION_REGRESSION.
        #[arg(long)]
        pin_generation: Option<String>,
        /// The service-key registry ROOT public key (base64url), as pinned in the signed client.
        #[arg(long)]
        registry_root_pubkey: Option<String>,
        /// Without a registry in the export, admission-record signatures cannot be verified; this
        /// downgrades that from a failure to a warning.
        #[arg(long)]
        allow_unverified_service_signatures: bool,
    },
    /// Differential git validation: rebuild the object set of a snapshot materialization and compare to the repo.
    Git {
        repo: PathBuf,
        materialization: PathBuf,
        /// A decrypted plaintext `ref_state` object (JSON) whose refs/head_target must match.
        #[arg(long)]
        ref_state: Option<PathBuf>,
        /// `K_digest("objectset")` as 64 lowercase hex — emits `restored_object_set_hmac`.
        #[arg(long)]
        k_digest_objectset: Option<String>,
        /// The checkpoint manifest's `object_set_hmac` to compare bytewise.
        #[arg(long)]
        expect_object_set_hmac: Option<String>,
    },
    /// Emit or check a signed `verifier_receipt`.
    Receipt {
        #[command(subcommand)]
        cmd: ReceiptCmd,
    },
}

#[derive(Subcommand)]
enum ReceiptCmd {
    /// Emit a `verifier_receipt` (stored bytes to stdout), signed with a verifier key file.
    Emit {
        /// File holding the 32-byte Ed25519 seed (64 lowercase hex or 43 base64url chars).
        #[arg(long)]
        key: PathBuf,
        #[arg(long)]
        repo_id: String,
        #[arg(long)]
        intent_core_sha256: String,
        #[arg(long)]
        checkpoint_head_sha256: String,
        #[arg(long)]
        cutoff_ticket_sha256: Option<String>,
        #[arg(long)]
        restored_object_set_hmac: String,
        #[arg(long)]
        retention_evolution_ok: bool,
        #[arg(long)]
        candidates_outside_roots_ok: bool,
        /// `restored_and_verified` or `failed`.
        #[arg(long, default_value = "restored_and_verified")]
        result: String,
        /// Fixed `vr_<32 hex>` id (default: minted from the OS CSPRNG).
        #[arg(long)]
        object_id: Option<String>,
    },
    /// Check a receipt's stored bytes against a verifier public key (base64url).
    Check {
        file: PathBuf,
        #[arg(long)]
        pubkey: String,
    },
    /// Print the base64url public key of a verifier key file.
    Pubkey {
        #[arg(long)]
        key: PathBuf,
    },
}

fn load_schemas(p: &Option<PathBuf>) -> Option<SchemaSet> {
    let dir = p
        .clone()
        .or_else(|| std::env::var("R402S_SCHEMAS").ok().map(PathBuf::from))?;
    match SchemaSet::load_dir(&dir) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("warning: schemas not loaded: {e}");
            None
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Vectors { path } => {
            if let Some(s) = &cli.schemas {
                std::env::set_var("R402S_SCHEMAS", s);
            }
            let path = match path.or_else(vectors::locate_vectors) {
                Some(p) => p,
                None => {
                    eprintln!("no vectors.json: pass a path, set R402S_VECTORS, or check out run402-private beside this repo");
                    return ExitCode::from(2);
                }
            };
            let r = match vectors::run(&path) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("error: {e}");
                    return ExitCode::from(2);
                }
            };
            println!(
                "{:36} {:>8} {:>7} {:>9}  status",
                "class", "vectors", "checks", "failures"
            );
            for (c, t) in &r.classes {
                println!(
                    "{c:36} {:>8} {:>7} {:>9}  {}",
                    t.vectors, t.checks, t.failures, t.status
                );
            }
            for f in &r.failures {
                println!("DISAGREEMENT {f}");
            }
            for n in &r.notes {
                println!("note: {n}");
            }
            println!(
                "replayed {} vectors (rev {}) + {} interop golden cases: {} checks, {} disagreements",
                r.vector_count,
                r.revision,
                r.interop_cases,
                r.checks,
                r.failures.len()
            );
            if r.ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Cmd::Chain {
            dir,
            pin_generation,
            registry_root_pubkey,
            allow_unverified_service_signatures,
        } => {
            let schemas = load_schemas(&cli.schemas);
            if schemas.is_none() {
                eprintln!("warning: no --schemas given; schema checks are skipped");
            }
            let opts = chain::ChainOptions {
                schemas: schemas.as_ref(),
                pin_generation,
                registry_root_pubkey,
                allow_unverified_service_signatures,
            };
            let r = chain::verify_chain(&dir, &opts);
            println!("{}", pretty(&chain::report_value(&r)));
            if r.ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Cmd::Git {
            repo,
            materialization,
            ref_state,
            k_digest_objectset,
            expect_object_set_hmac,
        } => {
            let rs: Option<Value> = match ref_state {
                Some(p) => match std::fs::read(&p)
                    .map_err(|e| e.to_string())
                    .and_then(|b| parse_lenient_layout(&b).map_err(|e| e.to_string()))
                {
                    Ok(v) => Some(v),
                    Err(e) => {
                        eprintln!("error: ref_state {}: {e}", p.display());
                        return ExitCode::from(2);
                    }
                },
                None => None,
            };
            let kd: Option<[u8; 32]> = match k_digest_objectset {
                Some(h) => match r402s_verify::codec::unhex(&h)
                    .ok()
                    .and_then(|b| b.try_into().ok())
                {
                    Some(k) => Some(k),
                    None => {
                        eprintln!("error: --k-digest-objectset must be 64 lowercase hex");
                        return ExitCode::from(2);
                    }
                },
                None => None,
            };
            let opts = gitdiff::DiffOptions {
                ref_state: rs.as_ref(),
                k_digest_objectset: kd,
                expect_object_set_hmac,
            };
            match gitdiff::differential(&repo, &materialization, &opts) {
                Ok(r) => {
                    println!("{}", pretty(&gitdiff::report_value(&r)));
                    if r.ok() {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::from(2)
                }
            }
        }
        Cmd::Receipt { cmd } => {
            let schemas = load_schemas(&cli.schemas);
            match cmd {
                ReceiptCmd::Emit {
                    key,
                    repo_id,
                    intent_core_sha256,
                    checkpoint_head_sha256,
                    cutoff_ticket_sha256,
                    restored_object_set_hmac,
                    retention_evolution_ok,
                    candidates_outside_roots_ok,
                    result,
                    object_id,
                } => {
                    let seed = match receipt::load_seed(&key) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("error: {e}");
                            return ExitCode::from(2);
                        }
                    };
                    let inp = receipt::ReceiptInput {
                        repo_id,
                        intent_core_sha256,
                        checkpoint_head_sha256,
                        cutoff_ticket_sha256,
                        restored_object_set_hmac,
                        retention_evolution_ok,
                        candidates_outside_roots_ok,
                        result,
                        object_id,
                    };
                    match receipt::emit(&inp, &seed, schemas.as_ref()) {
                        Ok(obj) => {
                            use std::io::Write;
                            let bytes = r402s_verify::preimage::stored_bytes(&obj);
                            std::io::stdout().write_all(&bytes).ok();
                            std::io::stdout().write_all(b"\n").ok();
                            eprintln!(
                                "stored_bytes_sha256 {}",
                                r402s_verify::preimage::sha256_hex(&bytes)
                            );
                            eprintln!(
                                "verifier_pubkey {}",
                                r402s_verify::codec::b64u(
                                    &r402s_verify::sig::public_key_from_seed(&seed)
                                )
                            );
                            ExitCode::SUCCESS
                        }
                        Err(e) => {
                            eprintln!("error: {e}");
                            ExitCode::from(1)
                        }
                    }
                }
                ReceiptCmd::Pubkey { key } => match receipt::load_seed(&key) {
                    Ok(seed) => {
                        println!(
                            "{}",
                            r402s_verify::codec::b64u(&r402s_verify::sig::public_key_from_seed(
                                &seed
                            ))
                        );
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("error: {e}");
                        ExitCode::from(2)
                    }
                },
                ReceiptCmd::Check { file, pubkey } => {
                    let bytes = match std::fs::read(&file) {
                        Ok(b) => b,
                        Err(e) => {
                            eprintln!("error: {}: {e}", file.display());
                            return ExitCode::from(2);
                        }
                    };
                    // a trailing newline written by `emit` is not part of the stored bytes
                    let bytes = bytes
                        .strip_suffix(b"\n")
                        .map(|b| b.to_vec())
                        .unwrap_or(bytes);
                    let r = receipt::check(&bytes, &pubkey, schemas.as_ref());
                    println!("stored_bytes_sha256 {}", r.stored_bytes_sha256);
                    for f in &r.failures {
                        println!("FAIL {f}");
                    }
                    if r.failures.is_empty() {
                        println!("verified");
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
            }
        }
    }
}
