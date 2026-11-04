# MongoDB Backup & Restore Tool

MongoDB backup and restore tool with Extended JSON support, preserving MongoDB data types (ObjectId, Date, Binary, etc.)

## Features

- Backup entire MongoDB cluster or selective databases
- Extended JSON support - preserves MongoDB data types
- Parallel processing - optimized performance
- Progress bar for tracking
- Flexible import options
- **AES-256-GCM encryption** for backup archives
- Upload backup to Telegram (auto-compress + encrypt)
- Scheduler for automatic backups

## Installation

```bash
npm install
```

## Configuration

Create `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Configure environment variables:

```env
# MongoDB URI
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net

# Telegram (optional - for backup-telegram.cjs)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
UPLOAD_PATHS=path/to/upload1,path/to/upload2

# Encryption key (REQUIRED for backup-telegram.cjs)
BACKUP_ENCRYPTION_KEY=your-secret-key
```

Generate a strong encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Usage

### 1. Backup MongoDB

#### Backup all databases

```bash
node backup.cjs
```

#### Backup specific databases

```bash
node backup.cjs --database db1,db2,db3
```

**Output:**
- Backup directory: `backups/DD-MM-YYYY_HH-MM-SS/`
- Metadata: `metadata.json`
- Details: `MONGO_URL.txt`
- Structure:
  ```
  backups/28-04-2026_10-08-38/
  ├── metadata.json
  ├── MONGO_URL.txt
  ├── database1/
  │   ├── collection1.json
  │   └── collection2.json
  └── database2/
      └── collection1.json
  ```

### 2. Import Backup

#### Import all databases

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --all
```

#### Import specific database

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --database mydb
```

#### Import specific collection

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --database mydb --col products
```

#### Import multiple collections

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --database mydb --collections products,categories,users
```

#### Import multiple databases

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --databases db1,db2,db3
```

#### Import with different database name

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --database mydb --target mydb_new
```

#### Import to different MongoDB URI

```bash
node import-backup.cjs ./backups/28-04-2026_10-08-38 --all --uri mongodb://localhost:27017
```

### 3. Backup and Upload to Telegram

```bash
node backup-telegram.cjs
```

Features:
- Automatic MongoDB backup
- Compress to ZIP file **and encrypt with AES-256-GCM**
- Upload encrypted archive to Telegram
- Support additional upload paths (configured in `UPLOAD_PATHS`)

The uploaded `.zip` contains a single encrypted entry (`backup.enc`). It can be
opened with WinRAR/7-Zip to inspect the archive, but the actual backup data
stays encrypted until decrypted with the correct key.

### 3.1 Decrypt / Restore an Encrypted Backup

Decrypt to a folder:

```bash
node decrypt-backup.cjs ./backups/backup-28-04-2026_10-08-38.zip --out ./restored
```

Then import as usual:

```bash
node import-backup.cjs ./restored --all
```

Or import directly from the encrypted archive (auto-decrypts first):

```bash
node import-backup.cjs ./backups/backup-28-04-2026_10-08-38.zip --all --password <key>
```

### 4. Backup to Google Drive (auto)

```bash
node backup-drive.cjs
```

Features:
- Dump all MongoDB databases (Extended JSON) → compress to ZIP
- Upload to Google Drive via **Resumable Upload** (supports large files, auto retry per chunk)
- Auto-cleanup old backups on Drive (`DRIVE_KEEP_COUNT`) and locally (`LOCAL_BACKUP_KEEP`)
- Optional Telegram notification
- Requires a Google **Service Account**

#### Setup Google Service Account

1. Vào [Google Cloud Console](https://console.cloud.google.com/) → tạo project → bật **Google Drive API**
2. Tạo Service Account → tải file JSON key
3. Đặt file key vào thư mục dự án (không commit lên git) và cấu hình `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json
DRIVE_FOLDER_NAME=MongoDB Backups
```

4. Tạo folder trên Drive và **Share** (Quyền *Editor*) cho email service account
   (`xxx@project.iam.gserviceaccount.com` trong file JSON)

Nếu dùng **domain-wide delegation**, thêm `GOOGLE_SUBJECT_USER=user@yourdomain.com`.

#### Options

```bash
node backup-drive.cjs --database db1,db2   # chỉ backup một số database
node backup-drive.cjs --no-upload         # chỉ backup local
node backup-drive.cjs --keep-local        # giữ file local sau khi upload
node backup-drive.cjs --folder-id <id>    # chỉ định folder Drive
node backup-drive.cjs --dry-run           # không upload, không dọn file cũ
```

### 5. Scheduler - Automatic Backup

```bash
node scheduler.js
```

Jobs registered in `scheduler.js`:

| Job | Script | Schedule |
| --- | --- | --- |
| Local backup | `backup.cjs` | every 6 hours |
| Google Drive | `backup-drive.cjs` | every 12 hours (`15 */12 * * *`) + on start |
| Telegram | `backup-telegram.cjs` | every 12 hours (`30 */12 * * *`) |

Edit the cron expressions in `scheduler.js` to change:

```javascript
// Run every 6 hours
cron.schedule('0 */6 * * *', runBackup);

// Run daily at 2:00 AM
cron.schedule('0 2 * * *', runBackup);
```

## Advanced Configuration

In `backup.cjs`, `backup-telegram.cjs` and `backup-drive.cjs`:

```javascript
const BATCH_SIZE = 1000; // Documents per batch
const MAX_CONCURRENT_COLLECTIONS = 5; // Concurrent collections
const MAX_CONCURRENT_DATABASES = 3; // Concurrent databases
const USE_EXTENDED_JSON = true; // Preserve MongoDB data types
```

## Extended JSON

Tool uses MongoDB Extended JSON to preserve special data types:

- `ObjectId`: `{"$oid": "507f1f77bcf86cd799439011"}`
- `Date`: `{"$date": "2023-01-01T00:00:00.000Z"}`
- `Binary`: `{"$binary": {"base64": "...", "subType": "00"}}`
- `Decimal128`: `{"$numberDecimal": "123.45"}`

## Encryption

Backup archives produced by `backup-telegram.cjs` are encrypted with **AES-256-GCM**:

- Key derivation: PBKDF2-SHA512, 310,000 iterations, random 32-byte salt per file
- Random 96-bit IV per file
- 128-bit authentication tag verified on decrypt

Because GCM is an *authenticated* cipher, a corrupted or tampered archive will
fail to decrypt instead of silently producing wrong data. Same for a wrong key.

> ⚠️ If `BACKUP_ENCRYPTION_KEY` is lost, the backup **cannot be recovered**.
> Store the key somewhere safe (password manager, secret manager).

## Important Notes

- System databases (`admin`, `local`, `config`) are not backed up
- Backup uses parallel processing for optimal speed
- Import will **DROP** existing data before importing (drop collection)
- Always verify before importing to production

## System Requirements

- Node.js >= 14
- MongoDB >= 4.0
- Sufficient disk space for backups

## License

ISC
