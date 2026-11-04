/**
 * backup-drive.cjs
 * ---------------------------------------------------------------------------
 * Tự động backup MongoDB và upload lên Google Drive (Service Account).
 *
 * Luồng:
 *   1. Dump toàn bộ databases (trừ admin/local/config) ra thư mục
 *      backups/DD-MM-YYYY_HH-MM-SS/ (Extended JSON - giữ nguyên kiểu dữ liệu)
 *   2. Nén thư mục backup thành file .zip
 *   3. Upload file .zip lên Google Drive bằng Resumable Upload (hỗ trợ file lớn)
 *   4. (Tuỳ chọn) Gửi thông báo kết quả lên Telegram
 *
 * Cấu hình qua .env (xem README):
 *   GOOGLE_SERVICE_ACCOUNT_FILE=/đường/dẫn/service-account.json
 *   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}   (thay thế file)
 *   DRIVE_FOLDER_ID=1AbCdEf...            (folder trên Drive đã share cho SA)
 *   DRIVE_FOLDER_NAME=Backups              (tên folder, dùng khi không có ID)
 *   DRIVE_SCOPE=https://www.googleapis.com/auth/drive.file
 *   GOOGLE_SUBJECT_USER=                    (bắt buộc nếu dùng domain-wide delegation)
 *   DRIVE_CHUNK_SIZE=8388608
 *   DRIVE_KEEP_COUNT=30                    (số bản backup giữ lại trên Drive)
 *   LOCAL_BACKUP_KEEP=30                   (số bản backup giữ lại trên local, 0 = xoá hết)
 *
 * Chạy:
 *   node backup-drive.cjs
 *   node backup-drive.cjs --database db1,db2
 *   node backup-drive.cjs --no-upload        (chỉ backup local)
 *   node backup-drive.cjs --keep-local       (không xoá file local sau khi upload)
 *   node backup-drive.cjs --dry-run          (không upload, không xoá gì)
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const chalk = require("chalk");
const dotenv = require("dotenv");
const archiver = require("archiver");
const { MongoClient, BSON } = require("mongodb");
const { EJSON } = BSON;
const { JWT } = require("google-auth-library");

dotenv.config();

/* ========================================================================== *
 * Cấu hình
 * ========================================================================== */

const BATCH_SIZE = 1000;
const MAX_CONCURRENT_COLLECTIONS = 5;
const MAX_CONCURRENT_DATABASES = 3;
const USE_EXTENDED_JSON = true;

const SYSTEM_DATABASES = ["admin", "local", "config"];

