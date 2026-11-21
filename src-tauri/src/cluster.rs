//! Clusters (photos taken close together), the filters, and the keep/delete
//! rule. Pure functions over the asset list: no I/O, unit-tested.

use crate::source::Asset;
use chrono::Datelike;
use std::collections::{HashMap, HashSet};

/// The cluster window steps, seconds (a log scale, 5 s – 30 min).
pub const WINDOWS: [u32; 8] = [5, 10, 30, 60, 120, 300, 600, 1800];
pub const DEFAULT_WINDOW: u32 = 60;

/// A calendar day (year, month, day) in local time.
pub type Ymd = (i32, u32, u32);

#[derive(Clone, Debug, Default)]
pub struct Filter {
    pub window: u32,
    /// hide clusters of a single photo
    pub clusters_only: bool,
    /// daily cleanup: only this day of the year, from earlier years
    pub on_this_day: Option<Ymd>,
    /// date range, local days, inclusive (ignored in daily cleanup)
    pub from: Option<Ymd>,
    pub to: Option<Ymd>,
}

/// Snap any number of seconds to the nearest window step.
pub fn snap_window(s: u32) -> u32 {
    *WINDOWS.iter().min_by_key(|w| (**w as i64 - s as i64).abs()).unwrap()
}

/// The local calendar day an asset was taken on. Time decision: an asset's
/// own time zone where known, otherwise `offset_min` (the Mac's offset at that
/// instant, so daylight saving is right). Clustering itself uses absolute
/// time, so a trip abroad never splits or merges clusters oddly.
pub fn local_day(a: &Asset, offset_min: &dyn Fn(i64) -> i32) -> Ymd {
    let off = a.tz.unwrap_or_else(|| offset_min(a.created));
    day_of(a.created + off as i64 * 60_000)
}

pub fn day_of(ms: i64) -> Ymd {
    let d = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().date_naive();
    (d.year(), d.month(), d.day())
}

pub fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Daily cleanup: taken on today's month and day in an earlier year. A photo
/// from 29 February shows on 29 February in leap years and on 28 February in
/// other years: once a year, never twice.
pub fn on_this_day(day: Ymd, today: Ymd) -> bool {
    if day.0 >= today.0 {
        return false;
    }
    let (m, d) = (day.1, day.2);
    if (m, d) == (2, 29) {
        return (today.1, today.2) == (2, 29) || ((today.1, today.2) == (2, 28) && !is_leap(today.0));
    }
    (m, d) == (today.1, today.2)
}

/// "MM-DD" → (month, day), for a day of the year (29 February allowed)
pub fn parse_md(s: &str) -> Option<(u32, u32)> {
    let (m, d) = s.trim().split_once('-')?;
    let (m, d) = (m.parse().ok()?, d.parse().ok()?);
    chrono::NaiveDate::from_ymd_opt(2024, m, d).map(|_| (m, d))
}

/// A photo taken on day `day` belongs to the day of the year `md` in `year`:
/// the same month and day, or 29 February on 28 February in other years
/// (the daily cleanup rule, without the "earlier years" part).
pub fn same_day_of_year(day: Ymd, md: (u32, u32), year: i32) -> bool {
    (day.1, day.2) == md || ((day.1, day.2) == (2, 29) && md == (2, 28) && !is_leap(year))
}

/// Clusters over `order` (asset indices sorted by time). A new cluster starts
/// where the gap since the previous photo is longer than the window; a gap of
/// exactly the window stays together. A burst always stays in one cluster.
pub fn cluster(assets: &[Asset], order: &[usize], window_s: u32) -> Vec<Vec<usize>> {
    let window_ms = window_s as i64 * 1000;
    // last position of each burst, so a split never falls inside one
    let mut last: HashMap<&str, usize> = HashMap::new();
    for (pos, &i) in order.iter().enumerate() {
        if let Some(b) = &assets[i].burst_id {
            last.insert(b.as_str(), pos);
        }
    }
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut open = 0usize; // furthest position an earlier burst reaches
    for (pos, &i) in order.iter().enumerate() {
        let split = match out.last() {
            None => true,
            Some(_) => {
                let prev = assets[order[pos - 1]].created;
                assets[i].created - prev > window_ms && open < pos
            }
        };
        if split {
            out.push(Vec::new());
        }
        out.last_mut().unwrap().push(i);
        if let Some(b) = &assets[i].burst_id {
            open = open.max(last[b.as_str()]);
        }
    }
    out
}

