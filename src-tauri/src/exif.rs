//! Just enough JPEG/EXIF reading for `FakeSource`: capture time (with its
//! offset and sub-seconds), orientation, pixel size and the embedded thumbnail.

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct Exif {
    /// DateTimeOriginal, "YYYY:MM:DD HH:MM:SS" (local wall-clock time)
    pub date: Option<String>,
    /// OffsetTimeOriginal in minutes east of UTC
    pub offset: Option<i32>,
    pub subsec_ms: u32,
    pub orientation: u16,
    pub width: u32,
    pub height: u32,
    /// the IFD1 thumbnail: (byte offset in the file, length)
    pub thumb: Option<(u64, u64)>,
    /// GPS latitude and longitude, degrees (south and west negative)
    pub gps: Option<(f64, f64)>,
}

pub fn read(path: &Path) -> Option<Exif> {
    let mut f = File::open(path).ok()?;
    let mut buf = Vec::new();
    f.by_ref().take(1 << 20).read_to_end(&mut buf).ok()?;
    parse(&buf)
}

pub fn parse(b: &[u8]) -> Option<Exif> {
    if b.len() < 4 || b[0] != 0xff || b[1] != 0xd8 {
        return None;
    }
    let mut e = Exif { orientation: 1, ..Default::default() };
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            break;
        }
        let m = b[i + 1];
        if m == 0xd8 || m == 0x01 || (0xd0..=0xd7).contains(&m) {
            i += 2;
            continue;
        }
        if m == 0xda || m == 0xd9 {
            break;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        let seg = i + 4;
        let end = (i + 2 + len).min(b.len());
        if m == 0xe1 && end > seg + 6 && &b[seg..seg + 6] == b"Exif\0\0" {
            tiff(&b[seg + 6..end], (seg + 6) as u64, &mut e);
        }
        // start-of-frame markers carry the pixel size
        if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc && end >= seg + 5 && e.width == 0 {
            e.height = u16::from_be_bytes([b[seg + 1], b[seg + 2]]) as u32;
            e.width = u16::from_be_bytes([b[seg + 3], b[seg + 4]]) as u32;
        }
        i = i + 2 + len;
    }
    Some(e)
}

struct Tiff<'a> {
    b: &'a [u8],
    le: bool,
}
impl<'a> Tiff<'a> {
    fn u16(&self, o: usize) -> u32 {
        let s = self.b.get(o..o + 2).unwrap_or(&[0, 0]);
        (if self.le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) }) as u32
    }
    fn u32(&self, o: usize) -> u32 {
        let s = self.b.get(o..o + 4).unwrap_or(&[0, 0, 0, 0]);
        if self.le {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        }
    }
    /// (tag, type, count, value-or-offset field position)
    fn entries(&self, at: usize) -> Vec<(u32, u32, u32, usize)> {
        let n = self.u16(at) as usize;
        (0..n.min(500)).map(|k| at + 2 + k * 12).filter(|&o| o + 12 <= self.b.len()).map(|o| (self.u16(o), self.u16(o + 2), self.u32(o + 4), o + 8)).collect()
    }
    fn value(&self, typ: u32, field: usize) -> u32 {
        if typ == 3 {
            self.u16(field)
        } else {
            self.u32(field)
        }
    }
    /// three rationals (degrees, minutes, seconds) → degrees
    fn dms(&self, field: usize) -> Option<f64> {
        let at = self.u32(field) as usize;
        let r = |k: usize| {
            let (n, d) = (self.u32(at + k * 8) as f64, self.u32(at + k * 8 + 4) as f64);
            if d == 0.0 { 0.0 } else { n / d }
        };
        (at + 24 <= self.b.len()).then(|| r(0) + r(1) / 60.0 + r(2) / 3600.0)
    }
    fn ascii(&self, count: u32, field: usize) -> String {
        let at = if count <= 4 { field } else { self.u32(field) as usize };
        let s = self.b.get(at..at + count as usize).unwrap_or(&[]);
        String::from_utf8_lossy(s).trim_end_matches('\0').trim().to_string()
    }
}

fn tiff(b: &[u8], base: u64, e: &mut Exif) {
    if b.len() < 8 {
        return;
    }
    let t = Tiff { b, le: &b[0..2] == b"II" };
    let ifd0 = t.u32(4) as usize;
    let mut exif_at = None;
    let mut gps_at = None;
    for (tag, typ, count, field) in t.entries(ifd0) {
        match tag {
            0x0112 => e.orientation = t.value(typ, field) as u16,
            0x8769 => exif_at = Some(t.value(typ, field) as usize),
            0x8825 => gps_at = Some(t.value(typ, field) as usize),
            0x0132 if e.date.is_none() => e.date = Some(t.ascii(count, field)),
            _ => {}
        }
    }
    if let Some(at) = exif_at {
        for (tag, typ, count, field) in t.entries(at) {
            match tag {
                0x9003 => e.date = Some(t.ascii(count, field)),
                0x9011 => e.offset = parse_offset(&t.ascii(count, field)),
                0x9291 => e.subsec_ms = parse_subsec(&t.ascii(count, field)),
                0xa002 => e.width = t.value(typ, field),
                0xa003 => e.height = t.value(typ, field),
                _ => {}
            }
        }
    }
    if let Some(at) = gps_at.filter(|&a| a > 0 && a < b.len()) {
        let (mut lat, mut lon, mut ns, mut ew) = (None, None, 'N', 'E');
        for (tag, _, count, field) in t.entries(at) {
            match tag {
                1 => ns = t.ascii(count, field).chars().next().unwrap_or('N'),
                2 => lat = t.dms(field),
                3 => ew = t.ascii(count, field).chars().next().unwrap_or('E'),
                4 => lon = t.dms(field),
                _ => {}
            }
        }
        if let (Some(la), Some(lo)) = (lat, lon) {
            if la != 0.0 || lo != 0.0 {
                e.gps = Some((if ns == 'S' { -la } else { la }, if ew == 'W' { -lo } else { lo }));
            }
        }
    }
    // IFD1: the thumbnail
    let n0 = t.u16(ifd0) as usize;
    let ifd1 = t.u32(ifd0 + 2 + n0 * 12) as usize;
    if ifd1 > 0 && ifd1 < b.len() {
        let (mut off, mut len) = (0, 0);
        for (tag, typ, _, field) in t.entries(ifd1) {
            match tag {
                0x0201 => off = t.value(typ, field) as u64,
                0x0202 => len = t.value(typ, field) as u64,
                _ => {}
            }
        }
        if off > 0 && len > 0 && (off + len) as usize <= b.len() {
            e.thumb = Some((base + off, len));
        }
    }
}

/// "+09:00" → 540
pub fn parse_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    let sign = match s.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let (h, m) = s[1..].split_once(':')?;
    Some(sign * (h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?))
}

fn parse_subsec(s: &str) -> u32 {
    let d: String = s.chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
    if d.is_empty() {
        return 0;
    }
    d.parse::<u32>().unwrap_or(0) * 10u32.pow(3 - d.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offsets_and_subseconds() {
        assert_eq!(parse_offset("+09:00"), Some(540));
        assert_eq!(parse_offset("-05:30"), Some(-330));
        assert_eq!(parse_offset("junk"), None);
        assert_eq!(parse_subsec("5"), 500);
        assert_eq!(parse_subsec("123456"), 123);
    }
}