const DRIVE_API = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function encodeMongoCredentials(uri) {
  try {
    const prefix = uri.startsWith("mongodb+srv://")
      ? "mongodb+srv://"
      : "mongodb://";
    const rest = uri.slice(prefix.length);
    const atIndex = rest.lastIndexOf("@");
    if (atIndex === -1) return uri;

    const credentialsPart = rest.slice(0, atIndex);
    const hostPart = rest.slice(atIndex + 1);

    const colonIndex = credentialsPart.indexOf(":");
    if (colonIndex === -1) return uri;

    const encodedUsername = encodeURIComponent(
      credentialsPart.slice(0, colonIndex),
    );
    const encodedPassword = encodeURIComponent(
      credentialsPart.slice(colonIndex + 1),
    );

    return `${prefix}${encodedUsername}:${encodedPassword}@${hostPart}`;
  } catch (error) {
    console.warn("⚠️  Không encode được MongoDB URI:", error.message);
    return uri;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    databases: [],
    upload: true,
    keepLocal: false,
    dryRun: false,
    folderId: process.env.DRIVE_FOLDER_ID || null,
    folderName: process.env.DRIVE_FOLDER_NAME || "MongoDB Backups",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--database":
      case "--databases":
        if (args[i + 1]) {
          options.databases.push(
            ...args[i + 1]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          i++;
        }
        break;
      case "--no-upload":
        options.upload = false;
        break;
      case "--keep-local":
        options.keepLocal = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--folder-id":
        if (args[i + 1]) {
          options.folderId = args[i + 1];
          i++;
        }
        break;
      case "--folder-name":
        if (args[i + 1]) {
          options.folderName = args[i + 1];
          i++;
        }
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function showUsage() {
  console.log(chalk.bold.blue("☁️  MongoDB Backup → Google Drive"));
  console.log(chalk.gray("\nTùy chọn:"));
  console.log(chalk.gray("  --database <db1,db2>     Chỉ backup một số database"));
  console.log(chalk.gray("  --no-upload              Chỉ backup local, không upload Drive"));
  console.log(chalk.gray("  --keep-local             Giữ lại file backup local sau khi upload"));
  console.log(chalk.gray("  --folder-id <id>         Override DRIVE_FOLDER_ID"));
  console.log(chalk.gray("  --folder-name <name>     Override DRIVE_FOLDER_NAME"));
  console.log(chalk.gray("  --dry-run                Không upload, không dọn file cũ"));
  console.log(chalk.gray("  --help                   Xem hướng dẫn"));
}

function formatDateVN(date = new Date()) {
  const vn = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(vn.getUTCDate())}-${pad(vn.getUTCMonth() + 1)}-${vn.getUTCFullYear()}_${pad(
    vn.getUTCHours(),
  )}-${pad(vn.getUTCMinutes())}-${pad(vn.getUTCSeconds())}`;
}

function humanSize(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== *
 * Telegram (tuỳ chọn)
 * ========================================================================== */

async function sendTelegram(message, filePath = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  try {
    if (filePath && fsSync.existsSync(filePath)) {
      const FormData = require("form-data");
      const axios = require("axios");
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", fsSync.createReadStream(filePath));
      form.append("caption", message);
      await axios.post(`https://api.telegram.org/bot${token}/sendDocument`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return true;
    }

    const axios = require("axios");
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });
    return true;
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Telegram: ${error.message}`));
    return false;
  }
}

/* ========================================================================== *
 * Bước 1 - Backup MongoDB ra thư mục local
 * ========================================================================== */

async function createBackupDirectory(dateStr) {
  const backupDir = path.join(__dirname, "backups", dateStr);
  await fs.mkdir(backupDir, { recursive: true });
  return backupDir;
}

async function backupCollection(db, collectionName, backupDir, databaseName) {
  const collection = db.collection(collectionName);
  const backupFile = path.join(backupDir, databaseName, `${collectionName}.json`);

  try {
    const totalCount = await collection.countDocuments();

    if (totalCount === 0) {
      await fs.writeFile(backupFile, EJSON.stringify([], null, 2));
      return 0;
    }

    const allDocuments = [];
    const cursor = collection.find({}).batchSize(BATCH_SIZE);
    for (
      let doc = await cursor.next();
      doc != null;
      doc = await cursor.next()
    ) {
      allDocuments.push(doc);
    }
    await cursor.close();

    await fs.writeFile(
      backupFile,
      USE_EXTENDED_JSON
        ? EJSON.stringify(allDocuments, null, 2)
        : JSON.stringify(allDocuments, null, 2),
    );
    return allDocuments.length;
  } catch (error) {
    console.log(
      chalk.red(
        `  ❌ Lỗi backup ${databaseName}.${collectionName}: ${error.message}`,
      ),
    );
    return 0;
  }
}

async function backupDatabase(client, databaseName, backupDir) {
  const db = client.db(databaseName);
  const collections = await db.listCollections().toArray();
  const names = collections.map((c) => c.name);
  if (names.length === 0) return { count: 0, collections: 0 };

  await fs.mkdir(path.join(backupDir, databaseName), { recursive: true });

  let total = 0;
  for (let i = 0; i < names.length; i += MAX_CONCURRENT_COLLECTIONS) {
    const batch = names.slice(i, i + MAX_CONCURRENT_COLLECTIONS);
    const results = await Promise.all(
      batch.map((name) => backupCollection(db, name, backupDir, databaseName)),
    );
    total += results.reduce((a, b) => a + b, 0);
    console.log(
      chalk.gray(
        `   ✓ ${databaseName}: ${Math.min(i + batch.length, names.length)}/${names.length} collections`,
      ),
    );
  }

  return { count: total, collections: names.length };
}

async function runMongoBackup({ databases: filter }) {
  const rawUri = process.env.MONGODB_URI;
  if (!rawUri) throw new Error("Thiếu biến môi trường MONGODB_URI trong .env");
  const uri = encodeMongoCredentials(rawUri);

  const dateStr = formatDateVN();
  const backupDir = await createBackupDirectory(dateStr);
  console.log(chalk.green(`✅ Thư mục backup: ${backupDir}`));

  const client = new MongoClient(uri, {
    maxPoolSize: 50,
    minPoolSize: 10,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 60000,
  });

  try {
    await client.connect();
    console.log(chalk.green("✅ Đã kết nối MongoDB"));

    const list = await client.db("admin").admin().listDatabases();
    let databaseNames = list.databases
      .map((d) => d.name)
      .filter((name) => !SYSTEM_DATABASES.includes(name));

    if (filter && filter.length > 0) {
      databaseNames = databaseNames.filter((name) => filter.includes(name));
      if (databaseNames.length === 0) {
        throw new Error(
          `Không tìm thấy database nào trong: ${filter.join(", ")}`,
        );
      }
    }

    console.log(
      chalk.cyan(`📋 Backup ${databaseNames.length} databases: ${databaseNames.join(", ")}`),
    );

    const metadata = {
      timestamp: new Date().toISOString(),
      mongodb_uri: uri,
      databases: databaseNames,
      total_databases: databaseNames.length,
      description:
        "Backup toàn bộ MongoDB cluster (Extended JSON) + upload Google Drive",
      backup_format: {
        type: "Extended JSON (EJSON)",
        file_extension: ".json",
        preserves_mongodb_types: true,
      },
    };
    await fs.writeFile(
      path.join(backupDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );
    await fs.writeFile(
      path.join(backupDir, "MONGO_URL.txt"),
      `=== THÔNG TIN BACKUP MONGODB ===\n` +
        `Thời gian: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}\n` +
        `MONGODB_URI: ${uri}\n\n` +
        `Databases:\n${databaseNames.map((n) => `  - ${n}`).join("\n")}\n\n` +
        `Format: Extended JSON (giữ nguyên ObjectId, Date, Binary...)\n`,
    );

    let totalDocs = 0;
    let totalCollections = 0;

    for (let i = 0; i < databaseNames.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databaseNames.slice(i, i + MAX_CONCURRENT_DATABASES);
      const results = await Promise.all(
        batch.map((name) => backupDatabase(client, name, backupDir)),
      );
      for (const r of results) {
        totalDocs += r.count;
        totalCollections += r.collections;
      }
    }

    return {
      backupDir,
      dateStr,
      databaseNames,
      totalDocs,
      totalCollections,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/* ========================================================================== *
 * Bước 2 - Nén thư mục backup thành zip
 * ========================================================================== */

async function zipBackupDirectory(backupDir, dateStr) {
  const zipFileName = `backup-${dateStr}.zip`;
  const zipFilePath = path.join(__dirname, "backups", zipFileName);

  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipFilePath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve(zipFilePath));
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(backupDir, path.basename(backupDir));
    archive.finalize();
  });
}

/* ========================================================================== *
 * Bước 3 - Google Drive (Service Account)
 * ========================================================================== */

/**
 * Tạo client xác thực bằng Service Account.
 * - GOOGLE_SERVICE_ACCOUNT_FILE: đường dẫn tới file JSON key
 * - GOOGLE_SERVICE_ACCOUNT_JSON: nội dung JSON inline (escape dấu nháy trong .env)
 * - GOOGLE_SUBJECT_USER: user để impersonate (domain-wide delegation)
 */
async function createDriveAuth() {
  const scopes = (
    process.env.DRIVE_SCOPE || "https://www.googleapis.com/auth/drive.file"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const subject = process.env.GOOGLE_SUBJECT_USER;

  let credentials;
  if (inlineJson) {
    let parsed = inlineJson.trim();
    // Cho phép dạng base64
    if (!parsed.startsWith("{")) {
      parsed = Buffer.from(parsed, "base64").toString("utf8");
    }
    credentials = JSON.parse(parsed);
  } else if (filePath) {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(__dirname, filePath);
    credentials = JSON.parse(await fs.readFile(abs, "utf8"));
  } else {
    throw new Error(
      "Thiếu cấu hình Google Service Account. " +
        "Đặt GOOGLE_SERVICE_ACCOUNT_FILE hoặc GOOGLE_SERVICE_ACCOUNT_JSON trong .env",
    );
  }

  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes,
    subject: subject || undefined,
  });

  await auth.authorize();
  return auth;
}

/**
 * Tìm (hoặc tạo) folder trên Drive.
 * Ưu tiên folderId; nếu không có thì tìm theo tên.
 */
async function resolveFolder(auth, { folderId, folderName }) {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
  );

  if (!folderId) {
    const res = await auth.request({
      url: `${DRIVE_FILES_API}?q=${q}&fields=files(id,name)&spaces=drive&pageSize=10`,
      method: "GET",
    });
    const files = (res.data && res.data.files) || [];
    if (files.length > 0) {
      console.log(
        chalk.gray(`📁 Dùng folder có sẵn "${folderName}" (${files[0].id})`),
      );
      return files[0].id;
    }

    // Tạo folder mới ở root
    const created = await auth.request({
      url: `${DRIVE_FILES_API}?fields=id,name`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    console.log(
      chalk.green(`📁 Đã tạo folder "${folderName}" (${created.data.id})`),
    );
    return created.data.id;
  }

  // Có folderId -> kiểm tra truy cập được không
  try {
    const res = await auth.request({
      url: `${DRIVE_FILES_API}/${folderId}?fields=id,name,mimeType`,
      method: "GET",
    });
    console.log(
      chalk.gray(`📁 Folder đích: "${res.data.name}" (${res.data.id})`),
    );
    return res.data.id;
  } catch (error) {
    throw new Error(
      `Không truy cập được folder ID "${folderId}": ${error.message}. ` +
        "Hãy share folder cho email service account.",
    );
  }
}

/**
 * Resumable Upload (chunked) - dùng được cho file lớn (>5MB).
 */
async function resumableUpload(auth, filePath, { name, folderId, chunkSize }) {
  const stat = await fs.stat(filePath);
  const total = stat.size;
  const mimeType = "application/zip";

  // 1) Khởi tạo session
  const initRes = await auth.request({
    url: `${DRIVE_API}?uploadType=resumable&fields=id,name,size`,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(total),
    },
    data: JSON.stringify({
      name,
      mimeType,
      parents: folderId ? [folderId] : undefined,
      description: `MongoDB backup ${name}`,
    }),
  });

  const sessionUri = initRes.headers.location || initRes.headers.Location;
  if (!sessionUri) {
    throw new Error("Không nhận được upload session URI từ Google Drive");
  }

  // 2) Upload từng chunk
  const handle = await fs.open(filePath, "r");
  let offset = 0;
  const chunk = Buffer.alloc(chunkSize);

  try {
    while (offset < total) {
      const length = Math.min(chunkSize, total - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) break;

      const end = offset + bytesRead - 1;
      let uploaded = false;
      let attempt = 0;

      while (!uploaded && attempt < 5) {
        attempt++;
        try {
          const res = await auth.request({
            url: sessionUri,
            method: "PUT",
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(bytesRead),
              "Content-Range": `bytes ${offset}-${end}/${total}`,
            },
            data: chunk.subarray(0, bytesRead),
            validateStatus: (status) => status >= 200 && status < 400,
          });

          const status = res.status;
          if (status === 308) {
            // Chưa xong, đọc Range để biết đã upload tới đâu
            const range = res.headers.range || res.headers.Range;
            if (range) {
              const m = /bytes=0-(\d+)/.exec(range);
              const serverOffset = m ? Number(m[1]) + 1 : offset;
              if (serverOffset > offset) {
                offset = serverOffset;
              }
            } else {
              offset = end + 1;
            }
            uploaded = true;
            const pct = ((offset / total) * 100).toFixed(1);
            console.log(chalk.gray(`   ⬆️  ${pct}% (${humanSize(offset)})`));
          } else if (status >= 200 && status < 300) {
            offset = end + 1;
            uploaded = true;
            return res.data;
          } else {
            throw new Error(`HTTP ${status}`);
          }
        } catch (error) {
          const msg = error.message || "";
          if (/HTTP 308/.test(msg)) {
            // Một số lần trả lỗi do validateStatus, coi như đã tạo session
            offset = end + 1;
            uploaded = true;
          } else {
            console.log(
              chalk.yellow(
                `   ↻ Retry chunk (${attempt}/5): ${error.message}`,
              ),
            );
            await sleep(2000 * attempt);
          }
        }
      }

      if (!uploaded) {
        throw new Error(`Không upload được chunk tại offset ${offset}`);
      }
    }
  } finally {
    await handle.close();
  }

  throw new Error("Upload không hoàn tất");
}

/**
 * Upload 1 file lên Drive bằng Resumable Upload.
 * Dùng chung cho mọi kích thước (kể cả file nhỏ) để tránh lỗi với binary.
 */
async function uploadToDrive(auth, filePath, opts) {
  const stat = await fs.stat(filePath);
  const name = path.basename(filePath);

  if (stat.size === 0) {
    throw new Error(`File rỗng, không thể upload: ${name}`);
  }

  return resumableUpload(auth, filePath, {
    name,
    folderId: opts.folderId,
    chunkSize: opts.chunkSize,
  });
}

/**
 * Xoá các bản backup cũ trên Drive, giữ lại keepCount bản mới nhất.
 */
async function cleanupDrive(auth, folderId, keepCount) {
  if (!keepCount || keepCount <= 0 || !folderId) return 0;

  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and name contains 'backup-'`,
  );
  const res = await auth.request({
    url: `${DRIVE_FILES_API}?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime desc&pageSize=100`,
    method: "GET",
  });

  const files = (res.data && res.data.files) || [];
  const outdated = files.slice(keepCount);
  if (outdated.length === 0) return 0;

  for (const file of outdated) {
    try {
      await auth.request({
        url: `${DRIVE_FILES_API}/${file.id}`,
        method: "DELETE",
      });
      console.log(chalk.gray(`🗑️  Đã xoá bản cũ trên Drive: ${file.name}`));
    } catch (error) {
      console.log(
        chalk.yellow(`⚠️  Không xoá được ${file.name}: ${error.message}`),
      );
    }
  }
  return outdated.length;
}

