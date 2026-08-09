//! 小说领域的可丢弃 SQLite 投影。
//!
//! Markdown 与 JSON 仍是唯一事实源。这里的数据只用于加速工作台的实体
//! 列表与反向引用查询，任何时候删除 `.cache/novel-projection.db` 都不会
//! 丢失用户数据。

pub mod commands;
mod schema;

use std::cmp::max;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

use crate::workspace_files::path_safety::{
    resolve_existing_inside_workspace, resolve_inside_workspace,
};

const DATABASE_PATH: &str = ".cache/novel-projection.db";
const CACHE_DIRECTORY: &str = ".cache";
const FINGERPRINT_META_KEY: &str = "source_fingerprint";
const CULTIVATION_ECOLOGY_INDEX_PATH: &str = "world/cultivation/index.json";
const CULTIVATION_ECOLOGY_PREFIX: &str = "world/cultivation/";
const FACTION_INDEX_PATH: &str = "world/factions/index.json";
const LOCATION_INDEX_PATH: &str = "world/locations/index.json";
const NARRATIVE_ENGINEERING_INDEX_PATH: &str = "narrative/index.json";
const TIMELINE_INDEX_PATH: &str = "timeline/index.json";

const INDEX_SOURCES: &[IndexSource] = &[
    IndexSource {
        path: "characters/index.json",
        collection: "characters",
        kind: "character",
        default_source_path: "characters/index.json",
    },
    IndexSource {
        path: "world/factions/index.json",
        collection: "factions",
        kind: "faction",
        default_source_path: "world/factions/index.json",
    },
    IndexSource {
        path: "world/items/index.json",
        collection: "items",
        kind: "item",
        default_source_path: "world/items/index.json",
    },
    IndexSource {
        path: "world/locations/index.json",
        collection: "locations",
        kind: "location",
        default_source_path: "world/locations/index.json",
    },
    IndexSource {
        path: "timeline/index.json",
        collection: "events",
        kind: "event",
        default_source_path: "timeline/index.json",
    },
    IndexSource {
        path: "narrative/index.json",
        collection: "chapters",
        kind: "narrativeChapter",
        default_source_path: "narrative/index.json",
    },
];

struct IndexSource {
    path: &'static str,
    collection: &'static str,
    kind: &'static str,
    default_source_path: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub source_path: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefRow {
    pub from_kind: String,
    pub from_id: String,
    pub to_kind: String,
    pub to_id: String,
    pub field: String,
}

/// 读取事实源、重建投影并返回实体数与引用数。
pub fn rebuild(project_root: &Path) -> Result<(usize, usize), String> {
    let sources = read_index_sources(project_root)?;
    let fingerprint = fingerprint_for_sources(project_root, &sources)?;
    let mut connection = open_database(project_root)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开始小说投影事务：{error}"))?;
    transaction
        .execute_batch(schema::CREATE_SCHEMA)
        .map_err(|error| format!("无法创建小说投影表：{error}"))?;
    transaction
        .execute("DELETE FROM refs", [])
        .and_then(|_| transaction.execute("DELETE FROM entities", []))
        .and_then(|_| transaction.execute("DELETE FROM meta", []))
        .map_err(|error| format!("无法清理小说投影：{error}"))?;

    let mut entity_count = 0;
    let mut reference_count = 0;
    for source in &sources {
        let parsed: Value = serde_json::from_str(&source.content).map_err(|error| {
            format!("无法解析小说投影事实源 {}：{error}", source.definition.path)
        })?;
        entity_count += insert_entities(&transaction, source.definition, &parsed)?;
        reference_count += insert_references(&transaction, source.definition, &parsed)?;
    }
    reference_count += insert_character_record_references(&transaction, project_root, &sources)?;
    reference_count += insert_cultivation_item_references(&transaction, project_root)?;
    transaction
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![FINGERPRINT_META_KEY, fingerprint],
        )
        .map_err(|error| format!("无法保存小说投影指纹：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交小说投影事务：{error}"))?;
    Ok((entity_count, reference_count))
}

/// 查询前确保投影与六份领域索引保持一致。
pub fn ensure_current(project_root: &Path) -> Result<(), String> {
    if !is_fingerprint_current(project_root)? {
        rebuild(project_root)?;
    }
    Ok(())
}

pub fn list_entities(project_root: &Path, kind: Option<&str>) -> Result<Vec<EntityRow>, String> {
    ensure_current(project_root)?;
    let connection = open_database(project_root)?;
    let mut rows = Vec::new();
    if let Some(kind) = kind.filter(|value| !value.trim().is_empty()) {
        let mut statement = connection
            .prepare(
                "SELECT id, kind, name, source_path, aliases, summary, updated_at FROM entities \
                 WHERE kind = ?1 ORDER BY name COLLATE NOCASE, id",
            )
            .map_err(|error| format!("无法准备小说实体查询：{error}"))?;
        let mapped = statement
            .query_map(params![kind], entity_from_row)
            .map_err(|error| format!("无法查询小说实体：{error}"))?;
        for row in mapped {
            rows.push(row.map_err(|error| format!("无法读取小说实体：{error}"))?);
        }
    } else {
        let mut statement = connection
            .prepare(
                "SELECT id, kind, name, source_path, aliases, summary, updated_at FROM entities \
                 ORDER BY kind, name COLLATE NOCASE, id",
            )
            .map_err(|error| format!("无法准备小说实体查询：{error}"))?;
        let mapped = statement
            .query_map([], entity_from_row)
            .map_err(|error| format!("无法查询小说实体：{error}"))?;
        for row in mapped {
            rows.push(row.map_err(|error| format!("无法读取小说实体：{error}"))?);
        }
    }
    Ok(rows)
}

