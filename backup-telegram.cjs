const { MongoClient, BSON } = require("mongodb");
const { EJSON } = BSON;
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const chalk = require("chalk");
const cliProgress = require("cli-progress");
const dotenv = require("dotenv");
const axios = require("axios");
const FormData = require("form-data");
const { createReadStream, statSync } = require("fs");
const archiver = require("archiver");
dotenv.config();

// Cấu hình kết nối MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI;

// Cấu hình Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

// Cấu hình đường dẫn uploads (từ .env)
const UPLOAD_PATHS_ENV = process.env.UPLOAD_PATHS
  ? process.env.UPLOAD_PATHS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  : [];


// Cấu hình tối ưu
const BATCH_SIZE = 1000; // Số documents xử lý mỗi batch
const MAX_CONCURRENT_COLLECTIONS = 5; // Số collections xử lý đồng thời
const MAX_CONCURRENT_DATABASES = 3; // Số databases xử lý đồng thời

const USE_EXTENDED_JSON = true; // Giữ nguyên kiểu dữ liệu MongoDB

// Tạo thư mục backup
async function createBackupDirectory() {
  const now = new Date();
  // Chuyển sang giờ Việt Nam (UTC+7)
  const vietnamTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);

  // Format: DD-MM-YYYY_HH-MM-ss
  const day = String(vietnamTime.getUTCDate()).padStart(2, "0");
  const month = String(vietnamTime.getUTCMonth() + 1).padStart(2, "0");
  const year = vietnamTime.getUTCFullYear();
  const hours = String(vietnamTime.getUTCHours()).padStart(2, "0");
  const minutes = String(vietnamTime.getUTCMinutes()).padStart(2, "0");
  const seconds = String(vietnamTime.getUTCSeconds()).padStart(2, "0");

  const dateStr = `${day}-${month}-${year}_${hours}-${minutes}-${seconds}`;
  const backupDir = path.join(__dirname, "backups", dateStr);
  try {
    await fs.mkdir(backupDir, { recursive: true });
    console.log(chalk.green(`✅ Đã tạo thư mục backup: ${backupDir}`));
    return { backupDir, dateStr };
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi tạo thư mục backup: ${error.message}`));
    throw error;
  }
}

// Hàm nén thư mục backup thành file zip
async function zipBackupDirectory(backupDir, dateStr) {
  return new Promise((resolve, reject) => {
    const zipFileName = `backup-${dateStr}.zip`;
    const zipFilePath = path.join(__dirname, "backups", zipFileName);
    const output = fsSync.createWriteStream(zipFilePath);
    const archive = archiver("zip", {
      zlib: { level: 9 }, // Mức độ nén tối đa
    });

    output.on("close", () => {
      const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
      console.log(chalk.green(`✅ Đã nén backup thành công: ${zipFileName} (${sizeMB} MB)`));
      resolve(zipFilePath);
    });

    archive.on("error", (err) => {
      console.log(chalk.red(`❌ Lỗi nén backup: ${err.message}`));
      reject(err);
    });

    archive.pipe(output);

    // Thêm toàn bộ thư mục backup vào zip
    archive.directory(backupDir, false);

    archive.finalize();
  });
}

// Backup một collection với progress bar và giữ nguyên kiểu dữ liệu MongoDB
async function backupCollection(
  db,
  collectionName,
  backupDir,
  databaseName,
  progressBar
) {
  const collection = db.collection(collectionName);
  const fileExtension = USE_EXTENDED_JSON ? ".json" : ".json";
  const backupFile = path.join(
    backupDir,
    databaseName,
    `${collectionName}${fileExtension}`
  );

  try {
    // Đếm tổng số documents trước
    const totalCount = await collection.countDocuments();

    if (totalCount === 0) {
      const emptyData = USE_EXTENDED_JSON
        ? EJSON.stringify([], null, 2)
        : JSON.stringify([], null, 2);
      await fs.writeFile(backupFile, emptyData);
      progressBar.increment();
      return 0;
    }

    // Backup theo batch để tiết kiệm memory
    const allDocuments = [];
    let processedCount = 0;

    // Sử dụng cursor để xử lý từng batch
    const cursor = collection.find({}).batchSize(BATCH_SIZE);

    for (
      let batch = await cursor.next();
      batch != null;
      batch = await cursor.next()
    ) {
      allDocuments.push(batch);
      processedCount++;

      // Cập nhật progress bar mỗi 100 documents
      if (processedCount % 100 === 0) {
        progressBar.update(processedCount, {
          collection: `${databaseName}.${collectionName}`,
          processed: processedCount,
          total: totalCount,
        });
      }
    }

    // Ghi file với Extended JSON để giữ nguyên kiểu dữ liệu MongoDB
    const serializedData = USE_EXTENDED_JSON
      ? EJSON.stringify(allDocuments, null, 2)
      : JSON.stringify(allDocuments, null, 2);

    await fs.writeFile(backupFile, serializedData);
    progressBar.increment();
    return allDocuments.length;
  } catch (error) {
    console.log(
      chalk.red(
        `  ❌ Lỗi backup collection ${databaseName}.${collectionName}: ${error.message}`
      )
    );
    progressBar.increment();
    return 0;
  }
}

// Backup một database với parallel processing và progress bar
async function backupDatabase(
  client,
  databaseName,
  backupDir,
  databaseProgressBar
) {
  const db = client.db(databaseName);

  // Lấy danh sách tất cả collection
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map((col) => col.name);

  if (collectionNames.length === 0) {
    databaseProgressBar.increment();
    return 0;
  }

  // Tạo thư mục cho database
  const dbBackupDir = path.join(backupDir, databaseName);
  await fs.mkdir(dbBackupDir, { recursive: true });

  // Tạo progress bar cho collections trong database này
  const collectionProgressBar = new cliProgress.SingleBar({
    format:
      "  📊 {bar} | {percentage}% | {value}/{total} collections | {collection}",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });

  collectionProgressBar.start(collectionNames.length, 0, {
    collection: "Starting...",
  });

  let totalBackedUp = 0;

  // Backup collections theo parallel với giới hạn concurrent
  for (let i = 0; i < collectionNames.length; i += MAX_CONCURRENT_COLLECTIONS) {
    const batch = collectionNames.slice(i, i + MAX_CONCURRENT_COLLECTIONS);
    const promises = batch.map(async (collectionName) => {
      const count = await backupCollection(
        db,
        collectionName,
        backupDir,
        databaseName,
        collectionProgressBar
      );
      return count;
    });

    const results = await Promise.all(promises);
    totalBackedUp += results.reduce((sum, count) => sum + count, 0);
  }

  collectionProgressBar.stop();
  databaseProgressBar.increment();
  return totalBackedUp;
}

// Thêm hàm parseArguments để lấy danh sách database và đường dẫn từ dòng lệnh hoặc .env
function parseArguments() {
  const args = process.argv.slice(2);
  const dbArgIndex = args.findIndex((arg) => arg === "--database");
  const pathArgIndex = args.findIndex((arg) => arg === "--paths");

  let databases = [];
  if (dbArgIndex !== -1 && args[dbArgIndex + 1]) {
    databases = args[dbArgIndex + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Ưu tiên đọc từ command line, nếu không có thì dùng từ .env
  let uploadPaths = [];
  if (pathArgIndex !== -1 && args[pathArgIndex + 1]) {
    // Đọc từ command line
    uploadPaths = args[pathArgIndex + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (UPLOAD_PATHS_ENV.length > 0) {
    // Đọc từ .env
    uploadPaths = UPLOAD_PATHS_ENV;
  }

  return { databases, uploadPaths };
}

// Hàm gửi tin nhắn lên Telegram
async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(chalk.yellow("⚠️  Telegram không được cấu hình, bỏ qua gửi tin nhắn"));
    return false;
  }

  try {
    const response = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    return response.data.ok;
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi gửi tin nhắn Telegram: ${error.message}`));
    return false;
  }
}