/**
 * Xoá các bản backup cũ trên local.
 */
async function cleanupLocal(keepCount) {
  if (!keepCount || keepCount <= 0) return 0;
  const backupsDir = path.join(__dirname, "backups");
  let entries;
  try {
    entries = await fs.readdir(backupsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  // Sắp xếp theo thời gian sửa đổi (mtime) vì tên thư mục DD-MM-YYYY không sort đúng thứ tự tháng
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(backupsDir, entry.name);
    const stat = await fs.stat(full);
    dirs.push({ name: entry.name, mtime: stat.mtimeMs });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);

  const outdated = dirs.slice(keepCount);

  for (const dir of outdated) {
    try {
      await fs.rm(path.join(backupsDir, dir.name), { recursive: true, force: true });
      console.log(chalk.gray(`🗑️  Đã xoá bản cũ local: ${dir.name}`));
    } catch (error) {
      console.log(
        chalk.yellow(`⚠️  Không xoá được ${dir.name}: ${error.message}`),
      );
    }
  }
  return outdated.length;
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

async function main() {
  const options = parseArgs();
  if (options.help) {
    showUsage();
    return;
  }

  const startTime = Date.now();
  console.log(chalk.bold.blue("☁️  MongoDB Backup → Google Drive"));
  console.log(chalk.gray(`Folder: ${options.folderId || options.folderName}`));
  console.log(chalk.gray(`Upload: ${options.upload ? "CÓ" : "KHÔNG"}`));

  let zipFilePath = null;
  let backupInfo = null;

  try {
    /* 1. Backup MongoDB */
    backupInfo = await runMongoBackup({ databases: options.databases });
    console.log(
      chalk.green(
        `🎉 Backup xong: ${backupInfo.databaseNames.length} DB / ${backupInfo.totalCollections} collections / ${backupInfo.totalDocs} documents`,
      ),
    );

    /* 2. Nén */
    console.log(chalk.cyan("📦 Đang nén backup..."));
    zipFilePath = await zipBackupDirectory(backupInfo.backupDir, backupInfo.dateStr);
    const zipStat = await fs.stat(zipFilePath);
    console.log(
      chalk.green(
        `✅ Đã nén: ${path.basename(zipFilePath)} (${humanSize(zipStat.size)})`,
      ),
    );

    /* 3. Upload lên Drive */
    if (options.upload && !options.dryRun) {
      console.log(chalk.cyan("📤 Đang upload lên Google Drive..."));
      const auth = await createDriveAuth();
      const folderId = await resolveFolder(auth, {
        folderId: options.folderId,
        folderName: options.folderName,
      });

      const chunkSize = Number(process.env.DRIVE_CHUNK_SIZE || 8 * 1024 * 1024);
      const uploaded = await uploadToDrive(auth, zipFilePath, {
        folderId,
        chunkSize,
      });

      console.log(
        chalk.green(
          `✅ Đã upload lên Drive: ${uploaded.name || path.basename(zipFilePath)} (id: ${uploaded.id})`,
        ),
      );

      // Dọn bản cũ trên Drive
      const keepCount = Number(process.env.DRIVE_KEEP_COUNT || 120);
      const removed = await cleanupDrive(auth, folderId, keepCount);
      if (removed) {
        console.log(chalk.gray(`🧹 Đã dọn ${removed} bản backup cũ trên Drive`));
      }
    } else {
      console.log(
        chalk.yellow("⏭️  Bỏ qua upload lên Drive (--no-upload / --dry-run)"),
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(chalk.bold.green(`\n🎉 Hoàn thành trong ${duration}s`));
    console.log(chalk.gray(`📁 Thư mục backup: ${backupInfo.backupDir}`));

    /* 4. Telegram */
    const summary =
      `☁️ <b>BACKUP GOOGLE DRIVE HOÀN THÀNH</b>\n\n` +
      `📊 Databases: ${backupInfo.databaseNames.length}\n` +
      `📁 Collections: ${backupInfo.totalCollections}\n` +
      `📄 Documents: ${backupInfo.totalDocs}\n` +
      `🗜️ Kích thước zip: ${humanSize(zipStat.size)}\n` +
      `⏱️ Thời gian: ${duration}s\n` +
      `🕐 ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;
    await sendTelegram(summary);

    /* 5. Dọn file local */
    if (!options.dryRun && !options.keepLocal) {
      await fs.rm(backupInfo.backupDir, { recursive: true, force: true });
      console.log(chalk.gray("🗑️  Đã xoá thư mục backup local (giữ file zip)"));
      await cleanupLocal(Number(process.env.LOCAL_BACKUP_KEEP || 30));
    }
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi: ${error.message}`));
    await sendTelegram(
      `❌ <b>LỖI BACKUP DRIVE</b>\n\n${error.message}\n\n` +
        `🕐 ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    );
    process.exitCode = 1;
  } finally {
    if (zipFilePath && fsSync.existsSync(zipFilePath)) {
      try {
        await fs.unlink(zipFilePath);
        console.log(chalk.gray(`🗑️  Đã xoá file zip tạm: ${path.basename(zipFilePath)}`));
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Không xoá được file zip: ${error.message}`));
      }
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  });
}

module.exports = {
  createDriveAuth,
  resolveFolder,
  uploadToDrive,
  resumableUpload,
  cleanupDrive,
  cleanupLocal,
  runMongoBackup,
  zipBackupDirectory,
};