pub fn inbound_refs(project_root: &Path, kind: &str, id: &str) -> Result<Vec<RefRow>, String> {
    ensure_current(project_root)?;
    let connection = open_database(project_root)?;
    let mut statement = connection
        .prepare(
            "SELECT from_kind, from_id, to_kind, to_id, field FROM refs \
             WHERE to_kind = ?1 AND to_id = ?2 \
             ORDER BY from_kind, from_id, field",
        )
        .map_err(|error| format!("无法准备小说反向引用查询：{error}"))?;
    let mapped = statement
        .query_map(params![kind, id], ref_from_row)
        .map_err(|error| format!("无法查询小说反向引用：{error}"))?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row.map_err(|error| format!("无法读取小说反向引用：{error}"))?);
    }
    Ok(rows)
}

fn entity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EntityRow> {
    let aliases: String = row.get(4)?;
    Ok(EntityRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        source_path: row.get(3)?,
        aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        summary: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn ref_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RefRow> {
    Ok(RefRow {
        from_kind: row.get(0)?,
        from_id: row.get(1)?,
        to_kind: row.get(2)?,
        to_id: row.get(3)?,
        field: row.get(4)?,
    })
}

fn is_fingerprint_current(project_root: &Path) -> Result<bool, String> {
    let sources = read_index_sources(project_root)?;
    let expected = fingerprint_for_sources(project_root, &sources)?;
    let database_path = database_path(project_root)?;
    if fs::symlink_metadata(&database_path).is_err() {
        return Ok(false);
    }
    let database_path = resolve_existing_inside_workspace(project_root, DATABASE_PATH)?;
    let connection = Connection::open(database_path)
        .map_err(|error| format!("无法打开小说投影数据库：{error}"))?;
    connection
        .execute_batch(schema::CREATE_SCHEMA)
        .map_err(|error| format!("无法初始化小说投影表：{error}"))?;
    let current = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![FINGERPRINT_META_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(current.as_deref() == Some(expected.as_str()))
}

fn open_database(project_root: &Path) -> Result<Connection, String> {
    let cache_path = resolve_inside_workspace(project_root, CACHE_DIRECTORY)?;
    match fs::symlink_metadata(&cache_path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                return Err("小说投影缓存路径不是目录".to_string());
            }
            let _ = resolve_existing_inside_workspace(project_root, CACHE_DIRECTORY)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&cache_path)
                .map_err(|error| format!("无法创建小说投影缓存目录：{error}"))?;
        }
        Err(error) => return Err(format!("无法检查小说投影缓存目录：{error}")),
    }
    let path = database_path(project_root)?;
    if fs::symlink_metadata(&path).is_ok() {
        let _ = resolve_existing_inside_workspace(project_root, DATABASE_PATH)?;
    }
    Connection::open(path).map_err(|error| format!("无法打开小说投影数据库：{error}"))
}

fn database_path(project_root: &Path) -> Result<PathBuf, String> {
    resolve_inside_workspace(project_root, DATABASE_PATH)
}

fn read_index_sources(project_root: &Path) -> Result<Vec<LoadedIndexSource>, String> {
    let mut sources = Vec::new();
    for definition in INDEX_SOURCES {
        let lexical_path = resolve_inside_workspace(project_root, definition.path)?;
        match fs::symlink_metadata(&lexical_path) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(format!("小说投影事实源不是文件：{}", definition.path));
                }
                let path = resolve_existing_inside_workspace(project_root, definition.path)?;
                let content = fs::read_to_string(&path).map_err(|error| {
                    format!("无法读取小说投影事实源 {}：{error}", definition.path)
                })?;
                let (content, modified_nanos, dependent_count) =
                    if definition.path == FACTION_INDEX_PATH {
                        load_faction_projection_source(
                            project_root,
                            &content,
                            modified_nanos(&metadata),
                        )?
                    } else if definition.path == LOCATION_INDEX_PATH {
                        load_location_projection_source(
                            project_root,
                            &content,
                            modified_nanos(&metadata),
                        )?
                    } else if definition.path == NARRATIVE_ENGINEERING_INDEX_PATH {
                        load_narrative_projection_source(
                            project_root,
                            &content,
                            modified_nanos(&metadata),
                        )?
                    } else if definition.path == TIMELINE_INDEX_PATH {
                        load_timeline_projection_source(
                            project_root,
                            &content,
                            modified_nanos(&metadata),
                        )?
                    } else {
                        (content, modified_nanos(&metadata), 0)
                    };
                sources.push(LoadedIndexSource {
                    definition,
                    content,
                    modified_nanos,
                    dependent_count,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法检查小说投影事实源 {}：{error}",
                    definition.path
                ));
            }
        }
    }
    Ok(sources)
}

struct LoadedIndexSource {
    definition: &'static IndexSource,
    content: String,
    modified_nanos: u128,
    dependent_count: usize,
}

fn modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos())
}

