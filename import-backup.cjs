const { MongoClient, BSON } = require("mongodb");
const { EJSON } = BSON;
const fs = require("fs").promises;
const path = require("path");
const chalk = require("chalk");
const readline = require("readline");

const MONGODB_URI = process.env.MONGODB_URI;

// Tạo interface để đọc input từ user
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Hàm hỏi user và trả về promise
function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Hàm hiển thị hướng dẫn sử dụng
function showUsage() {
  console.log(chalk.bold.blue("📥 MongoDB Backup Import Tool"));
  console.log(chalk.gray("Công cụ import backup MongoDB với nhiều tùy chọn"));
  console.log("");
  console.log(chalk.bold.yellow("Cách sử dụng:"));
  console.log(chalk.gray("node import-backup.js backups/16-10-2025_16-26-58"));
  console.log("");
  console.log(chalk.bold.cyan("Tùy chọn:"));
  console.log(chalk.gray("  --all                    Import tất cả databases"));
  console.log(
    chalk.gray("  --database <tên_db>      Import một database cụ thể")
  );
  console.log(
    chalk.gray(
      "  --databases <db1,db2>    Import nhiều databases (phân cách bằng dấu phẩy)"
    )
  );
  console.log(
    chalk.gray(
      "  --col <tên_collection>   Import một collection cụ thể (cần kết hợp với --database)"
    )
  );
  console.log(
    chalk.gray(
      "  --collections <col1,col2> Import nhiều collections (cần kết hợp với --database)"
    )
  );
  console.log(
    chalk.gray("  --target <tên_db_đích>   Chỉ định tên database đích")
  );
  console.log(
    chalk.gray(
      "  --uri <mongodb_uri>      Chỉ định MongoDB URI đích (mặc định: " +
        MONGODB_URI +
        ")"
    )
  );
  console.log(chalk.gray("  --help                   Hiển thị hướng dẫn này"));
  console.log("");
  console.log(chalk.bold.cyan("Ví dụ:"));
  console.log(chalk.gray("  # Import tất cả databases (giữ nguyên tên gốc)"));
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --all"
    )
  );
  console.log("");
  console.log(chalk.gray("  # Import chỉ database decorandmore"));
  console.log(
    chalk.gray(
      "node import-backup.js ./backups/28-04-2026_10-08-38 --database vincens"
    )
  );
  console.log("");
  console.log(
    chalk.gray("  # Import chỉ collection products từ database decorandmore")
  );
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --database decorandmore --col products"
    )
  );
  console.log("");
  console.log(
    chalk.gray("  # Import nhiều collections từ database decorandmore")
  );
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --database decorandmore --collections products,variants,categories"
    )
  );
  console.log("");
  console.log(chalk.gray("  # Import nhiều databases (giữ nguyên tên gốc)"));
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --databases decorandmore,apiyaviet"
    )
  );
  console.log("");
  console.log(
    chalk.gray("  # Import decorandmore với tên database đích tùy chỉnh")
  );
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --database decorandmore --target decorandmore-28-07-2025"
    )
  );
  console.log("");
  console.log(
    chalk.gray("  # Import nhiều databases vào CÙNG MỘT database đích")
  );
  console.log(
    chalk.gray(
      "  node import-backup.cjs ./backups/28-04-2026_10-08-38 --databases decorandmore,apiyaviet --target backup-test"
    )
  );
  console.log(chalk.gray("  # (decorandmore + apiyaviet → backup-test)"));
  console.log("");
  console.log(chalk.gray("  # Import tất cả databases sang MongoDB URI mới"));
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --all --uri mongodb+srv://user:pass@new-cluster.mongodb.net/"
    )
  );
  console.log("");
  console.log(
    chalk.gray(
      "  # Import decorandmore sang MongoDB URI mới với tên database tùy chỉnh"
    )
  );
  console.log(
    chalk.gray(
      "  node scripts/dbtools/import-backup.js ./backups/28-04-2026_10-08-38 --database decorandmore --target decorandmore-new --uri mongodb+srv://user:pass@new-cluster.mongodb.net/"
    )
  );
  console.log("");
}

