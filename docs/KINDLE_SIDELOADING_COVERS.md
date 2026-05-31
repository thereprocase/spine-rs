# Kindle Sideloading & Cover Sync Specification

*Based on primary sources and Calibre's internal driver implementation (2026-04-21).*

## The Problem
Amazon's modern Kindle firmware completely ignores embedded covers (e.g. within an AZW3 or EPUB converted to KFX/MOBI/AZW3) when a book is sideloaded over USB. Instead, the firmware expects the cover to be pre-cached as a thumbnail in a specific system directory. If this thumbnail is missing, the Kindle will show a blank generic cover on the home screen.

## The Solution
When Spine syncs a library to a Kindle via USB, it MUST emulate Calibre's thumbnail generation behavior. 

### Implementation Details:
1. **Extraction / Source**: Pull the cover image from Spine's local database or extract it from the book being transferred.
2. **Format**: The image MUST be saved as a standard baseline JPEG, RGB (sRGB implicit).
3. **Dimensions**: Aspect ratio should be preserved, but the height MUST be locked to **500px** (this is a constant used for Paperwhite/Voyage/Oasis rendering). Width scales accordingly.
4. **EXIF Data**: EXIF data MUST be explicitly stripped out entirely. The Kindle firmware will refuse and reject JPEGs that contain EXIF headers.
5. **Filename Construction**: 
   The filename must exactly match `thumbnail_<uuid>_<cdetype>_portrait.jpg`
   * `uuid` and `cdetype` must be parsed from the EXTH header of the AZW3/MOBI being written (Spine will need an EXTH parser similar to Calibre's `MetadataHeader` class).
6. **Locations**:
   * The primary destination is the Kindle's root directory at: `/system/thumbnails/`
   * A secondary backup cache must be written to `/amazon-cover-bug/` (This is because Amazon firmware sometimes periodically wipes the `/system/thumbnails/` directory. Storing a copy in the cover-bug directory acts as a restore cache that can be pulled from automatically next time the device mounts).

## Ejection & Indexing
When the device is ejected, the home screen will populate these covers immediately. If a specific book's cover stays blank, it means the library entry hasn't been indexed by the Kindle yet; a restart or "pull to refresh" will force the indexer to associate the newly sideloaded `thumbnail_*.jpg`.