// Hàm gửi file lên Telegram
async function sendTelegramFile(filePath, caption = "") {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(chalk.yellow("⚠️  Telegram không được cấu hình, bỏ qua gửi file"));
    return false;
  }

  try {
    const fileStats = statSync(filePath);
    const maxFileSize = 50 * 1024 * 1024; // 50MB limit của Telegram

    if (fileStats.size > maxFileSize) {
      console.log(
        chalk.yellow(
          `⚠️  File ${path.basename(filePath)} quá lớn (${(fileStats.size / 1024 / 1024).toFixed(2)}MB), bỏ qua gửi lên Telegram`
        )
      );
      return false;
    }

    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("document", createReadStream(filePath));
    if (caption) {
      form.append("caption", caption);
    }

    const response = await axios.post(
      `${TELEGRAM_API_URL}/sendDocument`,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    return response.data.ok;
  } catch (error) {
    console.log(
      chalk.red(`❌ Lỗi gửi file Telegram ${path.basename(filePath)}: ${error.message}`)
    );
    return false;
  }
}

// Hàm backup thư mục uploads từ một đường dẫn
async function backupUploadsDirectory(sourcePath, backupDir) {
  const uploadsPath = path.join(sourcePath, "uploads");

  try {
    // Kiểm tra thư mục uploads có tồn tại không
    await fs.access(uploadsPath);

    // Tạo tên thư mục duy nhất từ đường dẫn
    // Lấy cả thư mục cha và thư mục hiện tại để tránh trùng tên
    const normalizedPath = sourcePath.replace(/\\/g, "/");
    const pathParts = normalizedPath.split("/").filter(Boolean);

    // Lấy 2 thư mục cuối cùng để tạo tên duy nhất
    // Ví dụ: D:/Freelancer/website/VINCENS/backend -> VINCENS_backend
    let projectName;
    if (pathParts.length >= 2) {
      projectName = `${pathParts[pathParts.length - 2]}_${pathParts[pathParts.length - 1]}`;
    } else {
      // Nếu chỉ có 1 phần, dùng tên đó
      projectName = pathParts[pathParts.length - 1] || path.basename(sourcePath);
    }

    // Loại bỏ ký tự đặc biệt không hợp lệ cho tên thư mục
    projectName = projectName.replace(/[<>:"/\\|?*]/g, "_");

    const destPath = path.join(backupDir, "uploads", projectName);

    // Tạo thư mục đích
    await fs.mkdir(destPath, { recursive: true });

    // Copy thư mục uploads
    await copyDirectory(uploadsPath, destPath);

    console.log(chalk.green(`✅ Đã backup uploads từ: ${sourcePath} -> ${projectName}`));
    return destPath;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(chalk.yellow(`⚠️  Không tìm thấy thư mục uploads tại: ${uploadsPath}`));
    } else {
      console.log(chalk.red(`❌ Lỗi backup uploads từ ${sourcePath}: ${error.message}`));
    }
    return null;
  }
}

// Hàm copy thư mục đệ quy với xử lý lỗi
async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    try {
      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    } catch (error) {
      // Bỏ qua file không thể copy (có thể do quyền truy cập hoặc file đang được sử dụng)
      console.log(
        chalk.yellow(
          `  ⚠️  Bỏ qua file: ${path.relative(src, srcPath)} - ${error.message}`
        )
      );
    }
  }
}