/// The clusters a view shows, each a list of asset indices in time order.
pub fn build(assets: &[Asset], f: &Filter, offset_min: &dyn Fn(i64) -> i32) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..assets.len()).filter(|&i| !assets[i].hidden).collect();
    order.sort_by_key(|&i| assets[i].created);
    if let Some(today) = f.on_this_day {
        order.retain(|&i| on_this_day(local_day(&assets[i], offset_min), today));
    }
    let mut cs = cluster(assets, &order, f.window.max(1));
    if f.on_this_day.is_none() && (f.from.is_some() || f.to.is_some()) {
        // a cluster belongs to the day it starts on
        cs.retain(|c| {
            let d = local_day(&assets[c[0]], offset_min);
            f.from.map_or(true, |a| d >= a) && f.to.map_or(true, |b| d <= b)
        });
    }
    if f.clusters_only {
        cs.retain(|c| c.len() > 1);
    }
    cs
}

/// The keep/delete rule, the same as Brackit's picks:
/// - a cluster with no keeper is untouched;
/// - once it has a keeper, its other photos are marked for deletion,
///   except favorites, which go only when marked explicitly (`del`);
/// - a photo marked explicitly (`del`) goes, keeper or not;
/// - a keeper never goes.
pub fn to_delete(assets: &[Asset], c: &[usize], keep: &HashSet<String>, del: &HashSet<String>) -> Vec<usize> {
    let has_keeper = c.iter().any(|&i| keep.contains(&assets[i].id));
    c.iter()
        .copied()
        .filter(|&i| {
            let a = &assets[i];
            !keep.contains(&a.id) && (del.contains(&a.id) || (has_keeper && !a.favorite))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{short_id, Kind};

    const MIN: i64 = 60_000;
    // 2024-06-01T12:00:00Z
    const T0: i64 = 1_717_243_200_000;

    fn asset(name: &str, t: i64) -> Asset {
        Asset {
            id: short_id(name),
            local_id: name.into(),
            created: t,
            tz: Some(0),
            kind: Kind::Photo,
            subtypes: 0,
            width: 4000,
            height: 3000,
            duration: 0.0,
            favorite: false,
            hidden: false,
            burst_id: None,
            shared: false,
            bytes: None,
        }
    }
    fn utc(_: i64) -> i32 {
        0
    }
    fn sizes(cs: &[Vec<usize>]) -> Vec<usize> {
        cs.iter().map(|c| c.len()).collect()
    }
    fn f(window: u32) -> Filter {
        Filter { window, ..Default::default() }
    }

    #[test]
    fn gap_equal_to_window_stays_together_longer_splits() {
        let a = vec![asset("a", T0), asset("b", T0 + 60_000), asset("c", T0 + 120_001)];
        assert_eq!(sizes(&build(&a, &f(60), &utc)), vec![2, 1]);
        assert_eq!(sizes(&build(&a, &f(120), &utc)), vec![3]);
        assert_eq!(sizes(&build(&a, &f(5), &utc)), vec![1, 1, 1]);
    }

    #[test]
    fn unsorted_input_is_clustered_in_time_order() {
        let a = vec![asset("c", T0 + 10 * MIN), asset("a", T0), asset("b", T0 + 30_000)];
        let cs = build(&a, &f(60), &utc);
        assert_eq!(cs, vec![vec![1, 2], vec![0]]);
    }

    #[test]
    fn a_burst_stays_in_one_cluster_across_a_gap() {
        let mut a = vec![asset("a", T0), asset("b", T0 + 5 * MIN), asset("c", T0 + 10 * MIN), asset("d", T0 + 20 * MIN)];
        a[0].burst_id = Some("B".into());
        a[2].burst_id = Some("B".into());
        // b sits between two members of the burst: all three together; d apart
        assert_eq!(sizes(&build(&a, &f(60), &utc)), vec![3, 1]);
        // without the burst they're all apart
        a[0].burst_id = None;
        assert_eq!(sizes(&build(&a, &f(60), &utc)), vec![1, 1, 1, 1]);
    }

    #[test]
    fn hidden_photos_never_show() {
        let mut a = vec![asset("a", T0), asset("b", T0 + 1000)];
        a[1].hidden = true;
        assert_eq!(build(&a, &f(60), &utc), vec![vec![0]]);
    }

    #[test]
    fn clusters_only_hides_single_photos() {
        let a = vec![asset("a", T0), asset("b", T0 + 1000), asset("c", T0 + 10 * MIN)];
        let mut flt = f(60);
        flt.clusters_only = true;
        assert_eq!(build(&a, &flt, &utc), vec![vec![0, 1]]);
    }

    #[test]
    fn window_snaps_to_the_steps() {
        assert_eq!(snap_window(60), 60);
        assert_eq!(snap_window(70), 60);
        assert_eq!(snap_window(1), 5);
        assert_eq!(snap_window(100_000), 1800);
    }

    #[test]
    fn local_day_uses_the_photos_own_time_zone() {
        // 2024-03-03T14:30Z is 23:30 in Tokyo on the 3rd, 09:30 in New York
        let mut a = asset("a", 1_709_476_200_000);
        a.tz = Some(9 * 60);
        assert_eq!(local_day(&a, &utc), (2024, 3, 3));
        a.tz = Some(-5 * 60);
        assert_eq!(local_day(&a, &utc), (2024, 3, 3));
        // 2024-03-03T16:00Z: already the 4th in Tokyo
        let mut b = asset("b", 1_709_481_600_000);
        b.tz = Some(9 * 60);
        assert_eq!(local_day(&b, &utc), (2024, 3, 4));
        // unknown zone: the Mac's offset for that instant
        b.tz = None;
        assert_eq!(local_day(&b, &|_| -8 * 60), (2024, 3, 3));
    }

    #[test]
    fn trips_cluster_on_absolute_time() {
        // two photos 30 s apart either side of a time-zone change
        let mut a = vec![asset("a", T0), asset("b", T0 + 30_000)];
        a[0].tz = Some(60);
        a[1].tz = Some(-300);
        assert_eq!(sizes(&build(&a, &f(60), &utc)), vec![2]);
    }

    #[test]
    fn on_this_day_basic() {
        assert!(on_this_day((2019, 6, 1), (2025, 6, 1)));
        assert!(!on_this_day((2025, 6, 1), (2025, 6, 1)), "not this year");
        assert!(!on_this_day((2026, 6, 1), (2025, 6, 1)), "not the future");
        assert!(!on_this_day((2019, 6, 2), (2025, 6, 1)));
    }

    #[test]
    fn on_this_day_29_february() {
        let leap_day = (2020, 2, 29);
        // a leap year: on the 29th only
        assert!(on_this_day(leap_day, (2024, 2, 29)));
        assert!(!on_this_day(leap_day, (2024, 2, 28)));
        // other years: on the 28th
        assert!(on_this_day(leap_day, (2025, 2, 28)));
        assert!(!on_this_day(leap_day, (2025, 3, 1)));
        // the 28th itself still shows on the 28th, every year
        assert!(on_this_day((2020, 2, 28), (2024, 2, 28)));
        assert!(on_this_day((2020, 2, 28), (2025, 2, 28)));
        assert!(!on_this_day((2020, 2, 28), (2024, 2, 29)));
    }

    #[test]
    fn days_of_the_year() {
        assert_eq!(parse_md("03-03"), Some((3, 3)));
        assert_eq!(parse_md("02-29"), Some((2, 29)));
        assert_eq!(parse_md("02-30"), None);
        assert_eq!(parse_md("junk"), None);
        assert!(same_day_of_year((2019, 3, 3), (3, 3), 2026));
        assert!(same_day_of_year((2020, 2, 29), (2, 28), 2025));
        assert!(!same_day_of_year((2020, 2, 29), (2, 28), 2024));
        assert!(same_day_of_year((2020, 2, 29), (2, 29), 2024));
    }

    #[test]
    fn on_this_day_at_the_year_boundary() {
        // today: 1 January 2025. Photos from New Year's Eve 2023→2024 at midnight
        let d = |y: i32, mo: u32, da: u32, h: u32, mi: u32| {
            chrono::NaiveDate::from_ymd_opt(y, mo, da).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp_millis()
        };
        let a = vec![
            asset("eve", d(2023, 12, 31, 23, 59)),
            asset("new1", d(2024, 1, 1, 0, 0)),
            asset("new2", d(2024, 1, 1, 0, 0) + 20_000),
            asset("this-year", d(2025, 1, 1, 0, 5)),
        ];
        let flt = Filter { window: 600, on_this_day: Some((2025, 1, 1)), ..Default::default() };
        let cs = build(&a, &flt, &utc);
        assert_eq!(cs, vec![vec![1, 2]], "only 1 January of earlier years, split from 31 December");
        // a date range is ignored in daily cleanup
        let flt = Filter { from: Some((2030, 1, 1)), ..flt };
        assert_eq!(build(&a, &flt, &utc).len(), 1);
    }

    #[test]
    fn date_range_keeps_clusters_by_their_first_day() {
        let a = vec![asset("a", T0), asset("b", T0 + 24 * 60 * MIN), asset("c", T0 + 48 * 60 * MIN)];
        let flt = Filter { window: 60, from: Some((2024, 6, 2)), to: Some((2024, 6, 2)), ..Default::default() };
        assert_eq!(build(&a, &flt, &utc), vec![vec![1]]);
        let flt = Filter { window: 60, from: Some((2024, 6, 2)), ..Default::default() };
        assert_eq!(build(&a, &flt, &utc), vec![vec![1], vec![2]]);
    }

    #[test]
    fn mark_rules() {
        let a = vec![asset("a", T0), asset("b", T0 + 1), asset("c", T0 + 2)];
        let c = vec![0, 1, 2];
        let none = HashSet::new();
        let ids = |v: &[&str]| v.iter().map(|n| short_id(n)).collect::<HashSet<_>>();
        // no keeper: nothing goes
        assert!(to_delete(&a, &c, &none, &none).is_empty());
        // one keeper: the rest go
        assert_eq!(to_delete(&a, &c, &ids(&["b"]), &none), vec![0, 2]);
        // two keepers
        assert_eq!(to_delete(&a, &c, &ids(&["a", "c"]), &none), vec![1]);
        // an explicit mark goes even without a keeper
        assert_eq!(to_delete(&a, &c, &none, &ids(&["c"])), vec![2]);
        // a keeper never goes, even if also marked
        assert!(to_delete(&a, &c, &ids(&["a"]), &ids(&["a"])).iter().all(|&i| i != 0));
    }

    #[test]
    fn favorites_are_protected() {
        let mut a = vec![asset("a", T0), asset("fav", T0 + 1), asset("c", T0 + 2)];
        a[1].favorite = true;
        let c = vec![0, 1, 2];
        let keep: HashSet<String> = [short_id("a")].into();
        assert_eq!(to_delete(&a, &c, &keep, &HashSet::new()), vec![2], "the favorite stays");
        let del: HashSet<String> = [short_id("fav")].into();
        assert_eq!(to_delete(&a, &c, &keep, &del), vec![1, 2], "unless marked explicitly");
    }

    /// The plan's target: re-clustering 100,000 assets after a window change
    /// takes under 100 ms (checked in release builds: `cargo test --release`).
    #[test]
    fn reclustering_100k_assets_is_fast() {
        let a: Vec<Asset> = (0..100_000)
            .map(|i| {
                let mut x = asset(&format!("p{}", i), T0 + i as i64 * 7_000 + (i % 13) as i64 * 50_000);
                if i % 40 < 6 {
                    x.burst_id = Some(format!("b{}", i / 40));
                }
                x
            })
            .collect();
        let mut worst = 0.0f64;
        for w in WINDOWS {
            let t = std::time::Instant::now();
            let cs = build(&a, &Filter { window: w, clusters_only: true, ..Default::default() }, &utc);
            worst = worst.max(t.elapsed().as_secs_f64() * 1000.0);
            assert!(!cs.is_empty());
        }
        println!("re-clustering 100,000 assets: {:.1} ms at worst", worst);
        if !cfg!(debug_assertions) {
            assert!(worst < 100.0, "re-clustering took {:.1} ms", worst);
        }
    }
}
