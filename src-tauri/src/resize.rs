//! JPEG resizing: FakeSource's sizes (as PhotoKit would answer) and the
//! server's sharp copies served at the size the page asks for.

/// The JPEG at most `px` on its long side, upright, re-encoded; None if it's
/// already that small (and upright) or can't be read.
pub fn resize_jpeg(bytes: &[u8], px: u32, orientation: u16) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    if img.width().max(img.height()) <= px && orientation <= 1 {
        return None;
    }
    let img = if img.width().max(img.height()) > px { img.thumbnail(px, px) } else { img };
    let img = match orientation {
        3 => img.rotate180(),
        6 => img.rotate90(),
        8 => img.rotate270(),
        _ => img,
    };
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    img.to_rgb8().write_with_encoder(enc).ok()?;
    Some(out)
}