fn fingerprint_for_sources(
    project_root: &Path,
    sources: &[LoadedIndexSource],
) -> Result<String, String> {
    let mut source_count = sources.len();
    let mut newest = sources
        .iter()
        .fold(0, |current, source| max(current, source.modified_nanos));
    source_count += sources
        .iter()
        .map(|source| source.dependent_count)
        .sum::<usize>();
    for (_, path) in character_record_paths(sources)? {
        if let Some(metadata) = workspace_file_metadata(project_root, &path)? {
            source_count += 1;
            newest = max(newest, modified_nanos(&metadata));
        }
    }
    for source in load_cultivation_sources(project_root)? {
        source_count += 1;
        newest = max(newest, source.modified_nanos);
    }
    Ok(format!("{source_count}:{newest}"))
}

fn workspace_file_metadata(
    project_root: &Path,
    relative: &str,
) -> Result<Option<fs::Metadata>, String> {
    let lexical_path = resolve_inside_workspace(project_root, relative)?;
    match fs::symlink_metadata(&lexical_path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!("小说投影事实源不是文件：{relative}"));
            }
            let _ = resolve_existing_inside_workspace(project_root, relative)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法检查小说投影事实源 {relative}：{error}")),
    }
}

fn read_optional_workspace_file(
    project_root: &Path,
    relative: &str,
) -> Result<Option<String>, String> {
    let Some(_) = workspace_file_metadata(project_root, relative)? else {
        return Ok(None);
    };
    let path = resolve_existing_inside_workspace(project_root, relative)?;
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("无法读取小说投影事实源 {relative}：{error}"))
}

fn is_storage_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some('a'..='z' | '0'..='9'))
        && characters.all(|character| matches!(character, 'a'..='z' | '0'..='9' | '-'))
}

fn load_faction_projection_source(
    project_root: &Path,
    index_content: &str,
    index_modified_nanos: u128,
) -> Result<(String, u128, usize), String> {
    let index: Value = serde_json::from_str(index_content)
        .map_err(|error| format!("无法解析势力库索引：{error}"))?;
    if index.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || index.get("storageVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err("势力库索引必须使用 schemaVersion 2、storageVersion 1 的目录格式".to_string());
    }
    let entries = index
        .get("factions")
        .and_then(Value::as_array)
        .ok_or_else(|| "势力库索引缺少 factions 数组".to_string())?;
    let mut records = Vec::with_capacity(entries.len());
    let mut ids = HashSet::new();
    let mut newest = index_modified_nanos;
    for entry in entries {
        let id = string_value(entry, "id").ok_or_else(|| "势力索引缺少 id".to_string())?;
        if !is_storage_id(id) {
            return Err(format!("势力 id 只能使用小写字母、数字和连字符：{id}"));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("势力索引包含重复 id：{id}"));
        }
        let expected_path = format!("world/factions/records/{id}.json");
        let path = string_value(entry, "path").ok_or_else(|| "势力索引缺少 path".to_string())?;
        if path != expected_path {
            return Err(format!("势力记录路径必须是 {expected_path}"));
        }
        let content = read_optional_workspace_file(project_root, path)?
            .ok_or_else(|| format!("势力索引引用的记录不存在：{path}"))?;
        let mut record: Value = serde_json::from_str(&content)
            .map_err(|error| format!("无法解析势力记录 {path}：{error}"))?;
        if string_value(&record, "id") != Some(id) {
            return Err(format!("势力记录 {path} 的 id 与索引不一致"));
        }
        let Value::Object(record_object) = &mut record else {
            return Err(format!("势力记录 {path} 必须是 JSON 对象"));
        };
        record_object.insert("recordPath".to_string(), Value::String(path.to_string()));
        let metadata = workspace_file_metadata(project_root, path)?
            .ok_or_else(|| format!("势力记录读取后消失：{path}"))?;
        newest = max(newest, modified_nanos(&metadata));
        records.push(record);
    }
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 2,
        "factions": records,
    }))
    .map(|content| (content, newest, entries.len()))
    .map_err(|error| format!("无法聚合势力库投影来源：{error}"))
}

fn load_location_projection_source(
    project_root: &Path,
    index_content: &str,
    index_modified_nanos: u128,
) -> Result<(String, u128, usize), String> {
    let index: Value = serde_json::from_str(index_content)
        .map_err(|error| format!("无法解析地点库索引：{error}"))?;
    if index.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || index.get("storageVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err("地点库索引必须使用 schemaVersion 1、storageVersion 1 的目录格式".to_string());
    }
    let entries = index
        .get("locations")
        .and_then(Value::as_array)
        .ok_or_else(|| "地点库索引缺少 locations 数组".to_string())?;
    let mut records = Vec::with_capacity(entries.len());
    let mut ids = HashSet::new();
    let mut newest = index_modified_nanos;
    for entry in entries {
        let id = string_value(entry, "id").ok_or_else(|| "地点索引缺少 id".to_string())?;
        if !is_storage_id(id) {
            return Err(format!("地点 id 只能使用小写字母、数字和连字符：{id}"));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("地点索引包含重复 id：{id}"));
        }
        let expected_path = format!("world/locations/records/{id}.json");
        let path = string_value(entry, "path").ok_or_else(|| "地点索引缺少 path".to_string())?;
        if path != expected_path {
            return Err(format!("地点记录路径必须是 {expected_path}"));
        }
        let content = read_optional_workspace_file(project_root, path)?
            .ok_or_else(|| format!("地点索引引用的记录不存在：{path}"))?;
        let mut record: Value = serde_json::from_str(&content)
            .map_err(|error| format!("无法解析地点记录 {path}：{error}"))?;
        if string_value(&record, "id") != Some(id) {
            return Err(format!("地点记录 {path} 的 id 与索引不一致"));
        }
        let Value::Object(record_object) = &mut record else {
            return Err(format!("地点记录 {path} 必须是 JSON 对象"));
        };
        record_object.insert("recordPath".to_string(), Value::String(path.to_string()));
        let metadata = workspace_file_metadata(project_root, path)?
            .ok_or_else(|| format!("地点记录读取后消失：{path}"))?;
        newest = max(newest, modified_nanos(&metadata));
        records.push(record);
    }
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "locations": records,
    }))
    .map(|content| (content, newest, entries.len()))
    .map_err(|error| format!("无法聚合地点库投影来源：{error}"))
}

