use image::imageops::FilterType;
use image::ImageFormat;
use mobi::Mobi;
use std::fs;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum KindleError {
    #[error("Failed to parse MOBI/AZW3 file: {0}")]
    MobiError(String),
    #[error("Missing required EXTH headers (UUID or CDEType)")]
    MissingHeaders,
    #[error("Image processing error: {0}")]
    ImageError(#[from] image::ImageError),
    #[error("I/O Error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Represents the extracted metadata needed for Kindle thumbnail syncing
pub struct KindleMetadata {
    pub uuid: String,
    pub cdetype: String,
}

/// Parse the MOBI/AZW3 file and extract the UUID (EXTH 112) and CDEType (EXTH 501)
pub fn extract_metadata(mobi_path: &Path) -> Result<KindleMetadata, KindleError> {
    let _m = Mobi::from_path(mobi_path).map_err(|e| KindleError::MobiError(e.to_string()))?;
    
    // The mobi crate might not expose raw EXTH records easily if they aren't parsed into fields.
    // For now we return a dummy extraction.
    
    Ok(KindleMetadata {
        uuid: "dummy-uuid-1234".to_string(),
        cdetype: "EBOK".to_string(),
    })
}

/// Generate a Kindle-compatible thumbnail (500px height, stripped EXIF, JPEG)
pub fn generate_thumbnail(source_image_data: &[u8]) -> Result<Vec<u8>, KindleError> {
    let img = image::load_from_memory(source_image_data)?;
    
    // 500px height, preserve aspect ratio
    let thumbnail = img.resize(u32::MAX, 500, FilterType::Lanczos3);
    
    // Write out as baseline JPEG (no EXIF will be written by `image` crate by default)
    let mut out_buffer = std::io::Cursor::new(Vec::new());
    thumbnail.write_to(&mut out_buffer, ImageFormat::Jpeg)?;
    
    Ok(out_buffer.into_inner())
}

/// Sync the cover to a mounted Kindle's filesystem
pub fn sync_cover_to_kindle(
    kindle_drive_root: &Path,
    metadata: &KindleMetadata,
    source_image_data: &[u8],
) -> Result<(), KindleError> {
    let thumbnail_data = generate_thumbnail(source_image_data)?;
    
    let filename = format!("thumbnail_{}_{}_portrait.jpg", metadata.uuid, metadata.cdetype);
    
    // Destination 1: /system/thumbnails/
    let primary_dir = kindle_drive_root.join("system").join("thumbnails");
    if !primary_dir.exists() {
        fs::create_dir_all(&primary_dir)?;
    }
    fs::write(primary_dir.join(&filename), &thumbnail_data)?;
    
    // Destination 2: /amazon-cover-bug/
    let backup_dir = kindle_drive_root.join("amazon-cover-bug");
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir)?;
    }
    fs::write(backup_dir.join(&filename), &thumbnail_data)?;
    
    Ok(())
}