// Hàm parse arguments từ command line
function parseArguments() {
  const args = process.argv.slice(2);
  const options = {
    backupDir: null,
    databases: [],
    collections: [],
    // targetDatabase: DATABASE_NAME,
    targetUri: MONGODB_URI,
    importAll: false,
    showHelp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        options.showHelp = true;
        break;
      case "--all":
        options.importAll = true;
        break;
      case "--database":
        if (i + 1 < args.length) {
          options.databases.push(args[i + 1]);
          i++;
        }
        break;
      case "--databases":
        if (i + 1 < args.length) {
          const dbList = args[i + 1].split(",").map((db) => db.trim());
          options.databases.push(...dbList);
          i++;
        }
        break;
      case "--col":
      case "--collection":
        if (i + 1 < args.length) {
          options.collections.push(args[i + 1]);
          i++;
        }
        break;
      case "--collections":
        if (i + 1 < args.length) {
          const colList = args[i + 1].split(",").map((col) => col.trim());
          options.collections.push(...colList);
          i++;
        }
        break;
      case "--target":
        if (i + 1 < args.length) {
          options.targetDatabase = args[i + 1];
          i++;
        }
        break;
      case "--uri":
        if (i + 1 < args.length) {
          options.targetUri = args[i + 1];
          i++;
        }
        break;
      default:
        if (!options.backupDir) {
          options.backupDir = arg;
        }
        break;
    }
  }

  return options;
}

// Lấy thư mục backup từ tham số dòng lệnh
const options = parseArguments();

if (options.showHelp) {
  showUsage();
  process.exit(0);
}

if (!options.backupDir) {
  console.log(chalk.red("❌ Vui lòng cung cấp thư mục backup!"));
  console.log(chalk.gray("Sử dụng --help để xem hướng dẫn"));
  process.exit(1);
}