fn load_narrative_projection_source(
    project_root: &Path,
    index_content: &str,
    index_modified_nanos: u128,
) -> Result<(String, u128, usize), String> {
    let index: Value = serde_json::from_str(index_content)
        .map_err(|error| format!("无法解析剧情工程索引：{error}"))?;
    if index.get("schemaVersion").and_then(Value::as_u64) != Some(4)
        || index.get("storageVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err(
            "剧情工程索引必须使用 schemaVersion 4、storageVersion 1 的目录格式".to_string(),
        );
    }
    let mut aggregate = serde_json::Map::new();
    aggregate.insert("schemaVersion".to_string(), Value::from(4));
    aggregate.insert(
        "updatedAt".to_string(),
        index.get("updatedAt").cloned().unwrap_or(Value::Null),
    );
    let mut newest = index_modified_nanos;
    let mut record_count = 0;
    for (collection, segment) in [
        ("lines", "lines"),
        ("arcs", "arcs"),
        ("directories", "directories"),
        ("chapters", "chapters"),
        ("simulationProposals", "simulation-proposals"),
    ] {
        let entries = index
            .get(collection)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("剧情工程索引缺少 {collection} 数组"))?;
        let mut records = Vec::with_capacity(entries.len());
        let mut ids = HashSet::new();
        for entry in entries {
            let id = string_value(entry, "id")
                .ok_or_else(|| format!("剧情工程 {collection} 索引缺少 id"))?;
            if !ids.insert(id.to_string()) {
                return Err(format!("剧情工程 {collection} 索引包含重复 id：{id}"));
            }
            let expected_path = format!("narrative/{segment}/records/{id}.json");
            let path = string_value(entry, "path")
                .ok_or_else(|| format!("剧情工程 {collection} 索引缺少 path"))?;
            if path != expected_path {
                return Err(format!("剧情工程记录路径必须是 {expected_path}"));
            }
            let content = read_optional_workspace_file(project_root, path)?
                .ok_or_else(|| format!("剧情工程索引引用的记录不存在：{path}"))?;
            let mut record: Value = serde_json::from_str(&content)
                .map_err(|error| format!("无法解析剧情工程记录 {path}：{error}"))?;
            if string_value(&record, "id") != Some(id) {
                return Err(format!("剧情工程记录 {path} 的 id 与索引不一致"));
            }
            let Value::Object(record_object) = &mut record else {
                return Err(format!("剧情工程记录 {path} 必须是 JSON 对象"));
            };
            record_object.insert("recordPath".to_string(), Value::String(path.to_string()));
            let metadata = workspace_file_metadata(project_root, path)?
                .ok_or_else(|| format!("剧情工程记录读取后消失：{path}"))?;
            newest = max(newest, modified_nanos(&metadata));
            record_count += 1;
            records.push(record);
        }
        aggregate.insert(collection.to_string(), Value::Array(records));
    }
    serde_json::to_string(&Value::Object(aggregate))
        .map(|content| (content, newest, record_count))
        .map_err(|error| format!("无法聚合剧情工程投影来源：{error}"))
}

fn load_timeline_projection_source(
    project_root: &Path,
    index_content: &str,
    index_modified_nanos: u128,
) -> Result<(String, u128, usize), String> {
    let index: Value = serde_json::from_str(index_content)
        .map_err(|error| format!("无法解析时间线索引：{error}"))?;
    if index.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || index.get("storageVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err("时间线索引必须使用 schemaVersion 1、storageVersion 1 的目录格式".to_string());
    }
    let entries = index
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "时间线索引缺少 events 数组".to_string())?;
    let mut records = Vec::with_capacity(entries.len());
    let mut ids = HashSet::new();
    let mut newest = index_modified_nanos;
    for entry in entries {
        let id = string_value(entry, "id").ok_or_else(|| "时间线事件索引缺少 id".to_string())?;
        if !ids.insert(id.to_string()) {
            return Err(format!("时间线事件索引包含重复 id：{id}"));
        }
        let expected_path = format!("timeline/events/records/{id}.json");
        let path =
            string_value(entry, "path").ok_or_else(|| "时间线事件索引缺少 path".to_string())?;
        if path != expected_path {
            return Err(format!("时间线事件记录路径必须是 {expected_path}"));
        }
        let content = read_optional_workspace_file(project_root, path)?
            .ok_or_else(|| format!("时间线索引引用的事件记录不存在：{path}"))?;
        let mut record: Value = serde_json::from_str(&content)
            .map_err(|error| format!("无法解析时间线事件记录 {path}：{error}"))?;
        if string_value(&record, "id") != Some(id) {
            return Err(format!("时间线事件记录 {path} 的 id 与索引不一致"));
        }
        let Value::Object(record_object) = &mut record else {
            return Err(format!("时间线事件记录 {path} 必须是 JSON 对象"));
        };
        record_object.insert("recordPath".to_string(), Value::String(path.to_string()));
        let metadata = workspace_file_metadata(project_root, path)?
            .ok_or_else(|| format!("时间线事件记录读取后消失：{path}"))?;
        newest = max(newest, modified_nanos(&metadata));
        records.push(record);
    }
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "events": records,
    }))
    .map(|content| (content, newest, entries.len()))
    .map_err(|error| format!("无法聚合时间线投影来源：{error}"))
}

