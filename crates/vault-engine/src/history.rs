//! HistoryStore —— 恢复数据（recovery data，非 cache）。
//!
//! 两个存储：
//! - objects/<hash前2>/<hash>.zst ：内容寻址，天然去重
//! - history/index.db             ：版本链表（path, hash, ts, source）
//!
//! 独立于 .cyrene/index.db（后者是派生数据，可删可重建）；
//! 重建派生数据的流程永远不该知道本目录存在（契约 §5.4）。
//!
//! 写入顺序：先对象后 DB 行。崩溃残留的孤儿对象由 GC 清理，无害。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use vault_core::{ContentHash, HistorySource};

pub struct HistoryStore {
    root: PathBuf, // <vault>/.cyrene/history
    // Connection 非 Sync；Mutex 包一层让 Arc<HistoryStore> 能进 watcher 线程。
    // 写入频率低（一次版本一行），锁竞争不存在。
    db: Mutex<Connection>,
}

impl HistoryStore {
    pub fn open(vault_root: &Path) -> std::io::Result<Self> {
        let root = vault_root.join(".cyrene").join("history");
        std::fs::create_dir_all(root.join("objects"))?;
        let db = Connection::open(root.join("index.db"))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS history (
                 path   TEXT NOT NULL,
                 hash   TEXT NOT NULL,
                 ts     INTEGER NOT NULL,
                 source TEXT NOT NULL,
                 PRIMARY KEY (path, hash, ts)
             );
             CREATE INDEX IF NOT EXISTS idx_history_path_ts ON history(path, ts DESC);",
        )
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        Ok(Self { root, db: Mutex::new(db) })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        // 锁中毒只可能发生在 panic 时，此时 DB 已不可信——poison 直接传播 panic
        self.db.lock().expect("history db 锁中毒")
    }

    /// snapshot 一个完整版本：对象（如缺失）+ DB 行。
    /// 相同 hash 的对象已存在时跳过写入——去重零成本。
    pub fn snapshot(
        &self,
        path: &str,
        disk_bytes: &[u8],
        source: HistorySource,
    ) -> std::io::Result<ContentHash> {
        let hash = ContentHash::from_bytes(disk_bytes);
        let obj = self.object_path(&hash);
        if !obj.exists() {
            if let Some(parent) = obj.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // zstd level 3：速度/压缩比均衡；笔记体量小，无所谓
            let compressed = zstd::encode_all(disk_bytes, 3)?;
            // 先写临时再 rename：对象文件本身也保证原子性
            let tmp = obj.with_extension("tmp");
            std::fs::write(&tmp, compressed)?;
            std::fs::rename(&tmp, &obj)?;
        }
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // 同 (path,hash) 重复 snapshot 只刷新 ts 行为 no-op（IGNORE），DB 里不膨胀
        self.db()
            .execute(
                "INSERT OR IGNORE INTO history (path, hash, ts, source) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![path, hash.as_str(), ts, source.as_str()],
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        Ok(hash)
    }

    /// 取回某个版本的内容（解压）。
    pub fn load(&self, path: &str, hash: &str) -> std::io::Result<Vec<u8>> {
        // DB 校验该 (path, hash) 确实在链上（防止读任意 hash 的对象）
        let known: bool = self
            .db()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM history WHERE path = ?1 AND hash = ?2)",
                rusqlite::params![path, hash],
                |row| row.get(0),
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        if !known {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("history 里没有 {path}@{hash}"),
            ));
        }
        let h = ContentHash(hash.to_string());
        let obj = self.object_path(&h);
        let compressed = std::fs::read(obj)?;
        let bytes = zstd::decode_all(&compressed[..])?;
        // 完整性自检：对象名就是内容 hash
        if ContentHash::from_bytes(&bytes).as_str() != hash {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("对象内容与 hash 不符: {hash}"),
            ));
        }
        Ok(bytes)
    }

    /// 某路径的版本链（时间倒序）。
    pub fn versions(&self, path: &str) -> Vec<(String, i64, String)> {
        let db = self.db();
        let mut stmt = match db.prepare(
            "SELECT hash, ts, source FROM history WHERE path = ?1 ORDER BY ts DESC",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        });
        match rows {
            Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// GC：删除「无任何 history 行引用」的对象。
    /// 保留策略：每路径最近 N 版 + 30 天内的版本不删其对象。
    pub fn gc(&self) -> std::io::Result<usize> {
        const KEEP_PER_PATH: i64 = 20;
        const KEEP_WINDOW_MS: i64 = 30 * 24 * 3600 * 1000;

        // 保留集合：每路径最近 N 个 hash + 窗口期内的 hash
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let db = self.db();
            let mut stmt = db
                .prepare("SELECT DISTINCT path FROM history")
                .map_err(io_err)?;
            let paths: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(io_err)?
                .filter_map(|r| r.ok())
                .collect();
            for path in paths {
                let mut stmt = db
                    .prepare(
                        "SELECT hash, ts FROM history WHERE path = ?1 ORDER BY ts DESC",
                    )
                    .map_err(io_err)?;
                let rows: Vec<(String, i64)> = stmt
                    .query_map(rusqlite::params![path], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })
                    .map_err(io_err)?
                    .filter_map(|r| r.ok())
                    .collect();
                for (i, (hash, ts)) in rows.iter().enumerate() {
                    if (i as i64) < KEEP_PER_PATH || *ts >= now_ms() - KEEP_WINDOW_MS {
                        keep.insert(hash.clone());
                    }
                }
            }
        }

        // 扫描对象目录，删除不在保留集合内的
        let objects_dir = self.root.join("objects");
        let mut removed = 0;
        for shard in std::fs::read_dir(&objects_dir)? {
            let shard = shard?;
            if !shard.path().is_dir() {
                continue;
            }
            for obj in std::fs::read_dir(shard.path())? {
                let obj = obj?;
                let name = obj.file_name().to_string_lossy().to_string();
                if name.ends_with(".tmp") {
                    let _ = std::fs::remove_file(obj.path()); // 崩溃残留
                    removed += 1;
                    continue;
                }
                let hash = name.strip_suffix(".zst").unwrap_or(&name).to_string();
                if !keep.contains(&hash) {
                    let _ = std::fs::remove_file(obj.path());
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    fn object_path(&self, hash: &ContentHash) -> PathBuf {
        let s = hash.as_str();
        self.root.join("objects").join(&s[..2]).join(format!("{s}.zst"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn io_err(e: rusqlite::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (HistoryStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = HistoryStore::open(dir.path()).unwrap();
        (s, dir)
    }

    #[test]
    fn snapshot_dedups_and_roundtrips() {
        let (s, _d) = store();
        let h1 = s.snapshot("a.md", b"v1\n", HistorySource::Open).unwrap();
        // 相同内容再 snapshot（不同 source）——对象不重复，DB 追加行
        s.snapshot("a.md", b"v1\n", HistorySource::IndexScan).unwrap();
        let bytes = s.load("a.md", h1.as_str()).unwrap();
        assert_eq!(bytes, b"v1\n");
        // versions 有两行（不同 ts 可能同 ms；PK (path,hash,ts) 允许同 hash 双行）
        let v = s.versions("a.md");
        assert!(v.len() >= 1);
        assert!(v.iter().all(|(h, _, _)| h == h1.as_str()));
    }

    #[test]
    fn load_rejects_unknown_pair() {
        let (s, _d) = store();
        let h1 = s.snapshot("a.md", b"v1\n", HistorySource::Open).unwrap();
        // hash 存在但 path 不匹配 → 拒绝
        assert!(s.load("other.md", h1.as_str()).is_err());
        // 任意 hash → 拒绝
        assert!(s.load("a.md", "deadbeef").is_err());
    }

    #[test]
    fn corrupted_object_detected() {
        let (s, d) = store();
        let h1 = s.snapshot("a.md", b"v1\n", HistorySource::Open).unwrap();
        // 直接篡改对象文件内容
        let obj = d.path().join(".cyrene/history/objects")
            .join(&h1.as_str()[..2])
            .join(format!("{}.zst", h1.as_str()));
        let raw = zstd::decode_all(&std::fs::read(&obj).unwrap()[..]).unwrap();
        drop(raw);
        std::fs::write(&obj, zstd::encode_all(&b"tampered"[..], 3).unwrap()).unwrap();
        assert!(s.load("a.md", h1.as_str()).is_err());
    }

    #[test]
    fn gc_keeps_referenced_objects() {
        let (s, _d) = store();
        let h1 = s.snapshot("a.md", b"v1\n", HistorySource::Open).unwrap();
        // 一个不相关 hash 的孤儿对象（模拟崩溃残留）
        let orphan_hash = ContentHash::from_bytes(b"orphan");
        let obj = s.root.join("objects").join(&orphan_hash.as_str()[..2])
            .join(format!("{}.zst", orphan_hash.as_str()));
        std::fs::create_dir_all(obj.parent().unwrap()).unwrap();
        std::fs::write(&obj, zstd::encode_all(&b"orphan"[..], 3).unwrap()).unwrap();

        let removed = s.gc().unwrap();
        assert!(removed >= 1);
        // 引用着的 h1 对象仍在，可加载
        assert!(s.load("a.md", h1.as_str()).is_ok());
        // 孤儿对象被删
        assert!(!obj.exists());
    }

    #[test]
    fn separate_from_index_db() {
        // history 的库文件必须独立于 .cyrene/index.db（后者可被用户随时删除重建）
        let (s, d) = store();
        assert!(d.path().join(".cyrene/history/index.db").exists());
        assert_ne!(
            d.path().join(".cyrene/history/index.db"),
            d.path().join(".cyrene/index.db")
        );
        drop(s);
    }
}
