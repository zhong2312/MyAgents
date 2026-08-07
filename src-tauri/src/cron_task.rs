// Compatibility types and commands for the retired CronTask persistence model.
// New scheduled automation is persisted and executed as Task.

use crate::utils::bom::strip_bom;
use crate::{ulog_error, ulog_info, ulog_warn};
use chrono::{DateTime, Utc};
use cron::Schedule as CronExprSchedule;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::{AppHandle, Emitter};

pub(crate) mod commands;
pub(crate) mod delivery;
pub(crate) mod init_recovery;
pub(crate) mod manager;
pub(crate) mod run_records;
pub(crate) mod schedule;
pub(crate) mod types;
pub(crate) mod validation;

#[allow(unused_imports)]
pub use commands::{
    cmd_create_cron_task, cmd_delete_cron_task, cmd_get_cron_runs, cmd_get_cron_task,
    cmd_get_cron_tasks, cmd_get_session_cron_task, cmd_get_unmigrated_legacy_cron_tasks,
    cmd_get_workspace_cron_tasks, cmd_is_task_executing, cmd_start_cron_task, cmd_stop_cron_task,
    cmd_update_cron_task_fields,
};
pub(crate) use delivery::deliver_cron_result_to_bot;
pub use delivery::{deliver_task_notification_to_bot, deliver_task_notification_to_bot_checked};
pub use init_recovery::initialize_cron_manager;
pub use manager::{get_cron_task_manager, CronTaskManager};
pub use run_records::{read_cron_runs, record_cron_run, CronRunRecord, TriggerNowInfo};
pub use types::{
    CronDelivery, CronSchedule, CronTask, CronTaskConfig, EndConditions, ProviderIntent,
    RecurringWindow, RunMode, TaskProviderEnv, TaskStatus,
};
pub(crate) use validation::normalize_path;
pub use validation::validate_cron_expression;
#[allow(unused_imports)]
use validation::{next_cron_fire_time, translate_unix_dow_to_crate_dow};

#[cfg(test)]
mod cron_dialect_tests {
    use super::*;

    #[test]
    fn normalize_path_matches_windows_separator_variants() {
        assert_eq!(
            normalize_path(r"C:\Users\me\project\"),
            "c:/users/me/project"
        );
        assert_eq!(normalize_path("C:/Users/me/project"), "c:/users/me/project");
        assert_eq!(
            normalize_path(r"\\Server\Share\Project\"),
            "//server/share/project"
        );
        assert_eq!(normalize_path("/Users/me/project/"), "/Users/me/project");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path(r"C:\"), "c:/");
    }

    #[test]
    fn normalize_path_keeps_posix_literal_backslashes() {
        assert_ne!(normalize_path(r"/tmp/a\b"), normalize_path("/tmp/a/b"));
        assert_eq!(normalize_path(r"/tmp/a\b/"), r"/tmp/a\b");
    }

    /// Fingerprint cases for `translate_unix_dow_to_crate_dow` — encodes the
    /// Unix→crate mapping that the rest of the app relies on.
    #[test]
    fn translate_dow_handles_singletons_ranges_lists_steps_names() {
        // Singletons
        assert_eq!(translate_unix_dow_to_crate_dow("0"), "1"); // Sunday
        assert_eq!(translate_unix_dow_to_crate_dow("7"), "1"); // Sunday alias
        assert_eq!(translate_unix_dow_to_crate_dow("1"), "2"); // Monday
        assert_eq!(translate_unix_dow_to_crate_dow("6"), "7"); // Saturday
                                                               // Wildcards
        assert_eq!(translate_unix_dow_to_crate_dow("*"), "*");
        assert_eq!(translate_unix_dow_to_crate_dow("?"), "?"); // Quartz wildcard, pass through
                                                               // Forward ranges (no Sunday-alias wrap)
        assert_eq!(translate_unix_dow_to_crate_dow("1-5"), "2-6"); // Mon-Fri
        assert_eq!(translate_unix_dow_to_crate_dow("0-6"), "*"); // all days, Unix Sun=0 form
        assert_eq!(translate_unix_dow_to_crate_dow("0-7"), "*"); // wraps → all days
        assert_eq!(translate_unix_dow_to_crate_dow("1-7"), "*"); // wraps → all days
                                                                 // Wrap-around ranges that hit Sunday-alias 7 — must enumerate, not
                                                                 // produce invalid descending crate ranges like "6-1"
        assert_eq!(translate_unix_dow_to_crate_dow("5-7"), "1,6,7"); // Fri-Sun
        assert_eq!(translate_unix_dow_to_crate_dow("2-7"), "1,3-7"); // Tue-Sun
                                                                     // Lists
        assert_eq!(translate_unix_dow_to_crate_dow("0,3,5"), "1,4,6");
        assert_eq!(translate_unix_dow_to_crate_dow("1,3,5"), "2,4,6");
        // Step values — must produce same days as the Unix expression
        // `*/2` Unix (0,2,4,6 = Sun/Tue/Thu/Sat) → crate (1,3,5,7 = same days)
        assert_eq!(translate_unix_dow_to_crate_dow("*/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("0/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("1-5/2"), "2,4,6"); // Mon,Wed,Fri
                                                                       // 1-7/2 Unix = Mon,Wed,Fri,Sun (NOT */2 phase). Must preserve phase.
        assert_eq!(translate_unix_dow_to_crate_dow("1-7/2"), "1,2,4,6");
        // Named days pass through unchanged (cron crate already accepts them)
        assert_eq!(translate_unix_dow_to_crate_dow("SUN"), "SUN");
        assert_eq!(translate_unix_dow_to_crate_dow("MON-FRI"), "MON-FRI");
    }

    /// Issue #166 regression — `0 21 * * 0` (every Sunday 21:00) must parse,
    /// and the next fire time must land on a Sunday at 21:00.
    #[test]
    fn issue_166_unix_sunday_cron_parses_and_fires_on_sunday() {
        // Validation succeeds (was failing with "Days of Week must be greater than or equal to 1")
        assert!(validate_cron_expression("0 21 * * 0", Some("UTC")).is_ok());
        assert!(validate_cron_expression("0 21 * * 7", Some("UTC")).is_ok());

        // Next fire is on a Sunday
        let next = next_cron_fire_time("0 21 * * 0", Some("UTC")).unwrap();
        assert_eq!(next.format("%A").to_string(), "Sunday");
        assert_eq!(next.format("%H:%M").to_string(), "21:00");
    }

    /// Issue #166 broader pattern — `1-5` (frontend "weekdays") must mean
    /// Mon-Fri, not Sun-Thu. Regression for the silent-mis-fire bug.
    #[test]
    fn weekdays_range_means_monday_through_friday() {
        let next = next_cron_fire_time("0 8 * * 1-5", Some("UTC")).unwrap();
        let weekday = next.format("%A").to_string();
        assert!(
            matches!(
                weekday.as_str(),
                "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday"
            ),
            "weekday cron should fire Mon-Fri, got {}",
            weekday
        );
    }

    /// 6-field input is treated as the cron crate's native sec-min-hour-dom-month-dow
    /// (no year). Previously the year wildcard was missing and the format!
    /// prepended `0` instead, producing 7 fields with everything off by one.
    #[test]
    fn six_field_cron_appends_year_wildcard() {
        // 6-field: sec=0, min=0, hour=21, dom=*, month=*, dow=1 (Sun in crate semantics)
        assert!(validate_cron_expression("0 0 21 * * 1", Some("UTC")).is_ok());
    }
}