fn character_record_paths(sources: &[LoadedIndexSource]) -> Result<Vec<(String, String)>, String> {
    let Some(source) = sources
        .iter()
        .find(|source| source.definition.path == "characters/index.json")
    else {
        return Ok(Vec::new());
    };
    let parsed: Value = serde_json::from_str(&source.content)
        .map_err(|error| format!("无法解析小说投影事实源 characters/index.json：{error}"))?;
    let Some(characters) = parsed.get("characters").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    Ok(characters
        .iter()
        .filter_map(|entry| {
            let id = string_value(entry, "id")?;
            let path = string_value(entry, "recordPath")?;
            (path == format!("characters/records/{id}.json"))
                .then(|| (id.to_string(), path.to_string()))
        })
        .collect())
}

fn insert_entities(
    transaction: &rusqlite::Transaction<'_>,
    source: &IndexSource,
    parsed: &Value,
) -> Result<usize, String> {
    let Some(entries) = parsed.get(source.collection).and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut count = 0;
    for entry in entries {
        let Some(id) = string_value(entry, "id") else {
            continue;
        };
        let name = entity_name(source.kind, entry).unwrap_or(id);
        let source_path = entity_source_path(source, entry);
        let aliases = serde_json::to_string(&entity_aliases(entry))
            .map_err(|error| format!("无法序列化小说实体别名：{error}"))?;
        let summary = entity_summary(source.kind, entry);
        let updated_at = string_value(entry, "updatedAt").unwrap_or("");
        transaction
            .execute(
                "INSERT INTO entities (id, kind, name, source_path, aliases, summary, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    source.kind,
                    name,
                    source_path,
                    aliases,
                    summary,
                    updated_at
                ],
            )
            .map_err(|error| format!("无法写入小说实体投影：{error}"))?;
        count += 1;
    }
    Ok(count)
}

fn entity_name<'a>(kind: &str, entry: &'a Value) -> Option<&'a str> {
    let field = match kind {
        "event" | "narrativeChapter" => "title",
        _ => "name",
    };
    string_value(entry, field)
}

fn entity_aliases(entry: &Value) -> Vec<&str> {
    array_value(entry, "aliases")
        .iter()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn entity_summary<'a>(kind: &str, entry: &'a Value) -> &'a str {
    let field = if kind == "narrativeChapter" {
        "description"
    } else {
        "summary"
    };
    string_value(entry, field).unwrap_or("")
}

fn entity_source_path(source: &IndexSource, entry: &Value) -> String {
    let candidate = string_value(entry, "recordPath").unwrap_or("");
    if ((source.kind == "character" && candidate.starts_with("characters/records/"))
        || (source.kind == "faction" && candidate.starts_with("world/factions/records/"))
        || (source.kind == "location" && candidate.starts_with("world/locations/records/"))
        || (source.kind == "event" && candidate.starts_with("timeline/events/records/"))
        || (source.kind == "narrativeChapter"
            && candidate.starts_with("narrative/chapters/records/")))
        && candidate.ends_with(".json")
        && !candidate.contains("..")
    {
        candidate.to_string()
    } else {
        source.default_source_path.to_string()
    }
}

fn insert_references(
    transaction: &rusqlite::Transaction<'_>,
    source: &IndexSource,
    parsed: &Value,
) -> Result<usize, String> {
    match source.path {
        "timeline/index.json" => insert_timeline_references(transaction, parsed),
        "world/factions/index.json" => insert_faction_references(transaction, parsed),
        "narrative/index.json" => insert_narrative_references(transaction, parsed),
        _ => Ok(0),
    }
}

fn insert_character_record_references(
    transaction: &rusqlite::Transaction<'_>,
    project_root: &Path,
    sources: &[LoadedIndexSource],
) -> Result<usize, String> {
    let mut count = 0;
    for (character_id, path) in character_record_paths(sources)? {
        let Some(content) = read_optional_workspace_file(project_root, &path)? else {
            continue;
        };
        let record: Value = serde_json::from_str(&content)
            .map_err(|error| format!("无法解析人物记录 {path}：{error}"))?;
        for inventory_entry in array_value(&record, "inventory") {
            if let Some(item_id) = string_value(inventory_entry, "itemId") {
                insert_reference(
                    transaction,
                    "character",
                    &character_id,
                    "item",
                    item_id,
                    "物品栏",
                )?;
                count += 1;
            }
        }
    }
    Ok(count)
}

