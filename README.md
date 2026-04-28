# MongoDB Backup & Restore Tool

MongoDB backup and restore tool with Extended JSON support, preserving MongoDB data types (ObjectId, Date, Binary, etc.)

## Features

- Backup entire MongoDB cluster or selective databases
- Extended JSON support - preserves MongoDB data types
- Parallel processing - optimized performance
- Progress bar for tracking
- Flexible import options
- Upload backup to Telegram (auto-compress)
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
- Compress to ZIP file
- Upload to Telegram
- Support additional upload paths (configured in `UPLOAD_PATHS`)

### 4. Scheduler - Automatic Backup

```bash
node scheduler.js
```

Default runs backup every 1 hour. Edit cron expression in file to change:

```javascript
// Run every 6 hours
cron.schedule('0 */6 * * *', runBackup);

// Run daily at 2:00 AM
cron.schedule('0 2 * * *', runBackup);
```

## Advanced Configuration

In `backup.cjs` and `backup-telegram.cjs`:

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