// Hàm đọc metadata từ backup
async function readMetadata(backupPath) {
  try {
    const metadataPath = path.join(backupPath, "metadata.json");
    const metadataContent = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(metadataContent);
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi đọc metadata: ${error.message}`));
    return null;
  }
}

// Hàm phát hiện format file và parse dữ liệu đúng cách
async function parseBackupFile(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");

    // Phát hiện format dựa trên extension
    const isEjson = filePath.endsWith(".ejson");

    if (isEjson) {
      // Sử dụng EJSON.parse để giữ nguyên kiểu dữ liệu MongoDB
      return EJSON.parse(data);
    } else {
      // File .json có thể chứa Extended JSON format
      // Cần parse và convert sang BSON objects
      const parsed = JSON.parse(data);

      // Convert từng document từ Extended JSON sang BSON
      return parsed.map(doc => convertExtendedJsonToBson(doc));
    }
  } catch (error) {
    throw new Error(`Lỗi parse file ${filePath}: ${error.message}`);
  }
}

// Hàm convert Extended JSON sang BSON objects
function convertExtendedJsonToBson(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Xử lý array
  if (Array.isArray(obj)) {
    return obj.map(item => convertExtendedJsonToBson(item));
  }

  // Xử lý object
  if (typeof obj === 'object') {
    // Kiểm tra các kiểu Extended JSON đặc biệt
    if (obj.$oid) {
      return new BSON.ObjectId(obj.$oid);
    }
    if (obj.$date) {
      return new Date(obj.$date);
    }
    if (obj.$numberLong) {
      return BSON.Long.fromString(obj.$numberLong);
    }
    if (obj.$numberInt) {
      return parseInt(obj.$numberInt);
    }
    if (obj.$numberDouble) {
      return parseFloat(obj.$numberDouble);
    }
    if (obj.$binary) {
      return new BSON.Binary(Buffer.from(obj.$binary.base64, 'base64'), obj.$binary.subType);
    }
    if (obj.$regex) {
      return new RegExp(obj.$regex, obj.$options || '');
    }
    if (obj.$timestamp) {
      return new BSON.Timestamp(obj.$timestamp.t, obj.$timestamp.i);
    }

    // Xử lý object thông thường - đệ quy vào các properties
    const result = {};
    for (const key in obj) {
      result[key] = convertExtendedJsonToBson(obj[key]);
    }
    return result;
  }

  // Giá trị primitive
  return obj;
}

// Hàm tìm file backup cho collection (hỗ trợ cả .json và .ejson)
async function findCollectionBackupFile(
  backupPath,
  databaseName,
  collectionName
) {
  const ejsonFile = path.join(
    backupPath,
    databaseName,
    `${collectionName}.ejson`
  );
  const jsonFile = path.join(
    backupPath,
    databaseName,
    `${collectionName}.json`
  );

  try {
    // Ưu tiên file .ejson trước
    await fs.access(ejsonFile);
    return { filePath: ejsonFile, format: "ejson" };
  } catch (error) {
    try {
      // Fallback về file .json
      await fs.access(jsonFile);
      return { filePath: jsonFile, format: "json" };
    } catch (error) {
      return null;
    }
  }
}

// Hàm import một collection với hỗ trợ cả .json và .ejson
async function importCollection(
  db,
  collectionName,
  backupPath,
  sourceDatabaseName
) {
  console.log(
    chalk.blue(
      `\n📥 Đang import collection: ${sourceDatabaseName}.${collectionName} → ${db.databaseName}.${collectionName}`
    )
  );

  const collection = db.collection(collectionName);

  try {
    // Tìm file backup cho collection (hỗ trợ cả .json và .ejson)
    const backupFileInfo = await findCollectionBackupFile(
      backupPath,
      sourceDatabaseName,
      collectionName
    );

    if (!backupFileInfo) {
      console.log(
        chalk.yellow(
          `  ⚠️  Không tìm thấy file backup cho collection: ${sourceDatabaseName}.${collectionName}`
        )
      );
      return 0;
    }

    console.log(
      chalk.gray(
        `  Tìm thấy file backup: ${path.basename(
          backupFileInfo.filePath
        )} (${backupFileInfo.format.toUpperCase()})`
      )
    );

    // Parse dữ liệu với format phù hợp
    const documents = await parseBackupFile(backupFileInfo.filePath);

    console.log(
      chalk.gray(`  Đọc được ${documents.length} documents từ backup`)
    );

    if (backupFileInfo.format === "ejson") {
      console.log(
        chalk.cyan(
          `  🔧 Sử dụng Extended JSON - giữ nguyên kiểu dữ liệu MongoDB`
        )
      );
    } else {
      console.log(
        chalk.cyan(
          `  🔧 Đã convert Extended JSON sang BSON objects`
        )
      );
    }

    if (documents.length === 0) {
      console.log(
        chalk.yellow(
          `  ⚠️  Collection ${sourceDatabaseName}.${collectionName} trống, bỏ qua`
        )
      );
      return 0;
    }

    // Xóa collection cũ (nếu có)
    try {
      await collection.drop();
      console.log(
        chalk.gray(
          `  Đã xóa collection cũ: ${db.databaseName}.${collectionName}`
        )
      );
    } catch (error) {
      // Collection không tồn tại, không sao
    }

    // Import documents
    if (documents.length > 0) {
      await collection.insertMany(documents);
      console.log(
        chalk.green(
          `  ✅ Đã import ${documents.length} documents vào collection: ${db.databaseName}.${collectionName}`
        )
      );
    }

    return documents.length;
  } catch (error) {
    console.log(
      chalk.red(
        `  ❌ Lỗi import collection ${sourceDatabaseName}.${collectionName}: ${error.message}`
      )
    );
    return 0;
  }
}

// Hàm import một database
async function importDatabase(client, databaseName, backupPath) {
  console.log(chalk.yellow(`\n📊 Đang import database: ${databaseName}`));

  const db = client.db(databaseName);
  const dbBackupPath = path.join(backupPath, databaseName);

  try {
    // Kiểm tra thư mục database có tồn tại không
    await fs.access(dbBackupPath);
  } catch (error) {
    console.log(
      chalk.red(
        `  ❌ Không tìm thấy thư mục backup cho database: ${databaseName}`
      )
    );
    return 0;
  }

  // Lấy danh sách các file backup trong thư mục database (hỗ trợ cả .json và .ejson)
  const files = await fs.readdir(dbBackupPath);
  const backupFiles = files.filter(
    (file) => file.endsWith(".json") || file.endsWith(".ejson")
  );

  if (backupFiles.length === 0) {
    console.log(
      chalk.gray(
        `  ⚠️  Database ${databaseName} không có collection nào để import`
      )
    );
    return 0;
  }

  let totalImported = 0;
  for (const backupFile of backupFiles) {
    const collectionName = backupFile.replace(/\.(json|ejson)$/, "");
    const count = await importCollection(
      db,
      collectionName,
      backupPath,
      databaseName
    );
    totalImported += count;
  }

  console.log(
    chalk.green(
      `  ✅ Hoàn thành import database ${databaseName}: ${totalImported} documents`
    )
  );
  return totalImported;
}

// Hàm chính
async function main() {
  console.log(chalk.bold.blue("📥 MongoDB Backup Import Tool"));
  console.log(chalk.gray(`Thư mục backup: ${options.backupDir}`));
  console.log(chalk.gray(`MongoDB URI đích: ${options.targetUri}`));

  // Kiểm tra thư mục backup có tồn tại không
  try {
    await fs.access(options.backupDir);
  } catch (error) {
    console.log(
      chalk.red(`❌ Thư mục backup không tồn tại: ${options.backupDir}`)
    );
    process.exit(1);
  }

  // Đọc metadata
  const metadata = await readMetadata(options.backupDir);
  if (!metadata) {
    console.log(chalk.red("❌ Không thể đọc metadata, dừng import"));
    process.exit(1);
  }

  console.log(chalk.cyan(`\n📋 Thông tin backup:`));
  console.log(chalk.gray(`  - Thời gian: ${metadata.timestamp}`));
  console.log(chalk.gray(`  - MongoDB URI gốc: ${metadata.mongodb_uri}`));
  console.log(chalk.gray(`  - MongoDB URI đích: ${options.targetUri}`));
  console.log(chalk.gray(`  - Tổng số databases: ${metadata.total_databases}`));
  console.log(
    chalk.gray(`  - Databases có sẵn: ${metadata.databases.join(", ")}`)
  );
  console.log(chalk.gray(`  - Mô tả: ${metadata.description}`));

  // Hiển thị thông tin format backup nếu có
  if (metadata.backup_format) {
    console.log(chalk.cyan(`\n🔧 Format backup:`));
    console.log(chalk.gray(`  - Loại: ${metadata.backup_format.type}`));
    console.log(
      chalk.gray(`  - Extension: ${metadata.backup_format.file_extension}`)
    );
    console.log(
      chalk.gray(
        `  - Giữ nguyên kiểu dữ liệu: ${
          metadata.backup_format.preserves_mongodb_types ? "CÓ ✅" : "KHÔNG ❌"
        }`
      )
    );
    if (metadata.backup_format.description) {
      console.log(
        chalk.gray(`  - Mô tả: ${metadata.backup_format.description}`)
      );
    }
  }

  // Xác định databases và collections cần import
  let databasesToImport = [];
  let collectionsToImport = [];

  if (options.importAll) {
    // Import tất cả databases
    databasesToImport = metadata.databases;
    console.log(
      chalk.yellow(
        `\n📊 Sẽ import tất cả ${databasesToImport.length} databases sang MongoDB URI mới`
      )
    );
  } else if (options.databases.length > 0) {
    // Import databases được chỉ định
    databasesToImport = options.databases;
    console.log(
      chalk.yellow(
        `\n📊 Sẽ import ${
          databasesToImport.length
        } databases: ${databasesToImport.join(", ")}`
      )
    );

    // Kiểm tra xem tất cả databases có tồn tại trong backup không
    const missingDatabases = databasesToImport.filter(
      (db) => !metadata.databases.includes(db)
    );
    if (missingDatabases.length > 0) {
      console.log(
        chalk.red(`❌ Không tìm thấy databases: ${missingDatabases.join(", ")}`)
      );
      process.exit(1);
    }
  } else {
    // Nếu không có tùy chọn nào, hỏi user
    console.log(chalk.cyan("\n🤔 Chọn databases để import:"));
    console.log(chalk.gray("  1. Import tất cả databases"));
    console.log(chalk.gray("  2. Import một database cụ thể"));
    console.log(chalk.gray("  3. Thoát"));

    const choice = await askQuestion(chalk.yellow("Nhập lựa chọn (1-3): "));

    switch (choice) {
      case "1":
        databasesToImport = metadata.databases;
        break;
      case "2":
        console.log(
          chalk.gray(`\nDatabases có sẵn: ${metadata.databases.join(", ")}`)
        );
        const singleDb = await askQuestion(chalk.yellow("Nhập tên database: "));
        if (metadata.databases.includes(singleDb)) {
          databasesToImport = [singleDb];
        } else {
          console.log(
            chalk.red(`❌ Database "${singleDb}" không tồn tại trong backup`)
          );
          process.exit(1);
        }
        break;
      case "3":
        console.log(chalk.gray("👋 Tạm biệt!"));
        process.exit(0);
      default:
        console.log(chalk.red("❌ Lựa chọn không hợp lệ"));
        process.exit(1);
    }
  }

  if (options.collections.length > 0) {
    collectionsToImport = options.collections;
    console.log(
      chalk.yellow(
        `\n📊 Sẽ import ${
          collectionsToImport.length
        } collections: ${collectionsToImport.join(", ")}`
      )
    );

    // Kiểm tra xem có database được chỉ định không
    if (databasesToImport.length === 0) {
      console.log(
        chalk.red(`❌ Cần chỉ định database khi import collections cụ thể`)
      );
      console.log(
        chalk.gray(`Sử dụng: --database <tên_db> --col <tên_collection>`)
      );
      process.exit(1);
    }
  }

  // Xác nhận import
  console.log(
    chalk.yellow(
      "\n⚠️  Cảnh báo: Import sẽ ghi đè dữ liệu hiện tại trong databases đích!"
    )
  );
  console.log(chalk.gray("Bạn có chắc chắn muốn tiếp tục? (Ctrl+C để hủy)"));

  // Đợi 3 giây để người dùng có thể hủy
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const client = new MongoClient(options.targetUri);

  try {
    await client.connect();
    console.log(chalk.green("✅ Đã kết nối thành công đến MongoDB đích"));

    let totalImported = 0;
    let totalCollections = 0;

    // Import từng database
    for (const sourceDatabaseName of databasesToImport) {
      const targetDatabaseName = options.importAll
        ? sourceDatabaseName
        : options.targetDatabase;

      console.log(
        chalk.yellow(
          `\n📊 Đang import database: ${sourceDatabaseName} → ${targetDatabaseName}`
        )
      );

      const targetDb = client.db(targetDatabaseName);
      const sourceBackupPath = path.join(options.backupDir, sourceDatabaseName);

      try {
        // Kiểm tra thư mục backup của database có tồn tại không
        await fs.access(sourceBackupPath);
      } catch (error) {
        console.log(
          chalk.red(
            `  ❌ Không tìm thấy thư mục backup cho database: ${sourceDatabaseName}`
          )
        );
        continue;
      }

      // Lấy danh sách các file backup trong thư mục database (hỗ trợ cả .json và .ejson)
      const files = await fs.readdir(sourceBackupPath);
      const backupFiles = files.filter(
        (file) => file.endsWith(".json") || file.endsWith(".ejson")
      );

      if (backupFiles.length === 0) {
        console.log(
          chalk.gray(
            `  ⚠️  Database ${sourceDatabaseName} không có collection nào để import`
          )
        );
        continue;
      }

      // Lọc collections cần import
      let collectionsToProcess = backupFiles;
      if (collectionsToImport.length > 0) {
        // Chỉ import collections được chỉ định
        const requestedCollections = collectionsToImport.map((col) =>
          col.includes(".") ? col.split(".")[1] : col
        );
        collectionsToProcess = backupFiles.filter((file) => {
          const collectionName = file.replace(/\.(json|ejson)$/, "");
          return requestedCollections.includes(collectionName);
        });

        if (collectionsToProcess.length === 0) {
          console.log(
            chalk.yellow(
              `  ⚠️  Không tìm thấy collections được yêu cầu trong database: ${sourceDatabaseName}`
            )
          );
          continue;
        }
      }

      console.log(
        chalk.gray(
          `  Tìm thấy ${collectionsToProcess.length} collections để import`
        )
      );

      let dbImported = 0;
      // Import từng collection từ database gốc vào database đích
      for (const backupFile of collectionsToProcess) {
        const collectionName = backupFile.replace(/\.(json|ejson)$/, "");
        const count = await importCollection(
          targetDb,
          collectionName,
          options.backupDir,
          sourceDatabaseName
        );
        dbImported += count;
      }

      totalImported += dbImported;
      console.log(
        chalk.green(
          `  ✅ Hoàn thành import database ${sourceDatabaseName}: ${dbImported} documents`
        )
      );

      // Đếm số collections trong database đích
      try {
        const collections = await targetDb.listCollections().toArray();
        totalCollections += collections.length;
      } catch (error) {
        // Database có thể không tồn tại hoặc không có quyền truy cập
      }
    }

    console.log(chalk.bold.green(`\n🎉 Import hoàn thành!`));
    console.log(chalk.green(`📊 Tổng cộng:`));
    console.log(chalk.green(`  - ${databasesToImport.length} databases`));
    console.log(chalk.green(`  - ${totalCollections} collections`));
    console.log(chalk.green(`  - ${totalImported} documents`));
    console.log(chalk.gray(`📁 Thư mục backup: ${options.backupDir}`));
    console.log(chalk.gray(`🔗 MongoDB URI đích: ${options.targetUri}`));
  } catch (error) {
    console.log(chalk.red(`❌ Lỗi import: ${error.message}`));
  } finally {
    await client.close();
    console.log(chalk.gray("🔌 Đã đóng kết nối database"));
    rl.close();
  }
}

// Chạy script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { importCollection, importDatabase, readMetadata };