fn insert_cultivation_item_references(
    transaction: &rusqlite::Transaction<'_>,
    project_root: &Path,
) -> Result<usize, String> {
    let mut sequence = 0;
    load_cultivation_sources(project_root)?
        .iter()
        .try_fold(0, |count, source| {
            let parsed: Value = serde_json::from_str(&source.content)
                .map_err(|error| format!("无法解析修炼体系模块 {}：{error}", source.path))?;
            Ok(count + collect_cultivation_item_references(transaction, &parsed, &mut sequence)?)
        })
}

struct LoadedCultivationSource {
    path: String,
    content: String,
    modified_nanos: u128,
}

fn collect_cultivation_source_paths(value: &Value, queue: &mut VecDeque<String>) {
    match value {
        Value::String(path)
            if path.starts_with(CULTIVATION_ECOLOGY_PREFIX)
                && path.ends_with(".json")
                && !path.contains('\\')
                && !path.split('/').any(|segment| segment == "..") =>
        {
            queue.push_back(path.clone());
        }
        Value::Array(values) => values
            .iter()
            .for_each(|child| collect_cultivation_source_paths(child, queue)),
        Value::Object(record) => record
            .values()
            .for_each(|child| collect_cultivation_source_paths(child, queue)),
        _ => {}
    }
}

fn load_cultivation_sources(project_root: &Path) -> Result<Vec<LoadedCultivationSource>, String> {
    if workspace_file_metadata(project_root, CULTIVATION_ECOLOGY_INDEX_PATH)?.is_none() {
        return Ok(Vec::new());
    }
    let mut queue = VecDeque::from([CULTIVATION_ECOLOGY_INDEX_PATH.to_string()]);
    let mut visited = HashSet::new();
    let mut sources = Vec::new();
    while let Some(path) = queue.pop_front() {
        if !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > 100_000 {
            return Err("修炼体系目录引用文件过多，已停止构建投影".to_string());
        }
        let Some(content) = read_optional_workspace_file(project_root, &path)? else {
            return Err(format!("修炼体系索引引用的模块不存在：{path}"));
        };
        let parsed: Value = serde_json::from_str(&content)
            .map_err(|error| format!("无法解析修炼体系模块 {path}：{error}"))?;
        collect_cultivation_source_paths(&parsed, &mut queue);
        let metadata = workspace_file_metadata(project_root, &path)?
            .ok_or_else(|| format!("修炼体系模块读取后消失：{path}"))?;
        sources.push(LoadedCultivationSource {
            path,
            content,
            modified_nanos: modified_nanos(&metadata),
        });
    }
    Ok(sources)
}

fn collect_cultivation_item_references(
    transaction: &rusqlite::Transaction<'_>,
    value: &Value,
    sequence: &mut usize,
) -> Result<usize, String> {
    let Value::Object(record) = value else {
        if let Value::Array(values) = value {
            return values.iter().try_fold(0, |count, child| {
                Ok(count + collect_cultivation_item_references(transaction, child, sequence)?)
            });
        }
        return Ok(0);
    };
    let from_id = string_value(value, "id")
        .map(str::to_string)
        .unwrap_or_else(|| {
            *sequence += 1;
            format!("anonymous-{sequence}")
        });
    let mut count = 0;
    for item_id in array_value(value, "itemIds")
        .iter()
        .filter_map(Value::as_str)
    {
        insert_reference(
            transaction,
            "cultivation",
            &from_id,
            "item",
            item_id,
            "关联物品",
        )?;
        count += 1;
    }
    for child in record.values() {
        count += collect_cultivation_item_references(transaction, child, sequence)?;
    }
    Ok(count)
}

fn insert_timeline_references(
    transaction: &rusqlite::Transaction<'_>,
    parsed: &Value,
) -> Result<usize, String> {
    let Some(events) = parsed.get("events").and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut count = 0;
    for event in events {
        let Some(event_id) = string_value(event, "id") else {
            continue;
        };
        for (field, kind, label) in [
            ("characterIds", "character", "关联角色"),
            ("factionIds", "faction", "关联势力"),
            ("itemIds", "item", "关联物品"),
            ("locationIds", "location", "关联地点"),
        ] {
            count += insert_id_array_references(
                transaction,
                "event",
                event_id,
                event,
                field,
                kind,
                label,
            )?;
        }
        if let Some(changes) = event.get("stateChanges").and_then(Value::as_array) {
            for change in changes {
                let Some(kind) = string_value(change, "entityType") else {
                    continue;
                };
                if matches!(kind, "character" | "faction" | "item" | "location") {
                    if let Some(id) = string_value(change, "entityId") {
                        insert_reference(transaction, "event", event_id, kind, id, "状态变化")?;
                        count += 1;
                    }
                }
            }
        }
    }
    Ok(count)
}

