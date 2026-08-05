//! 小说领域的可丢弃 SQLite 投影。
//!
//! Markdown 与 JSON 仍是唯一事实源。这里的数据只用于加速工作台的实体
//! 列表与反向引用查询，任何时候删除 `.cache/novel-projection.db` 都不会
//! 丢失用户数据。

pub mod commands;
mod schema;

use std::cmp::max;
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
const CULTIVATION_ECOLOGY_PATH: &str = "world/cultivation-ecology.json";

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
                sources.push(LoadedIndexSource {
                    definition,
                    content,
                    modified_nanos: modified_nanos(&metadata),
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
    for (_, path) in character_record_paths(sources)? {
        if let Some(metadata) = workspace_file_metadata(project_root, &path)? {
            source_count += 1;
            newest = max(newest, modified_nanos(&metadata));
        }
    }
    if let Some(metadata) = workspace_file_metadata(project_root, CULTIVATION_ECOLOGY_PATH)? {
        source_count += 1;
        newest = max(newest, modified_nanos(&metadata));
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
    if source.kind == "character"
        && candidate.starts_with("characters/records/")
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
    let Some(content) = read_optional_workspace_file(project_root, CULTIVATION_ECOLOGY_PATH)?
    else {
        return Ok(0);
    };
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|error| format!("无法解析修炼体系事实源：{error}"))?;
    let mut sequence = 0;
    collect_cultivation_item_references(transaction, &parsed, &mut sequence)
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
            CULTIVATION_ECOLOGY_PATH,
            r#"{"systems":[{"id":"system-1","itemIds":["item-1"]}]}"#,
        );

        assert_eq!(rebuild(directory.path()).expect("rebuild project"), (1, 2));
        let refs = inbound_refs(directory.path(), "item", "item-1").expect("query refs");
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|entry| entry.from_kind == "character"));
        assert!(refs.iter().any(|entry| entry.from_kind == "cultivation"));
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