// Hàm lấy tất cả file trong thư mục (đệ quy)
async function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = await fs.readdir(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      arrayOfFiles = await getAllFiles(filePath, arrayOfFiles);
    } else {
      arrayOfFiles.push(filePath);
    }
  }

  return arrayOfFiles;
}

// Hàm chính với tối ưu hiệu suất và progress bars
async function main() {
  const startTime = Date.now();
  console.log(
    chalk.bold.blue(
      "💾 Bắt đầu backup toàn bộ MongoDB cluster (Giữ nguyên kiểu dữ liệu)"
    )
  );
  console.log(chalk.gray(`MONGODB_URI: ${MONGODB_URI}`));
  console.log(chalk.gray(`Batch size: ${BATCH_SIZE} documents`));
  console.log(
    chalk.gray(`Max concurrent collections: ${MAX_CONCURRENT_COLLECTIONS}`)
  );
  console.log(
    chalk.gray(`Max concurrent databases: ${MAX_CONCURRENT_DATABASES}`)
  );
  console.log(
    chalk.yellow(
      `📋 Backup format: ${USE_EXTENDED_JSON ? "Extended JSON (.ejson)" : "Standard JSON (.json)"
      }`
    )
  );
  console.log(
    chalk.yellow(
      `🔧 Giữ nguyên kiểu dữ liệu MongoDB: ${USE_EXTENDED_JSON ? "CÓ ✅" : "KHÔNG ❌"
      }`
    )
  );

  const { databases: userDatabases, uploadPaths } = parseArguments();

  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 50,
    minPoolSize: 10,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  try {
    await client.connect();
    console.log(chalk.green("✅ Đã kết nối thành công đến MongoDB"));

    // Lấy danh sách tất cả databases
    const adminDb = client.db("admin");
    const databases = await adminDb.admin().listDatabases();
    let databaseNames = databases.databases
      .map((db) => db.name)
      .filter((name) => !["admin", "local", "config"].includes(name)); // Loại bỏ system databases

    if (userDatabases && userDatabases.length > 0) {
      // Chỉ backup các database do người dùng chỉ định
      databaseNames = databaseNames.filter((name) =>
        userDatabases.includes(name)
      );
      if (databaseNames.length === 0) {
        console.log(
          chalk.red(
            "❌ Không tìm thấy database nào phù hợp với lựa chọn của bạn!"
          )
        );
        await client.close();
        return;
      }
      console.log(
        chalk.cyan(
          `📋 Chỉ backup các database do người dùng chọn: ${databaseNames.join(
            ", "
          )}`
        )
      );
    }

    console.log(
      chalk.cyan(`📋 Tìm thấy ${databaseNames.length} databases để backup:`)
    );
    databaseNames.forEach((name) => console.log(chalk.gray(`  - ${name}`)));

    const { backupDir, dateStr } = await createBackupDirectory();

    // Tạo metadata cho toàn bộ backup
    const metadata = {
      timestamp: new Date().toISOString(),
      mongodb_uri: MONGODB_URI,
      databases: databaseNames,
      total_databases: databaseNames.length,
      description:
        "Backup toàn bộ MongoDB cluster trước khi cập nhật (Giữ nguyên kiểu dữ liệu)",
      backup_format: {
        type: USE_EXTENDED_JSON ? "Extended JSON (EJSON)" : "Standard JSON",
        file_extension: USE_EXTENDED_JSON ? ".ejson" : ".json",
        preserves_mongodb_types: USE_EXTENDED_JSON,
        description: USE_EXTENDED_JSON
          ? "Sử dụng MongoDB Extended JSON để giữ nguyên ObjectId, Date, Binary và các kiểu dữ liệu đặc biệt khác"
          : "Sử dụng JSON thông thường (có thể mất kiểu dữ liệu MongoDB)",
      },
      performance_settings: {
        batch_size: BATCH_SIZE,
        max_concurrent_collections: MAX_CONCURRENT_COLLECTIONS,
        max_concurrent_databases: MAX_CONCURRENT_DATABASES,
      },
    };

    await fs.writeFile(
      path.join(backupDir, "metadata.json"),
      JSON.stringify(metadata, null, 2)
    );

    // Thêm ghi file MONGO_URL.txt với thông tin chi tiết
    const nowStr = new Date().toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    });
    const mongoUrlContent = `=== THÔNG TIN BACKUP MONGODB ===
Thời gian backup: ${nowStr}
MONGODB_URI: ${MONGODB_URI}

=== LOẠI BACKUP ===
Loại: Backup toàn bộ MongoDB cluster (Giữ nguyên kiểu dữ liệu)
Tổng số databases: ${databaseNames.length}
Databases được backup:
${databaseNames.map((name) => `  - ${name}`).join("\n")}

=== ĐỊNH DẠNG BACKUP ===
Format: ${USE_EXTENDED_JSON ? "Extended JSON (EJSON)" : "Standard JSON"}
File extension: ${USE_EXTENDED_JSON ? ".ejson" : ".json"}
Giữ nguyên kiểu dữ liệu MongoDB: ${USE_EXTENDED_JSON ? "CÓ" : "KHÔNG"}
${USE_EXTENDED_JSON
        ? "ObjectId, Date, Binary và các kiểu dữ liệu đặc biệt được bảo tồn"
        : "Các kiểu dữ liệu đặc biệt có thể bị chuyển thành string"
      }

=== CÀI ĐẶT HIỆU SUẤT ===
Batch size: ${BATCH_SIZE} documents
Max concurrent collections: ${MAX_CONCURRENT_COLLECTIONS}
Max concurrent databases: ${MAX_CONCURRENT_DATABASES}

=== THÔNG TIN HỆ THỐNG ===
Hệ điều hành: ${process.platform}
Node.js version: ${process.version}
Thời gian tạo backup: ${new Date().toISOString()}

=== MÔ TẢ ===
Đây là backup toàn bộ MongoDB cluster trước khi thực hiện cập nhật.
Backup bao gồm tất cả databases (trừ system databases: admin, local, config).
Mỗi database sẽ được lưu trong thư mục riêng với tất cả collections.
Sử dụng parallel processing để tăng tốc độ backup.
${USE_EXTENDED_JSON
        ? "Sử dụng Extended JSON để GIỮ NGUYÊN tất cả kiểu dữ liệu MongoDB!"
        : "Sử dụng JSON thông thường (có thể mất kiểu dữ liệu)."
      }

=== CẤU TRÚC BACKUP ===
backups/
└── ${path.basename(backupDir)}/
    ├── metadata.json          # Thông tin chi tiết về backup
    ├── MONGO_URL.txt         # File này
    ├── database1/
    │   ├── collection1${USE_EXTENDED_JSON ? ".ejson" : ".json"}
    │   └── collection2${USE_EXTENDED_JSON ? ".ejson" : ".json"}
    ├── database2/
    │   ├── collection1${USE_EXTENDED_JSON ? ".ejson" : ".json"}
    │   └── collection2${USE_EXTENDED_JSON ? ".ejson" : ".json"}
    └── ...

=== LƯU Ý QUAN TRỌNG ===
- Backup này có thể được restore bằng script import-backup.js
- Dữ liệu được lưu dưới dạng ${USE_EXTENDED_JSON ? "Extended JSON (.ejson)" : "Standard JSON (.json)"
      }
- ${USE_EXTENDED_JSON
        ? "TẤT CẢ kiểu dữ liệu MongoDB được bảo tồn (ObjectId, Date, Binary, etc.)"
        : "Các kiểu dữ liệu đặc biệt có thể bị mất"
      }
- System databases (admin, local, config) không được backup
- Sử dụng parallel processing để tối ưu hiệu suất
- Thời gian backup: ${nowStr}

=== VÍ DỤ KIỂU DỮ LIỆU ĐƯỢC BẢO TỒN ===
${USE_EXTENDED_JSON
        ? `