fn insert_faction_references(
    transaction: &rusqlite::Transaction<'_>,
    parsed: &Value,
) -> Result<usize, String> {
    let Some(factions) = parsed.get("factions").and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut count = 0;
    for faction in factions {
        let Some(faction_id) = string_value(faction, "id") else {
            continue;
        };
        for member in array_value(faction, "members") {
            if let Some(character_id) = string_value(member, "characterId") {
                insert_reference(
                    transaction,
                    "faction",
                    faction_id,
                    "character",
                    character_id,
                    "成员",
                )?;
                count += 1;
            }
        }
        for resource in array_value(faction, "resources") {
            if let Some(item_id) = string_value(resource, "itemId") {
                insert_reference(transaction, "faction", faction_id, "item", item_id, "资源")?;
                count += 1;
            }
        }
        for link in array_value(faction, "links") {
            let Some(kind) = string_value(link, "kind") else {
                continue;
            };
            if matches!(kind, "character" | "item") {
                if let Some(target_id) = string_value(link, "targetId") {
                    insert_reference(transaction, "faction", faction_id, kind, target_id, "链接")?;
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}

fn insert_narrative_references(
    transaction: &rusqlite::Transaction<'_>,
    parsed: &Value,
) -> Result<usize, String> {
    let mut count = 0;
    for line in array_value(parsed, "lines") {
        if let (Some(id), Some(character_id)) = (
            string_value(line, "id"),
            string_value(line, "protagonistCharacterId"),
        ) {
            insert_reference(
                transaction,
                "narrativeLine",
                id,
                "character",
                character_id,
                "主角",
            )?;
            count += 1;
        }
    }
    for arc in array_value(parsed, "arcs") {
        if let (Some(id), Some(character_id)) =
            (string_value(arc, "id"), string_value(arc, "characterId"))
        {
            insert_reference(
                transaction,
                "narrativeArc",
                id,
                "character",
                character_id,
                "关联角色",
            )?;
            count += 1;
        }
    }
    for chapter in array_value(parsed, "chapters") {
        let Some(chapter_id) = string_value(chapter, "id") else {
            continue;
        };
        for section in array_value(chapter, "sections") {
            if let Some(character_id) = string_value(section, "povCharacterId") {
                insert_reference(
                    transaction,
                    "narrativeChapter",
                    chapter_id,
                    "character",
                    character_id,
                    "场景视角",
                )?;
                count += 1;
            }
        }
    }
    Ok(count)
}

fn insert_id_array_references(
    transaction: &rusqlite::Transaction<'_>,
    from_kind: &str,
    from_id: &str,
    entry: &Value,
    array_field: &str,
    to_kind: &str,
    field: &str,
) -> Result<usize, String> {
    let mut count = 0;
    for target_id in array_value(entry, array_field)
        .iter()
        .filter_map(Value::as_str)
    {
        insert_reference(transaction, from_kind, from_id, to_kind, target_id, field)?;
        count += 1;
    }
    Ok(count)
}

fn insert_reference(
    transaction: &rusqlite::Transaction<'_>,
    from_kind: &str,
    from_id: &str,
    to_kind: &str,
    to_id: &str,
    field: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO refs (from_kind, from_id, to_kind, to_id, field) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![from_kind, from_id, to_kind, to_id, field],
        )
        .map_err(|error| format!("无法写入小说引用投影：{error}"))?;
    Ok(())
}

fn string_value<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)?
        .as_str()
        .filter(|value| !value.trim().is_empty())
}

fn array_value<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("test file parent")).expect("create test parent");
        fs::write(path, content).expect("write test source");
    }

    fn character_index(entries: &str) -> String {
        format!("{{\"schemaVersion\":1,\"characters\":[{entries}]}}")
    }

    #[test]
    fn rebuild_empty_project_has_no_entities() {
        let directory = tempfile::tempdir().expect("create test workspace");
        assert_eq!(
            rebuild(directory.path()).expect("rebuild empty project"),
            (0, 0)
        );
    }

    #[test]
    fn rebuild_indexes_character_entries() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            "characters/index.json",
            &character_index(
                r#"{"id":"character-a","name":"甲","summary":"剑修","recordPath":"characters/records/character-a.json","updatedAt":"2026-08-05T00:00:00Z"},{"id":"character-b","name":"乙","recordPath":"characters/records/character-b.json","updatedAt":"2026-08-05T00:00:00Z"}"#,
            ),
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (2, 0));
        let entities = list_entities(directory.path(), Some("character")).expect("list entities");
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[0].summary, "剑修");
    }

    #[test]
    fn rebuild_is_idempotent() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            "characters/index.json",
            &character_index(
                r#"{"id":"character-a","name":"甲","recordPath":"characters/records/character-a.json","updatedAt":"2026-08-05T00:00:00Z"}"#,
            ),
        );

        let first = rebuild(directory.path()).expect("first rebuild");
        let second = rebuild(directory.path()).expect("second rebuild");
        assert_eq!(first, second);
        assert_eq!(
            list_entities(directory.path(), None)
                .expect("list entities")
                .len(),
            1
        );
    }

    #[test]
    fn rebuild_indexes_item_references_from_records_and_cultivation() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            "characters/index.json",
            &character_index(
                r#"{"id":"character-a","name":"甲","recordPath":"characters/records/character-a.json","updatedAt":"2026-08-05T00:00:00Z"}"#,
            ),
        );
        write_file(
            directory.path(),
            "characters/records/character-a.json",
            r#"{"schemaVersion":1,"inventory":[{"itemId":"item-1"}]}"#,
        );
        write_file(
            directory.path(),
            CULTIVATION_ECOLOGY_INDEX_PATH,
            r#"{"systems":[{"path":"world/cultivation/systems/system-1/system.json"}]}"#,
        );
        write_file(
            directory.path(),
            "world/cultivation/systems/system-1/system.json",
            r#"{"id":"system-1","itemIds":["item-1"]}"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 2));
        let refs = inbound_refs(directory.path(), "item", "item-1").expect("query refs");
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|entry| entry.from_kind == "character"));
        assert!(refs.iter().any(|entry| entry.from_kind == "cultivation"));
    }

    #[test]
    fn rebuild_aggregates_narrative_records_from_manifest() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            NARRATIVE_ENGINEERING_INDEX_PATH,
            r#"{
                "schemaVersion":4,
                "storageVersion":1,
                "updatedAt":"2026-08-09T00:00:00Z",
                "lines":[{"id":"line-main","path":"narrative/lines/records/line-main.json"}],
                "arcs":[{"id":"arc-main","path":"narrative/arcs/records/arc-main.json"}],
                "directories":[],
                "chapters":[{"id":"chapter-one","path":"narrative/chapters/records/chapter-one.json"}],
                "simulationProposals":[],
                "legacyArchivePath":null
            }"#,
        );
        write_file(
            directory.path(),
            "narrative/lines/records/line-main.json",
            r#"{"id":"line-main","title":"主线","protagonistCharacterId":"character-a"}"#,
        );
        write_file(
            directory.path(),
            "narrative/arcs/records/arc-main.json",
            r#"{"id":"arc-main","title":"人物弧","characterId":"character-a"}"#,
        );
        write_file(
            directory.path(),
            "narrative/chapters/records/chapter-one.json",
            r#"{"id":"chapter-one","title":"第一章","description":"开端","sections":[{"povCharacterId":"character-a"}]}"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 3));
        let entities =
            list_entities(directory.path(), Some("narrativeChapter")).expect("list narrative");
        assert_eq!(entities.len(), 1);
        assert_eq!(
            entities[0].source_path,
            "narrative/chapters/records/chapter-one.json"
        );
        assert_eq!(
            inbound_refs(directory.path(), "character", "character-a")
                .expect("query narrative refs")
                .len(),
            3
        );
    }

    #[test]
    fn rebuild_aggregates_timeline_event_records_from_manifest() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            TIMELINE_INDEX_PATH,
            r#"{
                "schemaVersion":1,
                "storageVersion":1,
                "storyStartEventId":null,
                "factsThroughEventId":null,
                "calendars":[],
                "periods":[],
                "views":[],
                "branches":[],
                "events":[{"id":"event-one","path":"timeline/events/records/event-one.json"}]
            }"#,
        );
        write_file(
            directory.path(),
            "timeline/events/records/event-one.json",
            r#"{"id":"event-one","title":"第一战","summary":"开战","characterIds":["character-a"],"factionIds":[],"itemIds":[],"locationIds":[]}"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 1));
        let entities = list_entities(directory.path(), Some("event")).expect("list events");
        assert_eq!(entities.len(), 1);
        assert_eq!(
            entities[0].source_path,
            "timeline/events/records/event-one.json"
        );
        assert_eq!(
            inbound_refs(directory.path(), "character", "character-a")
                .expect("query timeline refs")
                .len(),
            1
        );
    }

    #[test]
    fn rebuild_aggregates_faction_records_from_manifest() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            FACTION_INDEX_PATH,
            r#"{
                "schemaVersion":2,
                "storageVersion":1,
                "factions":[{
                    "id":"faction-cloud-sect",
                    "path":"world/factions/records/faction-cloud-sect.json"
                }]
            }"#,
        );
        write_file(
            directory.path(),
            "world/factions/records/faction-cloud-sect.json",
            r#"{
                "id":"faction-cloud-sect",
                "name":"青云宗",
                "summary":"东玄剑修宗门",
                "members":[{"characterId":"character-a"}],
                "resources":[{"itemId":"item-one"}],
                "links":[]
            }"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 2));
        let entities = list_entities(directory.path(), Some("faction")).expect("list factions");
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].name, "青云宗");
        assert_eq!(
            entities[0].source_path,
            "world/factions/records/faction-cloud-sect.json"
        );
        assert_eq!(
            inbound_refs(directory.path(), "character", "character-a")
                .expect("query faction member refs")
                .len(),
            1
        );
        assert_eq!(
            inbound_refs(directory.path(), "item", "item-one")
                .expect("query faction resource refs")
                .len(),
            1
        );
    }

    #[test]
    fn rebuild_aggregates_location_records_from_manifest() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            LOCATION_INDEX_PATH,
            r#"{
                "schemaVersion":1,
                "storageVersion":1,
                "locations":[{
                    "id":"cloud-city",
                    "path":"world/locations/records/cloud-city.json"
                }]
            }"#,
        );
        write_file(
            directory.path(),
            "world/locations/records/cloud-city.json",
            r#"{
                "id":"cloud-city",
                "name":"云城",
                "aliases":["云上城"],
                "summary":"浮于云海之上的城池"
            }"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 0));
        let entities = list_entities(directory.path(), Some("location")).expect("list locations");
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].name, "云城");
        assert_eq!(entities[0].aliases, vec!["云上城"]);
        assert_eq!(
            entities[0].source_path,
            "world/locations/records/cloud-city.json"
        );
    }

    #[test]
    fn source_fingerprint_detects_changed_source_set() {
        let directory = tempfile::tempdir().expect("create test workspace");
        write_file(
            directory.path(),
            "characters/index.json",
            &character_index(""),
        );
        rebuild(directory.path()).expect("rebuild project");
        assert!(is_fingerprint_current(directory.path()).expect("read fingerprint"));

        write_file(
            directory.path(),
            "world/items/index.json",
            "{\"schemaVersion\":1,\"items\":[]}",
        );
        assert!(!is_fingerprint_current(directory.path()).expect("read changed fingerprint"));
    }
}
