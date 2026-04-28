const { MongoClient, BSON } = require("mongodb");
const { EJSON } = BSON;
const fs = require("fs").promises;
const path = require("path");
const chalk = require("chalk");
const cliProgress = require("cli-progress");

// Cấu hình kết nối MongoDB Atlas
const MONGODB_URI = process.env.MONGODB_URI;


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
    return backupDir;
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi tạo thư mục backup: ${error.message}`));
    throw error;
  }
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

// Thêm hàm parseArguments để lấy danh sách database từ dòng lệnh
function parseArguments() {
  const args = process.argv.slice(2);
  const dbArgIndex = args.findIndex((arg) => arg === "--database");
  let databases = [];
  if (dbArgIndex !== -1 && args[dbArgIndex + 1]) {
    databases = args[dbArgIndex + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { databases };
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
      `📋 Backup format: ${
        USE_EXTENDED_JSON ? "Extended JSON (.ejson)" : "Standard JSON (.json)"
      }`
    )
  );
  console.log(
    chalk.yellow(
      `🔧 Giữ nguyên kiểu dữ liệu MongoDB: ${
        USE_EXTENDED_JSON ? "CÓ ✅" : "KHÔNG ❌"
      }`
    )
  );

  const { databases: userDatabases } = parseArguments();

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

    const backupDir = await createBackupDirectory();

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
${
  USE_EXTENDED_JSON
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
${
  USE_EXTENDED_JSON
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
- Dữ liệu được lưu dưới dạng ${
      USE_EXTENDED_JSON ? "Extended JSON (.ejson)" : "Standard JSON (.json)"
    }
- ${
      USE_EXTENDED_JSON
        ? "TẤT CẢ kiểu dữ liệu MongoDB được bảo tồn (ObjectId, Date, Binary, etc.)"
        : "Các kiểu dữ liệu đặc biệt có thể bị mất"
    }
- System databases (admin, local, config) không được backup
- Sử dụng parallel processing để tối ưu hiệu suất
- Thời gian backup: ${nowStr}

=== VÍ DỤ KIỂU DỮ LIỆU ĐƯỢC BẢO TỒN ===
${
  USE_EXTENDED_JSON
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
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi backup: ${error.message}`));
  } finally {
    await client.close();
    console.log(chalk.gray("🔌 Đã đóng kết nối database"));
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { createBackupDirectory, backupCollection, backupDatabase };