ObjectId: {"$oid": "507f1f77bcf86cd799439011"}
Date: {"$date": "2023-01-01T00:00:00.000Z"}
Binary: {"$binary": {"base64": "...", "subType": "00"}}
Decimal128: {"$numberDecimal": "123.45"}
`
        : "Không áp dụng - sử dụng JSON thông thường"
      }`;

    await fs.writeFile(path.join(backupDir, "MONGO_URL.txt"), mongoUrlContent);

    // Tạo progress bar cho databases
    const databaseProgressBar = new cliProgress.SingleBar({
      format:
        "📊 {bar} | {percentage}% | {value}/{total} databases | {database}",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      hideCursor: true,
    });

    console.log(chalk.yellow("\n🚀 Bắt đầu backup databases..."));
    databaseProgressBar.start(databaseNames.length, 0, {
      database: "Starting...",
    });

    let totalBackedUp = 0;
    let totalCollections = 0;

    // Backup databases theo parallel với giới hạn concurrent
    for (let i = 0; i < databaseNames.length; i += MAX_CONCURRENT_DATABASES) {
      const batch = databaseNames.slice(i, i + MAX_CONCURRENT_DATABASES);
      const promises = batch.map(async (databaseName) => {
        const count = await backupDatabase(
          client,
          databaseName,
          backupDir,
          databaseProgressBar
        );

        // Đếm số collections trong database này
        const db = client.db(databaseName);
        const collections = await db.listCollections().toArray();
        return { count, collections: collections.length };
      });

      const results = await Promise.all(promises);

      for (const result of results) {
        totalBackedUp += result.count;
        totalCollections += result.collections;
      }
    }

    databaseProgressBar.stop();

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log(
      chalk.bold.green(`\n🎉 Backup hoàn thành trong ${duration} giây!`)
    );
    console.log(chalk.green(`📊 Tổng cộng:`));
    console.log(chalk.green(`  - ${databaseNames.length} databases`));
    console.log(chalk.green(`  - ${totalCollections} collections`));
    console.log(chalk.green(`  - ${totalBackedUp} documents`));
    console.log(chalk.gray(`📁 Thư mục backup: ${backupDir}`));
    console.log(
      chalk.yellow("\n⚠️  Bây giờ bạn có thể chạy script cập nhật an toàn!")
    );

    // Backup thư mục uploads nếu có đường dẫn được chỉ định
    if (uploadPaths && uploadPaths.length > 0) {
      console.log(chalk.cyan("\n📁 Bắt đầu backup thư mục uploads..."));
      console.log(chalk.gray(`   Sử dụng ${uploadPaths.length} đường dẫn từ ${process.argv.includes("--paths") ? "command line" : ".env file"}`));

      for (const uploadPath of uploadPaths) {
        const normalizedPath = uploadPath.replace(/\\/g, "/");
        console.log(chalk.gray(`  - Đang xử lý: ${normalizedPath}`));
        await backupUploadsDirectory(normalizedPath, backupDir);
      }

      console.log(chalk.green("✅ Hoàn thành backup thư mục uploads"));
    }

    // Gửi thông tin backup lên Telegram
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      console.log(chalk.cyan("\n📤 Đang gửi thông tin backup lên Telegram..."));

      // Gửi thông tin tổng quan
      const summaryMessage = `🔔 <b>BACKUP HOÀN THÀNH</b>

📊 <b>Thống kê:</b>
• Databases: ${databaseNames.length}
• Collections: ${totalCollections}
• Documents: ${totalBackedUp}
• Thời gian: ${duration} giây

📁 <b>Thư mục backup:</b>
<code>${backupDir}</code>

📋 <b>Databases:</b>
${databaseNames.map((name) => `• ${name}`).join("\n")}

${uploadPaths && uploadPaths.length > 0 ? `\n📂 <b>Thư mục uploads đã backup:</b>\n${uploadPaths.map((p) => `• ${p}`).join("\n")}` : ""}

⏰ <b>Thời gian:</b> ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;

      await sendTelegramMessage(summaryMessage);

      // Nén toàn bộ thư mục backup thành file zip
      console.log(chalk.cyan("\n📦 Đang nén toàn bộ backup thành file zip..."));
      let zipFilePath;
      try {
        zipFilePath = await zipBackupDirectory(backupDir, dateStr);

        // Kiểm tra kích thước file zip
        const zipStats = statSync(zipFilePath);
        const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
        const maxFileSize = 50 * 1024 * 1024; // 50MB limit của Telegram

        if (zipStats.size > maxFileSize) {
          console.log(
            chalk.yellow(
              `⚠️  File zip quá lớn (${zipSizeMB}MB), vượt quá giới hạn 50MB của Telegram. Không thể gửi lên Telegram.`
            )
          );
          console.log(chalk.gray(`   File zip đã được lưu tại: ${zipFilePath}`));
        } else {
          // Gửi file zip lên Telegram
          console.log(chalk.cyan(`📤 Đang gửi file backup lên Telegram (${zipSizeMB}MB)...`));
          const zipFileName = `backup-${dateStr}.zip`;
          const caption = `📦 <b>BACKUP HOÀN THÀNH</b>\n\n📊 <b>Thống kê:</b>\n• Databases: ${databaseNames.length}\n• Collections: ${totalCollections}\n• Documents: ${totalBackedUp}\n• Kích thước: ${zipSizeMB} MB\n• Thời gian backup: ${duration} giây\n\n⏰ ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;

          const success = await sendTelegramFile(zipFilePath, caption);

          if (success) {
            console.log(chalk.green("✅ Đã gửi file backup lên Telegram thành công"));

            // Xóa file zip sau khi gửi thành công để tiết kiệm dung lượng
            try {
              await fs.unlink(zipFilePath);
              console.log(chalk.gray(`🗑️  Đã xóa file zip tạm: ${zipFileName}`));
            } catch (deleteError) {
              console.log(chalk.yellow(`⚠️  Không thể xóa file zip: ${deleteError.message}`));
            }
          } else {
            console.log(chalk.yellow("⚠️  Không thể gửi file zip lên Telegram"));
            console.log(chalk.gray(`   File zip đã được lưu tại: ${zipFilePath}`));
          }
        }
      } catch (error) {
        console.log(chalk.red(`❌ Lỗi nén hoặc gửi backup: ${error.message}`));
        if (zipFilePath && fsSync.existsSync(zipFilePath)) {
          console.log(chalk.gray(`   File zip đã được lưu tại: ${zipFilePath}`));
        }
      }
    } else {
      console.log(chalk.yellow("⚠️  Telegram không được cấu hình, bỏ qua gửi lên Telegram"));
      console.log(chalk.gray("   Để sử dụng, thêm TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID vào file .env"));
    }
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi backup: ${error.message}`));

    // Gửi thông báo lỗi lên Telegram nếu có
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegramMessage(
        `❌ <b>LỖI BACKUP</b>\n\n${error.message}\n\n⏰ ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`
      );
    }
  } finally {
    await client.close();
    console.log(chalk.gray("🔌 Đã đóng kết nối database"));
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  createBackupDirectory,
  backupCollection,
  backupDatabase,
  backupUploadsDirectory,
  sendTelegramMessage,
  sendTelegramFile,
  zipBackupDirectory,
};
